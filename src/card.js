import crypto from 'node:crypto';
import fs from 'node:fs';

import { normalizeConfig } from './config.js';
import { CLARITY_ORDER, short, summarizeText, timeOf } from './text.js';
import { asArray, asObject, clampInt } from './util.js';

/** 来源 → 平台。平台的用处只有一个：决定这条记忆能不能出现在某个场合的提示词里。 */
const SOURCE_PLATFORM = {
  'qq-owner': 'qq',
  'qq-group': 'qq',
  'qq-private': 'qq',
  'qq-self': 'qq',
  'bili-video': 'bili',
  'bili-dynamic': 'bili',
  'bili-diary': 'bili',
  manual: 'shared',
  system: 'shared',
};

const PLATFORMS = ['qq', 'bili', 'shared'];

function hash(value, len = 16) {
  return crypto.createHash('sha1').update(String(value ?? '')).digest('hex').slice(0, len);
}

/** 场景快照：只存「谁 / 说了什么 / 什么时候」，最多 60 条，单条 200 字，防止 JSON 膨胀。 */
export function normalizeSceneContext(value) {
  const out = [];
  for (const item of asArray(value)) {
    if (!item || typeof item !== 'object') continue;
    const text = String(item.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
    if (!text) continue;
    out.push({
      sender: short(String(item.sender ?? ''), 24) || '某人',
      text,
      at: Number.isFinite(Number(item.at)) ? Number(item.at) : timeOf(item.at, 0),
    });
    if (out.length >= 60) break;
  }
  return out;
}

/** 一条记忆的标准形状。缺字段一律给安全默认，旧卡不需要迁移。 */
export function normalizeRecord(item) {
  const raw = asObject(item);
  const text = String(raw.text ?? '').trim();
  const title = String(raw.title ?? '').trim();
  if (!text && !title) return null;
  const createdAt = timeOf(raw.createdAt, Date.now());
  return {
    id: String(raw.id ?? `mem_${hash(`${createdAt}|${title}|${text}`)}`),
    source: String(raw.source ?? 'system'),
    platform: PLATFORMS.includes(raw.platform) ? raw.platform : (SOURCE_PLATFORM[raw.source] ?? 'shared'),
    scope: PLATFORMS.includes(raw.scope) ? raw.scope : 'qq',
    kind: String(raw.kind ?? 'event'),
    title: short(title, 80),
    text: String(text).slice(0, 1200),
    tags: asArray(raw.tags).map(String).slice(0, 12),
    /** 1~100。这个库不判断重要性，由调用方给；见 README「不做什么」。 */
    importance: clampInt(raw.importance, 30, 1, 100),
    emotional: clampInt(raw.emotional, 0, 0, 24),
    pinned: raw.pinned === true,
    clarity: CLARITY_ORDER.includes(raw.clarity) ? raw.clarity : 'clear',
    createdAt: new Date(createdAt).toISOString(),
    lastSeenAt: new Date(timeOf(raw.lastSeenAt, createdAt)).toISOString(),
    speaker: short(String(raw.speaker ?? ''), 40),
    private: raw.private === true,
    /** 敏感记忆永远不进提示词，只在完整卡里留档。 */
    sensitive: raw.sensitive === true,
    /** 用户说过「别记了」。 */
    deprecated: raw.deprecated === true,
    /**
     * 她做过的事：发帖、取名、配图。这类记忆不看重要度也要留——
     * 用户过两天会问「你发的那篇笔记怎么样了」，忘了就是硬伤。
     */
    durable: raw.durable === true,
    /** 初次相遇。召回时的保底锚点，压到 30 字也留着。 */
    firstMet: raw.firstMet === true,
    isSelf: raw.isSelf === true,
    /** 一问一答里的「她怎么回的」。一条记录展开成两行，场景才像对话。 */
    botReply: String(raw.botReply ?? '').slice(0, 600),
    summary: String(raw.summary ?? '').slice(0, 140),
    sceneContext: normalizeSceneContext(raw.sceneContext),
  };
}

export function createCard(now = Date.now()) {
  const iso = new Date(now).toISOString();
  return { version: 1, createdAt: iso, updatedAt: iso, records: [] };
}

/**
 * 从磁盘读一张卡。这是本库唯一碰文件系统的地方，其余全是纯函数。
 * 文件不存在或 JSON 坏了会直接抛——降级还是退出，由调用方决定。
 */
export function loadCard(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const card = createCard(timeOf(raw.createdAt, Date.now()));
  card.version = Number(raw.version) || 1;
  card.updatedAt = String(raw.updatedAt ?? card.updatedAt);
  for (const item of asArray(raw.records)) {
    const record = normalizeRecord(item);
    if (record) card.records.push(record);
  }
  return card;
}

/**
 * 追加一条记忆。写入时就生成摘要，别指望「维护任务顺手补」——
 * 这种口头约定没人执行，最后保护带里全是没摘要的原文。
 */
export function addRecord(card, input = {}, config = {}, now = Date.now()) {
  const cfg = normalizeConfig(config);
  const body = String(input.text ?? '');
  const record = normalizeRecord({
    ...input,
    createdAt: input.createdAt ?? now,
    summary: input.summary ?? (cfg.summary.enabled ? summarizeText(body, cfg.summary.maxChars) : ''),
  });
  if (!record) return null;
  if (!Array.isArray(card.records)) card.records = [];
  if (card.records.some((item) => item?.id === record.id)) return null;
  card.records.push(record);
  card.updatedAt = new Date(now).toISOString();
  return record;
}
