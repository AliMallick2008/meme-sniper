# v3.1 protocol: A4, late launch momentum on the tape

**Locked:** Thu Oct 22 2026, 3:58 PM UTC (11:58 AM ET), when this file was first pushed to the branch `v3-lock`, before A4
existed in code and before any v3 forward trade (v3.0 was deployed at 3:55 PM UTC and had not traded). `LOCKED_31` in
`server/v11/v3.js` carries the same time. v2.0 and v3.0 are unchanged and keep running beside it.

## 1. Where the idea comes from (training data, already used)

The forward A trades under engine 11.1 (Oct 21 20:14 UTC to Oct 22 15:55 UTC, 60 closed trades, from `v11-events/`),
split by minutes since the crossing at entry:

| Entered | Trades | Net SOL | Wins | Average |
|---|---|---|---|---|
| 3 to 8 min after the crossing | 34 | -5.04 | 21% | -19.6% |
| 8 to 20 min after the crossing | 26 | +3.38 | 50% | +15.7% |

The archived 11.0 period (Oct 21 16:12-20:14 UTC, 23 trades, a different engine version but the same A rules) points the
same way: 15 early trades -0.20 SOL with 20% wins, 8 late trades +0.39 SOL with 62% wins.

Other splits looked at in the same pass (so this is one pick among several, which the forward test must survive): the
1-minute and 3-minute rise, market cap, buy share, net buyers, traders, top holders' share, round-trip cost. Market cap
of $20K-$40K was also better in both periods, but it moves with the time since the crossing, so it is not added.

## 2. Hypothesis

**H4:** A's momentum rules do better on coins that are still rising 8 or more minutes after crossing $7K: the creator's
and the launch snipers' first dumps are usually over by then. **Null:** A4 does no better than A3.

## 3. Exact rules (v3.1)

Account `A4`, 10 paper SOL from the first server run with v3.1. Exactly A3 (v3.0: v2.0's A entries on live-tape coins,
curve fills at decision + 2 s, curve marks, reviews after every tape observation), with one change: **a coin enters A4's
universe only from 8 minutes after its crossing** (A's universe ends at 20 minutes, as before).

## 4. Evaluation

**Forward (primary):** A4 vs A3 (the same execution, so the difference is the 8-minute rule), and vs A and HOLD, on
trades decided after the lock. **Minimum evidence:** 30 closed trades and 5 calendar days; intervals by bootstrap over
days. **Secondary:** the replay tool's `A~late` variant (v2.0 A with the same 8-minute rule, model fills) on recorded
inputs after the lock only. Promotion as v2.0 (audit D5). v3.1 never changes.
