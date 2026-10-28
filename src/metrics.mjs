// Metric definitions, extraction, statistics, comparison, thresholds and verdict logic.

export const METRICS = {
  performance:   { label: 'Performance',    unit: 'score', better: 'higher', floor: 2,     gate: true },
  accessibility: { label: 'Accessibility',  unit: 'score', better: 'higher', floor: 2,     gate: true },
  bestPractices: { label: 'Best Practices', unit: 'score', better: 'higher', floor: 2,     gate: true },
  seo:           { label: 'SEO',            unit: 'score', better: 'higher', floor: 2,     gate: true },
  lcp:           { label: 'LCP',            unit: 'ms',    better: 'lower',  floor: 100,   gate: true },
  fcp:           { label: 'FCP',            unit: 'ms',    better: 'lower',  floor: 100,   gate: true },
  cls:           { label: 'CLS',            unit: 'cls',   better: 'lower',  floor: 0.01,  gate: true },
  tbt:           { label: 'TBT',            unit: 'ms',    better: 'lower',  floor: 50,    gate: true },
  speedIndex:    { label: 'Speed Index',    unit: 'ms',    better: 'lower',  floor: 100,   gate: true },
  ttfb:          { label: 'TTFB',           unit: 'ms',    better: 'lower',  floor: 50,    gate: true },
  transferBytes: { label: 'Transferred size',        unit: 'bytes', better: 'lower', floor: 10240, gate: true },
  resourceBytes: { label: 'Page size (uncompressed)', unit: 'bytes', better: 'lower', floor: 10240, gate: false },
  requests:      { label: 'Requests',       unit: 'count', better: 'lower',  floor: 1,     gate: false },
};
export const METRIC_KEYS = Object.keys(METRICS);

export const DEFAULT_THRESHOLDS = {
  performance:   { warn: 90,   fail: 50 },
  accessibility: { warn: 90,   fail: 70 },
  bestPractices: { warn: 90,   fail: 70 },
  seo:           { warn: 90,   fail: 70 },
  lcp:           { warn: 2500, fail: 4000 },
  fcp:           { warn: 1800, fail: 3000 },
  cls:           { warn: 0.1,  fail: 0.25 },
  tbt:           { warn: 200,  fail: 600 },
  speedIndex:    { warn: 3400, fail: 5800 },
  ttfb:          { warn: 800,  fail: 1800 },
  pageWeightKB:  { warn: 2000, fail: 5000 },
  requests:      { warn: 80,   fail: 150 },
  regression:    { noisePct: 5, warnPct: 10, failPct: 25 },
};

// Threshold keys that differ from metric keys.
const THRESHOLD_SOURCE = {
  pageWeightKB: { metric: 'transferBytes', scale: 1 / 1024, label: 'Page weight (transferred)' },
};
const thresholdMetric = (key) => THRESHOLD_SOURCE[key]?.metric ?? key;

/* ---------- formatting ---------- */
export function fmt(key, v) {
  if (v == null || !Number.isFinite(v)) return '—';
  switch (METRICS[key]?.unit) {
    case 'ms': return v >= 1000 ? `${(v / 1000).toFixed(2)} s` : `${Math.round(v)} ms`;
    case 'cls': return v.toFixed(3);
    case 'score': return String(Math.round(v));
    case 'bytes': return v >= 1048576 ? `${(v / 1048576).toFixed(2)} MB` : `${Math.round(v / 1024)} KB`;
    default: return String(Math.round(v));
  }
}
export function fmtDelta(key, abs) {
  if (abs == null || !Number.isFinite(abs)) return '—';
  if (abs === 0) return '0';
  return `${abs > 0 ? '+' : '−'}${fmt(key, Math.abs(abs))}`;
}
export function fmtThreshold(res, v) {
  if (v == null || !Number.isFinite(v)) return '—';
  return res.key === 'pageWeightKB' ? `${Math.round(v)} KB` : fmt(res.metric, v);
}

/* ---------- threshold configuration ---------- */
export function parseThresholdFlag(s) {
  const [k, val] = String(s).split('=');
  if (!k || val == null) throw new Error(`Bad --threshold "${s}". Use name=warn,fail (e.g. lcp=2500,4000) or regression.failPct=30`);
  if (k.startsWith('regression.')) {
    const n = Number(val);
    if (!Number.isFinite(n)) throw new Error(`Bad number in --threshold "${s}"`);
    return { regression: { [k.slice('regression.'.length)]: n } };
  }
  const [warn, fail] = val.split(',').map(Number);
  if (![warn, fail].every(Number.isFinite)) throw new Error(`Bad --threshold "${s}": need two numbers (warn,fail)`);
  return { [k]: { warn, fail } };
}

