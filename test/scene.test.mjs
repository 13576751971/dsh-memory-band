import assert from 'node:assert/strict';
import test from 'node:test';

import { buildMemoryBlock } from '../src/assemble.js';
import { captureScenes } from '../src/scene.js';
import { cfgOf, cardOf, HOUR, MIN, NOW } from './helpers.mjs';

/** 一段真实的私聊：一问一答，夹着两句收尾。 */
function chat() {
  return cardOf([
    { text: '今天加班到九点才回来，好累', source: 'qq-owner', speaker: '主人', importance: 70, createdAt: NOW - 9 * HOUR },
    { text: '辛苦啦，先喝点热水', source: 'qq-self', isSelf: true, speaker: '她', importance: 30, createdAt: NOW - 9 * HOUR + 2 * MIN },
    { text: '我泡了面，还想着你说的那杯热可可', source: 'qq-owner', speaker: '主人', importance: 66, createdAt: NOW - 9 * HOUR + 4 * MIN },
    { text: '那你早点睡，别熬夜', source: 'qq-self', isSelf: true, speaker: '她', importance: 30, createdAt: NOW - 9 * HOUR + 6 * MIN },
  ]);
}

test('命中记忆后回放当时的对话，两边的话都在', () => {
  const block = buildMemoryBlock(chat(), { query: '昨晚我说什么了', platform: 'qq', config: cfgOf(), now: NOW });
  assert.match(block.text, /当时场景/);
  // 锚点自己那句话在摘要带里，场景里补的是前后邻居
  assert.match(block.text, /\[主人\].*泡了面/);
  assert.match(block.text, /\[她\].*热水/);
  assert.match(block.text, /\[她\].*早点睡/);
  assert.equal(block.hitScene, true);
});

test('场景按时间正序，读起来是对话不是倒放', () => {
  const block = buildMemoryBlock(chat(), { query: '昨晚我说什么了', platform: 'qq', config: cfgOf(), now: NOW });
  const scene = block.text.split('\n').filter((line) => line.startsWith('- ') && line.includes('[她]'));
  assert.ok(scene.length >= 2);
  const first = scene[0].match(/^-\s+(?:\d\d-\d\d )?(\d\d):(\d\d)/);
  const last = scene[scene.length - 1].match(/^-\s+(?:\d\d-\d\d )?(\d\d):(\d\d)/);
  assert.ok(Number(first[1]) * 60 + Number(first[2]) <= Number(last[1]) * 60 + Number(last[2]));
});

test('两条记忆命中同一段对话，只回放一次', () => {
  const block = buildMemoryBlock(chat(), { query: '加班 热可可', platform: 'qq', config: cfgOf(), now: NOW });
  const scenes = block.text.match(/当时场景/g) ?? [];
  assert.equal(scenes.length, 1, `实际回放了 ${scenes.length} 段`);
});

test('关掉场景后只留摘要', () => {
  const block = buildMemoryBlock(chat(), {
    query: '昨晚我说什么了', platform: 'qq',
    config: cfgOf({ scene: { enabled: false } }), now: NOW,
  });
  assert.doesNotMatch(block.text, /当时场景/);
  assert.match(block.text, /加班/);
});

test('抓取快照：只抓够重要、且邻居凑得齐的记录', () => {
  const card = chat();
  const captured = captureScenes(card, cfgOf({ scene: { captureWindow: 20 } }), NOW);
  assert.ok(captured >= 1, `实际抓到 ${captured} 条`);
  const withScene = card.records.filter((record) => record.sceneContext.length > 0);
  assert.ok(withScene.length >= 1);
  assert.ok(withScene[0].sceneContext.some((item) => item.text.includes('热水')));
});

test('没开抓取时一条都不写，读取时用邻居现算', () => {
  const card = chat();
  assert.equal(captureScenes(card, cfgOf(), NOW), 0);
  assert.ok(card.records.every((record) => record.sceneContext.length === 0));
  const block = buildMemoryBlock(card, { query: '昨晚我说什么了', platform: 'qq', config: cfgOf(), now: NOW });
  assert.match(block.text, /当时场景/);
});
