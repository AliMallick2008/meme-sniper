# Meme Sniper v11: audit implementation report

Audit: `docs/audit/2026-10-21-strategy-audit.md` (Section E phases 0-5, Section F tests T01-T20, Section I evidence).
Code: branch `claude/v11-audit`, draft PR AliMallick2008/meme-sniper#1. Status per phase: `docs/PROGRESS.md`.

## In one paragraph

v11 is a second paper engine that runs inside the same server process as the seven legacy bots and never touches them.
It only acts on what it had received by the time it acts. A coin's watch starts when its last check arrived, not when it
crossed $7K. A buy or sell is a decision on a live observation, and it fills only from a Jupiter quote requested after
that decision, with fees, price impact, a latency allowance and network costs. A position's value comes from a sell
quote or the curve/pool model at a fresh price, never from an old price. Time the server was off books nothing.
On top of that it runs three new strategies (A launch momentum, B confirmed pullback, C after graduation). Each keeps
checking whether the reason it bought is still supported by evidence (price structure, buy vs sell flow, liquidity,
holders) and leaves when two of those break together, on a verified emergency, at its risk limit, on a trailing guard,
or at its horizon. The seven E0 accounts run the legacy rules exactly, but with honest timing, so the gap between each
E0 account and its legacy twin measures how much of the legacy result came from timing (audit experiment E0).
Nothing here shows that any strategy makes money. The point is that results can now be trusted enough to find out.

## What changed, by phase

| Phase | Done | Where | Tests |
|---|---|---|---|
| 0. Freeze baseline | legacy rules, journal snapshot and source hashes frozen; paper-only guard | `baseline/legacy-v10/`, `server/tests/phase0.test.js` | guards |
| 1. Causal correctness | event engine; eligibility from the last check; next-quote fills; backward-only SOL/USD; quote age; coverage gaps book nothing; requested vs filled orders; idempotent events; invariant checker | `server/v11/engine.js`, `parse.js`, `gates.js`, `verify.js` | T01 T02 T03 T10 T12 T14 T15 T20 |
| 2. Survival + execution | sizing from depth, break-even, reachable protective level or curve worst case, risk budget; graduation state machine; distressed marks when the route dies; kill switch on stale or broken data; exits outrank entries; minute equity ledger with worst-case band; MAE/MFE | `risk.js`, `model.js`, `fees.js`, `engine.js` | T04 T07 T11 T13 T17 T18 |
| 3. Market intelligence | feature snapshots and four independent evidence families; strategies A/B/C ranked at a common decision time with the reasons for every alternative; thesis state machine; corroborated deterioration exits; trailing guard from past marks only; ablation and E2 variants; trace replay | `features.js`, `strategies.js`, `replay.js` | T05 T06 T16 + Findings 07, 08, 15; replay tests |
| 4. Narrative layer | claims (unverified by default), name cluster demoted to context, independent mint-specific attention with copy-campaign merging; `unavailable` when no approved source is connected | `social.js` | T08 T09 T19 + Finding 06 |
| 5. Validation and dashboard | server wiring with fault isolation; v11.json + page view; event log; per-run event trace artifact; simulator checks; independent Python reference for E0; dashboard panel; reconciliation tool; this report | `runtime.js`, `view.js`, `reconcile.js`, `server/main.js`, `dashboard/sniper_ui.js`, `dashboard/tests/v11_e0_ref.py` | simulator, page check |

## Tests (Section F)

All in `node --test server/tests/*.test.js` (27 tests including the Phase 0 guards and the replay tests, all passing). Where the audit asks for it, a test also runs the
legacy engine on the same synthetic market and shows it doing what the fix forbids.

