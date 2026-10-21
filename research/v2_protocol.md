# V2 strategies protocol (v11 engine, strategies A, B, C)

**Locked:** Wed Oct 21 2026, 12:00 PM ET (`LOCKED` in `server/v11/v2.js`; the commit that adds this file). Written before any V2
trade on real data, forward or replayed. The server sim's synthetic market was only used to check that the code runs and
replays exactly; it says nothing about real coins and is not evidence for or against any rule here.

Audit reference: `docs/audit/2026-10-21-strategy-audit.md` (C2 strategies, C3 entry contract, C4 exit contract, D2-D5).

## 1. Hypotheses

- **A, Launch Momentum.** A pump.fun curve coin in its first 20 minutes after crossing $7K that is still rising near its
  high while most of its 5-minute dollar volume is buys, with more buying than selling wallets and enough traders, keeps
  rising long enough to pay its costs, more often or by more than it falls.
- **B, Confirmed Pullback Recovery.** After a strong move and a controlled pullback, a recovery confirmed by structure
  (bounce off a low that held, a green higher-low minute) and by demand (selling eased from its peak, buyers back) pays
  its costs. A raw dip is never a reason to buy.
- **C, Post-Graduation Momentum.** A coin trading on its PumpSwap pool with real liquidity and a sustained trend backed by
  buying on both the 5-minute and 1-hour windows continues for long enough to pay its costs.
- **Null for each:** no edge after costs; then cash (HOLD) is the right answer.

## 2. Exact rules (v2.0)

Accounts `A`, `B`, `C`, 10 paper SOL each from the first server run with v2.0. One position per account.

