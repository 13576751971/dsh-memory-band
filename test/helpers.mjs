import { addRecord, createCard } from '../src/card.js';
import { normalizeConfig } from '../src/config.js';

export const NOW = Date.parse('2026-11-02T04:00:00+08:00');
export const MIN = 60e3;
export const HOUR = 3600e3;
export const DAY = 24 * HOUR;

/** 造一张卡。所有记录的时间都相对 NOW，跑测试不受当前日期影响。 */
export function cardOf(list, config = {}) {
  const card = createCard(NOW);
  for (const item of list) addRecord(card, item, config, NOW);
  return card;
}

export function cfgOf(patch = {}) {
  return normalizeConfig(patch);
}