| ID | Scenario | v11 result | Legacy on the same market |
|---|---|---|---|
| T01 | checks arrive 5 min after the crossing, dip in between | no buy for the early dip; the watch starts at the last check; a fresh dip after it is bought | books the dip from before the checks |
| T02 | green candle known only at minute close | decision after the minute ends; fill from the next quote | fills at the close of its own signal candle |
| T03 | one-second wick to the buy level | order fails (price moved / no route / no quote in time) | candle low = fill |
| T04 | stop below the curve floor | never planned: replaced by the curve worst case, or refused over budget; E0 flags it | stop silently unreachable |
| T05 | price falls, buyers vanish, trend fails | thesis exit (structure + demand) well before the protective level | holds to a 90% stop |
| T06 | healthy pullback with renewed buying | holds; never judged broken | n/a |
| T07 | sell route disappears | exit logged unfilled, retried; state `exit_unavailable`; mark unpriceable with last value, age and worst case | valued at the last candle |
| T08 | copy-paste mentions from one group | merged into one voice; never `verified` | n/a |
| T09 | unverifiable partner claim | listed as an unverified claim with a warning | n/a |
| T10 | dev % and top holders missing | `unknown`, never 0% or a pass (strict gates); E0 keeps the legacy pass but labels it | dev = 0%, top = pass |
| T11 | price feed or SOL/USD stale | entries halt with the reason; held coin shown unpriced with the age | marks from the last candle |
| T12 | SOL/USD minute missing | last value known before; never a later one | searches 4 h forward |
| T13 | graduation between curve and pool | no fills or marks while migrating; pool fees after | n/a |
| T14 | server offline through a target | nothing booked; the would-be exit recorded as hypothetical from candles received later | books the exit inside the outage |
| T15 | duplicate events, restart | ignored by id; same books after a JSON save/load | n/a |
| T16 | strong winner | trailing exit from marks seen so far; identical decision when the future differs | +1% target sells early |
| T17 | size doubled in a thin pool | impact roughly doubles; size cut or refused | fixed 1 SOL |
| T18 | winner with a deep dip first | MAE and the account drawdown recorded from minute marks | drawdown from closed trades only |
| T19 | ten copycats share a name | name cluster only (context); social status `unavailable` | the name match is the "meme" check |
| T20 | API format change | field becomes unknown and is logged; a whole-response change halts entries; a bad quote fails the order | n/a |

## Verification beyond the unit tests

Simulator (`dashboard/tests/server_sim_test.py 2.5 3`): the busy synthetic market (150 coins over $7K and 300 duds in
2.5 h), run by the real server code in three runs with a 50 s handover and a 22 min outage.
- Legacy bots: all 7 match the independent Python replay of the locked rules (`ALL BOTS MATCH`): v11 changes nothing for them.
- v11 invariants (every trade justified by data received before its decision, nothing booked inside the outage, the
  books add up): no violations over 63 orders and 60 fills; the outage is recorded as a gap (8 open positions, nothing booked inside it, its hypothetical exits listed); 0 runtime errors, 0 duplicate events.
- Independent Python reference of the 7 E0 accounts, replaying the same event trace: `ALL E0 MATCH` over 159,203 events: same trades, same times, same cash to 1e-9 SOL for all 7 accounts, across the handover and the outage.
- Exact replay of the trace through a fresh engine (with the same save/load at each restart): `SAME BOOKS` for all 11 accounts.
- Sizes: `v11.json` at most 696 KB, the page view inside `state.json` at most 93 KB; the page in server mode shows the v11 panel with the saved balances, no page errors, 390 px phone width, 38 GitHub API calls an hour (`SERVER PAGE OK`). Page local mode unchanged (`ALL BOTS MATCH`).

A/B/C are covered by deterministic unit tests and the invariants, not by an independent re-implementation; their
simulator trades use made-up buy/sell stats derived from the synthetic price path, so their simulated P&L means nothing.

## Legacy vs causal reconciliation (live journal, Oct 21 2026 10:40 UTC)

From `node server/v11/reconcile.js state.json --md` on the live `data` branch. The E0 twins are not running yet, so that
column fills in once v11 is live.

