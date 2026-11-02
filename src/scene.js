import { normalizeSceneContext } from './card.js';
import { normalizeConfig } from './config.js';
import { platformVisible } from './band.js';
import { DAY_MS, clockOf, short, stampOf, timeOf } from './text.js';
import { clampInt } from './util.js';

/**
 * 场景只有「同一个场景」才算当时。隔了几小时的对话不是当时，是另一段生活。
 * 4 小时是量出来的：再放宽，深夜的收尾闲聊会被算进下午那件事的场景里。
 */
const SCENE_NEIGHBOR_MS = 4 * 3600e3;

/**
 * 取锚点前后各半的邻居（不含自己），场景回放和快照抓取共用。
 *
 * 一条记忆通常是一问一答（text + botReply），这里拆成两行——
 * 只回放对方说了什么、漏掉她怎么回的，读起来像旁听半场对话。
 */
function sceneNeighborItems(record, records, limit, anchorAt, { platform = 'qq', cfg } = {}) {
  const half = Math.max(1, Math.floor(limit / 2));
  const pool = [];
  for (const item of (Array.isArray(records) ? records : [])) {
    if (!item || item.id === record.id || item.sensitive || item.deprecated) continue;
    if (!platformVisible(item, platform, cfg)) continue;
    const text = String(item.text ?? '').trim();
    if (!text) continue;
    const at = timeOf(item.createdAt, 0);
    pool.push({ sender: item.isSelf ? '她' : (item.speaker || '某人'), text, at });
    const reply = String(item.botReply ?? '').trim();
    if (reply) pool.push({ sender: '她', text: reply, at: at + 1000 });
  }
  const near = pool.filter((item) => Math.abs(item.at - anchorAt) <= SCENE_NEIGHBOR_MS);
  const before = near.filter((item) => item.at < anchorAt).sort((a, b) => b.at - a.at).slice(0, half).reverse();
  const after = near.filter((item) => item.at > anchorAt).sort((a, b) => a.at - b.at).slice(0, half);
  return [...before, ...after];
}

/**
 * 写入侧的钩子：给近期、够重要的记录抓一份当时的前后对话，存进 sceneContext。
 *
 * 快照的意义是「邻居以后被压缩掉了，这段回忆还在」。没抓到的记录，
 * 读取时会用卡里现存的邻居兜底，所以这个函数是可选的——不跑也能用，只是老记忆的场景会变淡。
 */
export function captureScenes(card, config = {}, now = Date.now()) {
  const cfg = normalizeConfig(config);
  const limit = cfg.scene.captureWindow;
  if (!cfg.scene.enabled || limit <= 0) return 0;
  const records = Array.isArray(card?.records) ? card.records : [];
  if (!records.length) return 0;
  const freshCutoff = now - 7 * DAY_MS; // 只给最近 7 天抓；更早的走「读取时现算」
  let captured = 0;
  for (const record of records) {
    if ((record.sceneContext ?? []).length) continue;
    if (record.sensitive || record.deprecated) continue;
    if (record.scope === 'bili' || record.platform === 'bili') continue; // 视频记忆没有对话场景
    if (timeOf(record.createdAt, 0) < freshCutoff) continue;
    if (!record.durable && (Number(record.importance) || 0) < cfg.scene.captureMinImportance) continue;
    const anchorAt = timeOf(record.createdAt, now) || now;
    const neighbors = sceneNeighborItems(record, records, limit, anchorAt, { platform: 'qq', cfg });
    if (neighbors.length < 2) continue; // 凑不出邻居就不落盘，留给读取时兜底
    record.sceneContext = normalizeSceneContext(neighbors.map((item) => ({
      sender: item.sender,
      text: item.text.slice(0, 120),
      at: item.at,
    })));
    captured += 1;
  }
  return captured;
}

/**
 * 第二段：命中记忆后，回放「当时」的前后对话。
 *
 * 先吃 sceneContext 快照；不够就用卡里同平台的邻居补齐。
 * 两条路都走的记录，按「1 分钟内 + 同样文字」去重——
 * 同一条消息既可能被存进快照，又可能刚好是邻居。
 */
export function readSceneContext(record, { card, cfg, now = Date.now(), maxMessages = 20, platform = 'qq' } = {}) {
  if (!record) return '';
  const limit = clampInt(maxMessages, 20, 2, 60);
  const anchorAt = timeOf(record.createdAt, now) || now;
  const items = [];
  const push = (sender, text, at) => {
    const body = String(text ?? '').replace(/\s+/g, ' ').trim();
    if (!body) return;
    const when = Number(at) > 0 ? Number(at) : anchorAt;
    if (items.some((item) => Math.abs(item.at - when) < 60_000 && item.text === body)) return;
    items.push({ sender: short(String(sender ?? ''), 24) || '某人', text: body.slice(0, 160), at: when });
  };
  for (const entry of (Array.isArray(record.sceneContext) ? record.sceneContext : [])) {
    push(entry.sender, entry.text, entry.at);
  }
  if (items.length < limit) {
    for (const item of sceneNeighborItems(record, card?.records, limit, anchorAt, { platform, cfg })) {
      if (items.length >= limit) break;
      push(item.sender, item.text, item.at);
    }
  }
  if (!items.length) return '';
  items.sort((a, b) => a.at - b.at);
  const kept = items.length > limit ? items.slice(0, limit) : items;
  const anchorDay = new Date(anchorAt).toDateString();
  const lines = kept.map((item) => {
    const day = new Date(item.at).toDateString() === anchorDay ? '' : `${stampOf(item.at).slice(0, 5)} `;
    return `- ${day}${clockOf(item.at)} [${item.sender}] ${short(item.text, 72)}`;
  });
  return [cfg.prompt.sceneHeader.replace('{time}', stampOf(anchorAt)), ...lines].join('\n');
}

/** 场景总闸。保护带关着的时候场景没有锚点，所以它跟着一起关。 */
export function scenePlan(cfg) {
  return {
    on: cfg.protectionBand.enabled === true
      && cfg.scene.enabled === true
      && cfg.scene.maxScenesPerCall > 0
      && cfg.scene.maxSceneChars > 0,
    maxScenes: cfg.scene.maxScenesPerCall,
    maxChars: cfg.scene.maxSceneChars,
  };
}
