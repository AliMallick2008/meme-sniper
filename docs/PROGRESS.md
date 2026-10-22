# Progress on the audit (Section E)

Resume here. Plan and design: `docs/v11-plan.md`. Audit: `docs/audit/2026-10-21-strategy-audit.md`.
To continue in Claude Code: open this repo and say "Continue the v11 audit work from docs/PROGRESS.md."

| Phase | Status | Notes |
|---|---|---|
| 0. Freeze baseline | done | `baseline/legacy-v10/` (journal snapshot + manifest with rules and source hashes), experiment ids, paper-only guard test |
| 1. Causal engine (P0) | done | `server/v11/` engine + runtime live beside the legacy bots; tests T01 T02 T03 T10 T11 T12 T14 T15 T20 (engine side) pass; sim: E0 decisions never before eligibility, fills only after decisions, nothing inside coverage gaps |
| 2. Survival + execution | done (mechanisms) | `server/v11/risk.js` (unreachable stops rejected or converted, risk budget, horizon, round-trip cost), executable mark quotes per held coin, route-loss distressed state, quote-impact sizing, versioned fees (pump.fun Oct 17 2026), equity ledger with bands, drawdown from all marks, underwater/exposure time, MAE/MFE; tests T04 T07 T13 T17 T18 T20 pass. V2 strategies use them in phase 3 |
| 3. Market intelligence, A/B/C | done | `server/v11/features.js` (structure, demand, liquidity, holders, lifecycle; unknown stays null), `v2.js` (A Launch Momentum, B Confirmed Pullback Recovery, C Post-Graduation Momentum: strict gates, setup + demand + cost checks, ranking at one decision time, entry contracts, sizing by round trip and risk budgets), `thesis.js` (exit hierarchy: emergency, corroborated thesis break across 2 of 4 families with persistence, loss limit, stagnation, horizon, profit protection; fixed-target alternative assessed live). RugCheck full report as the second dev-wallet source (Jupiter omits it for ~74% of coins). Tests T05 T06 T16 + exit criterion (recovery vs collapse at the same 40% drawdown), contracts, ranking, unknown dev gate, report parsing. Rules locked in `research/v2_protocol.md` |
| 4. Narrative layer | done (no approved social API) | `server/v11/narrative.js`: attention "unavailable" without an approved source (nothing scraped or guessed), launcher links labeled "unverified claim", claimed partnerships never endorsements, name-cluster score labeled as copycats not attention, independent-cluster test for any future mentions; Narrative Dossier in the v11 tab; tests T08 T09 T19 |
| 5. Validation, dashboard, report | in progress | v11 tab on the page (status, strategies vs legacy and HOLD, equity, open positions with thesis health, trade audit, funnel, gaps, dossier); every engine input recorded (`v11-inputs/`) and replayed exactly (`server/tools/v11_replay.js`); ablations and baselines (`server/tools/v11_ablation.js`: ~timed, ~nodemand, ~random, E0, drift and latency sensitivity). Report `docs/v11-report.md` once real data accumulates |

## Log

- Oct 21 2026 ~5:10 AM ET: plan written; Phase 0 artifacts exported (server journal from the first live run, 1 legacy
  trade so far: GRN). Jupiter keyless limit found to be 30 requests/min shared by tokens + quote: keep all Jupiter calls
  on one 2 s lane.
- Oct 21 ~6:20 AM ET: Phase 1 done. v11 engine (`server/v11/`: engine, market, gates, model, fees, strategies,
  runtime) runs 7 E0 accounts (legacy rules, causal timing, fills at the next Jupiter quote) + HOLD. Server sim (busy
  market, 3 runs, 22 min outage): legacy bots still match the reference exactly; v11 causal checks pass; reconciliation
  shows the legacy STR bot crediting a take-profit at +1860 s that happened while the server was offline (audit finding
  19 reproduced), which E0 does not. Saved sizes: state.json ~300 KB, v11.json ~590 KB.
- Oct 21 ~7:10 AM ET: Phase 2 mechanisms done and deployed with Phase 1 (v11 runs live). Found live: Jupiter reports
  the dev wallet % for only 26% of coins (106 of 411), so strict gates need a second source (RugCheck full report)
  or most coins stay "unknown". Legacy live so far: U30 -2.03 SOL over 4 trades, U stuck in one coin since ~4:30 AM.