**Gates (all must be known and pass; unknown never passes):** pump.fun mint with its bonding curve; mint authority
revoked; freeze authority revoked; dev wallet share 10% or less (Jupiter's figure, else RugCheck's full report: the
creator's balance and the wallet Jupiter calls `dev` looked up in the top holders; the higher counts); top holders 30% or
less (Jupiter); no RugCheck "danger" risk. Gates are evaluated at decision time with the latest received data; each change
of gate state is logged with its reasons.

**Timely data:** price received within 20 s; Jupiter order flow received within 60 s.

| | A Launch Momentum | B Pullback Recovery | C Post-Graduation |
|---|---|---|---|
| Universe | curve, crossed <= 20 min ago, market cap $8K-$40K | not migrating, crossed <= 2 h ago, high >= 1.6x the crossing price | pool for 5+ min, crossed <= 8 h ago, pool liquidity >= $15K |
| Structure | up >= 10% vs 3 min ago; not falling over the last minute; within 10% of its high; last 1-min bar green | pullback 25-60% from the high; >= 10% off the low; the low is >= 2 min old; last minute green with a higher low | up >= 8% vs 15 min ago; at or above its 15-min average; within 15% of its high |
| Demand (Jupiter 5 min) | buys >= 58% of volume; net buyers >= 3; traders >= 12 | buys >= 55%; net buyers >= 2; traders >= 8; 5-min selling <= 75% of its peak since the high | buys >= 55% (5 min) and >= 52% (1 h); net buyers >= 3; traders >= 15 |
| Max round trip | 6% | 6% | 5% |
| Loss limit (executable value) | -15% | -18% | -12% |
| Stagnation | exit if under +2% after 8 min | under +3% after 15 min | under +3% after 45 min |
| Horizon | 20 min | 45 min | 3 h |
| Profit protection | after +20%, give back at most 35% of the gain | after +20%, 40% | after +25%, 40% |
| Invalidation (structure family) | under the lowest low of the 3 minutes before entry, -2% | under the pullback low, -3% (failed reclaim) | under the 15-minute low at entry |

**Round trip** = venue fees both ways (pump.fun schedule of Oct 17 2026) + price impact both ways from the reserve model
(a paper buy never moves the real market, so the sell meets the market without it) + 0.5% landing drift each way +
network fees. **Size:** the largest of 1, 0.85, 0.7, 0.55, 0.4, 0.25 SOL whose round trip stays under the cap, whose loss at
the limit (limit + round trip) is at most 0.25 SOL, and whose worst case (curve back at its launch price, or pool 80% down)
is at most 0.8 SOL. The first quote's price impact must be 6% or less, else the size is halved (minimum 0.25 SOL).

**Ranking at one decision time:** every coin that passes all of the above is scored; score = setup strength + buying
share + breadth (+ bounce/depth for B, 1-hour buying for C) - 20 x round trip. The best is bought; the next three are
recorded in the contract with how far behind they were.

**Entry contract** (on the order and the position): gates with values, sources and receive times; what confirmed the
setup and the demand; the feature values with their receive times; the plan (size, horizon, loss limit, loss at the
limit, worst case, round trip, invalidation, profit protection, emergency response); the ranking; social evidence
"unavailable" (no approved X/Telegram API).

**Exits, in priority order** (`server/v11/thesis.js`):
1. Emergency, one event is enough: no sell route (two quotes in a row), mint or freeze authority switched on, pool
   liquidity down 50% since entry, a sell quote with 25%+ impact.
2. Thesis break: at least two of four families (structure, demand, liquidity, holders) flag deterioration, each
   persisting across two separate observations of its own inputs at least 10 s apart.
   Structure: under the invalidation level; lower highs with a drop from the post-entry high of max(12%, 3x the coin's
   1-min volatility) (10% for C). Demand: buys <= 42% of 5-min volume with net selling; net buyers <= -2; traders down
   to 40% or less of the count at entry. Liquidity: last sell quote found no route; sell impact >= max(2x entry, 8%);
   liquidity down 30% since entry. Holders: holders down 5%+ in 5 min (30+ holders); top holders' share up 8+ points.
3. Loss limit on the executable value (fresh quote, else the reserve model on a fresh price).
4. Stagnation, then horizon.
5. Profit protection, confirmed by a second observation 10 s later.

**Cooldown:** 30 min after an exit; 7 days after a thesis or emergency exit; 60 s after a failed buy.

## 3. Execution and accounting (as all v11 accounts)

Decisions only from data received before them; fills only from a Jupiter quote received after the decision (plus 0.5%
drift and network fees), within 10% of the decision estimate for buys; exits take any executable quote. No fills while a
coin is migrating. Time the server was not running is a coverage gap: nothing in it is credited. Marks from quotes or the
reserve model on fresh prices, else unpriceable; equity in SOL with worst-case bands.

## 4. Evaluation

**Forward paper (primary).** From the start of v2.0, report per strategy: trades, win rate, net SOL and USD, profit factor,
average and worst trade, maximum drawdown from marks, worst day, exits by reason, the gate funnel (coins seen, passed gates,
setup, demand, cost, entered), decision age and quote-to-fill age. Compare with HOLD (cash), the E0 accounts (legacy rules
with honest timing) and the legacy bots.

**Replays (secondary, same recorded inputs, one model execution for every variant):** `node server/tools/v11_ablation.js`
on the `research` branch. Variants: `~timed` (identical entries, exit only at the horizon: do the thesis exits help?),
`~nodemand` (no order-flow confirmation: does flow help?), `~random` (same moments, a random coin among those passing the
gates: does the selection help?), and E0. Sensitivity: drift 1% (`--drift 0.01`), latency 3 s (`--latency 3000`).

**Split.** The recorded inputs from v2.0's start: decisions in the first 60% of the window choose, the last 40% judge.
v2.0 itself never changes. Any v2.1 is chosen only on the first 60%, judged once on the last 40%, then runs forward beside
v2.0 from its own lock time.

**Minimum evidence before any claim:** 30 closed trades per strategy and 5 calendar days; intervals by bootstrap over
days, not trades.

**Promotion (audit D5):** a strategy may be called better than the legacy bots only if it passes all P0 tests, beats its
E0 counterpart and HOLD after realistic costs on forward data, stays positive under drift 1% and latency 3 s, has no
hidden drawdown or route-failure problem, and every trade can be explained from its contract. If none passes, the honest
result is a research-grade simulator with no claimed edge.

## Observations after the lock (recorded, not applied)

Changes to v2.0 are never made in place. These notes list candidates for a v2.1 that would be chosen on the first 60% of
the recorded window and judged on the last 40%, as section 4 says.

- Oct 21, 12:12-12:16 PM ET, first live trade (A, DOGGO, +36% in 3 minutes, profit protection): bought at $26.7K after
  +69% in 3 minutes and +61% in the last minute; the coin's 1-minute volatility was 41%, which makes the structure
  family's threshold (3x volatility) 123%, so structure could never flag on such a coin. Candidates: cap that threshold
  (for example at 30%); skip entries right after a single-minute spike. The exit was decided on a model mark of about
  +16% (DexScreener price) and filled at +36% on the Jupiter quote: in fast markets the executable quote and the model can
  differ a lot, so replays (model fills) and live results must be compared with care.
- Oct 21, 3:30 PM ET, engine 11.1 (data, not rules): the live recording showed DexScreener's price for these coins lagging
  Jupiter's by about 46 s (median of 192 matched price changes; p10 14 s, p90 107 s; 10-25% apart in 17% of the pairs
  received close together), and engine 11.0 took whichever price arrived last. The effect on v2.0 under 11.0 (12:12-4:00 PM
  ET): 9 of A's 23 trades were sold within 6 seconds of the buy because a stale DexScreener price arrived just after the
  fill and made the position look 15-45% down; the sale quotes came back near the buy price (realized -12% to +5%). B's
  -60% (PUMPMINE) was a real collapse within 1.4 minutes. Engine 11.1 reads Jupiter first (its `updatedAt` is the data
  time; polled every 12 s), uses DexScreener only as a fallback after a minute without Jupiter, and never lets older data
  replace newer. The v2.0 rules are unchanged, but 11.0 results are not comparable, so every v11 account was archived
  (visible in the v11 tab) and restarted with 10 SOL at the 11.1 start; the v2.0 forward record counts from there.
  11.0 results for reference: A +0.191 SOL (23 trades, 8 wins), B -1.082 (7, 1 win), C -0.019 (1).

