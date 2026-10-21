# v11 plan: the audit's Section E, in order (with Section F tests as the bar)

Source: `docs/audit/2026-10-21-strategy-audit.md`. Owner's instruction (Oct 21 2026, 4:56 AM ET): implement Section E
phases 0 to 5 in order, using T01 to T20 as acceptance tests. Core idea: the bot stops thinking "price dropped, buy /
target hit, sell" and keeps checking whether the reason it owns a coin is still supported by evidence.

Status of each phase lives in `docs/PROGRESS.md`. Update it after every step and commit, so any session (this chat or
Claude Code) can resume.

## Non-negotiables

- Paper only. No keys, wallets, signing or order submission code anywhere (a test greps for it).
- The 7 legacy bots (U, U2, U30, T25, D55, GRN, STR in `server/sniper_core.js`) keep running UNCHANGED as the
  baseline ("legacy-v10", legacy assumptions). Their journal is `state.json` > `J`. Baseline frozen in
  `baseline/legacy-v10/` (journal snapshot, rules, source hashes).
- v11 is a new engine beside them in the same server process, with its own state (`v11.json` on the data branch, a view
  of it inside `state.json` > `v11`). It never edits legacy state.
- No decision may use data received after the decision time. No fill before an executable quote received after the
  decision. No trade credited for time the server was not running.

## Data the v11 engine uses (probed Oct 21 2026)

| Source | What | Notes |
|---|---|---|
| Jupiter `tokens/v2/search?query=<up to 100 mints>` | usdPrice, mcap, liquidity, holderCount, organicScore, audit (mint/freeze authority, topHoldersPercentage, devBalancePercentage often MISSING, devMints), stats5m/1h/6h/24h: buyVolume, sellVolume (USD notional by side), numBuys, numSells, numTraders, numNetBuyers, holderChange, priceChange; `updatedAt` (source as-of time) | Snapshot every ~20 s for active coins |
| Jupiter `swap/v1/quote` | executable route for an exact size: inAmount/outAmount (fees inside), priceImpactPct, route labels (`Pump.fun` = bonding curve, PumpSwap pools show their own label), contextSlot | Entry and exit fills; marks for held coins about once a minute |
| Jupiter rate limit | keyless: 30 requests per 60 s sliding window, one bucket for tokens + quote + price; headers `x-ratelimit-remaining/reset` | Server keeps all Jupiter calls (legacy + v11) on one lane at 2 s spacing |
| DexScreener `tokens/v1/solana/<30 mints>` | priceUsd, priceNative (SOL), marketCap, txns m5/h1 counts, volume m5/h1 (not split by side), liquidity (pools only), pair dexId (`pumpfun` / `pumpswap`), info.socials/websites (claims) | Every ~5 s for active coins (300/min allowed) |
| Coinbase SOL-USD | ticker + 1-minute candles | v11 only looks BACKWARD for SOL/USD; missing -> unknown |
| Solana public RPC | `api.mainnet-beta.solana.com` answered 403 from a browser | Not used |
| X / Telegram | no approved API access | social evidence = `unavailable` |
| pump.fun fees | https://pump.fun/docs/fees (last updated Oct 17 2026): curve 1.25%; PumpSwap SOL tiers 1.25% (<420 SOL mc) ... 0.30% (>=98,240 SOL mc), 25 tiers | `server/v11/fees.js`, versioned by effective date |

## Engine (server/v11/)

Pure, event-driven, deterministic: `engine.ingest(event)` and `engine.tick(at)`; returns requests (quotes) for the
runtime. Every event carries `at` = when the runtime received it. Persisted state is plain JSON.

- **Coverage:** `run_start` after more than 90 s of silence records a `CoverageGap`; pending orders are cancelled
  ("server offline"); held positions are re-reviewed on live data. Anything that "would have happened" inside the gap is
  only recorded as `hypothetical` (never in the forward ledger).
- **Eligibility:** `eligible_at = max(crossing observed, all check responses received)`, per gate set. Gates are
  4-valued: pass / fail / unknown / not_applicable. Unknown critical facts are not eligible (re-checked on later
  snapshots; eligibility time is when they arrive). Check UI shows request/receive times.
- **Orders:** decision at t -> `OrderRequested` (decision snapshot, quote request) -> filled by the first quote for
  that order received after t (+ landing drift) if within max slippage; else `OrderFailed`. Orders expire after 30 s.
  Costs: quote amounts (venue fees inside) + network fee per swap + token-account rent (refunded at close) + landing
  drift. Idempotent by order id; duplicate events ignored by event id.
- **Marks:** position value = fresh sell quote (<= 90 s) > curve/pool model from a fresh snapshot price (<= 30 s) >
  `UNPRICEABLE` (last value shown with its age, worst case shown separately). Equity ledger every minute with
  [worst, mark] band; per-trade MAE/MFE; drawdown from all marks.
- **Stages:** curve -> migrating (uncertain) -> pool, from snapshot pair ids and quote route labels. No fills while
  migrating.
- **Kill switch:** stale or invalid data on a coin blocks new entries on it; global feed outage halts all entries; exits
  keep trying; status shows "Incomplete data".

## Accounts (all start with 10 paper SOL at the v11 start)

- `E0-*` (7): the legacy rule sets with causal timing (audit experiment E0): same gates as legacy (including legacy's
  unknown-as-pass), the same watchlist as the legacy bot (6 slots and swaps, from the legacy core's own decision; rev 2),
  same 40% (55%) dip from the observed high, green-bar entry for GRN, same targets/stops/time limits,
  but eligibility from `eligible_at`, signals from live observations only, fills at the next quote. Measures how much of
  the legacy P&L survives honest timing. Stops below the curve floor are kept (legacy rule) and flagged.
- `A` Launch Momentum, `B` Confirmed Pullback Recovery, `C` Post-Graduation Momentum (Phase 3): strict 4-valued gates,
  entry contract (setup evidence, demand evidence, quote at size, round-trip cost, horizon, invalidation, risk budget,
  why this coin beats the alternatives now), ranking at a common decision time, thesis state machine
  (healthy -> watching -> broken -> exit pending -> filled / unavailable), corroborated deterioration exits (two
  independent feature families, persistent; one emergency event is enough), finite horizons, trailing profit protection.
- `HOLD` hold-SOL baseline (no trades).

## Test map (`node --test server/tests/*.test.js`)

T01 eligibility after checks | T02 green bar fills next event | T03 wick without quote does not fill | T04 unreachable
stop rejected (V2) | T05 corroborated deterioration exits | T06 healthy pullback holds | T07 route loss -> exit
unavailable, distressed mark | T08 one-group copy mentions not trusted | T09 unverified claim labeled | T10 missing
dev/top fields unknown | T11 stale feed halts entries, stale mark labeled | T12 no future SOL | T13 graduation pauses
fills | T14 offline -> hypothetical only | T15 duplicates + restart idempotent | T16 trailing exit without hindsight |
T17 thin liquidity reduces/rejects size | T18 MAE/MFE recorded | T19 name repetition is not social proof | T20 schema
change -> safe failure.

## Evidence to produce (Section I)

Source diff (git), T01-T20 results, legacy vs E0 reconciliation per trade, API endpoints + failure modes, dataset
provenance, execution cost breakdown, results vs legacy + hold SOL with sample sizes, and what could not be verified.
Report: `docs/v11-report.md`.
