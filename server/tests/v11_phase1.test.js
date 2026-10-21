'use strict';
/* v11 Phase 1 (causal correctness): audit tests T01, T02, T03, T12, T14, T15, T20, plus T10 (unknown is not a pass).
   Where the audit asks for it, each test also shows the legacy engine doing the thing the fix forbids, on the same market. */
const test = require('node:test');
const assert = require('node:assert');
const { World, addr, SOLUSD, MODEL, ENG, ST } = require('./v11_world.js');
const LEGACY = require('../sniper.js');
const PARSE = require('../v11/parse.js');
const GATES = require('../v11/gates.js');

const U = LEGACY.RULES.BOTS.find(b => b.id === 'U'), GRN = LEGACY.RULES.BOTS.find(b => b.id === 'GRN');
/* piecewise-linear USD price path from [[t, usd], ...] */
const path = pts => t => { if (t <= pts[0][0]) return pts[0][1]; for (let i = 1; i < pts.length; i++) if (t <= pts[i][0]) { const [a, x] = pts[i - 1], [b, y] = pts[i]; return x + (y - x) * (t - a) / (b - a); } return pts[pts.length - 1][1]; };
/* 1-minute candles of a path sampled every second, as the legacy engine reads them (USD per token, curve stage) */
function candles(price, from, to) {
  const out = [];
  for (let m = Math.floor(from / 60) * 60; m < to; m += 60) {
    const xs = []; for (let s = 0; s < 60; s++) xs.push(price(m + s) / 1e9);
    out.push([m, xs[0], Math.max(...xs), Math.min(...xs), xs[59], 100, 0]);
  }
  return out;
}
const buys = w => Object.values(w.eng.state().accts).flatMap(A => [...A.trades, ...(A.pos ? [A.pos] : [])]);

test('T01: checks arrive 5 min after the crossing; the dip in between is not bought, a fresh dip after it is', () => {
  const w = new World({ strategies: [ST.E0(U)] });
  const T = w.t0 + 1000;   // "12:00": first observation at or above $7K
  const price = path([[T - 600, 3000], [T - 5, 6900], [T, 7100], [T + 60, 10000], [T + 120, 5500], [T + 150, 5500], [T + 240, 9000], [T + 380, 9000], [T + 400, 5700], [T + 440, 5700], [T + 500, 8000], [T + 3000, 8000]]);
  const c = w.coin({ created: T - 600, price }); w.partner(c, T - 120);
  w.checks(c, T + 295, T + 300);
  w.run(T + 360);
  const A = w.acct('E0-U');
  assert.strictEqual(w.eng.state().coins[c.m].cross.at, T, 'crossing observed at 12:00');
  assert.strictEqual(A.watch[0].from, T + 300, 'watch starts when the last check arrived');
  assert.strictEqual(buys(w).length, 0, 'no buy for the 12:02 dip');
  w.run(T + 600);
  const b = buys(w);
  assert.strictEqual(b.length, 1, 'the fresh dip after the checks is bought');
  assert.ok(b[0].sigAt >= T + 400 && b[0].quoteReq >= b[0].at, 'signal from a live observation after eligibility, quote requested after the decision');
  // the old implementation books the 12:02 dip once the checks are in (watch from the crossing, candles replayed)
  const old = LEGACY.findEntry(candles(price, T - 600, T + 300), () => SOLUSD, T, T + 300, U.P);
  assert.ok(old.pos && old.pos.entryT >= T + 60 && old.pos.entryT < T + 300, 'legacy backdates a buy to before the checks finished');
});

