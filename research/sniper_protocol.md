# Meme Sniper: research protocol (written Mon Oct 19 2026, ~6:35 PM ET, before any outcome data was looked at)

Request (6:06-6:09 PM ET): scan NEW meme coins, only ones with >= $7k market cap, pick a good one based on current memes,
do all the rug checks, buy only on 40% dips, then hold until profitable or until the coin falls to 10% of the buy-in.
Improve the strategy with research. Paper only.

## Data (recorded live, so there is no survivorship bias)
- Universe: every SOL-paired pump.fun coin (program `pump`) created from 6:12 PM ET Oct 19, listed by pump.fun's API
  (newest first, polled every 40 s in the browser pane). Coins paired with other quote tokens are excluded.
- Crossing: first time Jupiter's token API reports mcap >= $7,000 (coins followed every ~60 s while younger than 75 min;
  coins still under $4,500 at 20 min are dropped as dead). Point-in-time snapshot at the crossing: Jupiter (holders,
  top holders %, dev balance %, dev mints, dev migrations, organic score, socials, 5 min stats) and RugCheck summary
  (score, risks). DexScreener paid profile / boost / community takeover events are logged with their first-seen time.
- Candles: GeckoTerminal 1-minute OHLCV in USD for the coin's pump.fun bonding-curve pool, then its PumpSwap pool if it
  graduates (stitched by time). Market cap = price x 1,000,000,000 (pump.fun supply). SOL/USD from Coinbase 1-minute.
- Recording window for this study: crossings from 6:12 PM to 10:00 PM ET. Horizon: 2 hours after each coin's crossing
  (positions still open at the horizon are closed at the last close, after costs, and flagged).
- Split (chronological by crossing time): first 60% = training, last 40% = hidden. The hidden coins are looked at once,
  after the pick is fixed.

## Costs (every fill)
- pump.fun fee 1.25% per side on the bonding curve; PumpSwap tier fee (1.25% under 420 SOL mcap, 1.20% to 1470 SOL).
- Execution slippage (latency, priority fees, MEV) 1% per side.
- Price impact of the bot's own order, exact for a constant-product curve: on the bonding curve k = 30 SOL x 1.073e9
  tokens, SOL reserve = sqrt(k x price); after graduation the PumpSwap pool, K = 85 SOL x 206.9e6 tokens.
- Stake 1 SOL per trade, account 10 SOL, one coin at a time.

## Exact user rules ("U")
- Watch a coin from its crossing. Reference high H = highest 1-minute high since launch, up to the previous candle.
- Buy (limit at 0.60 x H) in the first candle after the crossing whose low <= 0.60 x H; fill at min(open, 0.60 x H).
- Take profit as soon as selling would return more than the 1 SOL paid plus 1% (a candle high at or above that price,
  after all costs; not in the entry candle).
- Stop when price <= 10% of the entry price: fill at that level, or at the candle close if the candle closes below it.
  If a candle touches both, the stop counts first. No time limit.
- Rug checks (point-in-time, at the crossing): mint and freeze authority disabled; dev wallet <= 10% of supply; top
  holders <= 30% (when reported); no RugCheck "danger" risk.
- Current memes: a coin's meme score = the largest count, over its name/symbol words (3+ letters, common words removed),
  of other coins with that word that crossed $7k in the previous 2 hours. "On-meme" = score >= 1.

## Tests (training coins only, then the pick on hidden coins)
1. U exactly, and U without the rug checks / without the meme condition.
2. One change at a time: dip 30/50/60/70%; high since the crossing instead of since launch; take profit +10/+25/+50/+100%;
   stop -50/-30%/none; time limit 30 min / 2 h; market cap 10k/15k/25k; buy on the first green candle after the dip
   instead of the limit; stricter rug checks (also: dev launched <= 10 coins before, 50+ holders, a social link,
   RugCheck normalized score <= 50); DexScreener paid profile before the crossing.
3. Grid: dip {30,40,50,60} x take profit {1,10,25,50,100%} x stop {90,50,30%} x time limit {none, 30 min, 2 h}
   x entry {limit, green candle} x market cap {7k, 15k} x rug checks {standard, none} = 1,440 versions.
   Pick = highest mean net return per trade with >= 30 training trades.
Metrics: trades, win rate, mean / median net return per trade, 95% bootstrap interval of the mean, share of -90%
stops, share still open at the horizon, average time in trade. Portfolio check: 10 SOL, 1 SOL per trade, one coin at
a time, first trigger wins.
Verdict: the pick goes live only if its hidden mean net return per trade is > 0. Either way the exact user rules run
live too, so both can be compared forward.

## Addendum (6:58 PM ET, still before any outcome data was looked at)
- Meme words, fixed: name + symbol, camelCase split, lowercase letters only, 3+ letters, minus these filler words:
  the and for you are with this that from have not but all can its was new just get got our out who why how now one
  two coin token sol solana pump fun meme official. Engine: app/sniper.js words() / memeScore() (shared with the site).
- SOL/USD for a minute = close of Coinbase's SOL-USD 1-minute candle for that minute (or the latest earlier one).

