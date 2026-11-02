/**
 * dsh-memory-band — a local, zero-model-call memory band for DeepSeek Harness.
 *
 * What it does on every DSH session:
 *   1. injects a small "last 24 hours" band through the system-prompt runtime
 *      context (stable per session, so the prefix stays cacheable);
 *   2. injects only the few older memories that match the current user line,
 *      through a second, narrow context contribution;
 *   3. auto-captures user lines locally, and exposes one `memory_band` tool for
 *      explicit recall / remember / stats.
 *
 * The retrieval engine is in `src/` and is pure JavaScript: no embedding API,
 * no vector database, no model call. The only recurring model cost this plugin
 * adds is the injected text itself; the status page reports its exact size.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { MemoryStore } from './store.js';
import { dashboardHtml } from './dashboard.js';

export const name = 'dsh-memory-band';
export const version = '0.2.1';
export const inject = ['systemPrompt', 'tools'];

const PREFIX = '/dsh-memory-band';
const BOOT_CONTEXT = 'dsh-memory-band-boot';
const RECALL_CONTEXT = 'dsh-memory-band-recall';

function expandHome(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  if (text === '~') return os.homedir();
  if (text.startsWith('~/') || text.startsWith('~\\')) return path.join(os.homedir(), text.slice(2));
  return text;
}

function resolveDataDir(config = {}) {
  const dir = expandHome(process.env.DSH_MEMORY_BAND_DIR || process.env.MEMORY_BAND_DIR || config.dataDir)
    || path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'dsh-memory-band');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function textOf(message) {
  const content = Array.isArray(message?.content) ? message.content : [];
  return content
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n')
    .trim();
}

function isUserMessage(message) {
  if (!message || message.role !== 'user') return false;
  const kind = message.source?.kind;
  return kind === undefined || kind === 'user';
}

/**
 * Questions are requests, not memories. Capturing "what was the codeword?"
 * and then recalling it next turn is pure token waste; facts get captured,
 * questions do not unless the user explicitly asks us to remember them.
 */
function worthCapturing(text) {
  const value = String(text ?? '').trim();
  if (!value) return false;
  const asks = /[?？]\s*$/.test(value)
    || /^(请问|问一下|你还记得|还记不记得|什么是|为什么|怎么|如何|哪|谁|多少|几点|吗)/.test(value);
  if (!asks) return true;
  return /记住|记一下|别忘|约定是|约定好|叫做|名字是(?!什么)|暗号是(?!什么)|我喜欢|我讨厌|我住在|我决定/.test(value);
}

function isLoopback(req) {
  const address = req?.socket?.remoteAddress || '';
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function sendJson(res, status, value) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(value));
}

function sendHtml(res, status, html) {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(html);
}

async function readBody(req) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  try {
    return JSON.parse(raw || '{}');
  } catch {
    return null;
  }
}

/**
 * Cordis plugin entry.
 *
 * @param {object} ctx Cordis context with `systemPrompt` and `tools`.
 * @param {object} [pluginConfig] bundle patch config.
 */