test('T02: a green bar is known only when its minute ends; the fill is the next quote after that', () => {
  const w = new World({ strategies: [ST.E0(GRN)] });
  const T = w.t0 + 1000;
  const m0 = Math.floor((T + 200) / 60) * 60;      // the dip minute
  const price = path([[T - 600, 3000], [T, 7100], [T + 60, 10000], [m0 + 5, 5800], [m0 + 30, 5600], [m0 + 60, 5900], [m0 + 120, 6600], [m0 + 125, 7400], [m0 + 3000, 7400]]);
  const c = w.coin({ created: T - 600, price }); w.partner(c, T - 120);
  w.checks(c, T + 20, T + 25);
  w.run(m0 + 200);
  const b = buys(w);
  assert.strictEqual(b.length, 1);
  const p = b[0];
  // the dip minute closes red (5800 -> 5600 -> 5900 at its end? the bar's own close is its last observation, inside the minute)
  assert.ok(p.at >= m0 + 60, `decision at ${p.at - m0} s: only after a green minute has ended`);
  assert.ok(p.quoteReq >= p.at, 'quote requested after the decision');
  const bar = w.eng.state().coins[c.m].bars.find(x => x[0] === Math.floor(p.at / 60) * 60 - 60);
  assert.ok(bar && bar[4] > bar[1], 'the signal bar is green');
  const closeUsd = bar[4], fillUsd = p.px * SOLUSD;
  assert.ok(Math.abs(fillUsd / closeUsd - 1) > 0.001, 'the fill is not the signal bar close');
  // legacy: fills at the green candle's own close, inside the candle that produced the signal
  const old = LEGACY.findEntry(candles(price, T - 600, m0 + 200), () => SOLUSD, T, m0 + 200, GRN.P);
  assert.ok(old.pos && old.pos.how === 'green');
  const oc = candles(price, T - 600, m0 + 200).find(x => x[0] === old.pos.entryT);
  assert.strictEqual(old.pos.entryUsd, oc[4], 'legacy fills at the close of the candle that made the signal');
});

test('T03: a one-tick wick to the buy level with no executable quote does not fill', () => {
  for (const mode of ['moved', 'noroute', 'none']) {
    const w = new World({ strategies: [ST.E0(U)], obsEvery: 1 });
    const T = w.t0 + 1000;
    const wick = T + 200;
    const base = path([[T - 600, 3000], [T, 7100], [T + 60, 10000], [T + 3000, 9500]]);
    const price = t => (t >= wick && t < wick + 1) ? 5900 : base(t);
    const c = w.coin({ created: T - 600, price, quote: mode === 'moved' ? 'ok' : mode }); w.partner(c, T - 120);
    w.checks(c, T + 20, T + 25);
    w.run(T + 400);
    const A = w.acct('E0-U');
    assert.strictEqual(buys(w).length, 0, mode + ': no position');
    assert.ok(A.n.signals >= 1 && A.n.fails >= 1, mode + ': the signal produced an order that failed');
    const d = w.eng.state().dec.find(x => x.k === 'order-fail');
    assert.match(d.t, mode === 'moved' ? /price moved/ : mode === 'noroute' ? /no route/ : /no quote in time/);
    if (mode === 'moved') {   // legacy: a candle low at the level is a fill
      const old = LEGACY.findEntry(candles(price, T - 600, T + 400), () => SOLUSD, T + 25, T + 400, U.P);
      assert.ok(old.pos, 'legacy fills the wick');
    }
  }
});

test('T12: SOL/USD is only looked up backwards; a missing minute never reads the future', () => {
  const eng = ENG.create({ strategies: [] });
  const t0 = 1792500000;
  eng.ingest({ type: 'run_start', at: t0, run: 'x' });
  const rows = [];
  for (let k = 0; k <= 30; k++) if (k < 11 || k > 19) rows.push([t0 + k * 60, 100 + k]);
  eng.ingest({ type: 'solc', at: t0 + 32 * 60, req: t0 + 32 * 60, rows });
  assert.strictEqual(eng.solAt(t0 + 15 * 60), 110, 'minute 15: the last close known before it (minute 10)');
  assert.strictEqual(eng.solAt(t0 + 21 * 60), 120, 'minute 21: minute 20 has closed');
  assert.strictEqual(eng.solAt(t0 - 60), null, 'before any data: unknown, not the first later value');
  // a candle that had not closed when it was received is not stored
  eng.ingest({ type: 'solc', at: t0 + 40 * 60 + 30, rows: [[t0 + 40 * 60, 999]] });
  assert.strictEqual(eng.solAt(t0 + 41 * 60), 130);
  // the legacy lookup searches forward up to 4 hours when a minute is missing
  const fwd = (m, have) => { for (let k = 0; k < 240; k++) if (have[m - k * 60]) return have[m - k * 60]; for (let k = 1; k < 240; k++) if (have[m + k * 60]) return have[m + k * 60]; return null; };
  assert.strictEqual(fwd(t0, { [t0 + 300]: 7 }), 7, 'legacy-style lookup uses a future price');
});

