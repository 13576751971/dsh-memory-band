import { asObject, bool, clampInt } from './util.js';

/**
 * 默认配置。
 *
 * 每一项都能只覆盖一部分。覆盖值是坏值（NaN、负数、类型不对）时回落到这里的默认，
 * 不把污染值带进引擎——这类错误往往要跑上一周才显形。
 *
 * 两个开关值得单独说：
 *   protectionBand.enabled = false  退回「只按话题召回」的老行为，输出逐字节一致（回滚口）
 *   scene.enabled = false           保留 24 小时摘要，但不回放当时的对话
 */
export const DEFAULT_CONFIG = Object.freeze({
  /** 注入预算（字）。私聊和公开场合分开算，B 站那边只需要一半。 */
  injectMaxChars: Object.freeze({ qq: 600, bili: 400 }),

  /** B 站侧是否允许带 QQ 记忆。默认关：两边受众不同，串味很尴尬。 */
  includeQqInBili: false,

  /**
   * 近 24 小时常驻带。
   *
   * 它有自己的字数预算，不吃 injectMaxChars 的额度。这一点很关键：拿掉独立预算，
   * 「今天说过的话」就得跟三个月前的旧事抢同一个池子，抢不过就被挤掉，
   * 而「昨天聊了什么」恰恰是用户最常考的题。
   */
  protectionBand: Object.freeze({
    enabled: true,
    /** 时间窗（小时）。 */
    windowHours: 24,
    /** 独立预算。1500 字大约是 40~60 条一句话摘要。 */
    bandChars: 1500,
    /**
     * 进带的重要度门槛。
     *
     * 55 不是拍出来的：这套记忆的打分里，「主人私聊的一句日常」约 58 分。
     * 门槛设 60 会把当天大部分闲聊挡在带外，正好和「当天不丢」的目标相反。
     */
    bandImportanceMin: 55,
    /** 单条摘要上限。超过就在标点处收尾，不做硬截断。 */
    bandEntryCap: 100,
    /** 去掉同一句话的重复记录（同一次对话被两个来源写了两遍很常见）。 */
    dedup: true,
    /** 每个话题先给 1 槽，再按重要度补齐。不然一件事能把整条带占满。 */
    diversity: true,
    /** 带里的记忆命中后，是否回放当时的对话。 */
    sceneEnabled: true,
    /** 回放多少条。 */
    sceneMessages: 20,
    /** 每轮回放几段（默认 1 段，多了会挤占召回预算）。 */
    sceneTopK: 1,
  }),

  /** 按话题召回的带，管更早以前的事。关掉它，等于只记得最近 24 小时。 */
  recallBand: Object.freeze({
    enabled: true,
    /**
     * 候选重要度地板。45 是线上跑出来的值：刚好挡掉群聊噪声（18~30 分），
     * 留下主人的日常（58 分上下）。填 0 才是改造前的行为——任何记录都能被召回。
     */
    impFloor: 45,
    /** 最多召回几条。0 = 用内置配额（命中越多给越多，总量基本稳定）。 */
    recallTopK: 0,
    sceneEnabled: true,
    sceneMessages: 20,
    sceneTopK: 1,
  }),

  /** 场景回放的总闸。 */
  scene: Object.freeze({
    enabled: true,
    /** 每轮最多几段。保护带 1 + 召回带 1 是上限，再多就是拿预算换气氛。 */
    maxScenesPerCall: 2,
    /** 场景总字数上限，超了先丢最早的那段。 */
    maxSceneChars: 1500,
    /** 写入时抓取的前后条数。0 = 不抓，读取时用卡里的邻居现算。 */
    captureWindow: 0,
    /** 重要度低于此值的记录不抓快照，省存储。0 = 全抓。 */
    captureMinImportance: 55,
  }),

  /** 摘要字段（保护带和场景都靠它，原文永远留在 text 里）。 */
  summary: Object.freeze({
    enabled: true,
    /** 单条摘要上限（字）。 */
    maxChars: 100,
  }),

  /**
   * 注入块里的提示词。默认值就是线上跑了几个月的那一套，不建议随手改：
   * 末尾那句「别照读，也别提记忆卡」是防模型复述的关键。
   */
  prompt: Object.freeze({
    header: '【记忆卡 · 你自己的记忆（挑出和刚才话题相关的部分）】',
    bandHeader: '【记忆卡 · 你自己的记忆（最近的事）】',
    footer: '（这些是你自己的经历，不是别人给的设定；自然想起来就好，别照读，也别提“记忆卡”。）',
    sceneHeader: '【当时场景 · {time} 前后】',
    bandTitle: '## 最近 {hours} 小时（记得最清楚）',
    recallTitle: '## 和刚才的话题相关（更早以前）',
  }),
});

