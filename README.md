# BTC Paper Lab + Meme Sniper (paper trading)

A paper-trading lab: BTC bots, meme coin bots, and seven Meme Sniper bots for brand-new pump.fun coins. The Meme Sniper
bots run 24/7 on GitHub Actions, so no computer has to stay on. **Paper money only:** no wallet, no private keys, no
real orders. Every number is simulated from public market data.

**Dashboard:** https://alimallick2008.github.io/meme-sniper/

## What's here

- `server/`: the Meme Sniper server. `sniper.js` (bonding-curve math and the locked rules) and `sniper_core.js` (the
  bots) are shared with the dashboard; `main.js` is the server loop, `run.js` the GitHub entry point, `research.js`
  the data recorder, `sim.js` a simulator used by the tests.
- `dashboard/`: the web page, its build script and its tests.
- `research/`: research protocols, written before looking at results.
- `docs/PROJECT_NOTES.md`: the full history, every bot's rules and results.
- `CLAUDE.md`: how everything fits together, for Claude Code.

## Workflows

- **sniper**: the bots. One run lasts about 5 h 45 min, saves the state every couple of minutes, then starts the next
  run, which picks up where it left off.
- **watchdog**: three times an hour, starts the bots if no run is going.
- **dashboard**: builds the page and publishes it to GitHub Pages when it changes.

## Branches

- `main`: the code.
- `data`: the bots' latest state (`state.json`, read by the dashboard). Rewritten as one commit on every save, so it never grows.
- `research`: every coin that crossed $7K, with its rug checks at that moment and its 1-minute candles from launch to
  2 h after the crossing.
- `gh-pages`: the published dashboard.

## The Meme Sniper rules (locked Oct 20 2026, 8:25 AM Toronto)

Scan new pump.fun coins; when one crosses $7K market cap, check it once (mint and freeze authority revoked, dev wallet at
most 10%, top holders at most 30%, no RugCheck danger flag, on a current meme). Watch coins that pass for 2 hours and buy
1 paper SOL on a 40% dip from the high since launch. Sell at a profit after all costs, or at 10% of the buy price.
Six variations run beside it (2 h or 30 min time limit, +25% target, 55% dip, bounce entry, stricter checks).
Each bot started with 10 paper SOL.

## Stop or pause

Actions tab: pick **sniper** and **watchdog**, then **Disable workflow** on both. Enable them again to resume; the bots
continue from the saved state.