test('T14: server offline through a target: nothing booked in the gap, the would-be exit is hypothetical only', () => {
  const w = new World({ strategies: [ST.E0(U)] });
  const T = w.t0 + 1000;
  const off = T + 600, on = T + 2400;
  const price = path([[T - 600, 3000], [T, 7100], [T + 60, 10000], [T + 200, 5800], [T + 400, 5850], [off + 300, 5850], [off + 420, 7600], [off + 600, 5600], [on + 3000, 5600]]);
  const c = w.coin({ created: T - 600, price }); w.partner(c, T - 120);
  w.checks(c, T + 20, T + 25);
  w.offline(off, on);
  w.run(on + 200);
  const A = w.acct('E0-U'), S = w.eng.state();
  assert.ok(A.pos, 'bought before the outage and still holding (the target came only while offline)');
  assert.strictEqual(A.trades.length, 0);
  const g = S.gaps.find(x => x.why === 'offline');
  assert.ok(g && g.from < off + 1 && g.to === on, 'the outage is a coverage gap');
  assert.ok(g.open.some(o => o.a === 'E0-U'));
  // candles covering the gap arrive later (the legacy bots fetch them): the target hit is recorded as hypothetical
  const cs = candles(price, T, on + 100).map(x => [x[0], x[1] * 1e9 / 1e9, x[2], x[3], x[4], 100]).map(x => [x[0], x[1], x[2], x[3], x[4], x[5]]);
  w.eng.ingest({ type: 'candles', at: on + 260, req: on + 259, pool: c.bc, rows: cs });
  const h = S.hypo.find(x => x.a === 'E0-U');
  assert.ok(h && h.rule === 'tp' && h.at >= off && h.at < on, 'would have hit the target inside the gap: hypothetical');
  assert.strictEqual(A.trades.length, 0, 'and nothing was booked for it');
  // the legacy engine books that exit from the replayed candles
  const old = LEGACY.run(candles(price, T - 600, on + 100), () => SOLUSD, T + 25, on + 100, U.P);
  assert.ok(old.trade && old.trade.out === 'tp' && old.trade.exitT >= off && old.trade.exitT < on, 'legacy books the exit inside the outage');
});

test('T15: duplicate events and a restart: one order, one fill, same books', () => {
  const T0 = 1792500000;
  const mk = state => new World({ strategies: [ST.E0(U)], state, t0: T0 });
  const w = mk();
  const T = w.t0 + 1000;
  const price = path([[T - 600, 3000], [T, 7100], [T + 60, 10000], [T + 200, 5800], [T + 3000, 5800]]);
  const c = w.coin({ created: T - 600, price }); w.partner(c, T - 120);
  w.checks(c, T + 20, T + 25);
  // every quote answer is delivered twice
  const orig = w.quoteFor.bind(w);
  w.run(T + 199);
  const before = JSON.stringify(w.eng.state());
  w.run(T + 205);
  const S = w.eng.state();
  const fillQuote = w.quotes.find(q => q.outMint === c.m && q.ok);
  assert.ok(fillQuote, 'a buy quote was answered');
  const A = w.acct('E0-U'), cash = A.cash, nTrades = A.trades.length, pos = JSON.stringify(A.pos);
  assert.ok(A.pos, 'bought');
  // the same quote event again (same id): ignored
  const dupEv = Object.assign({ type: 'quote', id: 'q1' }, fillQuote);
  w.eng.ingest(dupEv); w.eng.ingest(dupEv);
  assert.ok(S.dup >= 1, 'duplicate counted');
  assert.strictEqual(A.cash, cash); assert.strictEqual(JSON.stringify(A.pos), pos);
  // restart from the saved state (as JSON), then the same event again
  const saved = JSON.parse(JSON.stringify(w.eng.save()));
  const w2 = mk(saved);
  w2.coins = w.coins; w2.t = w.t;
  w2.eng.ingest(dupEv);
  const A2 = w2.acct('E0-U');
  assert.strictEqual(A2.cash, cash); assert.strictEqual(A2.trades.length, nTrades); assert.strictEqual(JSON.stringify(A2.pos), pos);
  // a quote for the same route and size without an id, after the fill: no order is waiting, so nothing happens
  w2.eng.ingest(Object.assign({}, fillQuote, { type: 'quote', at: T + 206, req: T + 205.8 }));
  assert.strictEqual(A2.cash, cash);
  assert.notStrictEqual(before, JSON.stringify(saved));
  w2.run(T + 400);
  assert.ok(w2.acct('E0-U').eq.length > 0);
});

