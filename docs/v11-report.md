# v11 report: the audit's Section E, implemented

Status: living document. Static sections (what was built, endpoints, failure modes, provenance, costs, what cannot be
verified, risk register) are current as of Oct 21 2026. Results sections fill in as forward data accumulates; nothing here
claims an edge before the evidence rules in `research/v2_protocol.md` are met.

## 1. What changed (audit Section E)

| Phase | Deliverable | Where |
|---|---|---|
| 0 | Legacy v10 baseline frozen (journal, rules, source hashes), experiment ids, paper-only guard test | `baseline/legacy-v10/`, `server/tests/phase0.test.js` |
| 1 | Causal event engine: eligibility from check receipt times, fills only from quotes received after the decision, no future SOL/USD, stale marks labeled, coverage gaps credit nothing | `server/v11/engine.js`, `market.js`, `gates.js`, `runtime.js` |
| 2 | Survival and execution: unreachable stops rejected or converted, risk budgets, finite horizons, executable mark quotes, route-loss distressed state, quote-impact sizing, versioned pump.fun fees, equity ledger with bands, MAE/MFE | `risk.js`, `model.js`, `fees.js`, `engine.js` |
| 3 | Market intelligence: feature families, V2 strategies A/B/C with entry contracts, ranking, corroborated deterioration exits, RugCheck report as the second dev-wallet source; locked v2.0 | `features.js`, `v2.js`, `thesis.js`, `research/v2_protocol.md` |
| 4 | Narrative layer without fabricated evidence: social "unavailable", launcher links "unverified claim", name-cluster score labeled as copycats, dossier | `narrative.js`, v11 tab |
| 5 | Recording of every engine input with exact replay, ablation and baseline tool, v11 tab, this report | `record.js`, `server/tools/`, `dashboard/v11_ui.js` |
| 11.1 | Jupiter-first prices with data times after measuring DexScreener's lag; 11.0 accounts archived, all restarted | `market.js`, `engine.js` |
| E0 rev 2 | E0 follows the legacy bots' own watchlists (6 slots, swaps) via a `legacy_watch` event; only E0 restarted | `strategies.js`, `runtime.js` |

Acceptance tests T01-T20: `node --test server/tests/*.test.js` (T01 T02 T03 T10 T11 T12 T14 T15 in phase 1, T04 T07 T13
T17 T18 T20 in phase 2, T05 T06 T16 in phase 3, T08 T09 T19 in phase 4), plus the recording replay test. The server sim
(`dashboard/tests/server_sim_test.py`) additionally checks on a full mock market with a 22-minute outage that the legacy
bots still match the independent Python reference exactly, that no v11 buy happens before its eligibility or with data
received after the decision, that no fill falls inside a coverage gap, and that replaying the recorded inputs rebuilds
the live v11 state exactly across restarts.

## 2. Data sources, endpoints and failure modes

| Source | Endpoint | Used for | Failure handling |
|---|---|---|---|
| Jupiter tokens v2 | `lite-api.jup.ag/tokens/v2/search?query=<up to 100 mints>` | price, market cap, liquidity, holders, audit (mint/freeze authority, top holders, dev share when present, dev wallet), 5-min and 1-h order flow | keyless 30 calls/min shared with quotes: one lane at 2 s spacing. Missing fields stay unknown (Jupiter omits zero values: `numOrganicBuyers` never present, `devBalancePercentage` for ~26% of coins). A non-list response is an invalid observation, never zeros |
| Jupiter quote | `lite-api.jup.ag/swap/v1/quote` | every fill; mark quotes for held coins (60 s curve, 30 s pool) | HTTP 400 = no route (sellability fact, 2 in a row = route lost); timeouts and 5xx say nothing about the route; rate limited = the order times out after 30 s and the signal is re-checked |
| DexScreener | `api.dexscreener.com/tokens/v1/solana/<30 mints>` | prices every 5 s (fast list) / 30 s (slow list), pair venue (pump.fun curve vs PumpSwap pool), txns, liquidity | a missing price field or a changed envelope is an invalid observation with its reason (T20); a coin not listed yet is no observation |
| RugCheck | `api.rugcheck.xyz/v1/tokens/<mint>/report/summary` (legacy) and `/report` (v11) | danger flags; creator balance, top holders, known AMM accounts | report without `token.supply`/`topHolders` or for another mint is invalid; up to 3 tries per coin |
| Coinbase | `api.exchange.coinbase.com/products/SOL-USD/ticker` | SOL/USD | v11 only looks backward; none within 5 min = unknown (T12) |
| GeckoTerminal | 1-minute OHLCV | legacy bots and the legacy research recorder only | lane adapts on 429 (about 6 calls/min from a GitHub runner) |

