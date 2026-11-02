/**
 * 召回耗时。默认 1000 条记忆，可以传参改：
 *
 *   node bench/cost.mjs 3000
 *
 * 这条路径每轮对话都要走一次，所以看的是「单次调用多少毫秒」，
 * 不是吞吐量。超过 1ms 就该看看是不是把整张卡都扫了。
 */
import { buildMemoryBlock } from '../src/assemble.js';
import { addRecord, createCard } from '../src/card.js';
import { normalizeConfig } from '../src/config.js';

const NOW = Date.parse('2026-11-02T04:00:00+08:00');
const MIN = 60e3;
const count = Math.max(100, Number(process.argv[2]) || 1000);

const LINES = [
  '今天加班到九点才回来，泡了碗面，还想着你说的那杯热可可',
  '中午吃了番茄炒蛋，配了一杯冰美式，有点撑',
  '把那本旧小说念到第七章了，主角终于离开小镇',
  '楼下那只橘猫又来了，蹲在电动车上看我',
  '周末想去海边看日落，不知道会不会下雨',
  '今天有点累，什么都不想做，就想躺着',
  '把新写的笔记发出去了，配了九张图，有点紧张',
  '早上差点睡过头，闹钟响了三遍才起来',
];

function makeCard(n) {
  const card = createCard(NOW);
  for (let i = 0; i < n; i += 1) {
    const self = i % 3 === 1;
    addRecord(card, {
      text: `第 ${i} 条：${LINES[i % LINES.length]}`,
      source: self ? 'qq-self' : (i % 7 === 0 ? 'qq-group' : 'qq-owner'),
      isSelf: self,
      importance: i % 5 === 0 ? 75 : 52 + (i % 12),
      createdAt: NOW - i * 40 * MIN,
    }, {}, NOW);
  }
  return card;
}

const card = makeCard(count);
const cfg = normalizeConfig({});
const queries = [
  '你还记得我让你念的那本书吗',
  '今天好累啊',
  '在吗',
  '周末去海边吗',
  '那只橘猫还在吗',
  '中午吃了什么',
];

for (let i = 0; i < 5; i += 1) {
  for (const q of queries) buildMemoryBlock(card, { query: q, config: cfg, now: NOW });
}

const rounds = 40;
const t0 = process.hrtime.bigint();
let calls = 0;
for (let r = 0; r < rounds; r += 1) {
  for (const q of queries) {
    buildMemoryBlock(card, { query: q, config: cfg, now: NOW });
    calls += 1;
  }
}
const t1 = process.hrtime.bigint();

const perCall = Number(t1 - t0) / 1e6 / calls;
const sample = buildMemoryBlock(card, { query: queries[0], config: cfg, now: NOW });

console.log(`记忆条数      ${card.records.length}`);
console.log(`单次耗时      ${perCall.toFixed(3)} ms（${calls} 次调用的平均）`);
console.log(`单次注入      ${sample.chars} 字（保护带 ${sample.protection} 条 / 召回 ${sample.recall} 条 / 场景 ${sample.scenes} 段）`);
console.log(`整卡序列化    ${(JSON.stringify(card).length / 1024).toFixed(0)} KB`);
