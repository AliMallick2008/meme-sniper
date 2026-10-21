# Round 2 protocol: 100,000 evolved + 15,360 breakout variants (written Sat Oct 17 2026, ~2:35 AM ET, BEFORE running)

Costs and engine: identical to round 1 (s_engine.run_sim; futures taker 0.05% / maker 0.02%, slippage 0.02% market /
0.05% stops, funding 0.01% per 8 h, stop-first, unit notional).

Training (everything the search may look at): 2020-01-01 .. 2026-03-31 (quarters 2020Q1..2026Q1).
Hidden holdout (never used for selection or evolution): 2026-04-01 .. 2026-10-16 (2026Q2, Q3 and the start of Q4).

Fitness = t-stat of per-trade net return over training. Fewer than 200 training trades: fitness - (200 - n) / 50.
AMENDMENT (2:45 AM, before any holdout result was looked at): the first run was stopped after ~13,000 evaluations
because a strategy with only 2 training trades scored t = 289 and took over one population. Fewer than 100 training
trades now ranks below every valid strategy (fitness = -10 + n/100). Both workers restarted from scratch.

Evolution: two independent (mu + lambda) runs, population 300, 250 offspring per generation, 200 generations,
50,000 evaluations each. Offspring: tournament parents, mutation of 1-3 parameters, same-family crossover,
15% fresh random individuals. Families: volatility breakout (24 UTC start hours), opening-range breakout,
mean reversion, N-bar breakout, indicator fades, moving-average trend, session momentum, time of day.

Breakout grid: 24 UTC start hours x k {0.3..1.0 step 0.1} x stop {none, 0.25R, 0.5R, 1R} x exit {day end, 4h, 8h, 12h}
x filter {none, SMA20, SMA50, SMA100, SMA200}, long only = 15,360.

Final pick = the single highest training fitness across all evaluated strategies (any source).
It "holds up" only if: holdout total net > 0, holdout t >= 1.0, holdout trades >= 20, and positive in at least 5 of the 6
training calendar years 2020-2025. Only then does it go on the dashboard.

Also reported: top-100 by training fitness on the holdout vs 216 random-entry nulls; the best-so-far by generation on
the holdout; probability of backtest overfitting (CSCV, 12 blocks of 2 quarters from 2020Q2-2026Q1, 924 splits).
