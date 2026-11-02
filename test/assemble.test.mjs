import assert from 'node:assert/strict';
import test from 'node:test';

import { buildMemoryBlock } from '../src/assemble.js';
import { cfgOf, cardOf, DAY, HOUR, MIN, NOW } from './helpers.mjs';

function mixedCard() {
  return cardOf([
    { text: '今天加班到九点才回来，好累', source: 'qq-owner', speaker: '主人', importance: 70, createdAt: NOW - 10 * HOUR },
    { text: '辛苦啦，先喝点热水', source: 'qq-self', isSelf: true, importance: 30, createdAt: NOW - 10 * HOUR + 2 * MIN },
    { text: '我想听你讲睡前故事，你不是说攒了好长一个吗', title: '和主人：睡前故事', source: 'qq-owner', importance: 45, createdAt: NOW - 5 * DAY },
    { text: '小狐狸把星星藏在枕头底下，说这样就不会做噩梦了', title: '和主人：小狐狸', source: 'qq-owner', importance: 60, createdAt: NOW - 5 * DAY + 3 * MIN },
    { text: '今天中午吃了番茄炒蛋，还喝了杯冰美式', title: '和主人：午饭', source: 'qq-owner', importance: 58, createdAt: NOW - 3 * DAY },
  ]);
}

test('保护带里的记忆不会在召回段里再出现一次', () => {
  const block = buildMemoryBlock(mixedCard(), { query: '加班 热可可', platform: 'qq', config: cfgOf(), now: NOW });
  const hits = block.text.split('加班到九点').length - 1;
  assert.equal(hits, 1, `同一条记忆出现了 ${hits} 次`);
});

test('召回只管更早的事：24 小时内已经进带的，不再占召回的额度', () => {
  const block = buildMemoryBlock(mixedCard(), { query: '睡前故事', platform: 'qq', config: cfgOf(), now: NOW });
  assert.equal(block.protection, 1);
  assert.ok(block.recall >= 1);
  assert.match(block.text, /睡前故事/);
});

test('三段都在时，顺序是 摘要带 → 场景 → 相关 → 页脚', () => {
  const block = buildMemoryBlock(mixedCard(), { query: '睡前故事 小狐狸', platform: 'qq', config: cfgOf(), now: NOW });
  const iBand = block.text.indexOf('## 最近 24 小时');
  const iTitle = block.text.indexOf('## 和刚才的话题相关');
  const iFooter = block.text.lastIndexOf('自然想起来就好');
  assert.ok(iBand > 0, '缺摘要带标题');
  assert.ok(iTitle > iBand, '相关段应在摘要带之后');
  assert.ok(iFooter > iTitle, '页脚应在最后');
});

test('B 站拿不到 QQ 的私聊记忆', () => {
  const card = cardOf([
    { text: '这是私聊里说的事，不该出现在公开场合', source: 'qq-owner', scope: 'qq', importance: 90, createdAt: NOW - HOUR },
  ]);
  const block = buildMemoryBlock(card, { query: '私聊 说的事', platform: 'bili', config: cfgOf(), now: NOW });
  assert.equal(block.text, '');
});

test('超过 14 天的旧事不会冒充「最近」', () => {
  const card = cardOf([
    { text: '很久以前说过要去海边看日落，一直没去成', source: 'qq-owner', importance: 60, createdAt: NOW - 40 * DAY },
  ]);
  const block = buildMemoryBlock(card, { query: '在吗', platform: 'qq', config: cfgOf(), now: NOW });
  assert.equal(block.text, '', '没有相关的、也没有近期的，就该空着让调用方回退');
});

test('场景总预算压得住：两段场景不会一起灌进来', () => {
  const card = mixedCard();
  const block = buildMemoryBlock(card, {
    query: '睡前故事 加班', platform: 'qq',
    config: cfgOf({ scene: { maxSceneChars: 120 } }), now: NOW,
  });
  assert.ok(block.sceneChars <= 120, `场景共 ${block.sceneChars} 字`);
});