test('T20: format changes and missing fields fail safe with a logged reason', () => {
  // Jupiter: mint authority reported as a string; dev balance as an object
  const j = [{ id: addr('pump'), name: 'X', symbol: 'X', launchpad: 'pump.fun', usdPrice: 0.00001, audit: { mintAuthorityDisabled: 'yes', freezeAuthorityDisabled: true, devBalancePercentage: { v: 1 }, topHoldersPercentage: 12 } }];
  const r = PARSE.parse('https://lite-api.jup.ag/tokens/v2/search?query=' + j[0].id, { status: 200, json: j }, 1, 2);
  const ev = r.events[0];
  assert.strictEqual(ev.audit.mintOff, null); assert.strictEqual(ev.audit.dev, null);
  assert.ok(r.errors.length && /audit\.mintAuthorityDisabled/.test(r.errors[0]));
  const k = { audit: ev.audit, rc: { danger: [], sn: 1 }, meme: { score: 2, word: 'x' }, bc: addr(), quote: 'SOL' };
  assert.strictEqual(GATES.legacy(k, U.C).res.find(x => x.id === 'mint').legacyPass, false, 'a string is not "revoked"');
  assert.strictEqual(GATES.strict(k).ok, false);
  // DexScreener: not a list -> one schema event, nothing else
  const d = PARSE.parse('https://api.dexscreener.com/tokens/v1/solana/' + j[0].id, { status: 200, json: { pairs: [] } }, 1, 2);
  assert.deepStrictEqual(d.events.map(e => e.type), ['schema']);
  // Quote without outAmount: the order fails with the reason; no fill
  const q = PARSE.parse('https://lite-api.jup.ag/swap/v1/quote?inputMint=So11111111111111111111111111111111111111112&outputMint=' + j[0].id + '&amount=1000000000&slippageBps=1000', { status: 200, json: { inAmount: '1000000000', routePlan: [] } }, 1, 2);
  assert.strictEqual(q.events[0].ok, false); assert.match(q.events[0].why, /schema/);
  // in the engine: repeated format errors switch the status to incomplete data, which halts entries
  const w = new World({ strategies: [ST.E0(U)] });
  const T = w.t0 + 1000;
  const c = w.coin({ created: T - 600, price: path([[T - 600, 3000], [T, 7100], [T + 60, 10000], [T + 200, 5800], [T + 3000, 5800]]) }); w.partner(c, T - 120);
  w.checks(c, T + 20, T + 25);
  for (const s of [T + 150, T + 160, T + 170]) w.at(s, { type: 'schema', src: 'jupiter search', why: 'not a list' });
  w.run(T + 230);
  assert.strictEqual(w.eng.state().status.state, 'incomplete');
  assert.strictEqual(buys(w).length, 0, 'no entries while the data is incomplete');
  w.run(T + 500);
  assert.strictEqual(w.eng.state().status.state, 'forward', 'recovers once the errors stop');
  assert.strictEqual(buys(w).length, 1);
});

test('T10: missing dev balance and top holders are unknown, never a fake zero or a pass', () => {
  const k = { audit: { mintOff: true, freezeOff: true, dev: null, top: null }, rc: { danger: [], sn: 3 }, meme: { score: 1, word: 'cat' }, bc: addr(), quote: 'SOL' };
  const s = GATES.strict(k);
  assert.strictEqual(s.ok, false);
  assert.deepStrictEqual(s.unknown.sort(), ['dev', 'top']);
  assert.ok(!s.res.some(r => /0(\.0)?%/.test(r.text)), 'no "0%" for a missing value');
  const l = GATES.legacy(k, U.C);
  const dev = l.res.find(r => r.id === 'dev'), top = l.res.find(r => r.id === 'top');
  assert.strictEqual(dev.v, 'unknown'); assert.strictEqual(top.v, 'unknown');
  assert.match(dev.text, /legacy counts it as 0%/); assert.match(top.text, /legacy lets it pass/);
  assert.strictEqual(l.ok, true, 'E0 keeps the legacy behavior, labeled');
  // top known and low covers an unknown dev balance, and says so
  const s2 = GATES.strict(Object.assign({}, k, { audit: Object.assign({}, k.audit, { top: 20 }) }));
  assert.strictEqual(s2.ok, true);
  assert.match(s2.res.find(r => r.id === 'dev').text, /covered by top holders/);
});
