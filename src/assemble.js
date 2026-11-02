import { buildProtectionBand, buildRecallSection } from './band.js';
import { normalizeConfig } from './config.js';
import { readSceneContext, scenePlan } from './scene.js';
import { fingerprint, timeOf } from './text.js';
import { clampInt } from './util.js';

/**
 * 第三段：组装。
 *
 * 顺序是 保护带 → 保护带场景 → 召回带 → 召回带场景 → 页脚。
 * 场景安排在这种位置是有原因的：先看到「昨天她说了什么」，再看到「当时在聊什么」，
 * 模型读起来是一条线；反过来先看场景，摘要就成了补丁。
 *
 * 两重护栏：段数 ≤ maxScenesPerCall，场景总字数 ≤ maxSceneChars。
 * 超了先丢最早的那段——保护带场景通常更早，先丢它，留下更贴近当下话题的那段。
 */
export function buildMemoryBlock(card, options = {}) {
  const platform = options.platform === 'bili' ? 'bili' : 'qq';
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  const cfg = normalizeConfig(options.config ?? {});
  const query = String(options.query ?? '').replace(/\s+/g, ' ').trim().slice(0, 400);
  const budget = clampInt(options.maxChars, cfg.injectMaxChars[platform], 200, 4000);
  const s7 = cfg.protectionBand.enabled === true;
  const empty = { text: '', protection: 0, recall: 0, scenes: 0, sceneChars: 0, chars: 0, hitScene: false };

  // 没有 query、也没开保护带 → 空串。调用方据此回退到预渲染的静态块（老行为）。
  if (!query && !s7) return empty;

  const protection = s7
    ? buildProtectionBand(card, { platform, cfg, now })
    : { records: [], lines: [], text: '' };
  const skip = new Set(protection.records.map((record) => record.id));
  // 同一句话可能被不同来源写了两遍（id 不同），按文本指纹再挡一次。
  const skipFp = [...new Set(protection.records.map((record) => fingerprint(record.text)).filter(Boolean))];
  const recall = (query && cfg.recallBand.enabled !== false)
    ? buildRecallSection(card, { query, platform, maxChars: budget, cfg, now, skipIds: skip, skipFingerprints: skipFp })
    : { lines: [], records: [], topHit: null, text: '', budget };
  if (!protection.lines.length && !recall.lines.length) return empty;

  const plan = scenePlan(cfg);
  const scenes = [];
  const seenSceneLines = new Set();
  if (plan.on) {
    const add = (record, bandCfg, kind) => {
      if (!record || scenes.length >= plan.maxScenes) return false;
      const text = readSceneContext(record, {
        card, cfg, now, platform, maxMessages: bandCfg.sceneMessages,
      });
      if (!text) return false;
      const lines = text.split('\n').slice(1).filter(Boolean);
      // 一行不叫场景，那只是在重复上面已经列过的摘要。
      if (lines.length < 2) return false;
      // 两条记忆命中同一段对话时只回放一次，重合 ≥50% 就当它已经在场了。
      if (lines.filter((line) => seenSceneLines.has(line)).length / lines.length >= 0.5) return false;
      for (const line of lines) seenSceneLines.add(line);
      scenes.push({ kind, at: timeOf(record.createdAt, now), text });
      return true;
    };
    // 保护带里最靠前的常常是「她发了一篇笔记」这种没有对话的记录，
    // 所以往下多试几条（最多 5 条，不然一轮会把整条带扫一遍）。
    if (cfg.protectionBand.sceneEnabled && cfg.protectionBand.sceneTopK > 0) {
      let got = 0;
      for (const record of protection.records.slice(0, 5)) {
        if (got >= cfg.protectionBand.sceneTopK) break;
        if (add(record, cfg.protectionBand, 'prot')) got += 1;
      }
    }
    if (cfg.recallBand.sceneEnabled && cfg.recallBand.sceneTopK > 0) {
      const candidates = [];
      for (const record of [recall.topHit, ...recall.records]) {
        if (record && !candidates.some((item) => item.id === record.id)) candidates.push(record);
      }
      let got = 0;
      for (const record of candidates) {
        if (got >= cfg.recallBand.sceneTopK) break;
        // 初次相遇和置顶有自己的一行摘要，再给它配场景纯属浪费预算。
        if (record.firstMet || record.pinned) continue;
        if (add(record, cfg.recallBand, 'recall')) got += 1;
      }
    }
  }

  const kept = scenes.slice(0, plan.maxScenes);
  while (kept.length && kept.reduce((sum, scene) => sum + scene.text.length + 2, 0) > plan.maxChars) {
    let oldest = 0;
    for (let i = 1; i < kept.length; i += 1) if (kept[i].at < kept[oldest].at) oldest = i;
    kept.splice(oldest, 1);
  }

  // 没有保护带、也没有场景（= 关掉新机制）→ 原样返回召回块，和改造前逐字节一致。
  if (!protection.lines.length && !kept.length) {
    return { ...empty, text: recall.text, recall: recall.lines.length, chars: recall.text.length };
  }

  const header = recall.lines.length ? cfg.prompt.header : cfg.prompt.bandHeader;
  const parts = [header];
  if (protection.lines.length) {
    const title = cfg.prompt.bandTitle.replace('{hours}', String(cfg.protectionBand.windowHours));
    parts.push(`${title}\n${protection.lines.join('\n')}`);
  }
  for (const scene of kept.filter((item) => item.kind === 'prot')) parts.push(scene.text);
  if (recall.lines.length) {
    const label = s7 ? `${cfg.prompt.recallTitle}\n` : '';
    parts.push(`${label}${recall.lines.join('\n')}`);
  }
  for (const scene of kept.filter((item) => item.kind === 'recall')) parts.push(scene.text);
  parts.push(cfg.prompt.footer);
  const text = parts.join('\n\n');
  return {
    text,
    protection: protection.lines.length,
    recall: recall.lines.length,
    scenes: kept.length,
    sceneChars: kept.reduce((sum, scene) => sum + scene.text.length, 0),
    chars: text.length,
    hitScene: kept.length > 0,
  };
}

/**
 * 上层唯一要调的入口：按当前这句话生成注入块。
 *
 * 返回字符串，因为调用方只想知道「往提示词里贴什么」。
 * 想看统计就传 onStats，它拿到的是 buildMemoryBlock 的完整结果。
 * query 为空且没开保护带时返回 ''，调用方回退到预渲染块。
 */
export function recallMemoryBlock(card, options = {}) {
  const result = buildMemoryBlock(card, options);
  if (typeof options.onStats === 'function') {
    try { options.onStats(result); } catch { /* 打点坏了不能影响回复 */ }
  }
  return result.text;
}