export function mergeThresholds(...layers) {
  const out = structuredClone(DEFAULT_THRESHOLDS);
  for (const layer of layers) {
    if (!layer) continue;
    for (const [k, v] of Object.entries(layer)) {
      if (k === 'regression') { Object.assign(out.regression, v); continue; }
      if (v === null) { delete out[k]; continue; } // null disables a threshold
      if (!METRICS[thresholdMetric(k)]) {
        throw new Error(`Unknown threshold "${k}". Valid: ${[...Object.keys(DEFAULT_THRESHOLDS)].join(', ')}`);
      }
      out[k] = { ...out[k], ...v };
    }
  }
  for (const [k, t] of Object.entries(out)) {
    if (k === 'regression') continue;
    const better = METRICS[thresholdMetric(k)].better;
    if (!Number.isFinite(t.warn) || !Number.isFinite(t.fail)) throw new Error(`Threshold "${k}" needs numeric warn and fail`);
    if ((better === 'lower' && t.warn > t.fail) || (better === 'higher' && t.warn < t.fail)) {
      throw new Error(`Threshold "${k}": warn must be ${better === 'lower' ? '<=' : '>='} fail`);
    }
  }
  return out;
}

/* ---------- extraction ---------- */
export function extractRunMetrics(lhr) {
  const a = lhr.audits ?? {};
  const num = (id) => (Number.isFinite(a[id]?.numericValue) ? a[id].numericValue : null);
  const cat = (id) => (lhr.categories?.[id]?.score == null ? null : Math.round(lhr.categories[id].score * 100));
  const items = a['network-requests']?.details?.items;
  const sum = (field) => (Array.isArray(items) ? items.reduce((t, i) => t + (Number(i[field]) || 0), 0) : null);
  return {
    performance: cat('performance'),
    accessibility: cat('accessibility'),
    bestPractices: cat('best-practices'),
    seo: cat('seo'),
    lcp: num('largest-contentful-paint'),
    fcp: num('first-contentful-paint'),
    cls: num('cumulative-layout-shift'),
    tbt: num('total-blocking-time'),
    speedIndex: num('speed-index'),
    ttfb: num('server-response-time'), // root document response time (lab TTFB proxy)
    transferBytes: num('total-byte-weight') ?? sum('transferSize'),
    resourceBytes: sum('resourceSize'),
    requests: Array.isArray(items) ? items.length : null,
  };
}

const stripLinks = (s) => s.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/\s+/g, ' ').trim();

export function extractFindings(lhr) {
  const meta = new Map();
  for (const cat of Object.values(lhr.categories ?? {})) {
    for (const ref of cat.auditRefs) if (!meta.has(ref.id)) meta.set(ref.id, { category: cat.title, group: ref.group });
  }
  const out = [];
  for (const [id, a] of Object.entries(lhr.audits ?? {})) {
    const m = meta.get(id);
    if (!m || m.group === 'metrics' || m.group === 'hidden') continue;
    if (!['numeric', 'binary', 'metricSavings'].includes(a.scoreDisplayMode)) continue;
    if (a.score == null || a.score >= 0.9) continue;
    const d = a.details ?? {};
    const ms = Object.values(a.metricSavings ?? {}).filter(Number.isFinite);
    out.push({
      id, title: a.title, category: m.category,
      kind: d.type === 'opportunity' || ms.length ? 'opportunity' : 'diagnostic',
      displayValue: a.displayValue ?? '',
      savingsMs: d.overallSavingsMs ?? (ms.length ? Math.max(...ms) : null),
      savingsBytes: d.overallSavingsBytes ?? null,
      score: a.score,
      description: stripLinks(a.description ?? '').slice(0, 280),
    });
  }
  out.sort((x, y) => (y.savingsMs ?? 0) - (x.savingsMs ?? 0) || x.score - y.score);
  return out.slice(0, 30);
}

/* ---------- statistics ---------- */
export function stats(values) {
  const v = values.filter(Number.isFinite);
  if (!v.length) return { n: 0, median: null, min: null, max: null, mean: null, stdev: null, cvPct: null };
  const s = [...v].sort((x, y) => x - y);
  const mid = s.length >> 1;
  const median = s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  const mean = v.reduce((x, y) => x + y, 0) / v.length;
  const stdev = v.length > 1 ? Math.sqrt(v.reduce((t, x) => t + (x - mean) ** 2, 0) / (v.length - 1)) : 0;
  return { n: v.length, median, min: s[0], max: s[s.length - 1], mean, stdev, cvPct: mean ? (stdev / Math.abs(mean)) * 100 : null };
}

export function summarize(runMetrics) {
  return Object.fromEntries(METRIC_KEYS.map((k) => [k, stats(runMetrics.map((r) => r[k]))]));
}

// Index of the run whose performance score (then LCP) is closest to the median.
export function representativeIndex(runMetrics, summary) {
  const medPerf = summary.performance.median;
  const medLcp = summary.lcp.median;
  let best = 0, bestScore = Infinity;
  runMetrics.forEach((r, i) => {
    const d = Math.abs((r.performance ?? 0) - (medPerf ?? 0)) * 1e6 + Math.abs((r.lcp ?? 0) - (medLcp ?? 0));
    if (d < bestScore) { bestScore = d; best = i; }
  });
  return best;
}

