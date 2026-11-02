import { clampInt } from './util.js';

export const DAY_MS = 24 * 60 * 60 * 1000;

/** 清晰度阶梯。只允许按这个顺序一格一格往下走，跳档会让「记得住/记不住」变得随机。 */
export const CLARITY_ORDER = Object.freeze(['vivid', 'clear', 'fuzzy', 'trace', 'forgotten']);
export const CLARITY_LABEL = Object.freeze({
  vivid: '清晰',
  clear: '清楚',
  fuzzy: '模糊',
  trace: '只剩印象',
  forgotten: '已遗忘',
});

/** 卡里的 createdAt 同时存在毫秒数和 ISO 字符串两种写法，统一在这里收敛。 */
export function timeOf(value, fallback = 0) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : fallback;
  const t = Date.parse(String(value ?? ''));
  return Number.isFinite(t) ? t : fallback;
}

export function short(text, max = 80) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

export function dateOnly(value) {
  const at = timeOf(value, 0);
  if (!at) return '????-??-??';
  const d = new Date(at);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

/** 「MM-DD HH:mm」。保护带和场景都要看得出「是今天几点」，光有日期不够。 */
export function stampOf(value) {
  const at = timeOf(value, 0);
  if (!at) return '';
  const d = new Date(at);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${mm}-${dd} ${hh}:${mi}`;
}

export function clockOf(value) {
  const at = timeOf(value, 0);
  if (!at) return '';
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** 句子指纹：去掉空白取前 14 字。同一句话被记成两条记录（id 不同）时靠它认出来。 */
export function fingerprint(text) {
  return String(text ?? '').replace(/\s+/g, '').slice(0, 14);
}

// ── 切词 ────────────────────────────────────────────────────────────────────
// 中文不分词，用 2-gram 切片：不依赖词典，错杀率可控，成本是零。
// 代价是会切出「了什」「讲的」这种碎片，所以带一张停用表。

/** 含虚字的 bigram 一律丢掉，它们跟话题无关，却能把无关记忆顶上来。 */
const VIRTUAL_CHARS = /[的了着过是在和与就都也而及吗吧呢啊呀哦嗯哈把被给对从]/;

const STOP_BIGRAMS = new Set([
  '这个', '那个', '什么', '怎么', '我们', '你们', '他们', '她们', '今天', '昨天', '明天',
  '现在', '真的', '就是', '不是', '一个', '一下', '觉得', '知道', '记得', '还记', '说的',
  '可以', '但是', '因为', '所以', '如果', '然后', '时候', '已经', '还是', '这样', '那样',
  '在吗', '有没', '没有', '是什', '么呀', '我的', '你的', '他的', '她的', '是不', '你还',
  '你记', '记不', '不记', '聊的', '说起', '么样', '怎会', '会不', '事儿', '一段', '那段',
  '你觉', '我觉', '不知', '知你', '你知', '我了', '了你', '你了', '吧我', '吗我',
]);

/**
 * 话题性单字。bigram 桥不过去的地方靠它补一手：
 * 问「念的那本书」而记忆里写的是「念完第七章」，两个 2-gram 对不上，单字「念」「书」能对上。
 * 命中一个就够当弱信号。
 */
const KEY_CHARS = '书念读唱画看写吃睡玩累困';

/** 查询串 → token 列表。中文 2-gram + 英文数字整词。 */
export function recallTokens(query, limit = 24) {
  const q = String(query ?? '').toLowerCase();
  const tokens = new Set();
  for (const m of q.matchAll(/[a-z0-9]{2,}/g)) tokens.add(m[0]);
  const cjk = q.replace(/[^\u4e00-\u9fff]/g, ' ');
  for (const seg of cjk.split(/\s+/)) {
    for (let i = 0; i + 1 < seg.length; i += 1) {
      const bg = seg.slice(i, i + 2);
      if (!STOP_BIGRAMS.has(bg) && !VIRTUAL_CHARS.test(bg)) tokens.add(bg);
    }
  }
  return [...tokens].slice(0, limit);
}

/** 判断「两条记忆是不是在说同一件事」时，这几个词没有区分度，先剔掉。 */
const TEXT_STOP = /^(一个|这个|那个|就是|什么|怎么|可以|不是|没有|还是|已经|我们|你们|他们|自己|现在|今天|明天|昨天|然后|因为|所以)$/;

/** 记忆正文 → token（去重后按出现顺序）。用来判断两条记忆是不是在说同一件事。 */
export function textTokens(text, limit = 24) {
  const tokens = [];
  for (const segment of String(text ?? '').split(/[^\u4e00-\u9fa5A-Za-z0-9]+/)) {
    if (!segment) continue;
    if (/[\u4e00-\u9fa5]/.test(segment)) {
      for (let i = 0; i + 2 <= segment.length && tokens.length < limit; i += 1) {
        const token = segment.slice(i, i + 2);
        if (TEXT_STOP.test(token)) continue;
        tokens.push(token);
      }
    } else if (segment.length >= 3 && tokens.length < limit) {
      tokens.push(segment);
    }
  }
  return [...new Set(tokens)].slice(0, limit);
}

export function keyCharsOf(query) {
  return [...KEY_CHARS].filter((ch) => String(query ?? '').includes(ch));
}

// ── 摘要 ────────────────────────────────────────────────────────────────────
// 保护带只带摘要，带原文会把 24 小时塞成上万字。
// 摘要用规则生成（0 token、确定性、可回滚），原文始终留在 text 里。

/**
 * 归纳成 ≤limit 字的一句话。注意不是硬截断：
 * 先按句子拼，拼不下就退到最近的标点收尾，读起来不像被刀切的。
 */
export function summarizeText(text, limit = 100) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  if (s.length <= limit) return s;
  const sentences = s.split(/(?<=[。！？!?；;])/).filter((part) => part.trim());
  let out = '';
  for (const part of sentences) {
    if (!out) { out = part.trim(); continue; }
    if ((out + part).length > limit) break;
    out += part.trim();
  }
  if (out.length > limit) {
    const cut = out.slice(0, limit);
    let lastPunc = -1;
    for (const ch of ['。', '！', '？', '；', '，', '、', ' ']) {
      lastPunc = Math.max(lastPunc, cut.lastIndexOf(ch));
    }
    out = lastPunc >= Math.floor(limit * 0.5) ? cut.slice(0, lastPunc + 1) : cut;
  }
  const trimmed = out.trim();
  if (trimmed.length <= limit) return trimmed;
  return `${trimmed.slice(0, Math.max(1, limit - 1)).trimEnd()}…`;
}

// ── 脱敏 ────────────────────────────────────────────────────────────────────
/**
 * 提示词里不该出现密钥、手机号、证件号、外链。
 * scope 为 qq 时保留 QQ 号（本地记忆要用它认人）；对外分享的 scope 一律抹掉 5~12 位数字。
 */
export function redact(text, { scope = 'qq', maxChars = 600 } = {}) {
  let s = String(text ?? '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
    .replace(/\r\n?/g, '\n');
  s = s.replace(/\b(token|password|passwd|secret|api[_-]?key|cookie|authorization|bearer)\b\s*[:=：]\s*[^\s，。；]+/gi, '$1=[已隐藏]');
  s = s.replace(/(密码|口令|密钥|令牌|验证码)\s*(?:是|为|[:=：])\s*[^\s，。；]+/g, '$1=[已隐藏]');
  s = s.replace(/\b(?:sk|ghp|gho|xoxb|xoxp)[-_][A-Za-z0-9_-]{8,}\b/g, '[令牌已隐藏]');
  s = s.replace(/\b[A-Za-z0-9+/_-]{32,}={0,2}\b/g, '[长串已隐藏]');
  s = s.replace(/\b1[3-9]\d{9}\b/g, '[手机号已隐藏]');
  s = s.replace(/\b\d{15,19}\b/g, '[证件号已隐藏]');
  s = s.replace(/https?:\/\/[^\s，。；）)]+/gi, '（链接已省略）');
  if (scope !== 'qq') {
    s = s.replace(/(?<!\d)\d{5,12}(?!\d)/g, '[号码已隐藏]');
  }
  s = s.replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n').trim();
  const limit = clampInt(maxChars, 600, 100, 4000);
  return s.length > limit ? `${s.slice(0, limit)}…` : s;
}