| Bot | Coin | Entry candle (UTC) | Booked | Checks in | Entry MC | Exit | Net SOL | Flags | E0 twin |
|---|---|---|---|---|---|---|---|---|---|
| U | ok | 08:28 | 08:30:55 | 08:25:59 | $4.4K | open | open | stop-unreachable: stop at $443 under the curve floor $3.0K | not running yet |
| U2 | ok | 08:28 | 08:30:55 | 08:25:59 | $4.4K | time 10:27 | -0.3812 | booked-late: sell booked 244 s after its candle closed; stop-unreachable: stop at $443 under the curve floor $3.0K | not running yet |
| U30 | ok | 08:28 | 08:30:55 | 08:25:59 | $4.4K | time 08:57 | -0.3839 | booked-late: sell booked 5644 s after its candle closed; stop-unreachable: stop at $443 under the curve floor $3.0K | not running yet |
| U30 | DAWKOIN | 09:03 | 10:33:39 | 09:02:32 | $16.0K | time 09:32 | -0.7979 | booked-late: buy booked 5379 s after its candle closed; booked-late: sell booked 3640 s after its candle closed; stop-unreachable: stop at $1.6K under the curve floor $3.0K | not running yet |
| U30 | TILLY | 09:49 | 10:35:36 | 09:48:07 | $5.5K | tp 10:09 | +0.0100 | booked-late: buy booked 2736 s after its candle closed; booked-late: sell booked 1540 s after its candle closed; stop-unreachable: stop at $553 under the curve floor $3.0K | not running yet |
| T25 | ok | 08:28 | 08:30:55 | 08:25:59 | $4.4K | time 10:27 | -0.3812 | booked-late: sell booked 244 s after its candle closed; stop-unreachable: stop at $443 under the curve floor $3.0K | not running yet |
| D55 | ok | 08:28 | 08:30:55 | 08:25:59 | $3.3K | time 10:27 | -0.1838 | booked-late: sell booked 244 s after its candle closed; stop-unreachable: stop at $333 under the curve floor $3.0K | not running yet |
| GRN | TILLY | 08:31 | 08:35:11 | 08:29:29 | $7.7K | tp 08:32 | +0.0100 | booked-late: buy booked 191 s after its candle closed; booked-late: sell booked 134 s after its candle closed; same-candle: filled at the close of its own signal candle; stop-unreachable: stop at $773 under the curve floor $3.0K | not running yet |
| GRN | NICE | 08:44 | 08:50:01 | 08:39:46 | $3.0K | open | open | booked-late: buy booked 301 s after its candle closed; same-candle: filled at the close of its own signal candle; stop-unreachable: stop at $298 under the curve floor $3.0K | not running yet |

What it shows so far: every legacy trade has a stop the market cannot reach. Both GRN trades were booked 2 to 5 minutes
after their candles and filled at the close of their own signal candle. The coin "ok" died at the curve floor at 08:31 UTC,
three minutes after five bots bought it. The legacy time limits only fire on a new candle, and a dead coin has none, so
U30 sat 90 minutes past its 30-minute limit (Findings 03, 11, 15 observed live). When "ok" finally printed a candle at
10:27, U30 booked its 08:57 time exit 94 minutes late and then, within two minutes, two more trades from the past:
DAWKOIN bought at a 09:03 candle (booked 10:33, 90 minutes later) and TILLY bought at a 09:49 candle (booked 10:35).
Those are replays with hindsight recorded as forward paper trades (Findings 01, 19). The legacy bots stay as they are
(locked rules); E0 enforces time limits by the clock and never books the past.

## Execution costs (model, 1 SOL on the bonding curve, SOL $106.90)

| Entry market cap | Buy impact (avg vs spot) | Round trip at an unchanged price | Rise needed to break even | Worst case if every other holder sells |
|---|---|---|---|---|
| $4.4K | 2.7% | -8.5% | +9.4% | 0.66 SOL |
| $7K | 2.2% | -7.5% | +8.2% | 0.41 SOL |
| $15K | 1.5% | -6.2% | +6.7% | 0.19 SOL |
| $40K | 0.9% | -5.2% | +5.5% | 0.07 SOL |

Included: pump.fun's 1.25% curve fee each way, the bonding-curve impact of the bot's own order, a 0.5% latency allowance
each way, 0.0002 SOL priority fee and 0.000005 SOL network fee per swap. Token-account rent (0.00203928 SOL) is locked
while holding and refunded at the close. Live fills use Jupiter's quote for the exact size instead of this model.

## Data sources and failure modes

