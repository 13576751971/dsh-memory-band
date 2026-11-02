/**
 * 一个能直接跑的对照：
 *   同一张记忆卡、同一句问话，关掉三段式和打开三段式，注入块差在哪。
 *
 *   node examples/demo.mjs
 */
import { buildMemoryBlock } from '../src/assemble.js';
import { addRecord, createCard } from '../src/card.js';
import { normalizeConfig } from '../src/config.js';

const MIN = 60e3;
const HOUR = 60 * MIN;
// 固定「现在」，让输出可复现；实际使用时传 Date.now() 即可。
const NOW = Date.parse('2026-11-02T04:00:00+08:00');

function sampleCard() {
  const card = createCard(NOW);
  const add = (item) => addRecord(card, item, {}, NOW);

  // 三天前：一本书，没念完
  add({ text: '我最近在念一本很旧的小说，第七章一直没敢往下看', title: '和主人：那本旧小说', source: 'qq-owner', speaker: '主人', importance: 72, createdAt: NOW - 3 * 24 * HOUR });
  add({ text: '那我陪你一起念，念到第七章就停下来', source: 'qq-self', isSelf: true, importance: 62, createdAt: NOW - 3 * 24 * HOUR + 2 * MIN });

  // 昨天 19:00：加班、泡面
  add({ text: '今天加班到九点才回来，泡了碗面', source: 'qq-owner', speaker: '主人', importance: 70, createdAt: NOW - 9 * HOUR });
  add({ text: '辛苦啦，先喝点热水，面别放太久', source: 'qq-self', isSelf: true, importance: 30, createdAt: NOW - 9 * HOUR + 2 * MIN });
  add({ text: '还想着你说的那杯热可可，明天买', source: 'qq-owner', speaker: '主人', importance: 66, createdAt: NOW - 9 * HOUR + 4 * MIN });

  // 昨天深夜：发了一篇笔记（durable，忘了就是硬伤）
  add({ text: '把新写的那篇笔记发出去了，配了九张图', source: 'qq-self', isSelf: true, importance: 50, durable: true, createdAt: NOW - 4 * HOUR });

  // 今天凌晨：晚安
  add({ text: '晚安，明天想早点起', source: 'qq-owner', speaker: '主人', importance: 58, createdAt: NOW - 40 * MIN });

  // 群里的噪声，不该出现在私聊的注入块里
  add({ text: '群里有人发了张表情包，笑了半天', source: 'qq-group', kind: 'group', speaker: '路人', importance: 20, createdAt: NOW - 3 * HOUR });

  return card;
}

const card = sampleCard();
const query = '你还记得我昨天说的那本书吗';

const off = normalizeConfig({ protectionBand: { enabled: false }, scene: { enabled: false } });
const on = normalizeConfig({});

const before = buildMemoryBlock(card, { query, config: off, now: NOW });
const after = buildMemoryBlock(card, { query, config: on, now: NOW });

console.log(`问：${query}`);
console.log(`\n----- 关掉三段式（改造前的行为）${before.chars} 字 -----\n`);
console.log(before.text);

console.log(`\n----- 打开三段式 ${after.chars} 字 -----\n`);
console.log(after.text);

console.log('\n----- 统计 -----');
const rows = [
  ['保护带条数', before.protection, after.protection],
  ['召回条数', before.recall, after.recall],
  ['场景段数', before.scenes, after.scenes],
  ['场景字数', before.sceneChars, after.sceneChars],
  ['总字数', before.chars, after.chars],
];
for (const [name, a, b] of rows) {
  console.log(`${name.padEnd(6, '　')}  改造前 ${String(a).padStart(4)}    改造后 ${String(b).padStart(4)}`);
}
