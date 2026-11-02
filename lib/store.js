import fs from 'node:fs';
import path from 'node:path';

import {
  addRecord,
  buildMemoryBlock,
  buildProtectionBand,
  buildRecallSection,
  createCard,
  loadCard,
  normalizeConfig,
} from '../src/index.js';

const DEFAULT_DATA_DIR = path.join(process.env.DSH_HOME || path.join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh'), 'dsh-memory-band');

function expandHome(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  if (text === '~') return process.env.USERPROFILE || process.env.HOME || text;
  if (text.startsWith('~/') || text.startsWith('~\\')) {
    return path.join(process.env.USERPROFILE || process.env.HOME || '', text.slice(2));
  }
  return text;
}

function atomicWrite(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

function clean(text, max = 1200) {
  return String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** Heuristic importance for an automatically captured user line. */
export function autoImportance(text) {
  const s = String(text ?? '');
  if (!s.trim()) return 0;
  let score = 56;
  if (/记住|记一下|别忘|约定|决定|以后|将来|喜欢|讨厌|过敏|生日|名字|叫我|称呼|计划|目标|项目|密码|暗号/.test(s)) score = 72;
  if (/^(在吗|你好|早|早安|晚安|哈哈|嗯|哦|好的|ok|OK)[。！!？?~～\s]*$/.test(s)) score = 44;
  if (s.length > 300) score -= 4;
  if (s.length < 4) score -= 12;
  return Math.max(1, Math.min(100, score));
}

/**
 * Durable, local-only memory store for the DSH plugin.
 *
 * The retrieval engine lives in `src/` and is deliberately pure; this class
 * owns the filesystem, the write-back path and the small amount of bookkeeping
 * the plugin needs for its status page.
 */
export class MemoryStore {
  constructor(options = {}) {
    this.dataDir = path.resolve(expandHome(options.dataDir) || DEFAULT_DATA_DIR);
    this.cardPath = path.join(this.dataDir, 'memory-card.json');
    this.configPath = path.join(this.dataDir, 'config.json');
    this.bootChars = Number.isFinite(Number(options.bootChars)) ? Math.max(200, Number(options.bootChars)) : 760;
    this.recallChars = Number.isFinite(Number(options.recallChars)) ? Math.max(200, Number(options.recallChars)) : 380;
    this.autoCapture = options.autoCapture !== false;
    this.baseConfig = normalizeConfig(options.config ?? {});
    this.cache = { key: '', card: null };
    this.metrics = {
      captures: 0,
      recallCalls: 0,
      recallHits: 0,
      toolCalls: 0,
      injections: 0,
      injectedChars: 0,
      bootChars: 0,
      lastRecallChars: 0,
    };
    this.ensure();
  }

  ensure() {
    fs.mkdirSync(this.dataDir, { recursive: true });
    if (!fs.existsSync(this.cardPath)) {
      atomicWrite(this.cardPath, JSON.stringify(createCard(), null, 2));
    }
    if (!fs.existsSync(this.configPath)) {
      atomicWrite(this.configPath, JSON.stringify({
        // Deliberately small defaults: the point of the band is to replace a
        // long history, not to become another long history.
        injectMaxChars: { qq: 520, bili: 360 },
        protectionBand: { enabled: true, windowHours: 24, bandChars: 760, bandImportanceMin: 55, sceneEnabled: false },
        recallBand: { enabled: true, impFloor: 45, sceneEnabled: false },
        scene: { enabled: false },
        prompt: {
          header: '【记忆带 · 和这句话相关的旧事（本地检索，未调用模型）】',
          bandHeader: '【记忆带 · 最近 24 小时（本地记忆，自动带入）】',
          footer: '（这是本地记忆带自动带入的旧事，不是用户这轮说的话；如果这里已经能回答，就直接回答，别再读文件或搜索；自然用，别照读，也别提“记忆带”。）',
        },
      }, null, 2));
    }
  }

  readConfig() {
    try {
      const stat = fs.statSync(this.configPath);
      const key = `${stat.mtimeMs}:${stat.size}`;
      if (this.configKey === key) return this.configValue;
      const raw = JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
      this.configValue = normalizeConfig(raw.memoryCard ?? raw);
      this.configKey = key;
      return this.configValue;
    } catch {
      return this.baseConfig;
    }
  }

  load() {
    try {
      const stat = fs.statSync(this.cardPath);
      const key = `${stat.mtimeMs}:${stat.size}`;
      if (this.cache.key === key) return this.cache.card;
      const card = loadCard(this.cardPath);
      this.cache = { key, card };
      return card;
    } catch {
      return null;
    }
  }

  save(card) {
    card.updatedAt = new Date().toISOString();
    atomicWrite(this.cardPath, JSON.stringify(card, null, 2));
    const stat = fs.statSync(this.cardPath);
    this.cache = { key: `${stat.mtimeMs}:${stat.size}`, card };
    return card;
  }

  /** Add one memory; nearby duplicates refresh `lastSeenAt` instead of growing the card. */
  add(text, input = {}) {
    const body = clean(text);
    if (!body) return null;
    const card = this.load();
    if (!card) return null;
    const now = Number.isFinite(Number(input.now)) ? Number(input.now) : Date.now();
    const recent = card.records.find((record) => {
      if (record.deprecated || record.sensitive) return false;
      if (record.text !== body) return false;
      return Math.abs(Date.parse(record.createdAt) - now) < 6 * 3600_000;
    });
    if (recent) {
      recent.lastSeenAt = new Date(now).toISOString();
      this.save(card);
      return recent;
    }
    const record = addRecord(card, {
      ...input,
      text: body,
      createdAt: input.createdAt ?? now,
      source: input.source ?? 'dsh-user',
      importance: input.importance ?? autoImportance(body),
      scope: input.scope ?? 'qq',
      platform: input.platform ?? 'qq',
    }, this.readConfig(), now);
    if (!record) return null;
    this.save(card);
    this.metrics.captures += 1;
    return record;
  }

  bootBlock() {
    const card = this.load();
    if (!card || card.records.length === 0) return '';
    const cfg = this.readConfig();
    const text = buildMemoryBlock(card, {
      query: '',
      config: {
        ...cfg,
        protectionBand: { ...cfg.protectionBand, enabled: true, bandChars: this.bootChars, sceneEnabled: false },
        recallBand: { ...cfg.recallBand, enabled: false },
        scene: { ...cfg.scene, enabled: false },
      },
      now: Date.now(),
    }).text;
    this.metrics.bootChars = text.length;
    return text;
  }

  recallBlock(query, maxChars = this.recallChars) {
    const q = clean(query, 400);
    if (!q) return '';
    const card = this.load();
    if (!card || card.records.length === 0) return '';
    this.metrics.recallCalls += 1;
    const cfg = this.readConfig();
    const now = Date.now();
    // Do not repeat what the stable boot band already carries. The recall
    // band is for older things; the 24h band is already in the prompt.
    const boot = buildProtectionBand(card, { platform: 'qq', cfg, now });
    const skipIds = new Set(boot.records.map((record) => record.id));
    const skipFingerprints = [...new Set(boot.records.map((record) => record.text).filter(Boolean))];
    const recall = buildRecallSection(card, {
      query: q,
      platform: 'qq',
      maxChars,
      cfg,
      now,
      skipIds,
      skipFingerprints,
    });
    const text = recall.lines.length
      ? [cfg.prompt.header, ...recall.lines, cfg.prompt.footer].join('\n')
      : '';
    this.metrics.lastRecallChars = text.length;
    if (text) this.metrics.recallHits += 1;
    return text;
  }

  noteInjection(text) {
    if (!text) return;
    this.metrics.injections += 1;
    this.metrics.injectedChars += text.length;
  }

  recent(limit = 20) {
    const card = this.load();
    if (!card) return [];
    return [...card.records]
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
      .slice(0, Math.max(1, Math.min(100, Number(limit) || 20)))
      .map((record) => ({
        id: record.id,
        at: record.createdAt,
        source: record.source,
        importance: record.importance,
        text: record.text,
        summary: record.summary,
        tags: record.tags,
        botReply: record.botReply,
      }));
  }

  remove(id) {
    const card = this.load();
    if (!card) return false;
    const index = card.records.findIndex((record) => record.id === id);
    if (index < 0) return false;
    card.records.splice(index, 1);
    this.save(card);
    return true;
  }

  stats() {
    const card = this.load();
    const records = card?.records ?? [];
    const bySource = {};
    let chars = 0;
    for (const record of records) {
      bySource[record.source] = (bySource[record.source] ?? 0) + 1;
      chars += record.text.length;
    }
    const newest = records.reduce((max, r) => Math.max(max, Date.parse(r.createdAt) || 0), 0);
    return {
      ok: true,
      dataDir: this.dataDir,
      cardPath: this.cardPath,
      records: records.length,
      chars,
      bySource,
      newestAt: newest ? new Date(newest).toISOString() : null,
      autoCapture: this.autoCapture,
      budgets: { bootChars: this.bootChars, recallChars: this.recallChars },
      metrics: { ...this.metrics },
      estimatedInjectedTokens: Math.ceil(this.metrics.injectedChars / 1.5),
    };
  }
}
