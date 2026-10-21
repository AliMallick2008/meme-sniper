# BTC Paper Lab + Meme Sniper: handoff for Claude Code

This repo is the whole project: a paper-trading dashboard (BTC bots, meme coin bots, the Meme Sniper lab) and the
24/7 server that runs the Meme Sniper bots on GitHub Actions. It moved here from a long Claude app chat on Oct 21 2026;
`docs/PROJECT_NOTES.md` is that chat's running log (every bot's locked rules, start times, verification, results).
Read it before changing anything.

## Ground rules (from the owner, keep them)

- **Paper only.** No wallets, private keys, exchange accounts or real orders, ever. Every number is simulated from public data.
- **Locked rules never change.** Each bot's rules were locked at a recorded time before its start. An improvement is a
  new version with its own lock time and start, running beside the old one. Never edit a running bot's rules.
- **Protocol first.** For research, write the test protocol (data, split, metrics, pick rule) before looking at
  outcomes; choose on training data, judge on hidden data. See `research/*_protocol.md`.
- **Verify like it matters.** Every bot change is checked against an independent re-implementation (Python reference)
  on synthetic markets with a fake clock, plus restarts and API failures. Don't ship unverified.
- **The owner's style:** casual, short, specific, no filler. Never use em dashes in anything you write for him. He wants
  autonomy: don't stop to ask, pick the sensible option, say what you picked, keep working toward the goal (a bot that
  makes money every day, on paper first).

## Layout

```
server/                 the Meme Sniper server (Node 22, no dependencies)
  sniper.js             engine: pump.fun bonding-curve math, fees, entries/exits, memes, and the LOCKED v10 RULES
  sniper_core.js        the bots: discovery, rug checks, watchlists, candles, buys/sells (shared with the page)
  main.js               server loop (state saves, research, handover)
  run.js                GitHub Actions entry
  gitstore.js           state on the `data` branch, research on the `research` branch
  research.js           records every $7K crossing with its checks and final 1-minute candles
  sim.js                the same loop on a virtual clock against a mock market (tests)
dashboard/              the web page (one self-contained HTML file)
  page.html style.css engine.js meme.js ui.js sniper_ui.js research.json
  build.py              -> dashboard/dist/btc-paper-lab.html, dist/site/ (GitHub Pages), dist/btc-paper-lab-site.zip (Netlify)
  vendor/               TradingView Lightweight Charts 4.2.3 (Apache-2.0)
  tests/                Python + Playwright tests, Python reference implementation, fixtures
research/               research protocols
docs/PROJECT_NOTES.md   full history and current numbers
.github/workflows/      sniper.yml (bots), watchdog.yml (restarts), dashboard.yml (builds + publishes the page)
```

`server/sniper.js` and `server/sniper_core.js` are the only copies: `dashboard/build.py` inlines them into the page, so
the page's local mode and the server run identical code.

## How it runs

- **Bots:** `sniper.yml` runs `node server/run.js` for 5 h 45 min, saving state every 2 min (within 15 s after a buy,
  sell or new watch). At the end it dispatches the next run, which waits in the `sniper` concurrency group until the old
  one exits (handover measured at 3 s). Every 5 min the bot checks `main`; a new commit makes it hand over to the new
  code. `watchdog.yml` (cron 7/27/47) starts a run if none is going or waiting.
- **State:** branch `data`, one force-pushed commit with no history: `state.json` (what the page reads: `srv` health
  info + journal `J`), `young.json` (coins being followed), `rq.json` (research queue), `tc/<mint>.json` (chart candles
  of traded coins). Never hand-edit it while a run is going.
- **Research:** branch `research`, gzipped JSON lines, one file per hour per run: every coin that crossed $7K, its
  point-in-time checks, and its final 1-minute candles from launch to 2 h after the crossing (+ SOL/USD per minute).
- **Page:** https://alimallick2008.github.io/meme-sniper/ (branch `gh-pages`, published by `dashboard.yml` on every
  push to `main` that touches the page or the engine). Server mode reads `state.json` from the GitHub API (60 calls/h
  per IP without login; the page uses about 40) and falls back to raw.githubusercontent.com. Live charts and prices come
  straight from GeckoTerminal and DexScreener in the browser. Local mode (bots in the tab) only if the browser never
  reached the server.
- **Data sources and limits:** Jupiter tokens v2 (new coins, audit), DexScreener (market caps, live prices),
  RugCheck, GeckoTerminal (1-minute OHLCV, free API: keep it near 8 calls/min, the lane adapts on 429), Coinbase
  (SOL/USD, BTC, meme coins). GeckoTerminal wants whole-second timestamps.
- **Decisions use final candles only** (GeckoTerminal 1-minute, `include_empty_intervals=true`); live prices only mark
  positions and decide which coins need candles. So a gap in running time never changes a trade: watched and held coins
  are replayed from candles. Launches during a gap are not scanned.

## Build, test, deploy

Needs Node 22 and Python 3 with `playwright` and `pillow` (Chromium from Playwright, or set `CHROMIUM=/path/to/chrome`).

```bash
python3 dashboard/build.py                          # build the page
for f in dashboard/dist/_s*.js; do node --check $f; done
node dashboard/tests/engine_unit.js                 # 22 engine unit tests (curve math, fills, rearm, memes)
python3 dashboard/tests/server_sim_test.py 2.5 3    # server bots in 3 runs (handover + 21 min outage) vs the Python reference, research records vs market (~6 min)
python3 dashboard/tests/server_page_check.py        # page in server mode on that output: same bots, chart, replay, API budget, takeover (~3 min)
python3 dashboard/tests/sniper_e2e_run.py           # page local mode, scripted 3.2 h market vs reference (~10 min)
python3 dashboard/tests/sniper_e2e_more.py          # flaky APIs, reload, closed 37 min, two tabs
python3 dashboard/tests/sniper_e2e_busy.py          # 150 crossings stress, GeckoTerminal budget
```

Test outputs go to `dashboard/.out/`. Every result must say `ALL BOTS MATCH` / `SERVER PAGE OK`.
Deploy = push to `main`: the dashboard workflow publishes the page, and the running bot picks up server changes within 5 min.

## Status (Oct 21 2026, 4:45 AM ET)

- Server live since 4:19 AM ET (journal start). All five data sources healthy from the GitHub runner; first coins
  passed the checks within minutes. Every bot started with 10 paper SOL.
- BTC side (21 bots since Oct 16 8 PM ET, the Meme Coin Trader, the Solana Meme Trader) runs in the page by replaying
  Coinbase candles from fixed start times; nothing to run on a server. Results in `docs/PROJECT_NOTES.md`.
- Next: (1) watch the first natural handover (~10:04 AM ET) and the first research files; (2) once 1,000 crossings are
  recorded, run the sniper research per `research/sniper_protocol.md` Amendments 3 and 4 (first 60% choose, last 40%
  judge) and only then propose a new locked version; (3) `state.json` grows with trades (~180 KB now): compact old
  trades if it passes ~600 KB; (4) the stray branch `data-test` can be deleted.
