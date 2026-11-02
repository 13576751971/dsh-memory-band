function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function formatTime(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('zh-CN', { hour12: false });
}

/** Standalone dashboard: no build step, no external assets, no CSP surprises. */
export function dashboardHtml(stats, recent = []) {
  const rows = recent.map((record) => `
    <tr>
      <td class="time">${escapeHtml(formatTime(record.at))}</td>
      <td><span class="tag">${escapeHtml(record.source)}</span></td>
      <td>${escapeHtml(record.summary || record.text)}</td>
      <td class="num">${escapeHtml(record.importance)}</td>
    </tr>`).join('');

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>dsh-memory-band · 本地记忆带</title>
<style>
  :root { color-scheme: light dark; --bg:#f6f7fb; --card:#fff; --ink:#172033; --muted:#667085; --line:#e6e8ef; --accent:#3157d5; --accent2:#0f9f7a; }
  @media (prefers-color-scheme: dark) { :root { --bg:#0e1118; --card:#171b24; --ink:#eef2ff; --muted:#98a2b3; --line:#2a3040; --accent:#7c9cff; --accent2:#4ee0b0; } }
  * { box-sizing: border-box; }
  body { margin:0; padding:36px 20px; background:var(--bg); color:var(--ink); font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif; }
  .wrap { max-width: 980px; margin: 0 auto; }
  header { display:flex; align-items:center; justify-content:space-between; gap:16px; flex-wrap:wrap; margin-bottom:24px; }
  h1 { margin:0; font-size:28px; letter-spacing:-0.02em; }
  .sub { color:var(--muted); margin-top:4px; }
  .pill { display:inline-flex; align-items:center; gap:6px; padding:6px 10px; border:1px solid var(--line); border-radius:999px; color:var(--muted); background:var(--card); font-size:13px; }
  .dot { width:8px; height:8px; border-radius:50%; background:var(--accent2); box-shadow:0 0 0 4px color-mix(in srgb, var(--accent2) 18%, transparent); }
  .grid { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:12px; margin-bottom:20px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:14px; padding:16px; }
  .k { color:var(--muted); font-size:12px; text-transform:uppercase; letter-spacing:.06em; }
  .v { font-size:26px; font-weight:650; margin-top:6px; letter-spacing:-0.02em; }
  .v small { font-size:13px; color:var(--muted); font-weight:450; }
  .panel { background:var(--card); border:1px solid var(--line); border-radius:14px; padding:16px; margin-bottom:14px; }
  .panel h2 { font-size:15px; margin:0 0 10px; }
  table { width:100%; border-collapse:collapse; font-size:14px; }
  th,td { text-align:left; padding:9px 8px; border-bottom:1px solid var(--line); vertical-align:top; }
  th { color:var(--muted); font-weight:500; font-size:12px; }
  tr:last-child td { border-bottom:0; }
  .time { white-space:nowrap; color:var(--muted); font-variant-numeric:tabular-nums; }
  .num { text-align:right; font-variant-numeric:tabular-nums; }
  .tag { display:inline-block; padding:2px 7px; border-radius:6px; background:color-mix(in srgb, var(--accent) 10%, transparent); color:var(--accent); font-size:12px; }
  .empty { color:var(--muted); padding:24px 0; text-align:center; }
  .meta { display:flex; gap:16px; flex-wrap:wrap; color:var(--muted); font-size:13px; }
  code { font-family:ui-monospace,SFMono-Regular,Consolas,monospace; font-size:13px; }
  .route { padding:8px 10px; border:1px dashed var(--line); border-radius:9px; margin-top:8px; color:var(--muted); font-size:13px; overflow:auto; }
  @media (max-width:720px) { .grid { grid-template-columns:repeat(2,minmax(0,1fr)); } }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <div>
      <h1>dsh-memory-band</h1>
      <div class="sub">本地记忆带 · 零模型调用检索 · 装进 DSH 就能用</div>
    </div>
    <span class="pill"><span class="dot"></span> 已加载 v${escapeHtml(stats.version ?? '0.2.0')}</span>
  </header>

  <div class="grid">
    <div class="card"><div class="k">记忆条数</div><div class="v">${escapeHtml(stats.records)}</div></div>
    <div class="card"><div class="k">原文总字数</div><div class="v">${escapeHtml(stats.chars)}</div></div>
    <div class="card"><div class="k">本进程注入</div><div class="v">${escapeHtml(stats.metrics?.injections ?? 0)} <small>次</small></div></div>
    <div class="card"><div class="k">估算注入 token</div><div class="v">${escapeHtml(stats.estimatedInjectedTokens ?? 0)}</div></div>
  </div>

  <div class="panel">
    <h2>最近记忆</h2>
    ${rows ? `<table><thead><tr><th>时间</th><th>来源</th><th>摘要</th><th class="num">重要度</th></tr></thead><tbody>${rows}</tbody></table>` : '<div class="empty">还没有记忆。和助理聊两句，或在插件工具里调用 <code>memory_band remember</code>。</div>'}
  </div>

  <div class="panel">
    <h2>本地接口</h2>
    <div class="meta">
      <span>数据目录 <code>${escapeHtml(stats.dataDir)}</code></span>
      <span>预算 boot ${escapeHtml(stats.budgets?.bootChars)} 字 / recall ${escapeHtml(stats.budgets?.recallChars)} 字</span>
    </div>
    <div class="route">GET&nbsp; /dsh-memory-band/health&nbsp; · &nbsp;GET&nbsp; /dsh-memory-band/block?q=…&nbsp; · &nbsp;GET&nbsp; /dsh-memory-band/stats&nbsp; · &nbsp;POST&nbsp; /dsh-memory-band/add</div>
  </div>
</div>
</body>
</html>`;
}
