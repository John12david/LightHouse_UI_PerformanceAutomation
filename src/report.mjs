// Self-contained HTML report (inline CSS + inline SVG charts, no network needed).
import { METRICS, fmt, fmtDelta, fmtThreshold } from './metrics.mjs';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const STATUS_CLASS = { PASS: 'ok', WARNING: 'warn', FAIL: 'bad', MISSING: 'bad' };
const pctText = (p) => (p == null ? '—' : `${p > 0 ? '+' : ''}${p.toFixed(1)}%`);

function cmpClass(c) {
  if (!c || c.status === 'n/a' || c.status === 'unchanged') return 'muted';
  if (c.status === 'improved') return 'ok';
  return c.severity === 'fail' ? 'bad' : 'warn';
}

function lineChart(key, trend, th) {
  const W = 560, H = 200, pl = 52, pr = 14, pt = 14, pb = 28;
  const def = METRICS[key];
  const scale = key === 'transferBytes' && th ? 1024 : 1; // pageWeightKB threshold is in KB
  const pts = trend.map((r) => ({ y: r.summary[key]?.median, lo: r.summary[key]?.min, hi: r.summary[key]?.max, r }));
  const vals = pts.flatMap((p) => [p.y, p.lo, p.hi]).filter(Number.isFinite);
  const title = `<h3>${esc(def.label)}</h3>`;
  if (!vals.length) return `<div class="card chart">${title}<p class="muted">No data</p></div>`;
  const warn = th ? th.warn * scale : null, fail = th ? th.fail * scale : null;
  const max = def.unit === 'score' ? 100 : (Math.max(...vals, warn ?? 0) * 1.1 || 1);
  const n = pts.length;
  const X = (i) => pl + (n === 1 ? (W - pl - pr) / 2 : (i * (W - pl - pr)) / (n - 1));
  const Y = (v) => pt + (H - pt - pb) * (1 - v / max);
  let grid = '';
  for (let k = 0; k <= 4; k++) {
    const v = (max * k) / 4;
    grid += `<line x1="${pl}" x2="${W - pr}" y1="${Y(v)}" y2="${Y(v)}" class="grid"/><text x="${pl - 6}" y="${Y(v) + 4}" text-anchor="end" class="axis">${esc(fmt(key, v))}</text>`;
  }
  let lines = '';
  if (warn != null && warn <= max) lines += `<line x1="${pl}" x2="${W - pr}" y1="${Y(warn)}" y2="${Y(warn)}" class="thr-warn"/>`;
  if (fail != null && fail <= max) lines += `<line x1="${pl}" x2="${W - pr}" y1="${Y(fail)}" y2="${Y(fail)}" class="thr-fail"/>`;
  let d = '', pen = false, dots = '', whisk = '';
  pts.forEach((p, i) => {
    if (!Number.isFinite(p.y)) { pen = false; return; }
    d += `${pen ? 'L' : 'M'}${X(i).toFixed(1)} ${Y(p.y).toFixed(1)} `;
    pen = true;
    if (Number.isFinite(p.lo) && Number.isFinite(p.hi) && p.hi !== p.lo) whisk += `<line x1="${X(i)}" x2="${X(i)}" y1="${Y(p.lo)}" y2="${Y(p.hi)}" class="whisk"/>`;
    const last = i === n - 1;
    dots += `<circle cx="${X(i).toFixed(1)}" cy="${Y(p.y).toFixed(1)}" r="${last ? 5 : 3.5}" class="${last ? 'dot cur' : 'dot'}"><title>${esc(p.r.timestamp.slice(0, 16).replace('T', ' '))} · build ${esc(p.r.build)} · ${esc(fmt(key, p.y))}</title></circle>`;
  });
  const first = trend[0].timestamp.slice(0, 10), lastD = trend[n - 1].timestamp.slice(0, 10);
  const xl = `<text x="${pl}" y="${H - 8}" class="axis">${first}</text>` + (n > 1 ? `<text x="${W - pr}" y="${H - 8}" text-anchor="end" class="axis">${lastD}</text>` : '');
  return `<div class="card chart">${title}<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(def.label)} trend">${grid}${lines}${whisk}<path d="${d}" class="series"/>${dots}${xl}</svg></div>`;
}

function ring(label, score, delta) {
  const c = 2 * Math.PI * 34;
  const v = Number.isFinite(score) ? score : 0;
  const color = !Number.isFinite(score) ? 'var(--muted)' : score >= 90 ? 'var(--ok)' : score >= 50 ? 'var(--warn)' : 'var(--bad)';
  const dTxt = delta && delta.status !== 'n/a' && delta.abs ? `<small class="${cmpClass(delta)}">${fmtDelta('performance', delta.abs)}</small>` : '<small>&nbsp;</small>';
  return `<div class="ring"><svg viewBox="0 0 80 80"><circle cx="40" cy="40" r="34" class="ring-bg"/><circle cx="40" cy="40" r="34" fill="none" stroke="${color}" stroke-width="7" stroke-linecap="round" stroke-dasharray="${((v / 100) * c).toFixed(1)} ${c.toFixed(1)}" transform="rotate(-90 40 40)"/><text x="40" y="46" text-anchor="middle" class="ring-n" fill="${color}">${Number.isFinite(score) ? Math.round(score) : '—'}</text></svg><div>${esc(label)}</div>${dTxt}</div>`;
}

