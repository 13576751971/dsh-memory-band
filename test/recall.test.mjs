import assert from 'node:assert/strict';
import test from 'node:test';

import { buildRecallSection } from '../src/band.js';
import { recallMemoryBlock } from '../src/assemble.js';
import { cfgOf, cardOf, DAY, NOW } from './helpers.mjs';

// 完全退回改造前：保护带和场景都关，重要度地板也归 0（否则群聊低分记录会被挡掉）
const OFF = { protectionBand: { enabled: false }, scene: { enabled: false }, recallBand: { impFloor: 0 } };

function storyCard() {
  return cardOf([
    { text: '我想听你讲睡前故事，你不是说攒了好长一个吗', title: '和主人：睡前故事', source: 'qq-owner', importance: 45, createdAt: NOW - 3 * DAY },
    { text: '小狐狸把星星藏在枕头底下，说这样就不会做噩梦了', title: '和主人：小狐狸', source: 'qq-owner', importance: 60, createdAt: NOW - 3 * DAY + 5 * 60000 },
    { text: '今天中午吃了番茄炒蛋，还喝了杯冰美式', title: '和主人：午饭', source: 'qq-owner', importance: 58, createdAt: NOW - 2 * DAY },
  ]);
}

test('按话题召回：相关的那条排在兜底之前', () => {
  const card = storyCard();
  const block = buildRecallSection(card, { query: '我还想听你讲睡前故事', platform: 'qq', cfg: cfgOf(), now: NOW });
  const iStory = block.text.indexOf('睡前故事');
  const iLunch = block.text.indexOf('番茄炒蛋');
  assert.ok(iStory > 0, '没召回睡前故事');
  // 「最近 1~2 条」是兜底，允许出现，但必须排在相关条目后面
  if (iLunch >= 0) assert.ok(iStory < iLunch, '兜底条目排到了相关条目前面');
});

test('没有 query、又没开保护带时返回空串，调用方回退到预渲染块', () => {
  const card = storyCard();
  assert.equal(recallMemoryBlock(card, { query: '', platform: 'qq', config: OFF, now: NOW }), '');
});

test('关掉新机制后，输出退回老样子：没有分段标题、没有空行分段', () => {
  const card = storyCard();
  const out = recallMemoryBlock(card, { query: '睡前故事', platform: 'qq', config: OFF, now: NOW });
  assert.ok(out.length > 0);
  assert.doesNotMatch(out, /## 最近/);
  assert.ok(out.startsWith('【记忆卡'));
  assert.ok(!/\n\n/.test(out.split('\n').slice(1, -1).join('\n')), '老格式是单换行，不该出现空行');
});

test('零命中的问句不硬凑相关条目，只给最近几条', () => {
  const card = storyCard();
  const block = buildRecallSection(card, { query: '在吗', platform: 'qq', cfg: cfgOf(), now: NOW });
  assert.ok(block.lines.length >= 1, '至少要给一条，别让对话断层');
  assert.ok(block.lines.length <= 4, `实际 ${block.lines.length} 条`);
});

test('重要度地板把群聊噪声挡在外面', () => {
  const card = cardOf([
    { text: '加班到九点才回来，泡了碗面', source: 'qq-owner', importance: 68, createdAt: NOW - 2 * 3600e3 },
    // 20 天前的群聊，靠「最近」兜底也够不着，只能从相关性这条路上来
    { text: '群里聊到加班这事，说得挺夸张的', source: 'qq-group', importance: 22, createdAt: NOW - 20 * DAY },
  ]);
  const cfg = cfgOf({ ...OFF, recallBand: { impFloor: 45, recallTopK: 3 } });
  const block = buildRecallSection(card, { query: '今天加班累不累', platform: 'qq', cfg, now: NOW });
  assert.match(block.text, /泡了碗面/);
  assert.doesNotMatch(block.text, /说得挺夸张/);
});
