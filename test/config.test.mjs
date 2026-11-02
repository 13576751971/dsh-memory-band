import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeConfig } from '../src/config.js';
import { normalizeRecord } from '../src/card.js';
import { summarizeText } from '../src/text.js';
import { NOW } from './helpers.mjs';

test('配置里的坏值回落到默认，不会把 NaN 带进引擎', () => {
  const cfg = normalizeConfig({
    injectMaxChars: { qq: 'abc', bili: -5 },
    protectionBand: { windowHours: NaN, bandChars: -1, bandImportanceMin: 999 },
    recallBand: { recallTopK: 99 },
    scene: { maxScenesPerCall: 'x' },
  });
  assert.equal(cfg.injectMaxChars.qq, 600);
  assert.equal(cfg.injectMaxChars.bili, 100, '负数落到下限，不该是 400 或负数');
  assert.equal(cfg.protectionBand.windowHours, 24);
  assert.equal(cfg.protectionBand.bandChars, 0);
  assert.equal(cfg.protectionBand.bandImportanceMin, 100);
  assert.equal(cfg.recallBand.recallTopK, 12);
  assert.equal(cfg.scene.maxScenesPerCall, 2);
});

test('带命名空间的配置也能读：{ memoryCard: {...} }', () => {
  const cfg = normalizeConfig({ memoryCard: { protectionBand: { windowHours: 12 } } });
  assert.equal(cfg.protectionBand.windowHours, 12);
});

test('规范化后的配置再规范化一次，结果不变', () => {
  const once = normalizeConfig({ protectionBand: { bandChars: 900 } });
  const twice = normalizeConfig(once);
  assert.deepEqual(twice, once);
});

test('摘要优先在标点处收尾，不做硬截断', () => {
  const text = '今天加班到九点才回来，泡了碗面，还想着你说的那杯热可可。明天想早点睡，不想再熬夜了。';
  const out = summarizeText(text, 40);
  assert.ok(out.length <= 40);
  assert.match(out, /[。，]$/);
});

test('缺字段的记录也能读，坏值给安全默认', () => {
  const record = normalizeRecord({ text: '只有正文的一条记忆', createdAt: NOW });
  assert.ok(record);
  assert.equal(record.scope, 'qq');
  assert.equal(record.clarity, 'clear');
  assert.equal(record.importance, 30);
  assert.equal(record.deprecated, false);
  assert.equal(normalizeRecord({ text: '' }), null);
});
