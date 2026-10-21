# Big search protocol (written Sat Oct 17 2026, ~2:30 AM ET, BEFORE the full run)

Data: Bitstamp BTC/USD 5-minute candles. Periods: D = 2020-01-01..2022-12-31 (find), V = 2023-01-01..2024-12-31 (confirm),
T = 2025-01-01..2026-10-16 (final, looked at once for the survivors only).

Costs (futures, per side, on notional): taker 0.05%, maker 0.02%; slippage 0.02% market, 0.05% stops and stop entries;
limits need a 0.02% trade-through; funding 0.01% per 8 hours held, charged on both sides. Stop-first if a candle hits both.

Unit: return per trade on notional (unlevered). Leverage only scales results; it can't turn a losing edge into a winning one.

Families (~20,070 variants): volatility breakout (4 session anchors), opening-range breakout (Asia, London, US),
session momentum/reversal (24 hours), time of day, mean reversion (5m/15m/1h), N-bar breakouts (15m/1h),
indicator fades (RSI2, RSI14, Bollinger, VWAP), moving-average trend (15m/1h). Plus 216 random-entry null strategies.

Stage 1 (D): trades >= 150, total net > 0, t-stat of per-trade net >= 2.0.
Stage 2 (V): trades >= 60, total net > 0, t-stat >= 1.5.
Consistency: in D+V, at least 60% of quarters that had trades are positive.
Pick: among survivors, the highest t-stat over D+V combined, chosen before looking at T.
Final: survivors run once on T. "Reproduced" = T total net > 0; strong = T t-stat >= 1.0.
Null check: the same stages applied to the random-entry family show the pass rate expected from luck.