Not used: the Solana public RPC (403), X and Telegram (no approved API).

**Measured data lag (live, Oct 21 2026):** for pump.fun coins DexScreener's `priceUsd` lags Jupiter's price by a median
46 s (p10 14 s, p90 107 s, from 192 DexScreener price changes matched to the Jupiter price with the same value); 17% of
Jupiter/DexScreener pairs received close together differed by more than 10%. Jupiter's `updatedAt` is the time of its data
and stays old for a coin with no trades (median age at receipt 106 s, p90 14 min across all followed coins). Under engine
11.0 a stale DexScreener price arriving after a fill made 9 of A's first 23 positions look 15-45% down and sold them
within 6 s; the sale quotes came back near the buy price. Engine 11.1 builds prices from Jupiter first.

## 3. Dataset provenance

- `research/` on the `research` branch: legacy-protocol records (point-in-time checks + final GeckoTerminal candles), sampled
  per Amendment 5 (every coin that passed a bot's checks + 1 in 24 others by mint hash).
- `v11-inputs/`: every engine input in arrival order with receive times; complete for every crossing the server saw
  while running. Replays rebuild the live state exactly (`server/tools/v11_replay.js`).
- `v11-events/`: every engine decision (eligibility, orders, fills, failures, reviews, closes, coverage gaps).
- Coverage: only time the server was running; launches during an outage are not seen at all (selection bias, audit
  finding 20). Gaps are listed in the v11 tab and in `state.json > v11.gaps`. Within that time, every crossed coin is
  priced for 3 hours: held, ordering, watched, young and setup-candidate coins every 12 s (Jupiter) and 10 s (DexScreener),
  other live coins every 30 s, coins under $5K or dropped every 2 minutes (from Oct 21, 4:45 PM ET).
- Exact replay verified on real data across run handovers (Oct 21: 399k events, every reloaded state identical).

## 4. Execution cost model (per trade)

Venue fee (pump.fun curve 1.25% each way; PumpSwap tiers 1.25% under 420 SOL market cap down to 0.30%) inside the Jupiter
quote; price impact from the quote (the model before the quote); 0.5% landing drift each way; 0.000105 SOL network fee per
swap; 0.00203928 SOL token-account rent, refunded at close. A paper buy never moves the real market, so a paper round trip
pays impact both ways; on a real curve the buy's own impact would partly come back. V2 sizes each trade so the round trip
stays under 6% (A, B) or 5% (C): about 0.4-0.7 SOL on a $8-12K curve coin.

## 5. Results

Forward paper from v2.0's start (Oct 21 2026, about 12:20 PM ET). To be filled from `state.json > v11` and the replays.
Report per account: trades, wins, net SOL and USD, profit factor, max drawdown from marks, worst day, exits by reason,
funnel, decision age, quote-to-fill age; compared with HOLD, E0 and the legacy bots. Minimum 30 closed trades and 5 days
per strategy before any statement about edge.

## 6. What cannot be verified here

- Whether a real order would land at the quoted price: quotes are executable estimates, not fills; drift is modeled.
- Social attention: no approved data source; nothing is inferred from names or launcher links.
- The dev wallet: Jupiter's `dev` and RugCheck's `creator` often differ; both are checked and the higher share counts, but
  wallets the dev controls under other addresses are invisible without on-chain cluster analysis.
- Launches during server gaps; GitHub runner IPs shared with other users (rate limits vary).

## 7. Remaining risks

| Risk | Effect | Mitigation now |
|---|---|---|
| Jupiter rate limit shared by legacy and v11 | delayed checks or failed quotes | one 2 s lane; quotes failing for rate limits are not treated as route loss |
| Data branch size (state.json ~0.65 MB, v11.json ~1 MB, saved every 2 min) | slower saves | trimmed saves (20 bars, recent snapshots, 200 log lines); full history on the research branch |
| Research branch growth (v11 inputs, several MB a day) | repo size | shape-encoded, gzipped; move old files to releases if it passes ~1 GB |
| Small samples | false confidence | protocol minimums, no winner badges, bootstrap by day |
