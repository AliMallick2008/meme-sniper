# SOL Meme Degen: quick test protocol (written Mon Oct 19 2026, 5:34 PM ET, before any test ran)

Request (Oct 19, 5:32 PM ET): "no it give 10 solana and trade rigth now". Paper bot, 10 SOL, Solana meme coins, trades now.

Universe (fixed now): the Solana-native meme coins Coinbase lists in USD: BONK WIF POPCAT PNUT MOODENG FARTCOIN TRUMP GIGA USELESS TROLL PENGU.
Data: Coinbase hourly candles, last 200 days, prices converted to SOL with SOL-USD hourly closes (opens with SOL opens).
Eligible: >= max(30, L) hourly candles in a row and median hourly volume >= 50 SOL over the last 30 hours.
Costs: 0.25% swap fee + 0.25% price impact per swap (Jupiter / Raydium style), each way. Account in SOL, starts at 10 SOL.
Rules (engine research/meme_engine.js, rotation family, top 1, all-in): every E hours rank eligible coins by L-hour gain in SOL;
hold the #1 if its gain > 0 (else hold SOL); keep a held coin while it stays in the top 1 + buf.
Grid: L in {6, 24, 72, 168}; E in {1, 4, 24}; buf in {0, 2}; trend filter in {none, coin above its 24-hour average}. 48 variants.
Benchmarks: hold SOL (0 SOL gain by definition); equal-weight all eligible coins (in SOL); random coin on the same buy/sell hours (200 runs).
Training: first 130 days. Hidden: the last ~70 days (looked at once). Pick: best training Sharpe (hourly returns) with >= 30 training trades.
The bot goes live either way (user wants it trading); the page states the hidden result honestly.