export function apply(ctx, pluginConfig = {}) {
  const store = new MemoryStore({
    dataDir: resolveDataDir(pluginConfig),
    config: pluginConfig,
    bootChars: pluginConfig.bootChars,
    recallChars: pluginConfig.recallChars,
    autoCapture: pluginConfig.autoCapture,
  });

  const lastQuery = new Map();
  const bootCache = new Map();
  const pending = new Map();
  const emitted = new Set();

  const noteInjection = (text) => {
    if (!text || emitted.has(text)) return;
    emitted.add(text);
    store.noteInjection(text);
  };

  const rememberPending = (agentId) => {
    const entry = pending.get(agentId);
    if (!entry) return null;
    pending.delete(agentId);
    const record = store.add(entry.text, {
      source: entry.source,
      importance: entry.importance,
      botReply: entry.botReply,
      createdAt: entry.at,
      scope: 'qq',
      platform: 'qq',
    });
    bootCache.delete(agentId);
    return record;
  };

  const onInserted = ({ agent, message } = {}) => {
    if (!store.autoCapture || !isUserMessage(message)) return;
    const text = textOf(message).slice(0, 1200);
    if (!text || text.startsWith('/')) return;
    const id = agent?.id || 'global';
    // Capture the previous line, not the current one: the current line is
    // already in the request, and repeating it in the band wastes tokens.
    rememberPending(id);
    // A question is a request, not a memory. Close the previous pending line
    // but do not queue this one.
    if (!worthCapturing(text)) return;
    pending.set(id, {
      text,
      at: Date.now(),
      source: message.source?.kind === 'user' ? 'dsh-user' : 'dsh',
      importance: pluginConfig.importance ?? undefined,
      botReply: '',
    });
    lastQuery.set(id, text);
  };

  const onSessionEvent = (session, event) => {
    if (!event) return;
    const id = session?.id;
    if (!id) return;
    if (event.type === 'assistant/message') {
      const reply = textOf(event.data);
      const entry = pending.get(id);
      if (entry && reply) entry.botReply = reply.slice(0, 600);
      return;
    }
    if (event.type === 'turn/end') rememberPending(id);
  };

  const onDisposed = ({ agent } = {}) => {
    const id = agent?.id;
    if (!id) return;
    rememberPending(id);
    bootCache.delete(id);
    lastQuery.delete(id);
  };

  const bootText = (agentId) => {
    if (bootCache.has(agentId)) return bootCache.get(agentId);
    let text = '';
    try {
      text = store.bootBlock();
    } catch (error) {
      ctx.logger?.warn?.(`dsh-memory-band: boot block skipped: ${error?.message ?? error}`);
    }
    bootCache.set(agentId, text);
    noteInjection(text);
    return text;
  };

  const recallText = (_agentId, query) => {
    if (!query) return '';
    try {
      const text = store.recallBlock(query);
      noteInjection(text);
      return text;
    } catch (error) {
      ctx.logger?.warn?.(`dsh-memory-band: recall skipped: ${error?.message ?? error}`);
      return '';
    }
  };

  const safeRegister = (label, fn) => {
    try {
      return fn();
    } catch (error) {
      const message = String(error?.message ?? error);
      if (/duplicate|already (registered|exists)|exist/i.test(message)) return null;
      ctx.logger?.warn?.(`dsh-memory-band: ${label} registration failed: ${message}`);
      return null;
    }
  };

  // Stable boot band. The host deduplicates the projected snapshot, so an
  // unchanged band costs nothing after the first injection.
  safeRegister('boot context', () => ctx.systemPrompt.context({
    name: BOOT_CONTEXT,
    order: -180,
    text: (context) => {
      const id = context?.agent?.id || 'global';
      return bootText(id);
    },
  }));

  // Narrow, query-specific recall. It only appears when the local 2-gram
  // retriever actually finds something, so ordinary small talk adds nothing.
  safeRegister('recall context', () => ctx.systemPrompt.context({
    name: RECALL_CONTEXT,
    order: -170,
    text: (context) => {
      const id = context?.agent?.id || 'global';
      const query = lastQuery.get(id) || '';
      return recallText(id, query);
    },
  }));

  safeRegister('tool', () => ctx.tools.register({
    name: 'memory_band',
    description:
      '本地记忆带：查过去的旧事、让助理记住一条、或看记忆带用量。检索全在本地完成，不调用模型；'
      + '只有用户明确问起以前的事、或明确说“记住”时才需要调用。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['recall', 'remember', 'stats'], description: 'recall=查旧事；remember=记一条；stats=看用量' },
        query: { type: 'string', description: 'recall 时要查的内容（用户这句话或关键词）' },
        text: { type: 'string', description: 'remember 时要记住的一句话' },
        importance: { type: 'number', description: 'remember 的重要度 1~100，默认 75' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value ?? '') }],
    },
    async execute(args = {}) {
      store.metrics.toolCalls += 1;
      if (args.action === 'recall') {
        const query = String(args.query ?? '').trim();
        if (!query) throw new Error('memory_band: recall 需要 query');
        const text = store.recallBlock(query, 800);
        return text || '没有找到相关记忆。';
      }
      if (args.action === 'remember') {
        const text = String(args.text ?? '').trim();
        if (!text) throw new Error('memory_band: remember 需要 text');
        const importance = Number.isFinite(Number(args.importance)) ? Number(args.importance) : 75;
        const record = store.add(text, { source: 'dsh-user', importance, pinned: false, tags: ['explicit'] });
        if (!record) throw new Error('memory_band: 没有写成');
        bootCache.clear();
        return `记住了：${record.summary || record.text.slice(0, 80)}`;
      }
      if (args.action === 'stats') {
        const stats = store.stats();
        return [
          `记忆 ${stats.records} 条，原文 ${stats.chars} 字`,
          `本次进程注入 ${stats.metrics.injections} 次，估算 ${stats.estimatedInjectedTokens} token`,
          `数据目录 ${stats.dataDir}`,
        ].join('\n');
      }
      throw new Error('memory_band: action 只能是 recall / remember / stats');
    },
  }));

  // Events are optional in headless compositions; never let bookkeeping stop
  // the plugin from loading.
  const disposers = [];
  if (typeof ctx.on === 'function') {
    disposers.push(ctx.on('agent/inbox/inserted', onInserted));
    disposers.push(ctx.on('session/event', onSessionEvent));
    disposers.push(ctx.on('agent/disposed', onDisposed));
  }

  const registerRoutes = (webCtx) => {
    const route = (kind, pathname, handler) => {
      const wrapped = async (req, res) => {
        if (!isLoopback(req)) {
          sendJson(res, 403, { ok: false, error: '只接受本机回环访问' });
          return;
        }
        try {
          await handler(req, res);
        } catch (error) {
          sendJson(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      };
      safeRegister(`route ${pathname}`, () => webCtx.webServer.register({ kind, path: pathname, handler: wrapped }));
    };

    route('exact', `${PREFIX}/health`, (req, res) => {
      const stats = store.stats();
      sendJson(res, 200, {
        ok: true,
        name,
        version,
        dataDir: stats.dataDir,
        records: stats.records,
      });
    });

    route('exact', `${PREFIX}/stats`, (req, res) => {
      sendJson(res, 200, { ...store.stats(), version });
    });

    route('exact', `${PREFIX}/block`, (req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      const query = url.searchParams.get('q') || '';
      const block = query ? store.recallBlock(query, Number(url.searchParams.get('max')) || 800) : store.bootBlock();
      sendJson(res, 200, { ok: true, block, chars: block.length });
    });

    route('exact', `${PREFIX}/add`, async (req, res) => {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'add 只接受 POST' });
        return;
      }
      const data = await readBody(req);
      if (!data) {
        sendJson(res, 400, { ok: false, error: 'body 不是合法 JSON' });
        return;
      }
      const text = data.text ?? data.content ?? '';
      if (!String(text).trim()) {
        sendJson(res, 400, { ok: false, error: '需要 text/content 字段' });
        return;
      }
      const record = store.add(text, {
        source: data.source ?? 'manual',
        importance: data.importance,
        tags: data.tags,
        pinned: data.pinned === true,
        durable: data.durable === true,
      });
      bootCache.clear();
      sendJson(res, 200, { ok: true, record });
    });

    route('exact', `${PREFIX}/recent`, (req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      sendJson(res, 200, { ok: true, records: store.recent(url.searchParams.get('limit') || 20) });
    });

    route('exact', `${PREFIX}/forget`, async (req, res) => {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'forget 只接受 POST' });
        return;
      }
      const data = await readBody(req);
      const id = data?.id;
      if (!id) {
        sendJson(res, 400, { ok: false, error: '需要 id' });
        return;
      }
      bootCache.clear();
      sendJson(res, 200, { ok: store.remove(id) });
    });

    route('exact', `${PREFIX}/`, (req, res) => {
      const stats = store.stats();
      sendHtml(res, 200, dashboardHtml({ ...stats, version }, store.recent(20)));
    });
  };

  try {
    if (typeof ctx.inject === 'function' && !ctx.webServer) {
      ctx.inject(['webServer'], registerRoutes);
    } else if (ctx.webServer) {
      registerRoutes(ctx);
    }
  } catch (error) {
    ctx.logger?.warn?.(`dsh-memory-band: web routes unavailable: ${error?.message ?? error}`);
  }

  ctx.on?.('dispose', () => {
    for (const id of pending.keys()) rememberPending(id);
    for (const dispose of disposers) {
      try {
        dispose?.();
      } catch {
        /* ignore */
      }
    }
  });

  return {
    name,
    version,
    store,
    routes: true,
    memoryBlock: (query = '') => (query ? store.recallBlock(query) : store.bootBlock()),
  };
}

export default { name, version, inject, apply };