- Oct 21 ~11:15 AM ET: first natural handover worked (14:55 UTC), Phase 1-2 live from 15:11 UTC. Found the research
  recorder far behind (52 of 864 crossings, rq.json 1 MB growing): GeckoTerminal leaves ~9 coins/h for research. Fixed with
  hash sampling (all coins that passed some bot's checks + 1 in 24 others, queue capped at 300): protocol Amendment 5.
- Oct 21 ~12:30 PM ET: v11 now records every engine input (prices every 5 s for each crossed coin's first 20 min, then
  every 30 s while alive; Jupiter flow every 20 s for the fast list; quotes; checks; ticks; saves and loads) to
  `v11-inputs/` on the research branch, and the sim proves the replay rebuilds the live state exactly across restarts.
  RugCheck full report probed from a GitHub runner (`.github/workflows/probe.yml`, results on the `probe` branch):
  creatorBalance and token.supply are raw units; Jupiter's `dev` wallet differs from RugCheck's creator, so both count.
  Jupiter leaves zero-valued fields out of its stats (numOrganicBuyers never present; holderChange is a percent).
  Phase 3 and 4 code + tests done (31 tests pass).
- Oct 21 12:12 PM ET: phases 3-5 deployed (commit 3939acf). V2 A/B/C live; the server sim with the new code says ALL
  BOTS MATCH, V11 CAUSAL CHECKS OK, V11 REPLAY EXACT; the page check says SERVER PAGE OK (v11 tab included).
  First live V2 trade: A bought DOGGO at $26.7K (+69% in 3 min, 63% buys, 281 net buyers), sold 3 minutes later by
  profit protection at +36% (+0.307 SOL). The exit was decided on a model mark of about +16% and filled +16.5% better on
  the Jupiter quote 2 s later: DexScreener prices can lag the executable quote in fast markets. Post-lock observations
  (not applied) are in research/v2_protocol.md; research-only parameters for them (P.volCap, P.r1Max, unset in v2.0)
  and ablation variants `~volcap` and `~nospike` were added. Inputs now carry the recording code's commit ('V' line).
- Oct 21 ~4:00 PM ET: engine 11.1 deployed. Measured on the live recording: DexScreener's price lags Jupiter's by a median
  46 s (p10 14 s, p90 107 s); 17% of Jupiter/DexScreener pairs differed by more than 10%. Under 11.0 that produced spurious
  exits (9 of A's 23 trades sold within 6 s of the buy on a stale price). 11.1: Jupiter-first prices with data times,
  polled every 12 s (up to 200 coins), DexScreener every 10 s as fallback and venue, no older data over newer, priceAt
  only from accepted prices; on load an 11.0 state is archived and every account restarts. Also: recorded Jupiter
  snapshots trimmed to used fields (recording was 2.3 MB/h gzipped), state.json view slimmed (was 1.2 MB). The GeckoTerminal
  research recorder got no slots at all after 13:00 UTC (bots' candle queue never empty); the v11 recording now covers every
  crossing, so the legacy research will move to it (protocol amendment pending).
- Oct 21 ~5:30 PM ET: E0 rev 2. E0 had watched every coin passing the legacy checks, but the legacy bots keep at most 6
  coins each (a stronger coin replaces the weakest one far from its buy zone), so E0 traded far more coins than its bot
  (E0-U2 15 trades vs U2 4 under 11.0). Now the legacy core reports each watchlist decision (`legacy_watch` event from
  `decide()`: which bots watch the coin, which coins were swapped out) and E0 follows it with honest timing. Accounts got
  revisions: only E0 restarts (archived as "rev 1"), V2 keeps its ledger.
- Oct 21 ~4:35 PM ET: replay verified on real data across two run handovers (3939acf -> 6e7ea63 at 16:27 UTC and
  6e7ea63 -> dcc1779 at 20:15 UTC: 399k events, 3.1k ticks, "loaded state matches the replay" both times). First ablation
  run on the 4 recorded 11.0 hours with 11.1 logic and model fills worked, but showed a coverage gap: a replayed variant can
  hold a coin the live run had stopped following (74% of its model fills found no recent price). The runtime now records
  every crossed coin for 3 hours (coins the engine dropped every 2 minutes, recording only), and the ablation fills on the
  last price up to 150 s old, counting fills on prices older than 30 s per account.
- Oct 21 ~5:00 PM ET: exact replay verified across all four live handovers of the day (16:27, 20:15 with the 11.0 to 11.1
  upgrade, 20:30 with the E0 rev 2 restart, 20:46), each stretch with its own commit. v2.1 study pre-registered in
  research/v2_protocol.md section 5 (5 days of 11.1 data, one-change grid, 60/40 split, pick and judge rules); research-
  only switches added (inert in v2.0). v11 tab: "Profit by day" table (the owner's goal: green days).
  Scheduled check-ins: Oct 22 03:05 UTC (overnight health + replay), then ~13:00 UTC (morning summary).
- Oct 21 ~9:30 PM ET (01:30 UTC Oct 22): exact replay also verified across the 20:56 and 21:01 UTC handovers
  (463d34a -> 6295463 -> e7db7df, 274k events). Research branch 16.5 MB; v11 inputs about 1.2-1.6 MB/h gzipped.
  Forward since the 11.1 start (20:14 UTC), at 01:23 UTC: A 8.268 SOL (25 trades, 7 wins; exits: trail 7, loss limit
  17, stagnation 1; three rugs at -84% to -92%; loss-limit exits filled at -15% to -41% because a coin can fall a long
  way between 12 s price checks), B 9.583 (10 trades, 1 win), C no trade; E0 (since 20:30) all under 10; legacy bots U
  10.000, U2 8.633, U30 7.967, T25 7.909, D55 8.076, GRN 10.010, STR 9.306. v2.0 unchanged (locked).
- Oct 21 ~10:00 PM ET (02:00 UTC Oct 22): the trade tape. Probes from a GitHub runner (branch probe-src, read-only) showed the
  public Solana RPC answers there (it had looked blocked only from a browser): getMultipleAccounts in 26 ms (p50), and a
  websocket with one logs subscription per bonding curve delivers every trade (pump.fun TradeEvent: trader, side, SOL,
  tokens, the curve's reserves after it, the creator). 86% of the transactions touching busy curves fail (bot spam) and
  are skipped. Finding: not every curve starts at 30 virtual SOL any more (64 of 99 coins in a 20 s sample did; others
  from about 1 to 830 SOL), so the classic-curve model misprices the rest. New: `server/v11/tape.js` (the lane: up to 40
  curves, held and ordering coins first, then the fast list; polling every 2 s fills gaps and reports completion) and
  `server/v11/tapestate.js` (per-coin trades for 15 minutes, exact price, creator sells, window features). Data only:
  no v2.0 or E0 rule reads it (tests check their prices never come from the tape). Recorded as compact 'T'/'C' lines;
  replays exactly. The real module ran 90 s on a runner on the 25 busiest curves: 1,378 trades, no decode misses, no
  reconnects, recording about 1.1 MB/h gzipped. The simulator runs without the lane (real network, real clock); its
  own tests use recorded fixtures and a fake websocket (40 tests pass).
- Oct 22 11:20 AM ET (15:20 UTC): the overnight check (its scheduled reminder reached this session 12 h late). Server
  healthy all night: natural handovers at 02:47, 08:32 and 14:17 UTC (3 s each), no coverage gap, lanes clean
  (Jupiter 1 failure in this run). Exact replay verified across all three with the deployed commit (e7db7df, 987k events,
  12.9k ticks). Recording about 1.15 MB/h gzipped; research branch about 33 MB. state.json 1.16 MB (legacy journal coins
  616 KB, v11 view 436 KB): watch it. Forward since the 11.1 start (20:14 UTC Oct 21, about 19 h): A 8.522 SOL (62
  trades, 22 wins; exits: 15 loss limit, 14 profit protection, 1 thesis in the last 30), B 9.844 (20 trades, 7 wins), C
  9.806 (1 trade), HOLD 10; E0 all under 10 (E0-U30 6.12); legacy U2 7.79, U30 7.97, T25 7.07, D55 8.08, GRN 7.26,
  STR 9.31, U 10 (holding "ok" since Oct 21 4:30 AM: its v10 stop sits under the curve floor, so it can never trigger).
- Oct 22 11:20 AM ET: v3.0 locked (research/v3_protocol.md, pushed to branch `v3-lock` at 15:17 UTC before the code was
  finished; Amendment 1 at 15:21 UTC, before the start: A3e's 10-second drop counts the price the window started at).
  Accounts A3 and A3e (v2.0's A) and B3 (v2.0's B) take v2.0's entries on coins whose tape is live, fill against the
  curve as last received at or before decision + 2 s, are valued on the exact curve and reviewed after every tape
  observation; A3e also exits at once if the creator sells or the price drops 20% inside 10 s. Engine: `v3.js`, curve
  fills (`curveFills`), curve marks, `tapeReview`, `tape_sub` events (a coin's subscription confirmed or ended: the
  tape counts as live only after a curve state received since then), and the fill model check (`S.qc`: every Jupiter
  quote on a live-tape coin against the curve model). Tests (7 new, 47 total): A3 buys what A buys at the same tick and
  fills at the curve state of decision + 2 s; v2.0 and E0 trade identically with or without the tape and the v3
  accounts; a crash is sold on a tape observation before the next tick; A3e's emergencies; a tape outage falls back to
  quotes and blocks new entries; replay exact.
  Verified before the deploy: 47 tests pass; server sim ALL BOTS MATCH, V11 REPLAY EXACT, V11 CAUSAL CHECKS OK (the sim
  runs without the tape); page check SERVER PAGE OK (36 GitHub API calls/h). The final tape module ran once more on a
  runner against the real RPC (probe-src). On a (re)subscription the next poll always sends a curve state, so a quiet
  coin's tape becomes live within about 2 s. Saves keep 15 s of tape trades per coin (at most 30).
  Last runner probes of the final module (Oct 22, 15:42-15:52 UTC): at busy hours the public RPC dropped the websocket
  every 10-20 s on some runners (code 1006, no reason; 90% up with 0.5 s backoff), and not at all on others (0 drops in
  150 s, 4,618 trades on the 30 busiest curves, recording about 2 MB/h). A connection that lived 5 s or more is now
  replaced at once, the coins resubscribe, and an immediate poll makes their tape live again within about a second.
  Polls never failed. Each drop and its close code is recorded (tape_status), so tape uptime can be measured live.
- Oct 22 11:55 AM ET (15:55 UTC): tape lane and v3.0 deployed (commit 7136323); the page published.
- Oct 22 11:58 AM ET: v3.1 locked (research/v31_protocol.md, pushed to `v3-lock` at 15:57:56 UTC, before A4 existed in
  code and before any v3 trade). A4 = A3 with entries only 8 to 20 minutes after the crossing. Training evidence: A's
  60 forward trades under 11.1 split by minutes since the crossing (3-8 min: 34 trades, -5.04 SOL, 21% wins; 8-20 min:
  26 trades, +3.38 SOL, 50% wins), and the archived 11.0 period the same way (15 early: -0.20, 20% wins; 8 late: +0.39,
  62% wins). Other splits looked at in the same pass are listed in the protocol (one pick among several: the forward test
  must survive that). Also from that table: A's 35 loss-limit exits averaged -31% against a 15% limit (worst -92%),
  its 22 profit-protection exits +40%; at an exact -15% fill A would have been about +3 SOL instead of -1.7. That gap is
  what v3's tape execution targets. Replay variant `A~late` added to the ablation tool (secondary check, data after the
  lock only).
- Oct 22 12:15 PM ET: tape v2 (two connections). Live since 15:59 UTC the first version dropped its websocket every
  10-20 s on the production runner too (3 drops in its first 2 minutes). A runner A/B (two lanes, same coins, same time:
  one sending a tiny request every 5 s, one silent) gave 14 drops in 180 s each, so the drops are the server's and do
  not depend on client traffic. Now two connections carry the same subscriptions; a trade that arrives on both is passed
  on once (by signature and curve), and the engine sees their union (up while either is; a coin subscribed while either
  has it), so a single drop changes nothing downstream. Runner probe, 180 s, 30 busiest curves: union up 99.9% (one drop
  per connection, at different times), 2,672 trades, 23,474 duplicate copies dropped, 1.6 MB/h recorded. 49 tests;
  sim ALL BOTS MATCH, V11 REPLAY EXACT, V11 CAUSAL CHECKS OK; SERVER PAGE OK.
- Oct 22 12:21 PM ET: JAMESON. Crossed $7K at 16:00:52 UTC; A and A3 bought at 16:04 (about $20K market cap, A3 on the
  curve at decision + 2 s); it completed its curve, graduated, and peaked at +1,463% for A. A sold by profit protection at
  +1,004% (+8.54 SOL, Jupiter quote on the pool); A3 held to the 20-minute horizon, +1,259% (+10.71 SOL). A3e bought it too
  but its 20%-in-10-s exit fired 2 s after the fill (-11%): one data point against that rule on launch-phase coins. A is
  now +7.28 SOL realized since the 11.1 start (68 trades, 25 wins, profit factor 1.78; without JAMESON about -1.26).
  `server/tools/v11_compare.js` (new) on the saved state: A's 38 loss-limit exits average -30.2%, 15.2 points past the
  limit; its 27 profit-protection exits keep a median 57% of the peak gain. First tape-executed loss limit (A3e,
  CRAWLR): -15.6%, 0.6 points past the limit. Fill model check: 14 Jupiter quotes vs the curve model, median gap 0.07%
  (p90 3%). Tape on the server: each connection drops about every 10 s, the pair stayed up.
- Watch: v11.json (the engine save on the data branch) is 3.2 MB: coins 1.4 MB (228 coins, about 6 KB each with the
  tape), accounts 0.9 MB (trades accumulate), orders 0.8 MB (24 h). If it passes ~6 MB, keep the last few hundred trades
  per account in the save with running totals for the rest.
- run.js: a new commit on main now hands over only if it changes what the server runs (server/ outside tools and tests,
  or the sniper workflow; checked with the compare API once per new commit). Docs, tools and page commits no longer
  interrupt the bots or add replay boundaries.
