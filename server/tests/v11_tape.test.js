'use strict';
/* The tape lane (tape.js) and what the engine keeps from it (tapestate.js): decoding real pump.fun TradeEvents and curve
   accounts (fixtures recorded from the public Solana RPC on Oct 22 2026), subscription handling against a fake
   websocket, gap-filling polls, engine state and features, and exact recording/replay of tape inputs. Data only: no
   v2.0 or E0 decision may change because of the tape. */
const test = require('node:test');
const assert = require('node:assert');
const T = require('../v11/tape.js');
const TS = require('../v11/tapestate.js');
const REC = require('../v11/record.js');
const { createEngine } = require('../v11/engine.js');
const FX = require('./fixtures/tape_samples.json');
const { T0, min, M, BC, SOL_USD } = require('./helpers.js');

test('real TradeEvents decode: reserves consistent, creator read, other coins and non-SOL quotes skipped', () => {
  for (const x of FX.sol) {
    const t = T.decodeTrade(Buffer.from(x.b64, 'base64'), T.unb58(x.mint));
    assert.ok(t, 'decoded ' + x.mint);
    assert.strictEqual(t.vTok - t.rTok, 279.9e12, 'virtual-only tokens are 279.9M on every curve');
    assert.ok(t.vSol > t.rSol && t.sol > 0 && t.tok > 0 && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(t.user) && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(t.creator));
    assert.strictEqual(T.decodeTrade(Buffer.from(x.b64, 'base64'), T.unb58(FX.sol.find(y => y.mint !== x.mint).mint)), null, 'another coin\'s trade is not this coin\'s');
  }
  for (const x of FX.zero) assert.strictEqual(T.decodeTrade(Buffer.from(x.b64, 'base64'), T.unb58(x.mint)), null, 'a coin quoted in something other than SOL is skipped');
  assert.strictEqual(T.b58(T.unb58(FX.sol[0].mint)), FX.sol[0].mint, 'base58 round trip');
  // the curve account of the notification's coin names the same creator as its trades
  const n = FX.notification, acct = FX.accounts.result.value[0];
  const cv = T.decodeCurve(acct.data[0]);
  const tr = n.msg.params.result.value.logs.filter(l => l.startsWith('Program data: ')).map(l => T.decodeTrade(Buffer.from(l.slice(14), 'base64'), T.unb58(n.m))).find(Boolean);
  assert.ok(cv && tr && !cv.done && cv.supply === 1e15);
  assert.strictEqual(cv.creator, tr.creator);
  assert.strictEqual(cv.vTok - cv.rTok, 279.9e12);
});

// a fake websocket and RPC: the test plays the server
function fakeNet() {
  const sockets = [], posts = [];
  class FakeWS {
    constructor(url) { this.url = url; this.sent = []; this.closed = false; sockets.push(this); }
    send(s) { this.sent.push(JSON.parse(s)); }
    close() { if (this.closed) return; this.closed = true; if (this.onclose) this.onclose({ code: 1000 }); }
    // test side
    open() { this.onopen && this.onopen(); }
    recv(o) { this.onmessage && this.onmessage({ data: JSON.stringify(o) }); }
  }
  let answer = null;
  const fetchImpl = async (url, init) => { posts.push(JSON.parse(init.body)); const j = answer ? answer(JSON.parse(init.body)) : null; return { status: j ? 200 : 503, json: async () => j }; };
  return { FakeWS, sockets, posts, fetchImpl, setAnswer: f => { answer = f; } };
}

