# Progress on the audit (Section E)

Resume here. Plan and design: `docs/v11-plan.md`. Audit: `docs/audit/2026-10-21-strategy-audit.md`.
To continue in Claude Code: open this repo and say "Continue the v11 audit work from docs/PROGRESS.md."

| Phase | Status | Notes |
|---|---|---|
| 0. Freeze baseline | done | `baseline/legacy-v10/` (journal snapshot + manifest with rules and source hashes), experiment ids, paper-only guard test |
| 1. Causal engine (P0) | engine + tests done, not wired into the server yet | `server/v11/` (engine, parse, gates, model, fees, strategies, verify); tests T01 T02 T03 T10 T12 T14 T15 T20 in `server/tests/v11_phase1.test.js` |
| 2. Survival + execution | not started | |
| 3. Market intelligence, A/B/C | not started | |
| 4. Narrative layer | not started | |
| 5. Validation, dashboard, report | not started | |

## Log

- Oct 21 2026 ~5:10 AM ET: plan written; Phase 0 artifacts exported (server journal from the first live run, 1 legacy
  trade so far: GRN). Jupiter keyless limit found to be 30 requests/min shared by tokens + quote: keep all Jupiter calls
  on one 2 s lane.
- Oct 21 2026 ~6:00 AM ET (Claude Code, branch `claude/v11-audit`): Phase 1 engine. Pure event engine in `server/v11/engine.js`:
  eligibility from the last check's arrival, signals from live observations, fills only from a Jupiter quote requested
  after the decision (0.5% latency allowance, priority + network fee, token-account rent), sell-quote / calibrated-model
  / model marks or UNPRICEABLE with a worst case, backward-only SOL/USD, coverage gaps (orders cancelled, watches
  re-armed, exits inside the gap recorded as hypothetical from candles received later), idempotent events, invariant
  checker `server/v11/verify.js`. E0-* = the 7 legacy rule sets with causal timing; HOLD = 10 SOL. Each test also shows
  the legacy engine doing what the fix forbids (backdated buy, same-candle green fill, wick fill, booked outage exit).
  This session cannot reach the market APIs (network policy), so everything is tested on synthetic markets; the
  pump.fun fee tiers above 9,820 SOL are not copied in yet (0.95% used, flagged `bounded`).
