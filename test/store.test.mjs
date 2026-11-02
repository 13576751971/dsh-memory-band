import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { MemoryStore, autoImportance } from '../lib/store.js';

function tempStore(config = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memory-band-store-'));
  const store = new MemoryStore({ dataDir: dir, config });
  return { dir, store };
}

test('空卡时 bootBlock/recallBlock 都返回空串，不抛', () => {
  const { dir, store } = tempStore();
  try {
    assert.equal(store.bootBlock(), '');
    assert.equal(store.recallBlock('在吗'), '');
    assert.equal(store.stats().records, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('写入后能召回，且相关旧事优先于无关的最近记录', () => {
  const { dir, store } = tempStore();
  try {
    store.add('昨天主人说那本旧小说第七章一直没敢往下看', { importance: 80, createdAt: Date.now() - 2 * 3600_000 });
    store.add('上个月约好周末去海边看日出', { importance: 80, createdAt: Date.now() - 20 * 86400_000 });
    const boot = store.bootBlock();
    assert.match(boot, /旧小说/);
    assert.doesNotMatch(boot, /海边/);
    const recall = store.recallBlock('海边那次约的几点来着');
    assert.match(recall, /海边/);
    assert.doesNotMatch(recall, /旧小说/, '保护带里已有的不再重复召回');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('同一句话附近的重复写入只刷新 lastSeenAt，不涨条数', () => {
  const { dir, store } = tempStore();
  try {
    store.add('项目暗号是TEST-CODE-7F3A', { importance: 80 });
    store.add('项目暗号是TEST-CODE-7F3A', { importance: 80 });
    assert.equal(store.stats().records, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('自动重要度：约定/称呼类更高，寒暄更低', () => {
  assert.ok(autoImportance('记住，项目暗号是TEST-CODE-7F3A') > autoImportance('在吗'));
  assert.ok(autoImportance('在吗') < 55);
  assert.ok(autoImportance('今天加班到九点才回来') >= 55);
});

test('外部改卡后按 mtime 重新读取', () => {
  const { dir, store } = tempStore();
  const file = path.join(dir, 'memory-card.json');
  try {
    assert.equal(store.bootBlock(), '');
    fs.writeFileSync(file, JSON.stringify({
      version: 1,
      records: [{ text: '我在念一本旧小说，第七章没敢往下看', source: 'manual', importance: 72, createdAt: new Date().toISOString() }],
    }));
    assert.match(store.bootBlock(), /旧小说/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