## Amendment 2 (Wed Oct 21 2026, 3:30 AM ET, before any outcome data was looked at)
- The Oct 19 recording (browser pane, started 6:17 PM ET) was lost: the pane closed before its data was pulled.
  New recording window: crossings from the recorder restart (about 3:35 AM ET Oct 21) to 9:30 AM ET Oct 21. Candles are
  fetched 2 h 5 min after each crossing; horizon 2 h. Everything else as written above (universe, crossing via Jupiter,
  point-in-time Jupiter audit + RugCheck at the crossing, costs, rules U, tests, grid, pick rule, 60/40 split, verdict).
- The engine now has the re-arm rule used by the live bots (a coin already under its buy level when its watch starts is
  only bought after it trades back above that level). U and the grid use it; U is also reported without it.
- The 7 live lab versions (v10, locked Oct 20 8:25 AM ET) are reported as well: U, U + 2 h exit, U + 30 min exit,
  +25% target, 55% dip, bounce entry, stricter checks (the last four with the 2 h exit).

## Amendment 3 (Wed Oct 21 2026, 4:20 AM ET, before any outcome data was looked at)
- From v10.1 the live bots run on GitHub Actions (repo AliMallick2008/meme-sniper), with the same locked rules and the
  same code as the page (app/sniper.js + app/sniper_core.js, copied to server/). Fresh 10 paper SOL per bot from the
  server's first run.
- The server records every coin it sees cross $7K: the same point-in-time checks the bots used (Jupiter audit, holders,
  socials, RugCheck summary, meme score) and the coin's final 1-minute candles from launch to 2 h 2 min after the crossing, fetched
  at 2 h 5 min (GeckoTerminal, curve pool plus PumpSwap pool if it graduated), with Coinbase SOL/USD per minute. Gzipped JSON lines
  on the `research` branch. These coins are a continuous out-of-sample set: any rule change is first chosen on the
  Oct 21 browser recording (Amendment 2) and then judged only on server-recorded coins that came after it was chosen.
- Rules stay locked. A change would be a new version with its own start, never an edit of a running bot.

## Amendment 4 (Wed Oct 21 2026, 4:30 AM ET, before any outcome data was looked at)
- The Oct 21 browser recording (Amendment 2) was lost too: the browser pane on the user's computer closed around 4:25 AM ET
  with the recorder's data in memory. No more recording on the user's computer.
- The research runs on the server-recorded coins only (Amendment 3, from Oct 21 4:19 AM ET on): the first 60% of crossings
  by time choose any rule change (same tests and grid as above), the last 40% judge it, once at least 1,000 crossings with
  final candles are recorded. Nothing in the live bots changes because of this.

## Amendment 5 (Wed Oct 21 2026, 11:50 AM ET, no outcome analysis done)
- GeckoTerminal (the only source of final 1-minute candles) leaves room for about 9 research coins an hour beside the
  live bots' own candle needs, while about 80 coins an hour cross $7K. By 11:10 AM ET the queue held 812 coins and 52
  records had been written; the queue (rq.json, 1 MB) would have kept growing for 3 days.
- From v10.2 the recorder keeps every coin that passed at least one bot's checks (`samp: "passed"`), plus 1 in 24 of the
  other crossings, chosen by a hash of the mint (FNV-1a of the address, mod 24 = 0; `samp: "1/24"`), which cannot depend
  on how the coin did. Coins already queued were filtered the same way. The queue is capped at 300 coins (the oldest is
  dropped and counted in `dropped`). The 52 records written before this have no `samp` field and are kept as they are.
- Rules that trade only coins passing the bots' checks are evaluated on the "passed" stratum, which stays complete.
  Statements about all crossings use the 1/24 stratum. The 1,000-crossing threshold of Amendment 4 counts both strata.
- Separately, from v11 (Oct 21 2026) every input of the v11 engine is recorded (`v11-inputs/`, see
  `research/v2_protocol.md`): prices every 5 s for every crossed coin's first 20 minutes and every 30 s after that while
  it is alive, Jupiter order flow every 20 s, quotes, checks. That stream covers every crossing, not a sample.

## Amendment 6 (Wed Oct 21 2026, 4:00 PM ET, no outcome analysis done)
- After 13:00 UTC the GeckoTerminal recorder wrote nothing: it only uses GeckoTerminal slots the live bots leave free,
  and their candle queue was never empty (the sampling of Amendment 5 kept the queue small, not the throughput up).
- From engine 11.1 every crossing is recorded anyway, causally, as v11 inputs (`v11-inputs/`: Jupiter prices and order
  flow every 12 s while a coin is in play, DexScreener as fallback, checks, quotes), and the v11 engine replays the legacy
  rules on it (the E0 accounts, honest timing). So the research on rule changes moves to that recording: rule variants
  are replayed with `server/tools/v11_ablation.js` on the recorded inputs from the 11.1 start, the first 60% of the time
  window chooses and the last 40% judges, with the evidence minimums of `research/v2_protocol.md` (5 days, 30 trades per
  variant) replacing the 1,000-crossing threshold of Amendment 4. The GeckoTerminal recorder keeps running when it gets
  slots; its records stay usable for the candle-based checks of the original protocol.
