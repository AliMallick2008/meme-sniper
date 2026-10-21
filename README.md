# Meme Sniper (paper trading)

Seven paper-trading bots for brand-new pump.fun meme coins, running 24/7 on GitHub Actions so no computer has to stay on.
**Paper money only:** no wallet, no private keys, no real orders. Every number is simulated from public market data.

The dashboard (BTC Paper Lab, Meme Sniper tab) reads the bots' state from this repo and draws the live chart of each coin.

## What runs

- `.github/workflows/sniper.yml`: the bots. One run lasts about 5 h 45 min, saves the state every couple of minutes,
  then starts the next run, which picks up where it left off.
- `.github/workflows/watchdog.yml`: three times an hour, starts the bots if no run is going (for example after a GitHub hiccup).
- `server/`: the code. `sniper.js` (bonding-curve math and the locked rules) and `sniper_core.js` (the bots) are the same files
  the dashboard uses; `main.js` is the server loop, `run.js` the GitHub entry point, `research.js` the data recorder,
  `sim.js` a simulator used for tests.

## Branches

- `main`: the code.
- `data`: the bots' latest state (`state.json`, read by the dashboard), the coins being followed, and chart candles for traded coins.
  Rewritten as a single commit on every save, so it never grows.
- `research`: every coin that crossed $7K, with its rug checks at that moment and its 1-minute candles from launch to 2 h after
  the crossing, used to test rule changes on coins the rules never saw.

## The rules (locked Oct 20 2026, 8:25 AM Toronto)

Scan new pump.fun coins; when one crosses $7K market cap, check it once (mint and freeze authority revoked, dev wallet at
most 10%, top holders at most 30%, no RugCheck danger flag, on a current meme). Watch coins that pass for 2 hours and buy
1 paper SOL on a 40% dip from the high since launch. Sell at a profit after all costs, or at 10% of the buy price.
Six variations run beside it (2 h or 30 min time limit, +25% target, 55% dip, bounce entry, stricter checks).
Each bot started with 10 paper SOL.

## Stop or pause

Actions tab, pick **sniper** and **watchdog**, then **Disable workflow** on both. Enable them again to resume; the bots
continue from the saved state.
