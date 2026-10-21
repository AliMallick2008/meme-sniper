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
- Oct 21 ~2:30 PM ET: independent Python re-implementation of the E0 accounts and HOLD (`dashboard/tests/v11_e0_ref.py`,
  written from the rules, not translated from server/v11) replays the recorded inputs with the server's restart rules
  (last committed save, 20 bars rounded to 6 digits, seen cut to {at, pass}) and compares every E0/HOLD account, E0 order
  and the coins they use (plus the crossings list and the dedup map), field for field. Results: the server sim (167,696
  events, 41 E0 orders) matches at both run starts and at the end; a scripted market (`dashboard/tests/v11_e0_scenarios.js`:
  35 checked paths, most of them ones the busy sim never reaches: failed, late, missing and repeated quotes, failed exits,
  lost routes, graduation, invalid data, a 60 s data halt, restarts with orders in flight, a failed save, a 27 min outage,
  5.7 quiet days; every save is kept so all 177 are compared) matches everywhere; real server data (3 input files,
  138,139 events, 24 E0 orders incl. 2 real failed buys) matches the state run 39634954518 loaded at 16:27 UTC and, at the
  end of the recording, the JS engine's own replay of the same inputs (`--live`: v11.json on the data branch runs ahead of
  the hourly input upload). Mutation test: 40 rule changes planted in the Python copy (dip, fees, freshness, TTL,
  cooldowns, exit retry, route loss, graduation, stop text rounding, slippage guard, restart trimming, dedup, NaN
  impacts, time limit on the exact ms, crossing and dedup pruning...): all caught except 3 that cannot change any result
  (guarded twice in the code).
  A 4-reviewer self-review of the PR then tightened the check (see PR #2). The sim test now prints `ALL E0 MATCH`. Live E0 behaviours worth knowing (code is locked, nothing changed): no 6-coin watchlist limit;
  a watch is armed once and never re-armed after a failed buy; GRN's dip time is never reset, so after a failed buy the
  same old green minute triggers again; a coin marked "graduating" pauses every exit, the time limit included; a fill
  can land after the 30 s order limit if no tick ran in between.
