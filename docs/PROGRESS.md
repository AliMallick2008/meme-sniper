# Progress on the audit (Section E)

Resume here. Plan and design: `docs/v11-plan.md`. Audit: `docs/audit/2026-10-21-strategy-audit.md`.
To continue in Claude Code: open this repo and say "Continue the v11 audit work from docs/PROGRESS.md."

| Phase | Status | Notes |
|---|---|---|
| 0. Freeze baseline | done | `baseline/legacy-v10/` (journal snapshot + manifest with rules and source hashes), experiment ids, paper-only guard test |
| 1. Causal engine (P0) | in progress | `server/v11/` |
| 2. Survival + execution | not started | |
| 3. Market intelligence, A/B/C | not started | |
| 4. Narrative layer | not started | |
| 5. Validation, dashboard, report | not started | |

## Log

- Oct 21 2026 ~5:10 AM ET: plan written; Phase 0 artifacts exported (server journal from the first live run, 1 legacy
  trade so far: GRN). Jupiter keyless limit found to be 30 requests/min shared by tokens + quote: keep all Jupiter calls
  on one 2 s lane.