## 5. Pre-registered v2.1 study (written Wed Oct 21 2026, 4:55 PM ET)

Written before looking at any outcome under engine 11.1. What had been seen: the live 11.0 results (archived), and one
replay of the 4 recorded 11.0 hours with 11.1 logic and model fills (A -1.28 SOL over 10 trades, B -0.50 over 5, C -0.30
over 1), which showed loss-limit exits filling well past the limit in fast drops, profit protection giving back a lot in
fast crashes, and two rugs. Those hours are before the study window and are not used below.

- **Data:** `v11-inputs/` from the 11.1 start (Oct 21 2026, 20:14 UTC) to at least Oct 26 2026, 20:14 UTC (5 days),
  replayed with `server/tools/v11_ablation.js` (model fills at the last observed price, 1 s latency, 0.5% drift; the
  same execution model for every variant). Coverage gaps stay gaps.
- **Variants** (each v2.0 strategy, one change at a time; `grid()` in the tool): `volcap` (structure threshold capped at
  30%), `nospike` (A only: no entry right after a minute up 25%+), `loss` (loss limit A 10%, B 12%, C 8%), `give` (profit
  protection gives back at most 25%), `cost` (round trip at most 4.5% for A and B, 3.5% for C), `safe` (no RugCheck
  insider network and RugCheck top-10 share at most 25%; coins without a full report are not eligible), `demand` (A: 62%
  buys and 5 net buyers; B and C: 60% buys). Baselines reported beside them: `~timed`, `~nodemand`, `~random`, E0, HOLD.
- **Split:** by decision time; the first 60% of the window chooses, the last 40% judges.
- **Pick rule (per strategy):** among the variants with at least 20 closed trades in the choose window, the one with the
  highest net SOL there, if it beats the unchanged v2.0 replay's net there. **Judge:** on the last 40% it must have net
  above 0 and at least the unchanged replay's net, and stay above 0 with `--drift 0.01` and with `--latency 3000`.
- **If it passes:** v2.1 = v2.0 plus that one change, locked at that moment, running forward beside v2.0 as new
  accounts (A2/B2/C2). If nothing passes: no v2.1; v2.0 keeps running and the report says so.
- **Also reported, not used for the pick:** green days, profit factor, maximum drawdown, fills on old prices, and the
  forward (quote-filled) v2.0 results over the same days.
