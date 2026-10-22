# v3 protocol: tape execution for the V2 strategies (accounts A3, A3e, B3)

**Locked:** Thu Oct 22 2026, 3:20 PM UTC (11:20 AM ET), when this file was pushed to the branch `v3-lock` (before the
code was finished). `LOCKED` in `server/v11/v3.js` carries the same time. Written before any v3 trade, forward or
replayed, and before any outcome on the trade tape was seen: the tape lane was not deployed yet. Seen before the lock: the
v2.0 forward results up to Oct 22 01:30 UTC (these rules were drafted at about 02:20 UTC from them and are unchanged), and
probe samples of the tape used only to check decoding, rates and recording volume (`docs/PROGRESS.md`, Oct 22). v2.0
(`research/v2_protocol.md`) is unchanged and keeps running beside these accounts.

## 1. Why, and the hypotheses

Under engine 11.1 the V2 accounts value and review a position every 5 s from prices that are up to 12 s old (Jupiter is
polled every 12 s) and fill at a Jupiter quote after the decision. In the first five forward hours, A's 15% loss limit
filled at -15% to -41% and three rugs closed at -84% to -92%: these coins can fall a long way between two looks. The trade
tape (`server/v11/tape.js`, from Oct 22) delivers each trade of a followed bonding curve within about a second, with the
curve's reserves after it and the trader's wallet.

- **H1 (A3 vs A):** the same A rules, valued and reviewed on every trade and filled against the curve 2 s after the
  decision, lose less: loss-limit exits fill closer to the limit and profit protection keeps more of the peak.
- **H2 (A3e vs A3):** exiting at once when the coin's creator sells, or when the price drops 20% inside 10 seconds,
  avoids part of the rug losses.
- **H3 (B3 vs B):** as H1, for B.
- **Null:** no difference after costs.

## 2. Exact rules (v3.0)

Accounts `A3`, `A3e`, `B3`, 10 paper SOL each from the first server run with v3.0. One position per account.

**Entries:** exactly v2.0's A (for A3 and A3e) or B (for B3): universe, gates, timely data, structure, demand (Jupiter
5-minute flow), ranking and sizing (round-trip cap, risk budget, worst case), with one added requirement: **the coin's
tape is live** (the tape connection is up, the coin is on the tape plan, and a tape or curve observation of it was received
since the connection came up, and its curve is not complete).

**Fills while the tape is live:** against the bonding curve as last received at or before decision + 2 s: constant
product on the curve's actual virtual reserves, the pump.fun fee schedule of Oct 17 2026 (1.25% on the curve), 0.5%
landing drift, the network fee, and the token-account rent, as in v2.0. A buy fails if it would give 10% or more fewer
tokens than the curve promised at the decision, if its price impact against the spot price is over 6% (the size is then
halved for that coin, minimum 0.25 SOL), or if the curve completed. A sell takes any fill. When the tape is not live for
the coin at the decision, the order goes through a Jupiter quote exactly as in v2.0.

**Marks while the tape is live:** the executable value on the latest curve state (the exact sale of the whole position,
fee, drift and network fee). Otherwise v2.0's marks.

**Reviews:** v2.0's `thesis.js` review with A's or B's parameters, at every 5 s tick and after every tape or curve
observation of the held coin.

**A3e only, emergency exits (before the review):** (a) the creator wallet reported by the tape sells any amount after
the entry; (b) the curve price is 20% or more under the highest price the curve had in the last 10 seconds (every trade
in that window and the price it started the window at count; Amendment 1).

**Cooldowns:** as v2.0.

## 3. Evaluation

**Forward paper (primary)** from v3.0's start. Per account, as v2.0 (trades, win rate, net SOL, profit factor, average and
worst trade, drawdown, worst day, green days, exits by reason), plus: decision-to-fill delay; the gap between each
loss-limit exit's result and the limit; the share of the peak gain kept by profit-protection exits.

**Comparisons:** A3 vs A, B3 vs B, A3e vs A3; HOLD and E0 as before.

**Fill model check:** every Jupiter quote received for a coin whose tape is live is compared with the curve model's
answer for the same amount at that moment (count, median and spread of the gap, in the v11 tab). If the median gap is
over 2%, v3 results are reported with that bias stated.

**Minimum evidence before any claim:** 30 closed trades per account and 5 calendar days; intervals by bootstrap over
days. **Promotion** as v2.0 (audit D5). v3.0 never changes; a v3.1 would be a new version with its own lock.

## Amendments (before the start)

1. Oct 22 2026, 3:40 PM UTC, before v3 started and before any tape outcome was seen: rule (b) of A3e read "its highest
   trade price of the last 10 seconds". Writing the tests showed the hole in that wording: a coin with no trade for a
   while that is dumped in one transaction has only the dump inside the window, so the drop could never count. The rule
   now includes the price the curve started the window at (the last trade before it). Nothing else changed.

