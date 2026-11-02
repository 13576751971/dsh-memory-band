import {
  CLARITY_LABEL, DAY_MS, dateOnly, fingerprint, keyCharsOf, recallTokens, redact, short,
  stampOf, summarizeText, textTokens, timeOf,
} from './text.js';
import { clampInt } from './util.js';

/** 能进提示词吗。敏感、用户说过别记、只剩印象，一律不进。 */
export function promptableRecord(record) {
  if (!record) return false;
  if (record.sensitive || record.deprecated) return false;
  if (record.clarity === 'trace' || record.clarity === 'forgotten') return false;
  return Boolean(String(record.text || record.title || '').trim());
}

/** 平台可见性。B 站那边默认拿不到 QQ 的记忆，两个受众不该共享同一段私聊。 */
export function platformVisible(record, platform, cfg) {
  if (platform !== 'bili') return true;
  if (record.scope === 'bili' || record.scope === 'shared') return true;
  return cfg.includeQqInBili === true && record.scope === 'qq';
}

/** 一条记忆压成一行。正文按预算截，截之前先脱敏。 */
function recallLine(record, maxBody) {
  const scope = record.scope === 'bili' ? 'bili' : 'qq';
  const body = redact(record.text || record.title, { scope, maxChars: maxBody + 60 });
  const tag = CLARITY_LABEL[record.clarity] ?? '清楚';
  return `- ${dateOnly(record.createdAt)} [${tag}] ${short(body, maxBody)}`;
}

/** 「这事跟什么有关」：标题和正文的头两个 bigram。用来给每个话题留一个槽位。 */
function topicKeyOf(record) {
  const tokens = textTokens(`${record.title ?? ''} ${record.text ?? ''}`, 8);
  return tokens.slice(0, 2).join('|') || String(record.kind ?? '');
}

/** 和已选中的任意一条 bigram 重合 ≥70%，就当成同一件事。 */
function nearDuplicate(tokens, acceptedSets) {
  if (tokens.length < 4) return false;
  for (const set of acceptedSets) {
    let hit = 0;
    for (const token of tokens) if (set.has(token)) hit += 1;
    if (hit / tokens.length >= 0.7) return true;
  }
  return false;
}

/** 保护带的一行：`- MM-DD HH:mm 摘要`。 */
function protectionLine(record, limit = 100) {
  const body = String(record.summary || '').trim() || summarizeText(record.text || record.title, limit);
  if (!body) return '';
  return `- ${stampOf(record.createdAt)} ${short(body, limit)}`;
}

/**
 * 第一段：时间窗内的常驻摘要带。
 *
 * 排序是「durable 加权 > 重要度 > 时间」，先按话题各取一条再补齐，
 * 最后用自己的预算裁。裁的时候不把最后一条截成半句——半句比没有更难受。
 */
