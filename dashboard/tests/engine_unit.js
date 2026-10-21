const S = require('../../server/sniper.js');
const assert = (c, m) => { if (!c) { console.log('FAIL', m); process.exitCode = 1; } else console.log('ok  ', m); };
const near = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));
const sol = () => 100;                      // flat SOL/USD for tests
// 1) curve math against a direct hand computation
{
  const pUsd = 7e-6, pSol = pUsd / 100;     // $7k mc at SOL $100
  const R = Math.sqrt(30 * 1.073e9 * pSol * 1.01), T = R / (pSol * 1.01), net = 1 - 0.0125;
  const tok = T - (R * T) / (R + net);
  const b = S.buy(1, pSol, true, 0.01);
  assert(near(b.tokens, tok), `buy tokens ${b.tokens.toFixed(0)} = hand ${tok.toFixed(0)} (impact ${(b.impact * 100).toFixed(2)}%)`);
  const sl = S.sell(b.tokens, pSol, true, 0.01);
  console.log('     round trip at the same price:', ((sl.sol - 1) * 100).toFixed(2) + '%');
  assert(sl.sol < 1 && sl.sol > 0.9, 'round trip loses a few % only');
  const tp = S.priceFor(b.tokens, 1.01, true, 0.01);
  assert(S.sell(b.tokens, tp, true, 0.01).sol >= 1.01 && S.sell(b.tokens, tp * 0.999, true, 0.01).sol < 1.01, `break-even+1% price = ${(tp / pSol - 1) * 100 | 0}% above entry market price`);
}
// candles helper: [t, o, h, l, c, v, g], minute t
const m = i => 1000000 * 60 + i * 60;
// 2) dip entry then take profit
{
  const cs = [[m(0), 3e-6, 10e-6, 3e-6, 9e-6, 1, 0], [m(1), 9e-6, 9.5e-6, 7e-6, 8e-6, 1, 0], [m(2), 8e-6, 8e-6, 5.5e-6, 6.5e-6, 1, 0], [m(3), 6.5e-6, 7.5e-6, 6.2e-6, 7.4e-6, 1, 0]];
  const r = S.run(cs, sol, m(1) + 20, m(100));
  assert(r.trade && r.trade.entryT === m(2) && near(r.trade.entryUsd, 6e-6), 'entry at the 40% dip limit (0.6 x 10e-6) in candle 2');
  assert(r.trade.out === 'tp' && r.trade.exitT === m(3) && r.trade.ret >= 0.01 - 1e-9, `take profit next candle, ret ${(r.trade.ret * 100).toFixed(2)}%`);
}
// 3) stop at 10% of entry (closes below the stop -> fill at close)
{
  const cs = [[m(0), 3e-6, 10e-6, 3e-6, 9e-6, 1, 0], [m(2), 8e-6, 8e-6, 5.5e-6, 5.8e-6, 1, 0], [m(3), 5.8e-6, 5.9e-6, 0.3e-6, 0.4e-6, 1, 0]];
  const r = S.run(cs, sol, m(1), m(100));
  assert(r.trade && r.trade.out === 'sl' && near(r.trade.exitUsd, 0.4e-6), 'stop fills at the close when the candle closes under 10% of entry');
  assert(r.trade.ret < -0.9, `stop loss ${(r.trade.ret * 100).toFixed(1)}%`);
}
// 4) stop and target in the same candle: stop first
{
  const cs = [[m(0), 3e-6, 10e-6, 3e-6, 9e-6, 1, 0], [m(2), 8e-6, 8e-6, 5.5e-6, 5.8e-6, 1, 0], [m(3), 5.8e-6, 9e-6, 0.5e-6, 7e-6, 1, 0]];
  const r = S.run(cs, sol, m(1), m(100));
  assert(r.trade.out === 'sl' && near(r.trade.exitSol, 0.1 * r.trade.entrySol), 'same-candle stop and target: stop at its level');
}
// 5) entry-candle crash: stop in the same candle as the fill
{
  const cs = [[m(0), 3e-6, 10e-6, 3e-6, 9e-6, 1, 0], [m(2), 8e-6, 8.5e-6, 0.2e-6, 0.3e-6, 1, 0]];
  const r = S.run(cs, sol, m(1), m(100));
  assert(r.trade.entryT === m(2) && r.trade.exitT === m(2) && r.trade.out === 'sl', 'rug inside the entry candle stops out at the close');
}
// 6) no dip, horizon
{
  const cs = [[m(0), 3e-6, 10e-6, 3e-6, 9e-6, 1, 0], [m(2), 9e-6, 12e-6, 8e-6, 11e-6, 1, 0]];
  const r = S.run(cs, sol, m(1), m(100));
  assert(!r.trade && r.state === 'nodip' && near(r.trig, 0.6 * 12e-6), 'no dip: no trade, next trigger 0.6 x the latest high');
  const r2 = S.run(cs, sol, m(1), m(100), {}, true);
  assert(r2.state === 'watch' && near(r2.H, 12e-6) && near(r2.trig, 0.6 * 12e-6), 'live: still watching, next trigger 0.6 x new high');
}
// 7) open position marked at horizon
{
  const cs = [[m(0), 3e-6, 10e-6, 3e-6, 9e-6, 1, 0], [m(2), 8e-6, 8e-6, 5.5e-6, 5.8e-6, 1, 0], [m(3), 5.8e-6, 5.9e-6, 5e-6, 5.2e-6, 1, 0]];
  const r = S.run(cs, sol, m(1), m(100));
  assert(r.trade.out === 'horizon' && near(r.trade.exitUsd, 5.2e-6), 'horizon closes at the last close');
  const r2 = S.run(cs, sol, m(1), m(100), {}, true);
  assert(r2.trade.out === 'open' && r2.state === 'hold', 'live keeps it open');
}
// 8) green-candle entry and time limit
{
  const cs = [[m(0), 3e-6, 10e-6, 3e-6, 9e-6, 1, 0], [m(2), 8e-6, 8e-6, 5.5e-6, 5.6e-6, 1, 0], [m(3), 5.6e-6, 5.7e-6, 5.0e-6, 5.1e-6, 1, 0], [m(4), 5.1e-6, 5.6e-6, 5.1e-6, 5.5e-6, 1, 0], [m(5), 5.5e-6, 5.6e-6, 5.3e-6, 5.4e-6, 1, 0], [m(40), 5.4e-6, 5.5e-6, 5.2e-6, 5.3e-6, 1, 0]];
  const r = S.run(cs, sol, m(1), m(100), { entry: 'green', maxHold: 30 });
  assert(r.trade.entryT === m(4) && near(r.trade.entryUsd, 5.5e-6), 'green entry at the first green close after the dip');
  assert(r.trade.out === 'time' && r.trade.exitT === m(40), 'time limit exit at the first candle past 30 min');
}
// 9) mcMin 15k: watch starts after the first close >= 15k
{
  const cs = [[m(0), 3e-6, 10e-6, 3e-6, 9e-6, 1, 0], [m(2), 9e-6, 16e-6, 9e-6, 15.5e-6, 1, 0], [m(3), 15e-6, 15e-6, 9e-6, 9.5e-6, 1, 0]];
  const r = S.run(cs, sol, m(1), m(100), { mcMin: 15000 });
  assert(r.startT === m(3) && r.trade && near(r.trade.entryUsd, 0.6 * 16e-6), 'mcMin 15k: watch from the next minute, trigger 0.6 x 16e-6');
}
// 10) graduation: pool fee and reserves after migration
{
  const pG = 4.11e-7; // SOL per token at graduation
  const a = S.sell(1e7, pG, true, 0), b = S.sell(1e7, pG, false, 0);
  console.log('     selling 10M tokens at graduation: curve', a.sol.toFixed(3), 'SOL, pool', b.sol.toFixed(3), 'SOL');
  const [R1] = S.reserves(pG, true), [R2] = S.reserves(pG, false);
  assert(Math.abs(R1 - 115) < 1 && Math.abs(R2 - 85) < 1, `reserves at graduation: curve ${R1.toFixed(1)} SOL virtual, pool ${R2.toFixed(1)} SOL`);
}
// 11) words / meme score
{
  const w = S.words('DogWifHat Official', 'WIF');
  assert(JSON.stringify(w) === JSON.stringify(['dog', 'wif', 'hat']), 'words: camelCase split, filler removed: ' + w.join(','));
  const cr = [[100, 'a', ['dog', 'moon']], [200, 'b', ['cat']], [7400, 'c', ['dog']], [7500, 'self', ['dog']]];
  const r = S.memeScore(['dog', 'cat'], cr, 7500, 'self');
  assert(r.score === 1 && r.word === 'dog', 'meme score counts other crossers in the previous 2 h only (a at t=100 is too old)');
}
// 12) hold() from a stored entry equals run()
{
  const cs = [[m(0), 3e-6, 10e-6, 3e-6, 9e-6, 1, 0], [m(2), 8e-6, 8e-6, 5.5e-6, 6.5e-6, 1, 0], [m(3), 6.5e-6, 7.5e-6, 6.2e-6, 7.4e-6, 1, 0]];
  const e = S.findEntry(cs, sol, m(1), m(100), {});
  const h = S.hold(cs, sol, e.pos, m(100), {}, true), r = S.run(cs, sol, m(1), m(100), {}, true);
  assert(h.state === 'done' && JSON.stringify(h.trade) === JSON.stringify(r.trade), 'hold() from a stored entry = run()');
}
// 13) re-arm: a coin already under its buy level when the watch starts is only bought after it trades back above it
{
  const cs = [[m(0), 3e-6, 10e-6, 3e-6, 9e-6, 1, 0], [m(1), 9e-6, 9e-6, 2e-6, 2.5e-6, 1, 0], [m(2), 2.5e-6, 2.6e-6, 2.2e-6, 2.4e-6, 1, 0],
    [m(3), 2.4e-6, 7e-6, 2.4e-6, 6.8e-6, 1, 0], [m(4), 6.8e-6, 6.9e-6, 5.5e-6, 5.7e-6, 1, 0]];
  const r = S.run(cs, sol, m(2), m(100));
  assert(r.trade && r.trade.entryT === m(4) && near(r.trade.entryUsd, 6e-6), 'already under the buy level at the start: waits for 6.8e-6 > 6e-6, buys the next dip at 6e-6');
  const r0 = S.run(cs, sol, m(2), m(100), { rearm: false });
  assert(r0.trade && r0.trade.entryT === m(2) && near(r0.trade.entryUsd, 2.5e-6), 'without re-arm it would buy the crash at 2.5e-6');
}
