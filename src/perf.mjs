#!/usr/bin/env node
// Lighthouse runner: N runs -> median -> history JSON -> baseline comparison -> thresholds -> HTML report -> exit code.
import { parseArgs } from 'node:util';
import { mkdir, writeFile, readFile, readdir, appendFile, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import readline from 'node:readline/promises';
import lighthouse from 'lighthouse';
import * as chromeLauncher from 'chrome-launcher';
import {
  METRICS, fmt, fmtDelta, mergeThresholds, parseThresholdFlag, extractRunMetrics, extractFindings, summarize,
  representativeIndex, compatReasons, compareSummaries, evaluateThresholds, computeVerdict,
} from './lib/metrics.mjs';
import { renderReport } from './lib/report.mjs';

const EXIT = { PASS: 0, WARNING: 10, FAIL: 20, ERROR: 30, USAGE: 64 };
const DEFAULT_URL = 'https://johndavidportfolio.netlify.com';
const DESKTOP_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36 Chrome-Lighthouse';
const env = process.env;
const isCI = env.CI === 'true' || Boolean(env.GITHUB_ACTIONS);

const HELP = `Usage: node src/perf.mjs [options]

  --url <url>               Target URL (env PERF_URL)                         default ${DEFAULT_URL}
  --device <mobile|desktop> Lighthouse form factor (env PERF_DEVICE)          default mobile
  --runs <n>                Number of Lighthouse runs, 1-20 (PERF_RUNS)       default 3
  --browser <auto|chrome|chromium|edge|brave>  Chromium-family browser (PERF_BROWSER)  default auto
  --chrome-path <path>      Explicit browser executable (CHROME_PATH)
  --build <id>              Build id / commit SHA (PERF_BUILD, GITHUB_SHA, or git HEAD)
  --label <text>            Test label / environment (PERF_LABEL)             default local | github-actions
  --baseline <latest|none|id|file>  Baseline run (PERF_BASELINE)              default latest compatible
  --allow-incompatible      Compare against an explicitly chosen but incompatible baseline anyway
  --thresholds <file.json>  Threshold overrides (see thresholds.example.json)
  --threshold name=warn,fail  Inline override, repeatable (e.g. lcp=2000,3000, regression.failPct=30)
  --throttling <simulate|devtools|provided>   default simulate
  --fail-on <fail|warning|never>   Which verdict gives a non-zero exit code (PERF_FAIL_ON)  default fail
  --data-dir <dir>          Output root (PERF_DATA_DIR)                       default ./perf-results
  --history-limit <n>       Max historical runs drawn in trend charts         default 30
  -i, --interactive         Prompt for the main options (ignored in CI / non-TTY)
  --list                    List stored runs and exit
  -h, --help

Exit codes: 0 PASS (or below --fail-on), 10 WARNING, 20 FAIL, 30 execution error, 64 bad arguments.`;

const log = (...a) => console.log(...a);
const die = (msg, code = EXIT.USAGE) => { console.error(`Error: ${msg}`); process.exit(code); };
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'na';
const num = (v, name, min, max) => { const n = Number(v); if (!Number.isInteger(n) || n < min || n > max) die(`${name} must be an integer ${min}-${max}`); return n; };

function gitSha() {
  if (env.GITHUB_SHA) return env.GITHUB_SHA.slice(0, 7);
  try { return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() || 'local'; } catch { return 'local'; }
}

/* ---------- options ---------- */
async function readOptions() {
  let v;
  try {
    ({ values: v } = parseArgs({ options: {
      url: { type: 'string' }, device: { type: 'string' }, runs: { type: 'string' }, browser: { type: 'string' }, 'chrome-path': { type: 'string' },
      build: { type: 'string' }, label: { type: 'string' }, baseline: { type: 'string' }, 'allow-incompatible': { type: 'boolean' },
      thresholds: { type: 'string' }, threshold: { type: 'string', multiple: true }, throttling: { type: 'string' }, 'fail-on': { type: 'string' },
      'data-dir': { type: 'string' }, 'history-limit': { type: 'string' }, interactive: { type: 'boolean', short: 'i' }, list: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
    }, strict: true }));
  } catch (e) { die(`${e.message}\n\n${HELP}`); }
  if (v.help) { log(HELP); process.exit(0); }

  const o = {
    url: v.url ?? env.PERF_URL ?? DEFAULT_URL,
    device: (v.device ?? env.PERF_DEVICE ?? 'mobile').toLowerCase(),
    runs: v.runs ?? env.PERF_RUNS ?? '3',
    browser: (v.browser ?? env.PERF_BROWSER ?? 'auto').toLowerCase(),
    chromePath: v['chrome-path'] ?? env.CHROME_PATH,
    build: v.build ?? env.PERF_BUILD ?? gitSha(),
    label: v.label ?? env.PERF_LABEL ?? (isCI ? 'github-actions' : 'local'),
    baseline: v.baseline ?? env.PERF_BASELINE ?? 'latest',
    allowIncompatible: Boolean(v['allow-incompatible']),
    throttling: (v.throttling ?? 'simulate').toLowerCase(),
    failOn: (v['fail-on'] ?? env.PERF_FAIL_ON ?? 'fail').toLowerCase(),
    dataDir: path.resolve(v['data-dir'] ?? env.PERF_DATA_DIR ?? './perf-results'),
    historyLimit: v['history-limit'] ?? '30',
    thresholdsFile: v.thresholds ?? env.PERF_THRESHOLDS,
    thresholdFlags: v.threshold ?? [],
    list: Boolean(v.list),
  };

  if (v.interactive && !isCI && process.stdin.isTTY) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const ask = async (q, d) => (await rl.question(`${q} [${d}]: `)).trim() || d;
    o.url = await ask('Target URL', o.url);
    o.device = (await ask('Device (mobile/desktop)', o.device)).toLowerCase();
    o.runs = await ask('Number of runs', o.runs);
    o.browser = (await ask('Browser (auto/chrome/edge/brave/chromium)', o.browser)).toLowerCase();
    o.build = await ask('Build id / commit', o.build);
    o.label = await ask('Label / environment', o.label);
    o.baseline = await ask('Baseline (latest/none/run id)', o.baseline);
    rl.close();
  } else if (v.interactive) log('Interactive mode ignored (CI or non-interactive terminal).');

  try { o.url = new URL(o.url).href; } catch { die(`Invalid URL: ${o.url}`); }
  if (!['mobile', 'desktop'].includes(o.device)) die('--device must be mobile or desktop');
  if (!['simulate', 'devtools', 'provided'].includes(o.throttling)) die('--throttling must be simulate, devtools or provided');
  if (!['fail', 'warning', 'never'].includes(o.failOn)) die('--fail-on must be fail, warning or never');
  if (!['auto', 'chrome', 'chromium', 'edge', 'brave'].includes(o.browser)) die('--browser must be auto, chrome, chromium, edge or brave (Lighthouse cannot drive Firefox or Safari)');
  o.runs = num(o.runs, '--runs', 1, 20);
  o.historyLimit = num(o.historyLimit, '--history-limit', 1, 500);
  return o;
}