export function buildProtectionBand(card, { platform = 'qq', cfg, now = Date.now() } = {}) {
  const band = cfg.protectionBand;
  const empty = { records: [], lines: [], text: '' };
  if (!band || !band.enabled) return empty;
  const cutoff = now - band.windowHours * 3600e3;
  // durable 给 +10 的排序加权，但不绝对压过主人刚说的话。
  const rank = (record) => (Number(record.importance) || 0) + (record.durable ? 10 : 0);
  const candidates = (Array.isArray(card?.records) ? card.records : [])
    .filter(promptableRecord)
    .filter((record) => platformVisible(record, platform, cfg))
    .filter((record) => timeOf(record.createdAt, 0) >= cutoff)
    .filter((record) => record.durable === true || (Number(record.importance) || 0) >= band.bandImportanceMin)
    .sort((a, b) => (rank(b) - rank(a)) || (timeOf(b.createdAt, 0) - timeOf(a.createdAt, 0)));
  if (!candidates.length) return empty;

  const ordered = [];
  if (band.diversity) {
    const seenTopics = new Set();
    const rest = [];
    for (const record of candidates) {
      const topic = topicKeyOf(record);
      if (topic && !seenTopics.has(topic)) {
        seenTopics.add(topic);
        ordered.push(record);
      } else rest.push(record);
    }
    ordered.push(...rest);
  } else ordered.push(...candidates);

  const records = [];
  const lines = [];
  const tokenSets = [];
  const prints = new Set();
  let chars = 0;
  for (const record of ordered) {
    if (records.length >= 40) break; // 条数硬顶，是 bandChars 之外的第二道闸
    // 「晚安」「在吗」这种碎句单独占一行没信息量；durable 和置顶的例外。
    if (!record.durable && !record.pinned && String(record.text ?? '').trim().length < 6) continue;
    const line = protectionLine(record, band.bandEntryCap);
    if (!line) continue;
    const print = fingerprint(record.text);
    if (band.dedup) {
      if (print && prints.has(print)) continue;
      const tokens = textTokens(`${record.title ?? ''} ${record.text ?? ''}`, 24);
      if (nearDuplicate(tokens, tokenSets)) continue;
      tokenSets.push(new Set(tokens));
    }
    if (lines.length && chars + line.length + 1 > band.bandChars) break;
    if (print) prints.add(print);
    lines.push(line);
    records.push(record);
    chars += line.length + 1;
  }
  return { records, lines, text: lines.join('\n') };
}

/**
 * 第二段：按当前这句话召回的带。
 *
 * 结构是「保底锚点 2 条 + 词命中的几条 + 最近的 1~3 条」。
 * 配额随命中数变化：命中越多，兜底的越少，总条数基本稳定，
 * 这样「在吗」不会白占预算，「念书那事」也不会只剩兜底。
 */
