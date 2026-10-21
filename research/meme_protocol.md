# Meme Coin Trader: test protocol (written Mon Oct 19 2026, 5:08 PM ET, before any strategy was run)

Request (Oct 19, 5:03 PM ET): "make a meme coin trader". Goal: a paper bot on the dashboard, $8,000, trading meme coins.

## Data
Coinbase Exchange daily candles (UTC days), fetched in the browser pane on Oct 19 ~5:06 PM ET, finished days only.
Universe fixed now, before testing: the 22 meme coins Coinbase lists against USD:
DOGE SHIB PEPE BONK FLOKI WIF MOG MOODENG PNUT POPCAT FARTCOIN TRUMP PENGU SPX TURBO GIGA DEGEN TOSHI DOGINME TROLL USELESS KEYCAT.
Known bias: these are coins still listed today (survivorship). Most launched late 2024 or 2025, so before Nov 2024 the
universe is only DOGE, SHIB (and BONK from Dec 2023).

## Eligibility (each day, using only finished days)
A coin can be bought only if it has at least max(30, n) finished daily candles on Coinbase (n = the longest average the rule uses)
and its median daily dollar volume (close x volume) over the last 30 finished days is at least $1,000,000.

## Execution and costs
Decisions at each UTC daily close using finished candles. Orders fill at the next day's open price (market),
plus 0.15% slippage each way (meme spreads). Fees: Kraken Pro spot taker tiers (same table as the dashboard) on the bot's own
30-day volume. Long only, no leverage. New positions get an equal share of cash (cash / free slots). Positions are not resized.

## Rule families and grid (all variants run, none added after seeing results)
A. Momentum rotation: rank eligible coins by L-day return; hold the top k with return > 0 (and the filters).
   L in {3, 7, 14, 30}; k in {1, 2, 3}; keep buffer in {0, 2} (a held coin stays while in the top k + buffer and filters pass);
   coin trend filter in {none, close > SMA10, close > SMA20, close > SMA50}; BTC filter in {none, BTC close > BTC SMA50};
   cadence in {daily, weekly (Sunday 00:00 UTC close)}. 384 variants.
B. Breakout: buy a close above the prior N-day high, sell a close below the prior M-day low; up to P positions.
   N in {10, 20, 55}; M in {5, 10, 20}; P in {1, 2, 3}; BTC filter in {none, BTC > SMA50}. 54 variants.
C. Single-coin trend: hold DOGE (longest history) while close > SMA n, n in {10, 20, 50, 100}. 4 variants.
Benchmarks: DOGE buy and hold; equal-weight buy and hold of all eligible coins, rebalanced on the 1st of each month; BTC buy and hold; cash.
Random nulls: 200 runs that pick k random eligible coins at the same cadence (k = the pick's k), same costs.

## Periods
Training (selection may look at this): 2021-07-01 to 2025-06-30.
Hidden (looked at once, after the pick is fixed): 2025-07-01 to the last finished day (Oct 18 2026).

## Selection and pass bar
Pick = the variant with the highest training Sharpe (daily returns, 365-day annualized) among variants with at least 30 training trades.
"Passes" only if, in the hidden period: return > 0 after fees, Sharpe > 0, and return above the median random null.
The bot goes on the dashboard either way (the request is for a meme trader); a failed pick is labeled as failed on the page.
Rules are locked (timestamp in the project doc) before the bot's start, which is a UTC daily close after the lock.
