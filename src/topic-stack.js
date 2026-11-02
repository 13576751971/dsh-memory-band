/**
 * 话题栈：把「那件事 / 上次那个 / 还有下文吗」还原成具体的话题词。
 *
 * 只在调用召回之前补一次 query，不碰召回本身，不写记忆卡。
 *
 * 三条规矩：
 *   1. 开关关闭时原样返回入参，调用方行为一个字节都不变；
 *   2. 宁可漏补，不可错补——必须同时过「含指代词」和「没有任何稀有词」两道门；
 *   3. 补全只往 query 前面加词，不删词、不改写原句，原来的命中能力不受影响。
 *
 * 默认关闭。原因写在 README 的「话题栈」一节：保护带已经把近 24 小时带进上下文，
 * 它想捞的那部分本来就在，收益不显著，而每次补错要占掉一格注入预算。
 */
import { recallTokens, timeOf } from './text.js';
import { asObject, bool, clampInt } from './util.js';

const MIN_MS = 60e3;

export const DEFAULT_TOPIC_STACK_CONFIG = Object.freeze({
  enabled: false,
  /** 建栈只回看这么久。隔了一天的对话不算「刚才」。 */
  windowHours: 6,
  /** 栈深：最多留几个话题。 */
  maxDepth: 6,
  /** 会话切分：相邻记忆间隔超过它就认为换了话题。 */
  sessionGapMinutes: 20,
  /** 一个词出现在不超过这么多条记忆里，才算「有辨识度」。 */
  contentDfMax: 2,
  /** 往 query 前面补几个词。 */
  maxAnchors: 2,
  /** 补全前缀的字数上限，防止把整段话搬进 query。 */
  maxExpandChars: 24,
  /** 只在私聊记忆上建栈，群聊噪声不进话题。 */
  directOnly: true,
});

export function normalizeTopicStackConfig(input = {}) {
  const src = asObject(input);
  const raw = asObject(src.topicStack && typeof src.topicStack === 'object' ? src.topicStack : src);
  const D = DEFAULT_TOPIC_STACK_CONFIG;
  return {
    enabled: bool(raw.enabled, D.enabled),
    windowHours: clampInt(raw.windowHours, D.windowHours, 1, 72),
    maxDepth: clampInt(raw.maxDepth, D.maxDepth, 1, 20),
    sessionGapMinutes: clampInt(raw.sessionGapMinutes, D.sessionGapMinutes, 1, 240),
    contentDfMax: clampInt(raw.contentDfMax, D.contentDfMax, 1, 50),
    maxAnchors: clampInt(raw.maxAnchors, D.maxAnchors, 1, 6),
    maxExpandChars: clampInt(raw.maxExpandChars, D.maxExpandChars, 4, 80),
    directOnly: bool(raw.directOnly, D.directOnly),
  };
}

/** 出现这些词，才可能是在指代之前聊过的事。 */
const PRONOUN_RES = [
  /那件/, /那次/, /那个/, /那本/, /那首/, /那些/, /那边/, /那种/,
  /上次/, /上回/, /之前说/, /刚说/, /刚才说/, /前面说/,
  /还有下文/, /有下文/, /后来呢/, /然后呢/, /结果呢/, /怎么样了/,
  /那个东西/, /那个事/, /那事儿/, /那东西/,
  /之后呢/, /还作数/, /算数吗/,
];

/** 指代词本身切出来的 token。判断「稀有词」时先剔掉，免得被自己的词骗过。 */
const PRONOUN_TOKENS = new Set([
  '那件', '那次', '那个', '那本', '那首', '那些', '那边', '那种', '上次', '上回',
  '刚才', '才说', '之前', '前说', '还有', '有下', '下文', '后来', '然后', '结果', '怎么',
  '么样', '东西', '个东', '事儿', '之后', '作数', '算数',
]);

function hasPronoun(query) {
  const q = String(query ?? '');
  if (!q) return false;
  return PRONOUN_RES.some((re) => re.test(q));
}

function haystackOf(record) {
  return `${record.title ?? ''} ${record.text ?? ''}`.toLowerCase();
}

function usableRecord(record, cfg, now) {
  if (!record) return false;
  if (record.sensitive || record.deprecated) return false;
  if (record.clarity === 'trace' || record.clarity === 'forgotten') return false;
  if (!String(record.text ?? '').trim()) return false;
  // 群聊不进话题。private / direct 两个字段在不同写入路径上给得不一致，
  // 按 source / kind 判定比看标志位可靠。
  if (cfg.directOnly) {
    const source = String(record.source ?? '');
    if (record.kind === 'group' || /group/i.test(source)) return false;
  }
  const at = timeOf(record.createdAt, 0);
  if (!at || at > now) return false;
  return now - at <= cfg.windowHours * 60 * MIN_MS;
}

/** 一条记忆里有辨识度的短语，2-gram 口径与召回完全一致。 */
function tokensOf(record) {
  return recallTokens(`${record.title ?? ''} ${record.text ?? ''}`, 40);
}

/**
 * 建栈：窗口内的记忆按会话间隔聚成话题帧，给每帧挑几个有指向性的词。
 *
 * 挑法是「话题内高频 + 全窗口罕见」，因为能指到某条记忆的词，往往只在那个话题里出现。
 * 试过按「贪心最大覆盖」挑（每步选能覆盖最多记录的词），实测更差：
 * 稀有度上限会把贪心推向「刚好卡在上限的通用词」，覆盖得广，指得却不准。
 *
 * 纯函数，不读盘不写盘。帧按 score 排序，score = 轮次权重 × 半小时半衰。
 */
