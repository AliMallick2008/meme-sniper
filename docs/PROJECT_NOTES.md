# BTC Paper Lab, forward test v10.1 (21 dollar bots + the 10 SOL Solana Meme Trader + the Meme Sniper lab, now on a server)

Starts Fri Oct 16, 2026, 8:00 PM ET (2026-10-17 00:00 UTC). $8,000 paper money per bot. Rules locked before the start; any change = new version with a new start time. History: v2 limit-first orders for Trend Swing; v3 added Half-Size, Leveraged, Multi-Speed; v4 added 10 strategy-lab bots; v5 added the 1h/15m Trader (own start 11 PM ET); v6 added the Futures Breakout (own start Sat 3:00 AM ET); v7 added the Combo 50/50 (own start Sat 8:00 PM ET, delivered Mon Oct 19 5:05 PM ET); v8 adds the Meme Coin Trader (own start Mon Oct 19 8:00 PM ET). Earlier bots verified identical, trade for trade, across v4 to v7.

## Meme Sniper v11 (the Oct 21 audit, Section E). RULES LOCKED Wed Oct 21, 2026, 6:45 AM ET (10:45 UTC)
Requested Oct 21 4:56 AM ET: implement Section E phases 0-5 in order with tests T01-T20; continued in Claude Code
(branch `claude/v11-audit`, AliMallick2008/meme-sniper#1). Evidence: `docs/v11-report.md`. Legacy v10 bots unchanged.
- Engine `server/v11/`: event-driven, only acts on what had arrived. Watch starts when the last check arrived (not the
  crossing); signals are live observations; fills only from a Jupiter quote requested after the decision (0.5% latency
  allowance, 0.0002 SOL priority + 0.000005 network fee per swap, 0.00203928 SOL token-account rent locked while
  holding); marks from a sell quote, the quote-calibrated model or the model at a fresh price, else UNPRICEABLE with the
  last value and a worst case; SOL/USD backwards only; gaps over 90 s book nothing (orders cancelled, watches re-armed,
  would-be exits recorded as hypothetical); graduation pauses fills; stale or broken data halts entries.
- Accounts (10 paper SOL each, start = first server run after the lock): E0-U, E0-U2, E0-U30, E0-T25, E0-D55, E0-GRN,
  E0-STR (legacy rules exactly, honest timing; a buy fills only within 10% of the signal price), HOLD, and the new
  A (launch momentum), B (confirmed pullback), C (after graduation): strict four-valued gates, size from depth, risk
  budget 0.3 SOL, break-even under 12%, reachable protective level, ranked at a common decision time, thesis exits on two
  independent evidence families (structure, buy/sell flow, liquidity, holders) for 20 s or one verified emergency,
  trailing guard, horizons 20 min / 45 min / 2 h. Thresholds are first guesses, not tuned.
- Social: no approved X/Telegram source, so status `unavailable`; claims shown unverified; the old meme check is a name
  cluster (context only).
- Verified: 27 node tests (T01-T20, replay, Phase 0 guards); simulator (3 runs, 50 s handover, 22 min outage): legacy bots still match
  their reference exactly, v11 invariants hold, the 7 E0 accounts match an independent Python reference exactly over
  159,203 events, and an exact replay of the trace reproduces every account's books; page in server mode OK.
- Live observation before v11 (reconcile.js on the live journal, 10:14 UTC): every legacy position has a stop under the
  curve floor; both GRN trades were booked 3-5 min after their candles at their own signal candle's close; U, U2, U30,
  T25 and D55 have held "ok" since 08:28 UTC, after it died at the floor at 08:31; U30 is past its 30-min limit because
  legacy time limits need a new candle and a dead coin has none. At 10:27 "ok" printed a candle: U30 booked its 08:57
  exit 94 min late, then within 2 min two past trades (DAWKOIN at a 09:03 candle booked 10:33, TILLY at 09:49 booked 10:35).
- Not verifiable from the Claude Code session (network policy blocks the market APIs): live field shapes (taken from
  the earlier probes), pump.fun fee tiers above 9,820 SOL.

## Live check, Wed Oct 21, 3:16 AM ET (4 d 7 h in; BTC $82,689 vs $81,500 at the start)
Replayed the delivered v10 page on a fresh Coinbase capture through the browser pane (BTC 5m/1h/1d, 22 meme coins daily, SOL + 11 Solana memes hourly; sha256 f922b5a4...). Balances if closed now:
Meme Coin Trader $8,528.59 (+$528.59, holding PEPE since Mon 8 PM) | Solana Meme Trader 10.533 SOL (+0.533, holding PENGU since Mon 6 PM; ~$1,117 at SOL $106.07) | Leveraged $8,114.61 | Trend Swing $8,034.39 (first trade still open) | Multi-Speed $8,027.79 | Half-Size $8,017.20 | Buy & Hold $8,000.78 | Futures Breakout $7,651.58 (-$348.42: 3 longs, all stopped: Sun, Mon, Tue) | Combo $7,849.02 (same 3 futures stops; swing half +$23.23) | Old Bot $6,633.57 (34 trades, $1,215.61 fees) | 1h/15m and Day Trader no trades. Meme Sniper runs in the user's browser: not visible from here.
Sniper research: the Oct 19 recorder data was lost (pane closed), and so was the Oct 21 one (restarted 3:21 AM ET; the browser pane closed ~4:25 AM ET with the data in memory). Research now uses the server's own recording (research branch, protocol Amendments 3 and 4: first 60% of crossings choose, last 40% judge, from 1,000 recorded crossings).

## Meme Sniper on a server (v10.1), Wed Oct 21, 2026. Same locked rules, runs 24/7 on GitHub Actions
Requested Oct 21 3:26 AM ET: "make it so my computer doesn't have to be on". User created the public repo AliMallick2008/meme-sniper (3:32 AM) and installed the Claude GitHub app on it (3:39 AM).
- Code: one shared bot core, app/sniper_core.js (everything the page's bots did: lanes, discovery, checks, watch, candles, entries/exits), used by the page AND the server; rules from app/sniper.js RULES (locked v10 rules moved there unchanged). Server files in the repo's server/: main.js (loop), run.js (GitHub entry), gitstore.js (state + research storage), research.js (recorder), sim.js (virtual-clock simulator for tests), copies of sniper.js + sniper_core.js.
- Workflows: sniper.yml (workflow_dispatch; concurrency group "sniper"; one run = 5 h 45 min, then it dispatches its successor, which waits until it has saved and exited; checks main every 5 min and hands over to new code), watchdog.yml (cron 7/27/47 past each hour: starts a run if none is going or waiting).
- Storage: branch `data` = one force-pushed commit, no history: state.json (what the page reads: srv info + journal without trade candles), young.json (coins being followed), rq.json (research queue), tc/<mint>.json (chart candles of traded coins). Saved every 2 min, within 15 s after a buy/sell/new watch. Branch `research` = gzipped JSON lines, one per coin that crossed $7K: point-in-time checks + 1-minute candles from launch to 2 h 05 min after the crossing (+ SOL/USD per minute), one file per hour per run (REST contents API).
- Page v10.1: server mode by default. Reads state.json from api.github.com contents (raw, fresh; 60/h/IP free limit, page uses ~40/h) and falls back to raw.githubusercontent.com (CDN, up to 5 min old). Live chart candles and prices still come straight from GeckoTerminal/DexScreener in the browser; old trades' candles from tc/ files. Toasts for new server buys/sells. Local mode (bots in the tab, as v10) only if this browser never reached the server; it switches to server mode as soon as the server answers, and shows the earlier browser run's balances under the lab.
- Verified before going live: (1) page refactor gives v10's results exactly in local mode: scripted 3.2 h scenario ALL BOTS MATCH; flaky APIs + reload + closed 37 min + two tabs all MATCH, no duplicate events. (2) Server in the simulator (server/sim.js, virtual clock, mock market over HTTP; app/server_sim_test.py): busy market (128 crossings) as 3 server runs with a 50 s handover and a 21 min outage: all 7 bots = independent Python replay; 128 research records, 0 differ from the market's final candles; GeckoTerminal max 8.0 calls/min (mean 5.4). (3) Page in server mode (app/server_page_check.py): shows the server's bots exactly, chart + replay of an old trade from the server's tc file, 35 GitHub API calls/hour, phone width OK, local -> server takeover works and shows the earlier browser run. (4) gitstore tested against the real repo (throwaway branch data-test; the proxy blocks deleting it, harmless).
- LIVE: first server run 39568378546 started Wed Oct 21 4:19 AM ET (J.start). From the GitHub runner: Jupiter, DexScreener, RugCheck, Coinbase all OK at once; 79 launches and 6 crossings in the first 2 min (all failed: no meme history yet, plus top-holder and RugCheck flags).
- Dashboard now also on GitHub Pages: https://alimallick2008.github.io/meme-sniper/ (gh-pages branch, auto-enabled on first push; app/publish_pages.sh republishes, so updates no longer need a Netlify upload). Checked in a real browser: server mode via the API, status line live.
- First minutes live: handover to new code tested for real at 4:24 AM ET (old run exited 08:24:35 UTC, new one running 08:24:38, journal carried over); GeckoTerminal OK from the runner; first coin passed the checks at ~4:26 AM ET and 6 bots started watching it. A server check-in is scheduled for 10:30 AM ET (after the first natural handover ~10:04 AM ET).
- Follow-ups: state.json grows with trades (~180 KB now); compact old trades if it passes ~600 KB. Research analysis per research/sniper_protocol.md Amendment 3 once server data accumulates.

## Meme Sniper (v10). RULES LOCKED Tue Oct 20, 2026, 8:25 AM ET (12:25 UTC). New default tab "Meme Sniper"
Requested Oct 19 6:06 PM ET (interrupted) and Oct 20 5:49 AM ET: new pump.fun coins at $7K+ market cap, pick one on current memes, all rug checks, buy only on 40% dips, hold until profitable or until it falls to 10% of the buy-in; improve the strategy; show the exact chart traded with buys and sells in real time, switching charts when the bot moves to another coin. Paper only.
- Runs in the visitor's browser while the page is open (one tab leads; others only display; leader handover on close). Journal in localStorage `bpl_snipe_v2`. Each bot: 10 paper SOL, 1 SOL per trade, one coin at a time.
- Pipeline: Jupiter tokens/v2/recent (new pump.fun coins, every 12 s) -> followed on DexScreener tokens/v1 (75 min; dropped at 20 min under $4.5K) -> crossing at $7K market cap -> checks once (Jupiter audit: mint/freeze authority, dev %, top holders %, dev mints; RugCheck summary danger flags; meme = another coin with a shared name word crossed $7K in the last 2 h) -> watch 2 h (max 6 coins per bot; a stronger-scoring coin swaps out the weakest far-from-zone one) -> buy at 0.60 x high since launch (limit fill at min(open, level)) -> sell at +1% after all costs or at 10% of the buy price.
- Every buy and sell is decided on FINAL GeckoTerminal 1-minute candles (include_empty_intervals; final = before the newest candle, or 3 minutes old for quiet coins); entries commit only after every other watched coin is known not to have dipped earlier (first dip wins). Live DexScreener prices (every 8 s) only mark positions, move the last candle and decide which coins need candles (GeckoTerminal free API ~10 calls/min: adaptive lane, 7.5 s min gap).
- Re-arm rule (added while building, before any live trade): a coin already under its buy level when a bot starts watching it or frees up is not bought there; it must trade back above the level first. Without it, bots that were busy bought coins down 90%+.
- Costs: pump.fun 1.25% per side (PumpSwap tiers after graduation), 1% execution slippage per side, exact constant-product impact (curve k = 30 SOL x 1.073e9 tokens; PumpSwap 85 SOL x 206.9M). Round trip at the same price at $7K market cap = -8.2%, so "profitable" (+1%) needs about a 10% bounce.
- KEY FINDING: on the bonding curve a coin can't go below the launch price (28 SOL market cap, ~$2.9K at SOL $105). So the stop at 10% of the buy can only trigger for buys above ~$29K or after graduation. Under your exact rules a dying coin sits near the floor and the bot holds it forever (no time limit).
- Strategy lab (7 bots on the same coins, forward test): Your rules (exact); + 2 h exit; + 30 min exit; Target +25% (+2 h exit); Deeper dip 55% (+2 h exit); Bounce entry = buy at the close of the first green 1-minute candle after the dip (+2 h exit); Stricter checks = also 50+ holders, a social link, dev with <= 10 earlier coins, RugCheck risk score <= 50 (+2 h exit).
- Page: hero (wallet SOL/USD, status, API health), bot chips, TradingView Lightweight Charts 4.2.3 (inlined, Apache-2.0, attribution logo) candles of the exact pool with BUY/SELL markers, buy zone/high/target/stop/curve-floor lines, live last candle, market cap/price and 1m/5m toggles, DexScreener embed toggle, trade replay (candles play back with the marks), rug-check card per coin, current-meme chips, lab leaderboard + equity chart, watchlist dip meters, trades with replay, scanner funnel, activity feed, toasts.
- Verification (headless Chromium, fake clock, synthetic pump.fun market with the curve floor and graduation; mocks shaped like the real responses captured Oct 19): every bot = independent Python replay of the rules (sniper_e2e.py ref_run), exact to 1e-9 SOL, on (1) a 3.2 h scripted market (win, curve-floor death, mint-authority rug, RugCheck danger, no meme, no dip, busy bot, graduation + PumpSwap crash stop), (2) 20% GeckoTerminal 429s + 15% RugCheck errors, page reload mid-trade, page closed 38 min (catch-up), second tab (viewer, then takeover, no duplicate trades), (3) a busy market: 150 crossings + 300 duds in 2.5 h (GeckoTerminal 4.5 calls/min average, 7.5 max). 22 engine unit tests. All 21 BTC bots identical to v9; Solana Meme Trader unchanged on real Oct 19 data.
- Historical research per research/sniper_protocol.md (written Oct 19 6:35 PM ET) still to run: needs launch data through the user's computer (browser pane recorder started 6:17 PM Oct 19; its data was not retrieved before the session limit).

## Solana Meme Trader (v9). RULES LOCKED Mon Oct 19, 2026, 5:40 PM ET (21:40 UTC); start Mon Oct 19, 6:00 PM ET (22:00 UTC)
Requested 5:32 PM ET: "no it give 10 solana and trade rigth now". Paper only, 10 SOL, always invested in one Solana meme coin.
- Coins: BONK WIF POPCAT PNUT MOODENG FARTCOIN TRUMP GIGA USELESS TROLL PENGU. Coinbase USD hourly candles, priced in SOL with the same hour's SOL-USD candle (open/open, close/close); missing hours filled flat with zero volume. Eligible: 168+ hours of candles in a row and a median hourly volume >= 50 SOL over the last 30 hours.
- At the start and then every day at 00:00 UTC (8 PM ET; 7 PM ET after Nov 1): rank eligible coins by 7-day (168-hour) gain in SOL; hold the #1 even if its gain is negative (always invested); keep the held coin while it ranks in the top 3; otherwise swap into the new #1.
- Swaps at the next hourly open: 0.25% swap fee + 0.25% price impact each way. Account kept in SOL.
- Test (protocol research/sol_protocol.md written 5:34 PM before running; Coinbase hourly candles Apr 2 - Oct 19 2026; training = first 130 days, hidden = last 70): pre-registered grid of 48 versions, all needing a positive gain to buy. Pick (7-day gain, decide daily, top 1): training -24.9%, hidden +60.4%, max drop -89%. Hourly and 4-hourly versions lost (several to almost nothing).
- Nothing qualified at 5:40 PM (all 11 coins down over 7 days vs SOL), and the user wants it trading now, so 5 always-invested versions were tested next: hourly 24h and 6h rotations -99.9% (wiped out), 24h daily -69%, 7-day daily +2.9%, 7-day daily keep-top-3 +32% (training -3%, hidden +36%, max drop -77%, 36 trades). Chosen: 7-day daily keep-top-3. Picked after seeing both halves, so its backtest is optimistic.
- First trade at the start: the eligible 7-day leader (at 5:40 PM: PENGU, -1.3% vs SOL over 7 days; GIGA was higher but too thin).
- FIRST TRADE (real data, checked 6:01 PM ET, candles sha256 90b41261...): bought 138,332.19 PENGU at the 6:00 PM ET hourly open, 0.00007211 SOL each incl. slippage (PENGU $0.007526 / SOL $104.63 at the open), 9.9751 SOL notional + 0.0249 SOL fee. At 6:01 PM: 9.8926 SOL if swapped back (-1.07%, mostly the two swap costs). Ranking at the 6 PM close: PENGU -0.5% vs SOL over 7 days, WIF -1.4%, TRUMP -6.8%, BONK -8.3%, FARTCOIN -9.5%, USELESS -20.2%; GIGA, POPCAT, TROLL, MOODENG, PNUT too thin. Next check 8 PM ET (keeps PENGU while top 3). Page = Python reference exactly.
- Dashboard (v9, delivered Mon Oct 19 ~5:53 PM ET, final build ~6:03 PM ET with the panel moved above the bot cards): new "Solana Meme Trader" panel first on the Live tab (balance in SOL and USD, holding, 11-coin ranking by 7-day change vs SOL with hourly volume and status, closed trades with SOL and USD prices), full-width rules card, v9 paragraph. Loads 240 hourly candles for SOL + 11 coins from Coinbase; everything refreshes every 5 min and each new hour, SOL + the held/pending coin every 30 s. Same engine (app/meme.js, unchanged) on an hourly SOL-priced grid; account kept in SOL; balance shown after exit costs.
- Display-only details: a buy whose coin has no candle yet in the forming hour shows as "waiting for its first trade of this hour" (the fill happens at that candle's open); a sell for dropping off the eligible list is labeled as such (the shared engine's text was written for the daily dollar bot).
- Verification: (1) real Coinbase hourly candles pulled in the browser pane at 5:46 PM ET (sha256 8f2f340d...), page shows "Starts 6:00 PM", leader PENGU -1.3%, 6 eligible (PENGU, WIF, TRUMP, BONK, FARTCOIN, USELESS), 5 too thin; (2) same data with the start patched to 4 PM and 5 PM ET: page = independent Python reference (app/solb_check.py ref) exactly (PENGU qty 138,410.163 / 138,361.920, balance 9.8916 / 9.8882 SOL); (3) 5-day synthetic run with a liquidity collapse: 1 closed trade + 1 open, equity series, cash, balance all identical to the reference (max diff 0); (4) all 21 dollar bots identical v8 vs v9 on the live BTC candles (every field); no page errors desktop or phone dark.

## Meme Coin Trader (v8). RULES LOCKED Mon Oct 19, 2026, 5:16 PM ET (21:16 UTC); start Mon Oct 19, 8:00 PM ET (2026-10-20 00:00 UTC)
Requested Oct 19, 5:03 PM ET ("makr a meme coin trader"). $8,000 paper, spot, long only, one meme coin at a time.
- Universe (fixed before testing): 22 Coinbase USD meme coins: DOGE SHIB PEPE BONK FLOKI WIF MOG MOODENG PNUT POPCAT FARTCOIN TRUMP PENGU SPX TURBO GIGA DEGEN TOSHI DOGINME TROLL USELESS KEYCAT. Eligible on a day only with >= 30 finished daily candles in a row and a median daily dollar volume (close x volume) >= $1M over the last 30 days.
- Each UTC daily close (8 PM ET until Nov 1, 7 PM ET after), on finished candles: if BTC's close is above its 50-day average, rank eligible coins by 30-day gain (close / close 30 days earlier - 1). Candidates need a positive 30-day gain and a close above their own 20-day average. Hold the #1 candidate. A held coin is kept while it is a candidate ranked in the top 3; otherwise it is sold and the new #1 is bought. If BTC closes at or below its 50-day average, sell and wait in cash.
- Orders: market at the next day's open (right at the close), 0.15% slippage each way, Kraken Pro taker tier fees on the bot's own 30-day volume (0.80% at $0 down to 0.18%). All of the bot's cash goes into the one coin.
- Research (protocol research/meme_protocol.md written 5:08 PM before anything ran; engine research/meme_engine.js, run in the browser pane on Coinbase daily candles, identical code to the dashboard): 442 variants (384 momentum rotation, 54 breakout, 4 DOGE trend). Pick = highest training Sharpe with >= 30 training trades: momentum rotation L 30, top 1, keep while top 3, coin > SMA20, BTC > SMA50, daily.
- Pick, $8,000 from Jul 2021: training Jul 2021 - Jun 2025 +1,024% (Sharpe 1.04, max drop -62.5%, 60 trades); hidden Jul 1 2025 - Oct 18 2026 +17.2% (Sharpe 0.62, 30 trades) BUT max drop -82.7% (peak $246,983 on Jul 27 2025 after a +$103k PENGU trade, trough $42,680 on Aug 18 2026, then +$55.6k on USELESS in Sep 2026). Years: 2021 (Jul-Dec) +55.6%, 2022 -9.8%, 2023 +55.6%, 2024 +299.7%, 2025 +127.3%, 2026 to Oct 18 -33.6%.
- Benchmarks hidden / training: equal-weight meme basket (monthly rebalance) -72.2% / -61.3%; DOGE buy and hold -52.2% / -35.3%; BTC buy and hold -23.9% / +204%.
- All 442 variants in the hidden months: 38 positive, median -54.9% (rotation median -56.5%, breakout -29.3%, DOGE trend -53.9%). Best hidden result was a breakout variant ranked 15th in training (+344.6%): luck, not the pick.
- Nulls: the pre-registered null (k random coins re-drawn daily) churned to -100% in training, so it says nothing (pick "beats" it trivially). Added after seeing that, before building the bot: same-timing null = on each of the pick's buy days buy a random eligible coin instead, sell on its sell days. Pick beat 489 of 500 in training and 466 of 500 in the hidden months (null median hidden -54.8%, 90th percentile +2.2%), so the 30-day-momentum choice of coin added value beyond the timing.
- Verdict per protocol: passes (hidden > 0, Sharpe > 0, above the null median), with a warning: lottery-like, a few huge winners pay for many small losses, and it lost 83% from its peak inside the hidden months. Survivorship: coins still listed today.
- Dashboard (v8, delivered Mon Oct 19 ~5:30 PM ET): bay "Meme coins" (orange), row in "What each bot is doing", new "Meme coin leaderboard" panel (all 22 coins: close, 30-day gain, vs 20-day average, median daily volume, status), research panel "Meme Coin Trader: what testing found", rules card. Loads 100 days of daily candles per coin from Coinbase (22 requests, 3 at a time), all coins refresh every 5 minutes and at each new UTC day, the held coin every 30 s. Kept off the BTC price chart. Ignores the fee buttons (always Kraken taker tiers + 0.15% slippage).
- Verification: page result = direct engine replay exactly on a 35-day test run (MEME_START patched to Sep 15, synthetic coins, 3 trades + 1 open); the 20 v7 bots identical in v8 on the live Oct 19 candles; no page errors desktop or phone dark; engine code in the browser research run = app/meme.js (function hashes equal, comments aside).
- State at the lock (real data): at the Oct 18 close and intraday Oct 19 no meme coin qualified (all under their 20-day averages; best 30-day gain PEPE +5%), BTC above its 50-day average. Expect it to start in cash and wait for a coin to break out.

## Live check, Mon Oct 19, 4:51 PM ET (2 days 21 h in; BTC $81,876 vs $81,500 at the start)
Replayed the exact page on Coinbase candles pulled through the browser pane (SHA-256 checked). Balances if closed now:
Combo $7,869.80 (-$130.20, started Sat 8 PM) | Trend Swing $7,955.10 (-$44.90, holding since Fri 8 PM) | Futures Breakout $7,772.54 (-$227.46: Sun 5:35 AM long $82,091 stopped $81,556 -$90.92; Mon 3:35 AM long $83,051 stopped $82,181 -$136.54) | 1h/15m $8,000 (no trades) | Half-Size $7,977.55 | Leveraged $7,912.51 (2.68x) | Multi-Speed $7,968.33 (3 of 4 in) | Day Trader $8,000 (filter off) | Buy & Hold $7,921.50 | Old Bot $7,069.23 (21 trades, -$83 before fees, $848 fees). Lab trend bots holding at -$44.90, the rest in cash. Holders are down only by fees; Trend Swing is $34 ahead of Buy & Hold thanks to its limit-order entry.

## Combo 50/50 (v7). RULES LOCKED Sat Oct 17, 2026, 3:18 AM ET (07:18 UTC); start Sat Oct 17, 8:00 PM ET (2026-10-18 00:00 UTC = main START + 24 h)
$8,000 paper split into two independent $4,000 halves. No money moves between the halves, ever; the bot's balance = the sum of the two.
- Half 1, spot: Trend Swing v2 rules exactly (daily close at 00:00 UTC vs the 50-day average; above = limit buy at that close with all of the half's cash, at or below = limit sell; limit lives 4 h then market; Kraken Pro tier fees on the half's own 30-day volume; follows the page's fee buttons).
- Half 2, futures: Futures Breakout rules exactly (each UTC day trigger = day's open + 0.6 x previous UTC day's range; first 5-minute close above = long at the next open at 1.5x of the half's equity; stop = that close - 0.5 x previous range; out at the end of the UTC day; one trade a day, long only; 0.05% taker per side, 0.02% market / 0.05% stop slippage, 0.01% funding per 8 h).
- First decisions at the start: the spot half acts on the Oct 17 daily close; the futures half trades the Oct 18 UTC day.
- Why this bot: in the "close the gap" round (Oct 17, 2:50-3:15 AM ET) it was the method that held up, hidden months included. Daily-return correlation between the two parts 0.40.
- Exact backtest with the dashboard engine (research/combo_live.py = engine.js combo, $8,000 from Jan 1 2020 to Oct 16 2026): Combo +1,420%, max drop -43.4%, Sharpe 1.37, days up 32%, months up 52%, hidden Apr-Oct 2026 +21.9%; Trend Swing alone +1,923% / -61.8% / 1.27 / hidden +29.6%; Futures Breakout alone +974% / -44.1% / 1.14 / hidden +10.3%; Buy & Hold +1,037% / -77.3% / 0.90 / hidden +20.3%. Years for the Combo: 2020 +258%, 2021 +93%, 2022 -34%, 2023 +81%, 2024 +84%, 2025 -8%, 2026 +7%. Not smoother in every sub-period: 2020-24 worst drop -43% vs -33% for the breakout alone; 2025-Mar 2026 -31% vs -27% for Trend Swing alone.
- Monthly rebalancing looked slightly better (Sharpe 1.43, max drop -38.2%) but needs transfers between spot and futures; not used. Risk weighting (Sharpe 1.36) and adding the 1h/15m Trader (1.34, -48%) were worse.
- Other methods tested in that round and rejected: buy-stop entry at the trigger (hidden -8.0%), ML meta-label filter, walk-forward HistGradientBoosting (hidden -1.1% vs +7.8% unfiltered), volatility-targeted sizing (mixed: hidden +15.4% but drop -48% and ~2x average leverage), daily 50-day trend long/short on futures (Sharpe 0.75 vs 1.19 long/flat; shorts lost money). ETH cross-check blocked: no ETH data reachable from the sandbox.
- Verification: check_v8.js, engine.js combo = research/combo_live.py on 3 windows, 419 trades, zero difference; on the live Coinbase candles (Oct 19) all 19 v6 bots identical in v7.

## Round 2 search: ~100,000 evolved + 15,360 breakout versions (Oct 17, 2:28-3:00 AM ET). Result: no dashboard change
User asked for 100,000 strategies "each one better than the last" plus 15,000 variations of the breakout that also work in 2025. Protocol written before running: research/s_protocol2.md (one amendment before any holdout was seen: strategies with < 100 training trades rank below all valid ones, after a 2-trade strategy scored t = 289). Code: research/s_evo.py, s_evo_analyze.py, vbo_live.py (generalized breakout mirror).
- Training (search could see): 2020-01-01..2026-03-31. Hidden holdout: 2026-04-01..2026-10-16. Fitness = training per-trade t-stat.
- Evaluated: 99,725 evolved (two independent runs) + 15,360 breakout grid + the 20,070 from round 1 + 216 random nulls.
- Both evolution runs converged on the same thing: breakout with the session starting 18:00 UTC (2 PM ET), daily SMA50 filter, k ~0.62, stop ~0.65 x range, long only. Training t rose 3.0 -> 4.48 ("each better than the last"), but best-so-far holdout per-trade did not improve (worker 1: +0.164%/trade at gen 1 -> +0.066% at the end).
- Final pick (anchor 18, SMA50, hold 19 h, k 0.6225, stop 0.6535R): training 382 trades, t 4.48, yearly 2020 +58%, 2021 +80%, 2022 -3%, 2023 +17%, 2024 +45%, 2025 -6.5% (4/6 positive); holdout 50 trades, +0.066%/trade, t 0.29. FAILS the pre-registered rule (needed holdout t >= 1 and 5/6 years). Not added.
- Hidden months at 1.5x from $8,000: current dashboard Futures Breakout -> $8,823 (+10.3%, 65 trades); evolved best -> $8,284 (+3.5%, 50 trades). The original beat the optimized one on unseen data.
- Breakout grid: only 296 of 15,360 versions made money in 2025; best training version (anchor 19, SMA20, k 0.9, no stop) lost on the holdout (-0.026%/trade).
- Top 100 by training fitness were all positive on the holdout, but they are near-duplicates of one cluster; all real strategies: 58% positive on the holdout (a favorable stretch), random nulls 3%.
- Probability of backtest overfitting (CSCV, 924 splits, 125,755 strategies with 200+ training trades): 43%.
- generalized JS engine vboFut (anchor, k, side, daily SMA filter, stop mode, time limit) added to engine.js and verified vs vbo_live.py (check_v7.js, 488 trades incl. shorts, zero difference), currently unused by the page.

## Futures Breakout (v6). RULES LOCKED Sat Oct 17, 2026, 2:18 AM ET; start Sat Oct 17, 3:00 AM ET (07:00 UTC = main START + 7 h)
$8,000 paper, long only, BTC futures at 1.5x of equity per trade.
- Each UTC day (00:00 UTC = 8 PM ET until Nov 1, 7 PM ET after): trigger = that day's opening price + 0.6 x the previous UTC day's high-low range.
- The first 5-minute close above the trigger that day = buy at the next 5-minute open (market). One trade per day at most; no signal on the day's last candle.
- Stop-loss = that close - 0.5 x the previous day's range (market stop, 0.05% slippage, gap-aware). Exit at the end of the UTC day (market at the 00:00 UTC open) if the stop hasn't hit.
- Costs: futures taker 0.05% per side, slippage 0.02% market, funding 0.01% per 8 h. Ignores the spot fee buttons.
- Dashboard: bay ("Futures 1.5x"), row in "What each bot is doing", trigger and stop lines on the chart when selected, "Why" notes per trade, research panel "The 20,070-strategy search", rules card.
- Verification: engine.js futBreakout = research/futb_live.py trade for trade (481 trades over 4 windows, zero difference); = research run_sim on 2025-26; in-browser run Sep 1 - Oct 16 2026 = Python (14 trades, +$1,061.90); all 18 v5 bots identical in v6; hosted build passes phone tests.
- Backtest expectation at 1.5x: Jan 2025 -> Oct 2026 about $6,198 (-22.5%); Apr-Oct 2026 alone +10.3%. Best survivor, not a proven winner. 45% winners, average win $243, average loss -$142 at $12,000 per trade.

## Big search round 1, 20,070 strategies (Oct 17, 2:06-2:17 AM ET)
Protocol: research/s_protocol.md. Stages: 2020-22 find -> 2023-24 confirm -> 2025-26 once. 23 passed stage 1, 9 survivors (all UTC-day volatility breakout, long, k 0.5-0.7), 0 random nulls. Pre-declared pick -0.06%/trade in 2025-26 (after +0.40% and +0.30%). Walk-forward re-picking lost in all 4 setups. Pick at 1.5x, $12,000 per trade, no compounding: 2020 +$9,823, 2021 +$4,516, 2022 +$508, 2023 +$2,878, 2024 +$6,118, 2025 -$1,582, 2026 +$8.

## 45-minute leveraged futures research (Oct 17, 1:53-2:40 AM ET)
188 variants (S/R levels, breakouts, VWAP, EMA pullbacks, RSI, Bollinger, momentum, US-open range breakout), tune Jan-Jun 2026, check Jul-Oct 2026: 0 of 188 profitable after costs in either half; best pre-cost edge +0.01-0.03%/trade vs ~0.15% costs per round trip. Futures access: Coinbase CFTC-regulated futures for "eligible" Canadians (Sept 2026, up to 10x); other perp venues restrict Ontario retail.

## 1h/15m Trader (requested Oct 16, 9:56 PM ET). RULES LOCKED Fri Oct 16, 2026, 10:04 PM ET; start 11:00 PM ET
$8,000, long only, spot. Entries only while the last finished 1h close > 200-hour average x 1.01; buy on a 15m RSI(14) < 35 at a 15m close; sell when a 1h close < average x 0.99. Limit at the 15m close for 30 min, then market. Kraken tier fees. Research: 216 variants, picked on 2020-24; 2025-26 -3.6% after fees. Verified vs research/mtf_live.py (95 trades).
User feedback Oct 17, 1:53 AM: "ur bot is ass", wanted 45-minute futures trades making a couple hundred each.

## Dashboard and phone
Dashboard: `btc-paper-lab.html` (single file, open in Chrome, not the Claude app preview, which blocks network access). Pulls Coinbase BTC-USD candles (Bitstamp fallback), replays the locked rules from each bot's start time; same trades for every viewer. Trades recorded when each 5-minute candle closes (+15 s settle).

Phone version: `btc-paper-lab-site.zip` = same page plus a web-app manifest and home-screen icons ("BTC Lab"), files at the ZIP root. Host it via Netlify Drop (sign up first; unclaimed Drop sites are deleted automatically). To update, drag a new ZIP onto that site's Deploys page (same link).

How to check the bots from the sandbox (shell can't reach exchanges): open api.exchange.coinbase.com in the browser pane (user approves the site), fetch candles with same-origin JS, return them as text with SHA-256 checksums, write them to files, verify the hash, then replay the built page in headless Chromium with the API mocked from those files (app/live_check.py).

## Core bots
1. **Trend Swing (main):** daily close (00:00 UTC) > 50-day average: limit buy at that close; <= average: limit sell. Limit lives 4 hours, then market.
2. **1h/15m Trader**, 3. **Futures Breakout**, 4. **Combo 50/50**, 5. **Meme Coin Trader** (see above).
6. **Half-Size Swing**, 7. **Leveraged Swing** (cash x min(3, 100% / 30-day vol), 15%/yr borrowing, liquidation at 10% maintenance), 8. **Multi-Speed Trend** (20/50/100/200-day sleeves).
9. **Breakout Day Trader (experiment, spot fees)**, 10. **Buy & Hold (benchmark)**, 11. **Old Bot Replica (control)**.

## Strategy lab (all limit-first, unlevered, textbook settings, no tuning)
| Bot | Rule | 2020-24 | 2025-26 | ahead 1y |
|---|---|---|---|---|
| Turtle Breakout | close > prior 20-day high in; close < prior 10-day low out | +886% | -10.7% | 61% |
| 4-Week Momentum | close > close 28 days ago | +2,441% | -19.2% | 68% |
| 12-Month Momentum | close > close 365 days ago | +1,474% | -4.3% | 67% |
| Golden Cross | SMA50 > SMA200 | +476% | -28.7% | 63% |
| Weekly Trend | 50-day rule checked at Sunday close only | +1,532% | -17.0% | 64% |
| Chandelier Trend | close > prior 50-day high in; close < highest close since entry - 3x ATR22 out | +208% | +7.2% | 56% |
| RSI-2 Dip Buyer | RSI(2) < 10 and close > SMA200 in; close > SMA5 out | +60% | +1.7% | 67% |
| Bollinger Bounce | close < SMA20 - 2 sd (population) and > SMA200 in; close > SMA20 out | +5% | +16.9% | 71% |
| Volatility-Managed Hold | 4 quarters, each in while 30-day vol < 40/55/70/85% | +337% | -15.1% | 60% |
| Committee Vote | quarters: 50-day trend, Turtle, 4-week momentum, golden cross | +1,378% | -11.4% | 69% |
Buy & hold: +1,190% / -14.6%.

Core research summary: no day-trading variant profitable after Kraken spot tier fees (0 of 55 in 2025-26). Trend Swing v2 +1,613% / +11.3%; Half-Size +514% / +6.4%; Leveraged +11,189% / -1.1%; Multi-Speed +875% / +0.5%. Old ChatGPT-style bot -100%.

Costs (spot bots): Kraken Pro spot tiers (Oct 2026): 0.40/0.80% at $0+ down to 0.06/0.18% at $1M+ 30-day volume (maker/taker).

Verification: every JS engine/signal matches the Python research engine trade-for-trade (check.js .. check_v8.js), plus end-to-end in headless Chromium, plus the hosted build at phone size.

Caution for later reviews: many bots and huge searches mean some things will look great by luck; judge over months vs Buy & Hold.

## Open questions / ideas
- AI paper-trader side experiment on a schedule: offered, not set up.
- Cross-check the volatility breakout on another asset (ETH) for robustness: ETH candles are reachable through the browser pane the same way as the meme coins.
- Funding-rate carry (long spot + short perp) is the one known method aimed at small gains on most days; needs funding history from an exchange API through the browser pane.