async function loadThresholds(o) {
  let file = null;
  if (o.thresholdsFile) {
    try { file = JSON.parse(await readFile(o.thresholdsFile, 'utf8')); } catch (e) { die(`Cannot read thresholds file: ${e.message}`); }
  }
  try { return mergeThresholds(file, ...o.thresholdFlags.map(parseThresholdFlag)); } catch (e) { die(e.message); }
}

/* ---------- browser ---------- */
function browserPath(o) {
  if (o.chromePath) { if (!existsSync(o.chromePath)) die(`Browser not found at ${o.chromePath}`); return o.chromePath; }
  if (o.browser === 'auto') return undefined; // chrome-launcher auto-detects (honours CHROME_PATH)
  const p = process.platform, roots = [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].filter(Boolean);
  const win = (...rel) => roots.map((r) => path.join(r, ...rel));
  const table = {
    chrome: { win32: win('Google', 'Chrome', 'Application', 'chrome.exe'), darwin: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'], linux: ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable'] },
    chromium: { win32: win('Chromium', 'Application', 'chrome.exe'), darwin: ['/Applications/Chromium.app/Contents/MacOS/Chromium'], linux: ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium'] },
    edge: { win32: win('Microsoft', 'Edge', 'Application', 'msedge.exe'), darwin: ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'], linux: ['/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable'] },
    brave: { win32: win('BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'), darwin: ['/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'], linux: ['/usr/bin/brave-browser'] },
  };
  const found = (table[o.browser][p] ?? []).find((c) => existsSync(c));
  if (found) return found;
  if (o.browser === 'chrome') return undefined;
  die(`Could not find ${o.browser}. Install it or pass --chrome-path.`);
}

function lighthouseFlags(o) {
  const f = { output: 'json', logLevel: 'error', onlyCategories: ['performance', 'accessibility', 'best-practices', 'seo'], throttlingMethod: o.throttling, formFactor: o.device };
  if (o.device === 'desktop') {
    Object.assign(f, {
      screenEmulation: { mobile: false, width: 1350, height: 940, deviceScaleFactor: 1, disabled: false },
      throttling: { rttMs: 40, throughputKbps: 10240, cpuSlowdownMultiplier: 1, requestLatencyMs: 0, downloadThroughputKbps: 0, uploadThroughputKbps: 0 },
      emulatedUserAgent: DESKTOP_UA,
    });
  }
  return f;
}

async function runOnce(o, chromePath) {
  const flags = ['--headless=new', '--disable-gpu', '--disable-dev-shm-usage', '--no-first-run', '--mute-audio'];
  if (isCI || env.PERF_NO_SANDBOX === '1') flags.push('--no-sandbox');
  const chrome = await chromeLauncher.launch({ chromePath, chromeFlags: flags });
  try {
    const rr = await lighthouse(o.url, { ...lighthouseFlags(o), port: chrome.port });
    if (!rr?.lhr) throw new Error('Lighthouse returned no result');
    if (rr.lhr.runtimeError) throw new Error(`${rr.lhr.runtimeError.code}: ${rr.lhr.runtimeError.message}`);
    return { lhr: rr.lhr, json: rr.report };
  } finally {
    try { await chrome.kill(); } catch { /* Windows may fail to delete the temp profile; harmless */ }
  }
}

/* ---------- history ---------- */
async function loadHistory(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const f of await readdir(dir)) {
    if (!f.endsWith('.json')) continue;
    try { const j = JSON.parse(await readFile(path.join(dir, f), 'utf8')); if (j?.id && j.summary && j.compat) out.push({ ...j, _file: f }); } catch { /* skip corrupt */ }
  }
  return out.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

async function pickBaseline(history, spec, compat, allowIncompatible) {
  if (spec === 'none') return { mode: 'none', usable: false, reasons: [] };
  if (spec === 'latest') {
    const rec = [...history].reverse().find((h) => compatReasons(h.compat, compat).length === 0);
    if (rec) return { mode: 'latest', record: rec, id: rec.id, timestamp: rec.timestamp, build: rec.build, usable: true, reasons: [] };
    return { mode: 'latest', usable: false, reasons: [], note: history.length ? `No compatible previous run among ${history.length} stored (different URL, device, throttling, label or Lighthouse major). This run becomes a new baseline.` : 'No previous runs found. This run becomes the first baseline.' };
  }
  let rec = history.find((h) => h.id === spec || h._file === spec) ?? history.find((h) => h.id.startsWith(spec));
  if (!rec && existsSync(spec)) { try { rec = JSON.parse(await readFile(spec, 'utf8')); } catch { /* fallthrough */ } }
  if (!rec?.summary) die(`Baseline "${spec}" not found. Use --list to see stored runs.`);
  const reasons = compatReasons(rec.compat, compat);
  return { mode: 'explicit', record: rec, id: rec.id, timestamp: rec.timestamp, build: rec.build, reasons, usable: reasons.length === 0 || allowIncompatible };
}

/* ---------- output helpers ---------- */
function consoleSummary(rec) {
  const pad = (s, n) => String(s).padEnd(n);
  log(`\n${'='.repeat(78)}\n ${rec.verdict.status}   ${rec.url}  (${rec.config.formFactor}, build ${rec.build}, ${rec.runs.length} run(s))\n${'='.repeat(78)}`);
  log(` ${pad('Metric', 26)}${pad('Median', 12)}${pad('Baseline', 12)}${pad('Change', 14)}Status`);
  for (const k of Object.keys(METRICS)) {
    const c = rec.comparison?.metrics?.[k];
    const use = rec.baselineInfo?.usable && c;
    log(` ${pad(METRICS[k].label, 26)}${pad(fmt(k, rec.summary[k].median), 12)}${pad(use ? fmt(k, c.prev) : '—', 12)}${pad(use && c.abs != null ? `${fmtDelta(k, c.abs)}${c.pct != null ? ` ${c.pct > 0 ? '+' : ''}${c.pct.toFixed(1)}%` : ''}` : '—', 14)}${use ? c.status : ''}`);
  }
  if (rec.verdict.reasons.length) { log('\n Reasons:'); rec.verdict.reasons.forEach((r) => log(`  [${r.level}] ${r.message}`)); }
  if (rec.baselineInfo?.note) log(`\n ${rec.baselineInfo.note}`);
  if (rec.baselineInfo && !rec.baselineInfo.usable && rec.baselineInfo.reasons?.length) log(`\n Baseline ${rec.baselineInfo.id} is incompatible (${rec.baselineInfo.reasons.join('; ')}); comparison skipped.`);
}

function markdownSummary(rec) {
  const lines = [`## Lighthouse: ${rec.verdict.status}`, `${rec.url} · ${rec.config.formFactor} · build \`${rec.build}\` · median of ${rec.runs.length}`, '', '| Metric | Median | Baseline | Change | Status |', '|---|---|---|---|---|'];
  for (const k of Object.keys(METRICS)) {
    const c = rec.baselineInfo?.usable ? rec.comparison?.metrics?.[k] : null;
    lines.push(`| ${METRICS[k].label} | ${fmt(k, rec.summary[k].median)} | ${c ? fmt(k, c.prev) : '—'} | ${c && c.abs != null ? fmtDelta(k, c.abs) : '—'} | ${c ? c.status : ''} |`);
  }
  if (rec.verdict.reasons.length) lines.push('', ...rec.verdict.reasons.map((r) => `- **${r.level}** ${r.message}`));
  return lines.join('\n') + '\n';
}

/* ---------- main ---------- */
async function main() {
  const o = await readOptions();
  const histDir = path.join(o.dataDir, 'history'), rawRoot = path.join(o.dataDir, 'raw'), repDir = path.join(o.dataDir, 'reports');
  const history = await loadHistory(histDir);

  if (o.list) {
    if (!history.length) log('No stored runs.');
    for (const h of history) log(`${h.id}   perf ${fmt('performance', h.summary.performance?.median)}  LCP ${fmt('lcp', h.summary.lcp?.median)}  ${h.verdict?.status ?? ''}`);
    return EXIT.PASS;
  }

  const thresholds = await loadThresholds(o);
  const chromePath = browserPath(o);
  await Promise.all([histDir, rawRoot, repDir].map((d) => mkdir(d, { recursive: true })));

  const started = new Date();
  const stamp = started.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  let id = `${stamp}_${o.device}_${slug(o.label)}_${slug(o.build)}`, n = 1;
  while (existsSync(path.join(histDir, `${id}.json`))) id = `${stamp}_${o.device}_${slug(o.label)}_${slug(o.build)}-${++n}`;

  log(`Lighthouse ${o.runs}x on ${o.url} [${o.device}, ${o.throttling} throttling] ...`);
  const ok = [], errors = [];
  for (let i = 1; i <= o.runs; i++) {
    try {
      const t0 = Date.now();
      const res = await runOnce(o, chromePath);
      const rawRel = path.join('raw', id, `run-${i}.json`);
      await mkdir(path.join(o.dataDir, 'raw', id), { recursive: true });
      await writeFile(path.join(o.dataDir, rawRel), res.json); // untouched original Lighthouse JSON
      ok.push({ run: i, lhr: res.lhr, metrics: extractRunMetrics(res.lhr), rawFile: rawRel.split(path.sep).join('/') });
      log(`  run ${i}/${o.runs}: perf ${ok.at(-1).metrics.performance}, LCP ${fmt('lcp', ok.at(-1).metrics.lcp)} (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
    } catch (e) {
      errors.push({ run: i, message: e.message });
      console.error(`  run ${i}/${o.runs} FAILED: ${e.message}`);
    }
  }
  if (!ok.length) die(`All ${o.runs} runs failed. Check the URL, browser installation and network. ${errors[0]?.message ?? ''}`, EXIT.ERROR);

  const metricsList = ok.map((r) => r.metrics);
  const summary = summarize(metricsList);
  const repIdx = representativeIndex(metricsList, summary);
  const first = ok[0].lhr, cs = first.configSettings;
  const ua = first.environment?.hostUserAgent ?? '';
  const browserVer = (ua.match(/(?:Headless)?Chrome\/[\d.]+/) ?? [ua || 'unknown'])[0] + (/Edg\//.test(ua) ? ` (Edge ${ua.match(/Edg\/([\d.]+)/)[1]})` : '');
  const compat = {
    url: o.url, label: o.label, formFactor: cs.formFactor, throttlingMethod: cs.throttlingMethod,
    throttling: cs.throttling, lighthouseMajor: Number(String(first.lighthouseVersion).split('.')[0]),
  };

  const baselineInfo = await pickBaseline(history, o.baseline, compat, o.allowIncompatible);
  if (baselineInfo.record && baselineInfo.reasons?.length) baselineInfo.forced = baselineInfo.usable;
  const comparison = baselineInfo.usable && baselineInfo.record ? compareSummaries(summary, baselineInfo.record.summary, thresholds.regression) : null;
  const thresholdResults = evaluateThresholds(summary, thresholds);
  const verdict = computeVerdict({ thresholdResults, comparison, errors, runsRequested: o.runs });

  const record = {
    schemaVersion: 1, id, timestamp: started.toISOString(), url: o.url, finalUrl: first.finalDisplayedUrl ?? first.finalUrl, build: o.build, label: o.label,
    tool: { lighthouse: first.lighthouseVersion, browser: browserVer, hostUserAgent: ua, node: process.version, platform: `${os.platform()} ${os.release()} ${os.arch()}`, ci: isCI },
    config: { formFactor: cs.formFactor, throttlingMethod: cs.throttlingMethod, throttling: cs.throttling, screenEmulation: cs.screenEmulation, runsRequested: o.runs, browserOption: o.browser, categories: cs.onlyCategories },
    compat, runs: ok.map((r) => ({ run: r.run, metrics: r.metrics, benchmarkIndex: r.lhr.environment?.benchmarkIndex ?? null, fetchTime: r.lhr.fetchTime, rawFile: r.rawFile })),
    errors, representativeRun: ok[repIdx].run, summary, findings: extractFindings(ok[repIdx].lhr),
    thresholds, thresholdResults,
    baselineInfo: { mode: baselineInfo.mode, id: baselineInfo.id ?? null, timestamp: baselineInfo.timestamp ?? null, build: baselineInfo.build ?? null, usable: Boolean(comparison), reasons: baselineInfo.reasons ?? [], note: baselineInfo.note ?? null, record: Boolean(baselineInfo.record) },
    comparison, verdict,
  };

  await writeFile(path.join(histDir, `${id}.json`), JSON.stringify(record, null, 2), { flag: 'wx' }); // never overwrites

  const compatHistory = history.filter((h) => compatReasons(h.compat, compat).length === 0).slice(-(o.historyLimit - 1));
  const html = renderReport({ record, trend: [...compatHistory, record], thresholds });
  const reportFile = path.join(repDir, `${id}.html`);
  await writeFile(reportFile, html);
  await copyFile(reportFile, path.join(repDir, 'latest.html'));
  await writeFile(path.join(repDir, 'latest-summary.md'), markdownSummary(record));
  if (env.GITHUB_STEP_SUMMARY) await appendFile(env.GITHUB_STEP_SUMMARY, markdownSummary(record));

  consoleSummary(record);
  log(`\nResult : ${path.join(histDir, `${id}.json`)}\nRaw LH : ${path.join(rawRoot, id)}\nReport : ${reportFile}`);

  const rank = { PASS: 0, WARNING: 1, FAIL: 2 };
  const limit = { fail: 2, warning: 1, never: 99 }[o.failOn];
  return rank[verdict.status] >= limit ? EXIT[verdict.status] : EXIT.PASS;
}

main().then((code) => { process.exitCode = code; }, (e) => { console.error(e); process.exitCode = EXIT.ERROR; });