/* ---------- compatibility ---------- */
export function compatReasons(a, b) {
  const reasons = [];
  for (const k of ['url', 'label', 'formFactor', 'throttlingMethod', 'throttling', 'lighthouseMajor']) {
    const x = JSON.stringify(a?.[k]), y = JSON.stringify(b?.[k]);
    if (x !== y) reasons.push(`${k}: baseline ${a?.[k] == null ? 'n/a' : typeof a[k] === 'object' ? x : a[k]} vs current ${typeof b[k] === 'object' ? y : b[k]}`);
  }
  return reasons;
}

/* ---------- comparison ---------- */
export function compareSummaries(cur, base, reg) {
  const metrics = {};
  const counts = { improved: 0, regressed: 0, unchanged: 0, missing: 0 };
  for (const key of METRIC_KEYS) {
    const def = METRICS[key];
    const prev = base[key]?.median ?? null;
    const now = cur[key]?.median ?? null;
    if (prev == null || now == null) {
      metrics[key] = { prev, cur: now, abs: null, pct: null, status: 'n/a', severity: null, gate: def.gate };
      counts.missing++;
      continue;
    }
    const abs = now - prev;
    const pct = prev === 0 ? null : (abs / Math.abs(prev)) * 100; // zero baseline → no percentage
    const meaningful = Math.abs(abs) >= def.floor && (pct === null || Math.abs(pct) >= reg.noisePct);
    const worse = def.better === 'lower' ? abs > 0 : abs < 0;
    const status = !meaningful ? 'unchanged' : worse ? 'regressed' : 'improved';
    let severity = null;
    if (status === 'regressed') {
      severity = pct === null ? 'warn' : Math.abs(pct) >= reg.failPct ? 'fail' : Math.abs(pct) >= reg.warnPct ? 'warn' : 'info';
    }
    metrics[key] = { prev, cur: now, abs, pct, status, severity, gate: def.gate };
    counts[status]++;
  }
  return { metrics, counts };
}

/* ---------- thresholds ---------- */
export function evaluateThresholds(summary, thresholds) {
  const results = [];
  for (const [key, t] of Object.entries(thresholds)) {
    if (key === 'regression') continue;
    const src = THRESHOLD_SOURCE[key];
    const metric = thresholdMetric(key);
    const def = METRICS[metric];
    const raw = summary[metric]?.median;
    const value = raw == null ? null : raw * (src?.scale ?? 1);
    let status;
    if (value == null) status = 'MISSING';
    else if (def.better === 'lower') status = value > t.fail ? 'FAIL' : value > t.warn ? 'WARNING' : 'PASS';
    else status = value < t.fail ? 'FAIL' : value < t.warn ? 'WARNING' : 'PASS';
    results.push({ key, metric, label: src?.label ?? def.label, value, warn: t.warn, fail: t.fail, better: def.better, status });
  }
  return results;
}

export function computeVerdict({ thresholdResults, comparison, errors, runsRequested }) {
  let level = 0;
  const reasons = [];
  const bump = (l, message) => { level = Math.max(level, l); reasons.push({ level: l === 2 ? 'FAIL' : 'WARNING', message }); };
  for (const t of thresholdResults) {
    if (t.status === 'MISSING') bump(2, `${t.label}: no measurement available (not treated as a pass)`);
    else if (t.status === 'FAIL') bump(2, `${t.label} ${fmtThreshold(t, t.value)} is past the fail limit (${t.better === 'lower' ? '>' : '<'} ${fmtThreshold(t, t.fail)})`);
    else if (t.status === 'WARNING') bump(1, `${t.label} ${fmtThreshold(t, t.value)} is past the warning limit (${t.better === 'lower' ? '>' : '<'} ${fmtThreshold(t, t.warn)})`);
  }
  for (const [key, c] of Object.entries(comparison?.metrics ?? {})) {
    if (!c.gate || c.status !== 'regressed') continue;
    const pct = c.pct == null ? 'from a zero baseline' : `${c.pct > 0 ? '+' : ''}${c.pct.toFixed(1)}%`;
    if (c.severity === 'fail') bump(2, `${METRICS[key].label} regressed ${pct} vs baseline (${fmt(key, c.prev)} → ${fmt(key, c.cur)})`);
    else if (c.severity === 'warn') bump(1, `${METRICS[key].label} regressed ${pct} vs baseline (${fmt(key, c.prev)} → ${fmt(key, c.cur)})`);
  }
  if (errors.length) bump(1, `${errors.length} of ${runsRequested} Lighthouse runs failed; the result uses the remaining runs`);
  return { status: ['PASS', 'WARNING', 'FAIL'][level], reasons };
}
