# Progress on the audit (Section E)

Resume here. Plan and design: `docs/v11-plan.md`. Audit: `docs/audit/2026-10-21-strategy-audit.md`.
To continue in Claude Code: open this repo and say "Continue the v11 audit work from docs/PROGRESS.md."

| Phase | Status | Notes |
|---|---|---|
| 0. Freeze baseline | done | `baseline/legacy-v10/` (journal snapshot + manifest with rules and source hashes), experiment ids, paper-only guard test |
| 1. Causal engine (P0) | done | `server/v11/` engine + runtime live beside the legacy bots; tests T01 T02 T03 T10 T11 T12 T14 T15 T20 (engine side) pass; sim: E0 decisions never before eligibility, fills only after decisions, nothing inside coverage gaps |
| 2. Survival + execution | done (mechanisms) | `server/v11/risk.js` (unreachable stops rejected or converted, risk budget, horizon, round-trip cost), executable mark quotes per held coin, route-loss distressed state, quote-impact sizing, versioned fees (pump.fun Oct 17 2026), equity ledger with bands, drawdown from all marks, underwater/exposure time, MAE/MFE; tests T04 T07 T13 T17 T18 T20 pass. V2 strategies use them in phase 3 |
| 3. Market intelligence, A/B/C | in progress | |
| 4. Narrative layer | not started | |
| 5. Validation, dashboard, report | not started | |

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
