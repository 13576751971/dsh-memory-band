import assert from 'node:assert/strict';
import test from 'node:test';

import { buildProtectionBand } from '../src/band.js';
import { cfgOf, cardOf, HOUR, MIN, NOW } from './helpers.mjs';

test('只收时间窗内、且过重要度门槛的记录', () => {
  const card = cardOf([
    { text: '今天加班到九点才回来，泡了碗面。', source: 'qq-owner', speaker: '主人', importance: 70, createdAt: NOW - 3 * HOUR },
    { text: '前天在楼下看到一只很胖的橘猫。', source: 'qq-owner', speaker: '主人', importance: 70, createdAt: NOW - 30 * HOUR },
    { text: '群里有人发了张表情包，笑了半天。', source: 'qq-group', speaker: '路人', importance: 30, createdAt: NOW - 2 * HOUR },
  ]);
  const band = buildProtectionBand(card, { cfg: cfgOf(), now: NOW });
  assert.equal(band.lines.length, 1);
  assert.match(band.text, /加班/);
  assert.doesNotMatch(band.text, /橘猫/);
  assert.doesNotMatch(band.text, /表情包/);
});

test('durable 的记录不看门槛：发帖、取名这类事忘了就是硬伤', () => {
  const card = cardOf([
    { text: '把新写的那篇笔记发出去了，配了九张图。', source: 'qq-self', isSelf: true, importance: 20, durable: true, createdAt: NOW - 6 * HOUR },
  ]);
  const band = buildProtectionBand(card, { cfg: cfgOf(), now: NOW });
  assert.equal(band.lines.length, 1);
  assert.match(band.text, /笔记/);
});

test('用户说过「别记了」的，不进带', () => {
  const card = cardOf([
    { text: '这件事以后别再提了，不重要。', source: 'qq-owner', importance: 90, deprecated: true, createdAt: NOW - 2 * HOUR },
  ]);
  const band = buildProtectionBand(card, { cfg: cfgOf(), now: NOW });
  assert.equal(band.lines.length, 0);
});

test('同一句话被记了两遍，只占一行', () => {
  const card = cardOf([
    { text: '说好周末去海边看日落。', source: 'qq-owner', importance: 80, createdAt: NOW - 5 * HOUR },
    { text: '说好周末去海边看日落。', source: 'qq-owner', importance: 80, createdAt: NOW - 4 * HOUR },
  ]);
  const band = buildProtectionBand(card, { cfg: cfgOf(), now: NOW });
  assert.equal(band.lines.length, 1);
});

test('预算按整条裁，不把最后一条截成半句', () => {
  const list = [];
  for (let i = 0; i < 20; i += 1) {
    list.push({
      text: `第 ${i} 条日常：今天下楼买了点东西，路上碰见邻居，聊了几句天气，然后就回家了。`,
      source: 'qq-owner',
      importance: 70,
      createdAt: NOW - (i + 1) * 10 * MIN,
    });
  }
  const card = cardOf(list);
  const band = buildProtectionBand(card, { cfg: cfgOf({ protectionBand: { bandChars: 300 } }), now: NOW });
  assert.ok(band.text.length <= 300, `实际 ${band.text.length} 字`);
  assert.ok(band.lines.length >= 1);
  for (const line of band.lines) assert.match(line, /。$/, `这一行被截断了：${line}`);
});

test('关掉开关时不出带', () => {
  const card = cardOf([
    { text: '今天加班到九点才回来，泡了碗面。', source: 'qq-owner', importance: 90, createdAt: NOW - HOUR },
  ]);
  const band = buildProtectionBand(card, { cfg: cfgOf({ protectionBand: { enabled: false } }), now: NOW });
  assert.equal(band.lines.length, 0);
  assert.equal(band.text, '');
});