export function buildTopicStack(records, options = {}) {
  const cfg = normalizeTopicStackConfig(options.config ?? {});
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  const pool = (Array.isArray(records) ? records : [])
    .filter((record) => usableRecord(record, cfg, now))
    .map((record) => ({ record, at: timeOf(record.createdAt, 0), hay: haystackOf(record) }))
    .filter((item) => item.at > 0)
    .sort((a, b) => a.at - b.at);
  if (!pool.length) return [];
  const gapMs = cfg.sessionGapMinutes * MIN_MS;

  const groups = [];
  let current = null;
  for (const item of pool) {
    if (!current || item.at - current.lastAt > gapMs) {
      current = { items: [item], startAt: item.at, lastAt: item.at };
      groups.push(current);
    } else {
      current.items.push(item);
      current.lastAt = item.at;
    }
  }

  const df = new Map();
  const bump = (map, key) => map.set(key, (map.get(key) || 0) + 1);
  for (const item of pool) {
    for (const token of new Set(tokensOf(item.record))) bump(df, token);
  }

  const frames = [];
  for (const group of groups) {
    const tf = new Map();
    for (const item of group.items) {
      for (const token of new Set(tokensOf(item.record))) bump(tf, token);
    }
    const anchors = [...tf.entries()]
      .filter(([token]) => token.length >= 2 && !PRONOUN_TOKENS.has(token))
      .filter(([token]) => (df.get(token) || 0) <= cfg.contentDfMax)
      .sort((a, b) => (b[1] - a[1]) || (b[0].length - a[0].length) || a[0].localeCompare(b[0]))
      .slice(0, cfg.maxAnchors)
      .map(([token]) => token);
    if (!anchors.length) continue; // 全是「晚安」「好的」，没有可指代的东西
    const turns = group.items.length;
    const idle = Math.max(0, now - group.lastAt);
    const score = (1 + Math.log2(1 + turns)) * Math.pow(0.5, idle / (30 * MIN_MS));
    frames.push({
      id: `ts-${group.lastAt}`,
      key: anchors[0],
      anchors,
      turns,
      startAt: group.startAt,
      lastAt: group.lastAt,
      recordIds: group.items.map((item) => item.record.id),
      score: Math.round(score * 1000) / 1000,
    });
  }

  return frames
    .sort((a, b) => b.score - a.score || b.lastAt - a.lastAt)
    .slice(0, cfg.maxDepth);
}

/**
 * 这句话是不是「只说了个指代，没有任何可检索内容」。
 *
 * 两道门：① 含指代词；② 所有 token 都是常见词。
 * 第二条不能写成「内容词 ≤1 个」——中文口语里「刚才说的那件事」也会切出一堆虚词 bigram，
 * 按个数算会被判成「有内容」，结果该补的不补。
 */
export function shouldExpand(query, records, options = {}) {
  const cfg = normalizeTopicStackConfig(options.config ?? {});
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  const q = String(query ?? '').replace(/\s+/g, ' ').trim();
  if (!q) return false;
  if (!hasPronoun(q)) return false;
  const tokens = recallTokens(q, 40).filter((token) => !PRONOUN_TOKENS.has(token));
  if (!tokens.length) return true; // 纯「那个呢？」，本来就该补
  const pool = (Array.isArray(records) ? records : []).filter((record) => usableRecord(record, cfg, now));
  for (const token of tokens) {
    let hits = 0;
    for (const record of pool) {
      if (haystackOf(record).includes(token)) {
        hits += 1;
        if (hits > cfg.contentDfMax) break;
      }
    }
    if (hits > 0 && hits <= cfg.contentDfMax) return false; // 有稀有词，这句话本身能检索
  }
  return true;
}

/**
 * 取栈顶话题的锚点词，空格拼接后前置。
 * 用空格隔开是防假 bigram：直接拼「热可可」「书」会切出「可书」这种不存在的词。
 */
export function expandQuery(query, frames, options = {}) {
  const cfg = normalizeTopicStackConfig(options.config ?? {});
  const q = String(query ?? '');
  const passthrough = { query: q, applied: false, key: '', anchors: [] };
  if (!cfg.enabled) return passthrough;
  if (!Array.isArray(frames) || !frames.length) return passthrough;
  const frame = frames.find((item) => item && item.anchors && item.anchors.length);
  if (!frame) return passthrough;
  const prefix = frame.anchors.join(' ').slice(0, cfg.maxExpandChars).trim();
  if (!prefix) return passthrough;
  return { query: `${prefix} ${q}`, applied: true, key: frame.key, anchors: frame.anchors.slice() };
}

/** 一步到位：判定 + 补全。调用方只需要这一个入口。 */
export function resolveTopicQuery(query, card, options = {}) {
  const cfg = normalizeTopicStackConfig(options.config ?? {});
  const passthrough = { query: String(query ?? ''), applied: false, key: '', anchors: [] };
  if (!cfg.enabled) return passthrough;
  const records = Array.isArray(card?.records) ? card.records : [];
  if (!records.length) return passthrough;
  if (!shouldExpand(query, records, { config: cfg, now: options.now })) return passthrough;
  const frames = Array.isArray(options.frames)
    ? options.frames
    : buildTopicStack(records, { config: cfg, now: options.now });
  return expandQuery(query, frames, { config: cfg });
}