export function buildRecallSection(card, {
  query: rawQuery, platform = 'qq', maxChars, cfg, now = Date.now(),
  skipIds = new Set(), skipFingerprints = [],
} = {}) {
  const empty = { lines: [], records: [], topHit: null, text: '', budget: maxChars ?? 0 };
  const q = String(rawQuery ?? '').replace(/\s+/g, ' ').trim().slice(0, 400);
  if (!q) return empty;
  const budget = clampInt(maxChars, cfg.injectMaxChars[platform], 200, 4000);
  const records = (Array.isArray(card?.records) ? card.records : [])
    .filter((record) => promptableRecord(record))
    .filter((record) => !skipIds.has(record.id))
    .filter((record) => platformVisible(record, platform, cfg));
  if (!records.length) return { ...empty, budget };

  const byTime = (a, b) => timeOf(b.createdAt, 0) - timeOf(a.createdAt, 0);
  const tokens = recallTokens(q);
  const keyChars = keyCharsOf(q);
  const picked = [];
  const pickedRecords = [];
  const used = new Set();
  // 保护带里已经出现过的话，召回不再重复占一行（同一句话常被记成两条不同 id）。
  const seenFp = new Set(skipFingerprints);
  let topHit = null;
  const take = (record, maxBody = 56) => {
    if (!record || used.has(record.id)) return false;
    const fp = fingerprint(record.text);
    if (fp && seenFp.has(fp)) return false;
    used.add(record.id);
    if (fp) seenFp.add(fp);
    picked.push(recallLine(record, maxBody));
    pickedRecords.push(record);
    return true;
  };

  // 1) 保底：初次相遇压到 30 字，一条置顶压到 34 字。这两条是根基，再省也得留。
  take(records.filter((r) => r.firstMet).sort(byTime)[0], 30);
  take(records.filter((r) => r.pinned && !r.firstMet)
    .sort((a, b) => (b.importance - a.importance) || byTime(a, b))[0], 34);

  // 2) 打分：词命中 > 新鲜 > 重要度，清晰度只做小幅加成。
  const scored = [];
  for (const record of records) {
    if (used.has(record.id)) continue;
    const text = String(record.text || '');
    const title = String(record.title || '');
    let s = 0;
    let hit = 0;
    for (const t of tokens) {
      if (title.includes(t)) { s += 5; hit += 1; } else if (text.includes(t)) { s += 2; hit += 1; }
    }
    // bigram 桥不过去的地方，靠话题性单字补一手，命中一个就够。
    for (const ch of keyChars) {
      if (text.includes(ch)) { s += 3; hit += 1; break; }
    }
    if (hit >= 2) s += 3;
    const days = (now - timeOf(record.createdAt, 0)) / DAY_MS;
    if (days <= 2) s += 8;
    else if (days <= 7) s += 4;
    else if (days <= 30) s += 1;
    s += Math.min(6, (Number(record.importance) || 0) / 12);
    if (record.clarity === 'vivid') s += 2;
    // 碎句会被反复记录、又很新，光靠新鲜度就能挤掉有内容的条目。
    if (!hit && text.length < 12) s -= 8;
    // 内容量只在有命中时给分：无关的长条目不该靠长度挤进来。
    if (hit && text.length >= 120) s += 4;
    else if (hit && text.length >= 60) s += 2;
    scored.push({ record, s, hit });
  }
  scored.sort((a, b) => b.s - a.s || byTime(a.record, b.record));

  // 3) 给几条只看「词命中数」，不看总分。新鲜度再高也不等于相关。
  const bestHit = scored.reduce((m, x) => Math.max(m, x.hit), 0);
  const baseQuota = bestHit >= 3 ? 4 : bestHit >= 2 ? 3 : bestHit >= 1 ? 2 : 0;
  const bandCfg = cfg.recallBand ?? {};
  const configuredTopK = clampInt(bandCfg.recallTopK, 0, 0, 12);
  const relevantQuota = configuredTopK > 0 ? Math.min(baseQuota || configuredTopK, configuredTopK) : baseQuota;
  const impFloor = clampInt(bandCfg.impFloor, 0, 0, 100);
  let relevant = 0;
  for (const { record, hit } of scored) {
    if (configuredTopK > 0 ? relevant >= relevantQuota : picked.length >= 2 + relevantQuota) break;
    // 新鲜度可以让一条无关记录排在命中记录前面；跳过它，别让 break
    // 把后面真正命中的旧事一起挡掉。
    if (!hit) continue;
    if (impFloor > 0 && (Number(record.importance) || 0) < impFloor) continue;
    if (take(record, bestHit >= 2 ? 64 : 56)) {
      relevant += 1;
      if (!topHit) topHit = record;
    }
  }

  // 4) 兜底：最近的 1~3 条，防止「聊到一半前后不接」。
  const recentQuota = bestHit >= 3 ? 1 : bestHit >= 1 ? 2 : 3;
  const freshCutoff = now - 14 * DAY_MS;
  const recentOrder = records
    .filter((r) => timeOf(r.createdAt, 0) >= freshCutoff)
    .sort((a, b) => {
      const la = String(a.text || '').length >= 12 ? 0 : 1;
      const lb = String(b.text || '').length >= 12 ? 0 : 1;
      return (la - lb) || byTime(a, b);
    });
  let got = 0;
  for (const record of recentOrder) {
    if (got >= recentQuota) break;
    // 兜底也要过地板。群聊和碎句最容易从「最近」这条路混进来，
    // 而它们恰恰是最没用的那种最近——地板上设 0 时行为与改造前一致。
    if (impFloor > 0 && (Number(record.importance) || 0) < impFloor) continue;
    if (take(record, 52)) got += 1;
  }

  if (!picked.length) return { ...empty, budget };
  // 超预算从尾部丢（尾部是最不相关的「最近」），锚点不动。
  const lines = picked.slice();
  const recordsOut = pickedRecords.slice();
  const assemble = () => [cfg.prompt.header, ...lines, cfg.prompt.footer].join('\n');
  let out = assemble();
  while (out.length > budget && lines.length > 2) {
    lines.pop();
    recordsOut.pop();
    out = assemble();
  }
  if (out.length > budget) out = `${out.slice(0, Math.max(0, budget - 1))}…`;
  return { lines, records: recordsOut, topHit, text: out, budget };
}