| Source | Endpoint | Used for | Failure handling |
|---|---|---|---|
| Jupiter | `lite-api.jup.ag/tokens/v2/recent` | new pump.fun coins (via the legacy scanner) | none needed: discovery only |
| Jupiter | `lite-api.jup.ag/tokens/v2/search?query=<40 mints>` | audit (first and re-checks), 5-min buy/sell notional, traders, holders | unexpected field types become unknown and are logged; a non-list response is a schema error (3 in 2 min halt entries) |
| Jupiter | `lite-api.jup.ag/swap/v1/quote` | every fill; a sell quote per held coin a minute | 400 = no route (order fails; 2 in a row = exit unavailable); 429/5xx retried within the order's 30 s; missing amounts = schema failure |
| DexScreener | `api.dexscreener.com/tokens/v1/solana/<30 mints>` | prices every 5-10 s, pool reserves, transaction counts, claims | no price for 60 s halts entries; a coin's price older than 30 s blocks acting on it and unprices its position |
| RugCheck | `api.rugcheck.xyz/v1/tokens/<mint>/report/summary` | danger flags | missing = unknown (strict gates refuse; legacy fails it) |
| GeckoTerminal | `.../pools/<pool>/ohlcv/minute` (legacy fetches) | the high since launch from final candles, gap hypotheticals | only candles closed 2 min before receipt are used |
| Coinbase | `SOL-USD/ticker`, `/candles` | SOL/USD for reporting and USD thresholds | backward lookup only; stale over 10 min halts entries |
| pump.fun | fee schedule (docs) | model marks only | tiers above 9,820 SOL not copied in (0.95% upper bound used, flagged) |
| X / Telegram | none approved | social evidence | status `unavailable`, never "no interest" |

Rate limits: all Jupiter calls (legacy and v11) share one lane at 2.1 s spacing (keyless limit 30 per minute).

## Point-in-time data and provenance

- Every event carries `req` (request sent) and `at` (response received). Decisions record the observation they used and
  its time; orders record decision, quote request and quote receipt times; trades keep all of them.
- `v11.json` (data branch): full engine state, saved every 2 min and within seconds of a fill.
- `state.json > v11` (data branch): the page view.
- Research branch `v11/events/<date>/<hour>h-run<id>-<n>.jsonl.gz`: append-only event log (crossings, audits as
  received, gate results, stage changes, orders, fills, failures, reviews, gaps, hypotheticals, status changes).
- GitHub Actions artifact `v11-trace-<run id>` (30 days): every event each run ingested, in order, for exact replays
  (`node server/v11/replay.js <trace>`) and model-quote ablations (`--model --set ablations`).
- Legacy research recordings (research branch `research/...`) continue unchanged.

## Results against legacy and holding SOL

Not available yet: v11 has not run on live data. How results will be reported (Section D): every account against its
legacy twin and against HOLD, in SOL and USD, with trade counts, marked drawdown, time underwater, exit reasons, cost
breakdown, and decision-to-fill ages; no ranking under 30 closed trades per account; ablations from the recorded traces.
The promotion rule (D5) applies: nothing replaces the legacy bots unless it passes every P0 test (done), does at least as
well on causally valid simulation with realistic costs, holds up on unseen forward weeks, and has no hidden drawdown or
no-route problem. If nothing passes, the honest result is a research-grade simulator with no claimed edge.

## What could not be verified

- No live market data from this Claude Code session: its network policy blocks Jupiter, DexScreener, GeckoTerminal,
  RugCheck, Coinbase and pump.fun. Field names and shapes follow the probes made in the earlier session (Oct 21, in
  `docs/v11-plan.md`); everything else is tested on synthetic markets.
- Whether Jupiter quotes for brand-new curve coins always return; the stage labels for PumpSwap routes (`Pump.fun Amm`
  is assumed; any label with "pump" and "amm"/"swap" counts).
- pump.fun fee tiers above 9,820 SOL market cap.
- Whether the Jupiter 5-minute stats are as fresh as `updatedAt` claims.
- A/B/C thresholds are first guesses, not tuned or validated values. No profitability claim of any kind.
- No approved social data source: the narrative layer is informational and reports `unavailable`.

## Remaining risks

| Risk | Effect | Mitigation now | Next step |
|---|---|---|---|
| v11 bug in production | v11 stops for the run | errors counted; 50 stop v11, legacy continues; `V11=off` disables it | watch `rt.errors` in the page view |
| Jupiter rate limit (30/min shared) | quotes late, orders expire | one lane at 2.1 s, exits first, one mark quote per held coin per minute | measure live usage in the first runs |
| Marks between quotes | model error of the curve/pool math | calibrated by the latest quote; source shown | compare model vs quote over the first week |
| Legacy time limits not enforced on dead coins | legacy baseline overstated or stuck | reported here; E0 uses the clock | owner decides whether a v10.2 fixes it |
| Small samples | noise read as edge | no winner badge; sample size shown; bootstrap intervals in the analysis | wait for 30+ trades per account |
| Trace artifacts expire after 30 days | ablations limited to recent data | download older traces to research storage | add a weekly export if needed |
