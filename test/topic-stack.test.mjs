import assert from 'node:assert/strict';
import test from 'node:test';

import { buildTopicStack, resolveTopicQuery } from '../src/topic-stack.js';
import { cfgOf, cardOf, MIN, NOW } from './helpers.mjs';

const ON = { enabled: true };

function storyCard() {
  return cardOf([
    { text: '我想听你讲睡前故事，你不是说攒了好长一个吗', source: 'qq-owner', importance: 45, createdAt: NOW - 70 * MIN },
    { text: '好呀，那我讲一个小狐狸攒星星的故事', source: 'qq-self', isSelf: true, importance: 30, createdAt: NOW - 68 * MIN },
    { text: '小狐狸把星星藏在枕头底下，说这样就不做噩梦了', source: 'qq-owner', importance: 30, createdAt: NOW - 66 * MIN },
    { text: '那后来它睡着了吗', source: 'qq-owner', importance: 25, createdAt: NOW - 64 * MIN },
    { text: '睡了呀，星星陪着它呢', source: 'qq-self', isSelf: true, importance: 20, createdAt: NOW - 62 * MIN },
  ]);
}

test('关闭时原样返回，调用方拿到的 query 一个字符都不差', () => {
  const card = storyCard();
  const result = resolveTopicQuery('那件事你还记得吗', card, { config: cfgOf({}), now: NOW });
  assert.equal(result.applied, false);
  assert.equal(result.query, '那件事你还记得吗');
});

test('建栈：按会话聚成一帧，锚点落在反复出现的词上', () => {
  const frames = buildTopicStack(storyCard().records, { config: { ...ON }, now: NOW });
  assert.equal(frames.length, 1);
  assert.ok(frames[0].anchors.length >= 1);
  assert.ok(
    frames[0].anchors.some((anchor) => ['小狐', '狐狸', '星星', '故事'].includes(anchor)),
    `锚点是 ${frames[0].anchors.join('/')}`,
  );
  assert.equal(frames[0].turns, 5);
});

test('指代问句补上话题词，补全只加前缀、不改原句', () => {
  const card = storyCard();
  const result = resolveTopicQuery('那件事你还记得吗', card, { config: ON, now: NOW });
  assert.equal(result.applied, true);
  assert.ok(result.query.endsWith('那件事你还记得吗'));
  assert.ok(result.query.length > '那件事你还记得吗'.length);
});

test('本来就能检索的问句不补：它自己带着稀有词', () => {
  const card = storyCard();
  const result = resolveTopicQuery('小狐狸后来怎么样了', card, { config: ON, now: NOW });
  assert.equal(result.applied, false);
  assert.equal(result.query, '小狐狸后来怎么样了');
});

test('没有指代词的问句，一律不补', () => {
  const card = storyCard();
  const result = resolveTopicQuery('今天中午吃什么', card, { config: ON, now: NOW });
  assert.equal(result.applied, false);
});

test('窗口外的旧话题不进栈', () => {
  const card = cardOf([
    { text: '小狐狸把星星藏在枕头底下', source: 'qq-owner', importance: 60, createdAt: NOW - 20 * 60 * MIN },
    { text: '星星陪着它呢', source: 'qq-self', isSelf: true, importance: 30, createdAt: NOW - 19 * 60 * MIN },
  ]);
  const frames = buildTopicStack(card.records, { config: { ...ON }, now: NOW });
  assert.equal(frames.length, 0);
});