test('the lane subscribes per curve, turns trades into tape events, ignores failed transactions, reconnects, fills gaps by polling', async () => {
  const net = fakeNet(), got = [];
  let t = T0;
  const tape = T.createTape({ now: () => t, ingest: ev => got.push(ev), WS: net.FakeWS, fetch: net.fetchImpl, url: 'https://rpc.test' });
  const n = FX.notification;
  tape.want([{ m: n.m, bc: n.bc }]);
  assert.strictEqual(net.sockets.length, 1);
  assert.strictEqual(net.sockets[0].url, 'wss://rpc.test');
  const ws = net.sockets[0];
  ws.open();
  assert.deepStrictEqual(got.map(e => [e.type, e.up]), [['tape_status', true]]);
  const sub = ws.sent.find(x => x.method === 'logsSubscribe');
  assert.deepStrictEqual(sub.params, [{ mentions: [n.bc] }, { commitment: 'processed' }], 'one logs subscription per bonding curve');
  ws.recv({ jsonrpc: '2.0', id: sub.id, result: 4242 });
  t += 700;
  const msg = JSON.parse(JSON.stringify(n.msg)); msg.params.subscription = 4242;
  ws.recv(msg);
  const tr = got.filter(e => e.type === 'tape');
  assert.strictEqual(tr.length, 1, 'one TradeEvent in that transaction');
  assert.deepStrictEqual(tr[0], { type: 'tape', at: T0 + 700, m: n.m, slot: 459856853, b: 0, s: 95823, q: 120801356, u: 'BwWK17cb', vs: 296502, vt: 686060571, cr: 'XvmH3d7V' });
  // the creator is sent once per coin and run
  ws.recv(msg);
  assert.strictEqual(got.filter(e => e.type === 'tape')[1].cr, undefined);
  // a failed transaction moved nothing
  const bad = JSON.parse(JSON.stringify(msg)); bad.params.result.value.err = { InstructionError: [3, { Custom: 6003 }] };
  ws.recv(bad);
  assert.strictEqual(got.filter(e => e.type === 'tape').length, 2);
  assert.strictEqual(tape.stats.failedTx, 1);
  // notifications for a subscription we do not know are dropped
  const stray = JSON.parse(JSON.stringify(msg)); stray.params.subscription = 999; ws.recv(stray);
  assert.strictEqual(got.filter(e => e.type === 'tape').length, 2);

  // polling: the curve account becomes a curve event only when it changed
  net.setAnswer(b => b.method === 'getMultipleAccounts' ? { jsonrpc: '2.0', id: 1, result: { context: { slot: 459856858 }, value: [FX.accounts.result.value[0]] } } : null);
  t += 1000; await tape.poll();
  const cv = got.filter(e => e.type === 'curve');
  assert.strictEqual(cv.length, 1);
  assert.deepStrictEqual(cv[0], { type: 'curve', at: T0 + 1700, m: n.m, slot: 459856858, vs: 343976, vt: 618957107, rs: 119610, rt: 339057107, done: false, src: 'poll' });
  t += 2000; await tape.poll();
  assert.strictEqual(got.filter(e => e.type === 'curve').length, 1, 'an unchanged curve is not sent again');
  assert.deepStrictEqual(net.posts[0].params[0], [n.bc]);

  // the coin is no longer wanted: unsubscribed
  tape.want([]);
  assert.ok(ws.sent.some(x => x.method === 'logsUnsubscribe' && x.params[0] === 4242));
  // a dropped connection: status down, then a reconnect after the backoff with every wanted curve again
  tape.want([{ m: n.m, bc: n.bc }]);
  ws.close();
  assert.deepStrictEqual(got.filter(e => e.type === 'tape_status').map(e => e.up), [true, false]);
  tape.want([{ m: n.m, bc: n.bc }]);
  assert.strictEqual(net.sockets.length, 1, 'waits for the backoff');
  t += 2500; tape.want([{ m: n.m, bc: n.bc }]);
  assert.strictEqual(net.sockets.length, 2);
  net.sockets[1].open();
  assert.ok(net.sockets[1].sent.some(x => x.method === 'logsSubscribe' && x.params[0].mentions[0] === n.bc));
  // a socket that never opens is replaced
  net.sockets[1].close();
  t += 5000; tape.want([{ m: n.m, bc: n.bc }]);
  assert.strictEqual(net.sockets.length, 3);
  t += 21000; tape.want([{ m: n.m, bc: n.bc }]);
  assert.ok(net.sockets[2].closed, 'gave up on a socket that did not open in 20 s');
  // a connection that lived 5 s or more is replaced at once, without waiting for the next call
  const before = net.sockets.length;
  t += 1000; tape.want([{ m: n.m, bc: n.bc }]);
  const sock = net.sockets[net.sockets.length - 1];
  sock.open(); t += 6000; sock.close();
  assert.strictEqual(net.sockets.length, before + 2, 'reconnected at once after a drop');
  assert.match(got.filter(e => e.type === 'tape_status').slice(-1)[0].why, /disconnected \(code/);
  // at most TAPE_MAX curves
  const many = Array.from({ length: 60 }, (_, i) => ({ m: FX.sol[i % FX.sol.length].mint, bc: 'Curve' + i }));
  tape.want(many);
  assert.strictEqual(tape.desired.size, T.TAPE_MAX);
});

// a coin in the engine with a tape: trades every 2 s, the creator sells once
function engineWithTape() {
  const e = createEngine();
  e.init(min(-5));
  e.ingest({ type: 'run_start', at: min(-5), run: 'test' });
  e.ingest({ id: 'x1', type: 'crossing', at: T0, m: M, sym: 'FROGT', name: 'Frog Test', mcX: 7000, bc: BC });
  const evs = [];
  let vs = 66e6, vt = 30 * 1.073e9 * 1e6 / vs;           // classic curve at about $7K (micro-SOL, tokens)
  evs.push({ type: 'tape_status', at: T0 + 500, up: true, subs: 1, why: 'connected' });
  for (let k = 0; k < 600; k++) {
    const at = T0 + 1000 + k * 2000, buy = k !== 300 && k % 3 !== 2, s = buy ? 200000 : 150000;   // 0.2 SOL buys, 0.15 SOL sells
    const k0 = vs * vt;
    if (buy) vs += s; else vs -= s;
    vt = Math.round(k0 / vs);
    const ev = { type: 'tape', at, m: M, slot: 1000 + k, b: buy ? 1 : 0, s, q: 1000, u: 'W' + (k % 7), vs: Math.round(vs), vt };
    if (k === 0) ev.cr = 'Creator1';
    if (k === 300) ev.u = 'Creator1';                  // the creator sells 0.15 SOL
    evs.push(ev);
    if (k % 5 === 0) evs.push({ type: 'curve', at: at + 300, m: M, slot: 1000 + k, vs: Math.round(vs), vt, rs: Math.round(vs) - 30e6, rt: vt - 279.9e6, done: false, src: 'poll' });
  }
  return { e, evs };
}

test('the engine keeps the tape per coin (exact price, flow, creator sells) and trims it; v2.0 inputs are untouched', () => {
  const { e, evs } = engineWithTape();
  const S = e.state();
  for (const ev of evs) { e.ingest(ev); if ((ev.at - T0) % 5000 < 2000 && ev.type === 'tape') e.tick(ev.at); }
  const c = S.coins[M];
  assert.strictEqual(c.tp.cr, 'Creator1');
  assert.strictEqual(c.tp.n, 600);
  assert.ok(c.tp.crSold > 0 && c.tp.crSellAt === T0 + 1000 + 300 * 2000, 'the creator sold once');
  assert.strictEqual(c.tp.last.ps, TS.psOf(c.tp.last.vs, c.tp.last.vt));
  assert.ok(c.tp.tr.length <= 15 * 30 + 5 && c.tp.tr.length >= 15 * 30 - 5, 'only the last 15 minutes of trades are kept (pruned at ticks): ' + c.tp.tr.length);
  assert.strictEqual(c.last, null, 'tape trades never become the price v2.0 and E0 use (market.js)');
  assert.strictEqual(c.bars.length, 0);
  assert.deepStrictEqual(S.tape, { up: true, at: T0 + 500, subs: 1, why: 'connected' });
  const at = evs[evs.length - 1].at;
  const f = TS.features(c, at, 59000);
  // the same window computed directly from the events
  const w = evs.filter(x => x.type === 'tape' && at - x.at <= 59000);
  assert.strictEqual(f.n, 30); assert.strictEqual(w.length, 30);
  assert.strictEqual(f.nb, w.filter(x => x.b).length); assert.strictEqual(f.ns, w.filter(x => !x.b).length);
  assert.ok(Math.abs(f.buySol - w.filter(x => x.b).reduce((a, x) => a + x.s / 1e6, 0)) < 1e-9 && Math.abs(f.sellSol - w.filter(x => !x.b).reduce((a, x) => a + x.s / 1e6, 0)) < 1e-9);
  assert.strictEqual(f.buyers, new Set(w.filter(x => x.b).map(x => x.u)).size);
  assert.ok(f.ret > 0, 'net buying lifted the price');
  assert.ok(Math.abs(f.crSold - 0.15) < 1e-9);
  // the saved copy keeps the last 15 s of trades, at most 30
  const saved = REC.trimSave(e.save());
  assert.ok(saved.coins[M].tp.tr.length >= 1 && saved.coins[M].tp.tr.length <= 30 && saved.coins[M].tp.tr.every(x => saved.lastAt - x[0] <= 15000));
  // the plan: curve coins, held first, then the fast list
  assert.deepStrictEqual(e.tapePlan(T0 + 60000), [{ m: M, bc: BC }]);
});

test('tape inputs are recorded compactly and replay exactly across a restart', () => {
  const { evs } = engineWithTape();
  const rec = REC.recorder();
  let eng = createEngine(), saveN = 0, committed = null;
  const ingest = ev => { rec.event(ev); eng.ingest(ev); };
  rec.load(min(-5), null); eng.init(min(-5)); ingest({ type: 'run_start', at: min(-5), run: 'r1' });
  ingest({ id: 'x1', type: 'crossing', at: T0, m: M, sym: 'FROGT', name: 'Frog Test', mcX: 7000, bc: BC });
  ingest({ type: 'sol', at: T0, usd: SOL_USD });
  const half = evs.length >> 1;
  const step = list => { for (const ev of list) { ingest(ev); if (ev.type === 'tape' && ev.slot % 3 === 0) { rec.tick(ev.at); eng.tick(ev.at); eng.drain(); } } };
  step(evs.slice(0, half));
  const s = REC.trimSave(eng.save()); rec.save(evs[half - 1].at, ++saveN); rec.committed(evs[half - 1].at + 100, saveN, true); committed = REC.roundTrip(s);
  const f1 = rec.take();
  assert.ok(f1.some(l => l.startsWith('["T"')) && f1.some(l => l.startsWith('["C"')), 'tape and curve lines');
  const tLine = f1.find(l => l.startsWith('["T"'));
  assert.ok(tLine.length < 90, 'a trade line stays short: ' + tLine);
  // the next run loads the committed save
  const at2 = evs[half].at - 500;
  rec.load(at2, committed); eng = createEngine(); eng.load(REC.unpack(REC.roundTrip(committed))); ingest({ type: 'run_start', at: at2, run: 'r2' });
  step(evs.slice(half));
  rec.save(evs[evs.length - 1].at, ++saveN); rec.committed(evs[evs.length - 1].at + 100, saveN, true);
  const final = REC.roundTrip(REC.trimSave(eng.save()));
  const f2 = rec.take();
  // decoded events equal the ingested ones
  const decoded = [...REC.decode([f1, f2])].filter(x => x.k === 'event' && (x.ev.type === 'tape' || x.ev.type === 'curve')).map(x => x.ev);
  assert.strictEqual(decoded.length, evs.filter(e => e.type !== 'tape_status').length);
  assert.deepStrictEqual(decoded[0], evs.find(e => e.type === 'tape'));
  const r = REC.replayExact([f1, f2]);
  assert.strictEqual(r.checks.length, 1);
  assert.ok(r.checks[0].same, r.checks[0].detail);
  assert.strictEqual(REC.firstDiff(REC.roundTrip(r.lastSave), final), null);
});
