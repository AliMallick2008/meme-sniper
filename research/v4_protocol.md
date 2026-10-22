# v4 research protocol: telling runners from rugs on the trade tape (pre-registered)

**Written:** Thu Oct 22 2026, 12:41 PM ET (16:41 UTC, commit 12e9611), before any analysis of tape features against outcomes. The trade
tape started on the server at 15:59 UTC Oct 22. Tape data seen before this: probe samples (decoding, rates, volume) and
the first v3 trades (A3 +10.7 SOL on JAMESON; A3e's 20%-in-10-s exit fired on JAMESON 2 s after its fill), which are
forward results of locked rules, not feature analyses.

## Why

The forward A trades so far are fat-tailed: most lose a little, a few rug (-68% to -92%: 6 of the first 60 trades cost
4.1 SOL), and rare runners pay for everything (JAMESON +1,004%). Entries in the first minutes after the crossing held
5 of the 6 rugs but also the biggest runner. The tape shows what Jupiter's 5-minute stats cannot: who is buying and
selling, how concentrated the buying is, whether the creator is selling, how big the sells are. The question: at the
moment A's rules want to buy, do tape features separate the coins that run from the ones that rug?

## Data

- `v11-inputs/` from Oct 22 16:00 UTC (tape lines `T`/`C`), replayed with the code of each stretch.
- **Moments:** every engine tick at which a coin passes v2.0 A's gates, timely data, setup and demand checks
  (`v2.js evaluate`) while its tape is live, at most one moment per coin per 2 minutes.
- **Features at the moment (tape only, received before it):** trades, buys, sells, unique buyers and sellers, buy SOL
  share in the last 30 s and 60 s; the largest single buyer's share of the last 60 s of buy SOL; the top 3 wallets' share
  of all SOL traded since the tape began; sells of 1 SOL or more in the last 60 s; whether the creator has sold, and how
  much; price change over the last 30 s, 60 s and 180 s from the tape; the curve's starting virtual SOL (vSol - rSol,
  when a poll reported rSol); minutes since the crossing; curve progress.
- **Outcome (from later tape and curve states only):** the return of a buy filled on the curve at moment + 2 s and sold
  by a fixed rule: the first of +100% (take), -15% on the curve value (stop, filled at the next state, as v3), or 20
  minutes (time), with the pump.fun fee, 0.5% drift each way and network fees. Also recorded: rug (price 50% or more
  under the fill within 5 minutes), best and worst return within 20 minutes.

## Split, method, pick rule

- **Train:** moments from Oct 22 16:00 UTC to Oct 25 16:00 UTC. **Validate:** Oct 25 16:00 to Oct 27 16:00 UTC.
  Nothing from the validation window is looked at before the train-window work is written down in this file's log.
- **Method (in order of preference, simplest first):** (1) single-feature thresholds; (2) a two-feature rule; (3) a
  logistic score on at most 5 standardized features. Each chosen on train only, by mean outcome per trade with at least
  40 train trades kept.
- **Pick:** the candidate with the best mean outcome per trade on validation among those keeping at least 25 validation
  trades, if its validation mean beats the unfiltered moments' validation mean and is above 0. Otherwise: no v4.
- **If one is picked:** v4 = A3 plus that filter, locked at that moment as new accounts, judged forward like v3 (30
  trades and 5 days, bootstrap by day, beats A3 and HOLD after costs).

## Log

(Entries are added as the work happens, with times, before any validation-window result is seen.)
