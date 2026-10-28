# Portfolio Lighthouse monitor

One Node.js script: runs Lighthouse N times, takes the median, saves history, compares with a baseline,
applies thresholds, writes a self-contained HTML report and returns a CI-friendly exit code.

## Install (Windows 11, PowerShell)

```powershell
node --version            # needs 18.20+ (20 or 22 recommended)
cd lighthouse-monitor
npm install
```
You need Chrome, Edge, Brave or Chromium installed. Edge ships with Windows 11, so this works with no extra install:

```powershell
npm run perf -- --browser edge
```

## Run

```powershell
# defaults: your portfolio URL, mobile, 3 runs, compare with latest compatible run
npm run perf

# desktop, 5 runs, build id, label, custom thresholds, explicit baseline
npm run perf -- --device desktop --runs 5 --build v1.4.0 --label prod `
  --thresholds thresholds.example.json --baseline latest

# compare against a specific stored run (see ids with: npm run perf:list)
npm run perf -- --runs 3 --baseline 20261028T101500Z_mobile_local_abc1234

# inline threshold overrides
npm run perf -- --threshold lcp=2000,3000 --threshold regression.failPct=30

# prompts for the main options (ignored automatically in CI)
npm run perf -- --interactive
```
Open `perf-results\reports\latest.html` in any browser. No server needed.

Every option also has an environment variable (`PERF_URL`, `PERF_DEVICE`, `PERF_RUNS`, `PERF_BUILD`, `PERF_LABEL`,
`PERF_BASELINE`, `PERF_BROWSER`, `CHROME_PATH`, `PERF_DATA_DIR`, `PERF_FAIL_ON`, `PERF_THRESHOLDS`). CLI flags win.
Run `node src/perf.mjs --help` for the full list.

## Browsers

Lighthouse drives **Chromium-family browsers only**, over the Chrome DevTools Protocol:
Chrome, Chromium, Edge (Chromium-based) and Brave. **Firefox and Safari cannot be audited by Lighthouse.**
Use `--browser auto|chrome|chromium|edge|brave` or `--chrome-path <exe>`. Scores can differ slightly between
browsers, so the browser version is stored with every run.

## Lab vs field data

Everything here is **lab data**: one machine, emulated device, simulated throttling. It is good for catching
regressions, but it is not what real users experience. Real-user (field) data comes from CrUX / PageSpeed Insights
or RUM. A lab run cannot give a representative **INP**, because INP needs real interactions; use **TBT** as the lab proxy.
TTFB here is Lighthouse's root-document server response time.

## What is stored

```
perf-results/
  history/<run-id>.json      one file per execution, never overwritten (metrics, runs, median, comparison, verdict)
  raw/<run-id>/run-N.json    untouched Lighthouse JSON for each run
  reports/<run-id>.html      report per execution
  reports/latest.html        most recent report (overwritten)
  reports/latest-summary.md  markdown summary (also appended to the GitHub job summary)
```

### Comparison rules
- Representative value = **median** of the successful runs; min/max/stdev/CV% are stored and shown.
- A baseline is *compatible* when URL, label/environment, device, throttling and Lighthouse **major** version match.
  Numbers from a laptop and a GitHub runner are not comparable, which is why the default label differs
  (`local` vs `github-actions`). An incompatible explicit baseline is flagged and skipped unless `--allow-incompatible`.
- Change = current − previous, plus percentage (shown as "—" for a zero baseline).
- A change counts as *unchanged* inside the noise band (default 5 % and a per-metric minimum such as 100 ms LCP).
- Regressions of at least `warnPct` (10 %) give WARNING, at least `failPct` (25 %) give FAIL.
  Requests and uncompressed size are informational and never gate.

## Thresholds and exit codes

`thresholds.example.json` shows every key. Lower-is-better metrics breach when the value is **above** warn/fail,
scores when **below**. Set a key to `null` to disable it. A threshold metric with no measurement is **FAIL**, never a pass.

| Exit code | Meaning |
|---|---|
| 0 | PASS (or verdict below `--fail-on`) |
| 10 | WARNING (only with `--fail-on warning`) |
| 20 | FAIL |
| 30 | Execution error (e.g. all runs failed) |
| 64 | Bad arguments |

`--fail-on fail` (default) lets warnings pass; `--fail-on warning` is stricter; `never` always exits 0.

## Reading the report

1. **Verdict badge** is the worst of threshold results and baseline regressions.
2. **KPI cards**: median value, colour = threshold status, chip = change vs baseline (red ▲ on LCP means slower).
   CV% on the card shows run-to-run noise; above about 15 % treat small deltas with suspicion.
3. **Comparison table**: previous, current, absolute and % change, status.
4. **Trends**: line = median, faint bar = min to max of that run set, dashed amber/red = warn/fail limits,
   hollow dot = this run. Only compatible runs are plotted.
5. **Opportunities / diagnostics** come from the representative (median) run, sorted by estimated saving.
   Savings are estimates, not guarantees.

## GitHub Actions

Runners have Chrome preinstalled. The script adds `--no-sandbox` automatically when `CI=true`.

```yaml
name: lighthouse
on:
  schedule: [{ cron: "0 3 * * *" }]
  workflow_dispatch:
jobs:
  perf:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: npm }
      - run: npm ci            # commit package-lock.json first (run npm install locally once)
      # Restore history so the run has something to compare with (see trade-offs below)
      - uses: actions/cache/restore@v4
        with:
          path: perf-results
          key: perf-history-${{ github.run_id }}
          restore-keys: perf-history-
      - run: node src/perf.mjs --device mobile --runs 3 --thresholds thresholds.example.json
      - uses: actions/cache/save@v4
        if: always()
        with: { path: perf-results, key: "perf-history-${{ github.run_id }}" }
      - uses: actions/upload-artifact@v4
        if: always()
        with: { name: lighthouse-report, path: perf-results/reports }
```

### Where to keep history: trade-offs

| Option | Pros | Cons |
|---|---|---|
| **Artifacts only** | Simple, nothing committed | A fresh run starts with no history. Retention is limited (90 days by default), and you must download the previous artifact to compare. |
| **actions/cache** (above) | No commits; rolling history works with `restore-keys` | Entries are evicted after 7 days unused or when you hit the repo cache limit; not meant as permanent storage; stale caches are not guaranteed. |
| **Dedicated history branch** (e.g. `perf-data`) | Permanent, diffable, and viewable on GitHub | Needs `contents: write`, a commit step and some git plumbing; repo grows with raw JSON (consider not committing `raw/`, or pruning). Daily bot commits add noise, so keep them off `main`. |

For a daily portfolio check, cache plus artifact upload is the lightest start. Move to a history branch when you want
a permanent trend line. Nothing in the script commits files automatically.

## Notes
- Each run launches a fresh browser; Lighthouse also clears storage, so runs are cold-cache.
- Netlify's current default domain is `*.netlify.app`. If `https://johndavidportfolio.netlify.com` does not resolve or redirects,
  pass `--url https://<your-site>.netlify.app`. The report shows the final URL after redirects.
- Don't compare a CPU-throttled mobile run with a desktop run; the compatibility check prevents it.
