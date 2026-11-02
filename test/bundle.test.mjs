import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { name, inject, apply, version } from '../lib/index.js';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memory-band-test-'));
}

/** Minimal Cordis ctx: only the services this bundle uses. */
function makeCtx() {
  const registered = [];
  const contexts = [];
  const registeredTools = [];
  const listeners = new Map();
  return {
    registered,
    contexts,
    registeredTools,
    listener(name, fn) {
      const list = listeners.get(name) ?? [];
      list.push(fn);
      listeners.set(name, list);
      return () => {};
    },
    emit(name, payload) {
      for (const fn of listeners.get(name) ?? []) fn(payload);
    },
    systemPrompt: {
      context(spec) {
        contexts.push(spec);
        return () => {};
      },
    },
    tools: {
      register(spec) {
        registeredTools.push(spec);
        return () => {};
      },
    },
    webServer: {
      register(spec) {
        if (registered.find((r) => r.path === spec.path)) {
          throw new Error(`webserver: duplicate exact route "${spec.path}"`);
        }
        registered.push(spec);
        return () => {};
      },
    },
    on(event, fn) {
      return this.listener(event, fn);
    },
  };
}

test('bundle 入口导出符合 DSH cordis 插件契约', () => {
  assert.equal(name, 'dsh-memory-band');
  assert.equal(typeof apply, 'function');
  assert.ok(Array.isArray(inject));
  assert.ok(inject.includes('systemPrompt'), '必须声明 systemPrompt');
  assert.ok(inject.includes('tools'), '必须声明 tools');
  assert.ok(version && typeof version === 'string');
});

test('apply 注册两条 prompt 上下文、一个工具和回环路由', () => {
  const dir = tempDir();
  process.env.DSH_MEMORY_BAND_DIR = dir;
  const ctx = makeCtx();
  const meta = apply(ctx);
  assert.equal(meta.routes, true);
  assert.equal(ctx.contexts.length, 2);
  assert.deepEqual(ctx.contexts.map((c) => c.name), ['dsh-memory-band-boot', 'dsh-memory-band-recall']);
  assert.equal(ctx.registeredTools.length, 1);
  assert.equal(ctx.registeredTools[0].name, 'memory_band');
  const paths = ctx.registered.map((r) => r.path).sort();
  assert.deepEqual(paths, [
    '/dsh-memory-band/',
    '/dsh-memory-band/add',
    '/dsh-memory-band/block',
    '/dsh-memory-band/forget',
    '/dsh-memory-band/health',
    '/dsh-memory-band/recent',
    '/dsh-memory-band/stats',
  ]);
  for (const r of ctx.registered) assert.equal(r.kind, 'exact');
});

test('boot 带回最近记忆，recall 按 query 命中旧事', () => {
  const dir = tempDir();
  process.env.DSH_MEMORY_BAND_DIR = dir;
  const ctx = makeCtx();
  const meta = apply(ctx);
  meta.store.add('昨天主人说那本旧小说第七章一直没敢往下看', { importance: 80, createdAt: Date.now() - 2 * 3600_000 });
  meta.store.add('上个月约好周末去海边看日出', { importance: 80, createdAt: Date.now() - 20 * 86400_000 });

  const boot = ctx.contexts.find((c) => c.name === 'dsh-memory-band-boot').text({ agent: { id: 'a' } });
  assert.match(boot, /旧小说/);
  assert.doesNotMatch(boot, /海边/);

  // No current query yet -> the recall context adds nothing.
  const recall = ctx.contexts.find((c) => c.name === 'dsh-memory-band-recall');
  assert.equal(recall.text({ agent: { id: 'a' } }), '');

  // A real user message teaches the plugin the query, without capturing the
  // current line into the same request.
  ctx.emit('agent/inbox/inserted', {
    agent: { id: 'a' },
    message: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '海边那次约的几点来着' }] },
  });
  const hit = recall.text({ agent: { id: 'a' } });
  assert.match(hit, /海边/);
  assert.doesNotMatch(hit, /海边那次约的几点来着/);
});

test('agent/inbox/inserted 会捕获上一轮，而不是当前轮', () => {
  const dir = tempDir();
  process.env.DSH_MEMORY_BAND_DIR = dir;
  const ctx = makeCtx();
  const meta = apply(ctx);
  const send = (text) => ctx.emit('agent/inbox/inserted', {
    agent: { id: 'a' },
    message: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] },
  });
  send('第一句：项目暗号是蓝鲸七号');
  assert.equal(meta.store.stats().records, 0, '当前轮先不记');
  send('第二句：今天有点热');
  assert.equal(meta.store.stats().records, 1);
  assert.match(meta.store.recent()[0].text, /蓝鲸七号/);

  // A question is a request, not a memory; it must not pollute the band.
  send('交接记录里的项目暗号是什么？');
  send('第三句：晚上吃点好的');
  assert.equal(meta.store.stats().records, 2);
  assert.doesNotMatch(meta.store.recent()[0].text, /交接记录/);
});

test('非本机请求被 403 拒绝', async () => {
  const dir = tempDir();
  process.env.DSH_MEMORY_BAND_DIR = dir;
  const ctx = makeCtx();
  apply(ctx);
  const health = ctx.registered.find((r) => r.path === '/dsh-memory-band/health');
  let captured = null;
  const req = { method: 'GET', url: 'http://127.0.0.1/dsh-memory-band/health', socket: { remoteAddress: '8.8.8.8' } };
  const res = { writeHead(c) { this._c = c; }, end(b) { captured = { c: this._c, b }; } };
  await health.handler(req, res);
  assert.equal(captured.c, 403);
});

test('apply 容忍重复注册（DSH 安装/启用会多次调用 apply）', () => {
  const dir = tempDir();
  process.env.DSH_MEMORY_BAND_DIR = dir;
  const ctx = makeCtx();
  assert.equal(apply(ctx).routes, true);
  assert.doesNotThrow(() => apply(ctx));
});