export function renderReport({ record, trend, thresholds }) {
  const r = record, s = r.summary, cmp = r.comparison, b = r.baselineInfo;
  const thBy = Object.fromEntries(r.thresholdResults.map((t) => [t.metric, t]));
  const usable = cmp && b?.usable;

  const kpiKeys = ['performance', 'lcp', 'fcp', 'cls', 'tbt', 'speedIndex', 'ttfb', 'transferBytes', 'requests'];
  const kpis = kpiKeys.map((k) => {
    const t = thBy[k], c = usable ? cmp.metrics[k] : null;
    const chip = c && c.status !== 'n/a'
      ? `<span class="chip ${cmpClass(c)}">${c.abs > 0 ? '▲' : c.abs < 0 ? '▼' : '●'} ${esc(fmtDelta(k, c.abs))} (${pctText(c.pct)})</span>`
      : '<span class="chip muted">no baseline</span>';
    return `<div class="card kpi ${t ? STATUS_CLASS[t.status] : ''}"><div class="kpi-l">${esc(METRICS[k].label)}</div><div class="kpi-v">${esc(fmt(k, s[k].median))}</div>${chip}<div class="kpi-s">${t ? esc(t.status) : 'no threshold'} · σ ${s[k].cvPct == null ? '—' : s[k].cvPct.toFixed(1) + '% CV'}</div></div>`;
  }).join('');

  const cats = [['Performance', 'performance'], ['Accessibility', 'accessibility'], ['Best Practices', 'bestPractices'], ['SEO', 'seo']]
    .map(([l, k]) => ring(l, s[k].median, usable ? cmp.metrics[k] : null)).join('');

  let baseNote;
  if (!b || b.mode === 'none') baseNote = '<div class="note">Baseline comparison disabled for this run.</div>';
  else if (!b.record && !b.id) baseNote = `<div class="note">${esc(b.note ?? 'No baseline available.')}</div>`;
  else if (!b.usable) baseNote = `<div class="note bad-note"><b>Incompatible baseline – comparison skipped.</b> Baseline <code>${esc(b.id)}</code> differs: <ul>${b.reasons.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>Use <code>--allow-incompatible</code> to compare anyway.</div>`;
  else baseNote = `<div class="note">Compared with <code>${esc(b.id)}</code> (${esc(b.timestamp.slice(0, 16).replace('T', ' '))} UTC, build ${esc(b.build)}).${b.reasons.length ? ` <b>Forced despite differences:</b> ${esc(b.reasons.join('; '))}.` : ''} Changes inside the noise band (&lt; ${thresholds.regression.noisePct}% or below the per-metric minimum) count as unchanged.</div>`;

  const rows = Object.keys(METRICS).map((k) => {
    const c = usable ? cmp.metrics[k] : null;
    const status = !c ? 'n/a' : c.status === 'regressed' ? `regressed${c.severity === 'fail' ? ' (large)' : ''}` : c.status;
    return `<tr><td>${esc(METRICS[k].label)}</td><td>${esc(fmt(k, c ? c.prev : null))}</td><td><b>${esc(fmt(k, s[k].median))}</b></td><td>${esc(c ? fmtDelta(k, c.abs) : '—')}</td><td>${esc(c ? pctText(c.pct) : '—')}</td><td><span class="badge ${cmpClass(c)}">${esc(status)}</span></td></tr>`;
  }).join('');

  const thRows = r.thresholdResults.map((t) => `<tr><td>${esc(t.label)}</td><td>${esc(fmtThreshold(t, t.value))}</td><td>${t.better === 'lower' ? '&gt;' : '&lt;'} ${esc(fmtThreshold(t, t.warn))}</td><td>${t.better === 'lower' ? '&gt;' : '&lt;'} ${esc(fmtThreshold(t, t.fail))}</td><td><span class="badge ${STATUS_CLASS[t.status]}">${t.status}</span></td></tr>`).join('');
  const reasons = r.verdict.reasons.length
    ? `<ul class="reasons">${r.verdict.reasons.map((x) => `<li class="${x.level === 'FAIL' ? 'bad' : 'warn'}"><b>${x.level}</b> ${esc(x.message)}</li>`).join('')}</ul>`
    : '<p class="ok">No threshold violations or significant regressions.</p>';

  const charts = ['performance', 'lcp', 'fcp', 'tbt', 'cls', 'speedIndex', 'transferBytes']
    .map((k) => lineChart(k, trend, k === 'transferBytes' ? thresholds.pageWeightKB : thresholds[k])).join('');

  const runKeys = ['performance', 'lcp', 'fcp', 'cls', 'tbt', 'speedIndex', 'ttfb', 'transferBytes', 'requests'];
  const runRows = r.runs.map((x) => `<tr><td>#${x.run}${x.run === r.representativeRun ? ' ★' : ''}</td>${runKeys.map((k) => `<td>${esc(fmt(k, x.metrics[k]))}</td>`).join('')}</tr>`).join('');
  const varRows = runKeys.map((k) => { const v = s[k]; const noisy = v.cvPct != null && v.cvPct > 15 && METRICS[k].unit !== 'score';
    return `<tr><td>${esc(METRICS[k].label)}</td><td>${esc(fmt(k, v.median))}</td><td>${esc(fmt(k, v.min))}</td><td>${esc(fmt(k, v.max))}</td><td>${v.cvPct == null ? '—' : v.cvPct.toFixed(1) + '%'}</td><td>${noisy ? '<span class="badge warn">high variability</span>' : ''}</td></tr>`; }).join('');

  const fi = (list) => list.map((f) => `<tr><td>${esc(f.title)}<div class="muted small">${esc(f.description)}</div></td><td>${esc(f.category)}</td><td>${esc(f.displayValue)}</td><td>${f.savingsMs ? Math.round(f.savingsMs) + ' ms' : '—'}</td><td>${f.savingsBytes ? Math.round(f.savingsBytes / 1024) + ' KB' : '—'}</td></tr>`).join('');
  const opps = r.findings.filter((f) => f.kind === 'opportunity'), diags = r.findings.filter((f) => f.kind === 'diagnostic');

  const cfg = r.config, tool = r.tool;
  const meta = [
    ['Run ID', r.id], ['Timestamp (UTC)', r.timestamp], ['URL', r.url], ['Final URL', r.finalUrl], ['Build / commit', r.build], ['Label / environment', r.label],
    ['Device profile', cfg.formFactor], ['Throttling', `${cfg.throttlingMethod} ${JSON.stringify(cfg.throttling)}`], ['Runs (ok/requested)', `${r.runs.length}/${cfg.runsRequested}`],
    ['Lighthouse', tool.lighthouse], ['Browser', tool.browser], ['Node / OS', `${tool.node} / ${tool.platform}`], ['Host benchmark index', r.runs.map((x) => Math.round(x.benchmarkIndex ?? 0)).join(', ')],
  ].map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join('');

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Lighthouse report – ${esc(r.id)}</title><style>
:root{--bg:#f5f7fa;--card:#fff;--fg:#1c2430;--muted:#6b7684;--line:#e3e8ee;--ok:#0a9b5c;--warn:#d98e04;--bad:#d63b3b;--acc:#3b6df0}
@media(prefers-color-scheme:dark){:root{--bg:#0f141b;--card:#18202b;--fg:#e6ebf2;--muted:#8d99a8;--line:#2a3441;--ok:#35c98a;--warn:#f0b03a;--bad:#f26b6b;--acc:#6f95ff}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:1200px;margin:0 auto;padding:24px 16px 60px}h1{margin:0;font-size:22px}h2{margin:34px 0 12px;font-size:17px}h3{margin:0 0 6px;font-size:14px}
.top{display:flex;flex-wrap:wrap;gap:12px;align-items:center;justify-content:space-between}.sub{color:var(--muted);font-size:13px}
.verdict{font-weight:700;padding:8px 18px;border-radius:999px;color:#fff}.verdict.ok{background:var(--ok)}.verdict.warn{background:var(--warn)}.verdict.bad{background:var(--bad)}
.grid3{display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:12px}.charts{display:grid;grid-template-columns:repeat(auto-fill,minmax(340px,1fr));gap:12px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px}.kpi{border-top:4px solid var(--line)}.kpi.ok{border-top-color:var(--ok)}.kpi.warn{border-top-color:var(--warn)}.kpi.bad{border-top-color:var(--bad)}
.kpi-l{color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.04em}.kpi-v{font-size:26px;font-weight:700;margin:2px 0 4px}.kpi-s{color:var(--muted);font-size:11px;margin-top:6px}
.chip{display:inline-block;font-size:12px;padding:1px 8px;border-radius:999px;border:1px solid currentColor}
.ok{color:var(--ok)}.warn{color:var(--warn)}.bad{color:var(--bad)}.muted{color:var(--muted)}.small{font-size:12px}
.badge{display:inline-block;padding:1px 9px;border-radius:6px;font-size:12px;font-weight:600;border:1px solid currentColor}
.rings{display:flex;flex-wrap:wrap;gap:24px;justify-content:space-around}.ring{text-align:center;width:110px}.ring svg{width:96px;height:96px}.ring-bg{fill:none;stroke:var(--line);stroke-width:7}.ring-n{font-size:24px;font-weight:700}
table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);border-radius:12px;overflow:hidden}th,td{text-align:left;padding:8px 12px;border-bottom:1px solid var(--line);vertical-align:top}thead th{background:var(--bg);font-size:12px;text-transform:uppercase;color:var(--muted)}tbody tr:last-child td{border-bottom:0}
.tw{overflow-x:auto}.note{padding:10px 14px;border-radius:10px;background:var(--card);border:1px solid var(--line);margin-bottom:12px}.bad-note{border-color:var(--bad)}
.reasons{list-style:none;margin:0;padding:0}.reasons li{padding:8px 12px;margin-bottom:6px;background:var(--card);border:1px solid var(--line);border-left:4px solid currentColor;border-radius:8px}
svg .grid{stroke:var(--line)}svg .axis{fill:var(--muted);font-size:10px}svg .series{fill:none;stroke:var(--acc);stroke-width:2}svg .dot{fill:var(--acc)}svg .dot.cur{fill:var(--card);stroke:var(--acc);stroke-width:3}svg .whisk{stroke:var(--acc);opacity:.35;stroke-width:3;stroke-linecap:round}svg .thr-warn{stroke:var(--warn);stroke-dasharray:5 4}svg .thr-fail{stroke:var(--bad);stroke-dasharray:5 4}
.chart svg{width:100%;height:auto}code{background:var(--bg);padding:1px 5px;border-radius:4px}details{margin-top:28px}summary{cursor:pointer;font-weight:600}th[scope],.meta th{width:210px;color:var(--muted);font-weight:500;background:none;text-transform:none;font-size:13px}
</style></head><body><main>
<div class="top"><div><h1>Lighthouse performance report</h1><div class="sub">${esc(r.url)} · ${esc(cfg.formFactor)} · build ${esc(r.build)} · ${esc(r.label)} · ${esc(r.timestamp.slice(0, 16).replace('T', ' '))} UTC</div></div><div class="verdict ${STATUS_CLASS[r.verdict.status]}">${r.verdict.status}</div></div>
<div class="note" style="margin-top:14px"><b>Lab data, not field data.</b> These are simulated-throttling Lighthouse results from one machine (median of ${r.runs.length} run${r.runs.length > 1 ? 's' : ''}). They do not include real-user metrics, and a lab run cannot produce a representative INP; use TBT as the lab proxy and CrUX/RUM for real-user INP.</div>
<h2>Key metrics</h2><div class="grid3">${kpis}</div>
<h2>Category scores</h2><div class="card rings">${cats}</div>
<h2>Current vs baseline</h2>${baseNote}<div class="tw"><table><thead><tr><th>Metric</th><th>Previous</th><th>Current</th><th>Change</th><th>Change %</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table></div>
<h2>Threshold violations &amp; regressions</h2>${reasons}<div class="tw"><table><thead><tr><th>Metric</th><th>Value</th><th>Warn</th><th>Fail</th><th>Status</th></tr></thead><tbody>${thRows}</tbody></table></div>
<h2>Trends <span class="muted small">(${trend.length} compatible run${trend.length > 1 ? 's' : ''}; line = median, bar = min–max, dashed = warn/fail)</span></h2><div class="charts">${charts}</div>
<h2>Optimization opportunities</h2><div class="tw"><table><thead><tr><th>Audit</th><th>Category</th><th>Detail</th><th>Time saving</th><th>Size saving</th></tr></thead><tbody>${fi(opps) || '<tr><td colspan="5" class="muted">None found</td></tr>'}</tbody></table></div>
<h2>Diagnostics &amp; failing audits</h2><div class="tw"><table><thead><tr><th>Audit</th><th>Category</th><th>Detail</th><th>Time saving</th><th>Size saving</th></tr></thead><tbody>${fi(diags) || '<tr><td colspan="5" class="muted">None found</td></tr>'}</tbody></table></div>
<h2>Individual runs &amp; variability</h2><div class="tw"><table><thead><tr><th>Run</th>${runKeys.map((k) => `<th>${esc(METRICS[k].label)}</th>`).join('')}</tr></thead><tbody>${runRows}</tbody></table></div><p class="muted small">★ = representative run used for opportunities/diagnostics. CV = stdev ÷ mean.</p>
<div class="tw"><table><thead><tr><th>Metric</th><th>Median</th><th>Min</th><th>Max</th><th>CV</th><th></th></tr></thead><tbody>${varRows}</tbody></table></div>
<h2>Test configuration &amp; metadata</h2><div class="tw"><table class="meta"><tbody>${meta}</tbody></table></div>
</main></body></html>`;
}