/** 配置收敛。传入的可以是整块 config，也可以是 `{ memoryCard: {...} }` 这种带命名空间的写法。 */
export function normalizeConfig(input = {}) {
  const src = asObject(input);
  const raw = asObject(src.memoryCard && typeof src.memoryCard === 'object' ? src.memoryCard : src);
  const D = DEFAULT_CONFIG;
  const inject = asObject(raw.injectMaxChars);
  const prot = asObject(raw.protectionBand);
  const recall = asObject(raw.recallBand);
  const scene = asObject(raw.scene);
  const summary = asObject(raw.summary);
  const prompt = asObject(raw.prompt);
  const str = (value, fallback) => String(value ?? '').trim() || fallback;

  return {
    injectMaxChars: {
      qq: clampInt(inject.qq, D.injectMaxChars.qq, 100, 8000),
      bili: clampInt(inject.bili, D.injectMaxChars.bili, 100, 8000),
    },
    includeQqInBili: bool(raw.includeQqInBili, D.includeQqInBili),
    protectionBand: {
      enabled: bool(prot.enabled, D.protectionBand.enabled),
      windowHours: clampInt(prot.windowHours, D.protectionBand.windowHours, 1, 240),
      bandChars: clampInt(prot.bandChars, D.protectionBand.bandChars, 0, 8000),
      bandImportanceMin: clampInt(prot.bandImportanceMin, D.protectionBand.bandImportanceMin, 0, 100),
      bandEntryCap: clampInt(prot.bandEntryCap, D.protectionBand.bandEntryCap, 1, 120),
      dedup: bool(prot.dedup, D.protectionBand.dedup),
      diversity: bool(prot.diversity, D.protectionBand.diversity),
      sceneEnabled: bool(prot.sceneEnabled, D.protectionBand.sceneEnabled),
      sceneMessages: clampInt(prot.sceneMessages, D.protectionBand.sceneMessages, 2, 60),
      sceneTopK: clampInt(prot.sceneTopK, D.protectionBand.sceneTopK, 0, 3),
    },
    recallBand: {
      enabled: bool(recall.enabled, D.recallBand.enabled),
      impFloor: clampInt(recall.impFloor, D.recallBand.impFloor, 0, 100),
      recallTopK: clampInt(recall.recallTopK, D.recallBand.recallTopK, 0, 12),
      sceneEnabled: bool(recall.sceneEnabled, D.recallBand.sceneEnabled),
      sceneMessages: clampInt(recall.sceneMessages, D.recallBand.sceneMessages, 2, 60),
      sceneTopK: clampInt(recall.sceneTopK, D.recallBand.sceneTopK, 0, 3),
    },
    scene: {
      enabled: bool(scene.enabled, D.scene.enabled),
      maxScenesPerCall: clampInt(scene.maxScenesPerCall, D.scene.maxScenesPerCall, 0, 4),
      maxSceneChars: clampInt(scene.maxSceneChars, D.scene.maxSceneChars, 0, 8000),
      captureWindow: clampInt(scene.captureWindow, D.scene.captureWindow, 0, 60),
      captureMinImportance: clampInt(scene.captureMinImportance, D.scene.captureMinImportance, 0, 100),
    },
    summary: {
      enabled: bool(summary.enabled, D.summary.enabled),
      maxChars: clampInt(summary.maxChars, D.summary.maxChars, 20, 140),
    },
    prompt: {
      header: str(prompt.header, D.prompt.header),
      bandHeader: str(prompt.bandHeader, D.prompt.bandHeader),
      footer: str(prompt.footer, D.prompt.footer),
      sceneHeader: str(prompt.sceneHeader, D.prompt.sceneHeader),
      bandTitle: str(prompt.bandTitle, D.prompt.bandTitle),
      recallTitle: str(prompt.recallTitle, D.prompt.recallTitle),
    },
  };
}
