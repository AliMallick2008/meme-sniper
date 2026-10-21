'use strict';
/* A tiny deterministic world for v11 tests: coins with price paths (market cap in USD as a function of time), a fixed SOL/USD, price
   observations every few seconds, and a quote desk that answers the engine's quote requests after a delay from the
   bonding-curve / pool model at the price at answer time. Like the runtime, it ticks the engine once a second. */
const ENG = require('../v11/engine.js');
const ST = require('../v11/strategies.js');
const MODEL = require('../v11/model.js');
const { SOL_MINT } = require('../v11/parse.js');
const VERIFY = require('../v11/verify.js');

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
let seq = 1;
function addr(suffix = '') { let s = '', x = seq++ * 7919; for (let i = 0; s.length < 44 - suffix.length; i++) { s += B58[(x + i * 31) % 58]; x = (x * 131 + 7) % 1000003; } return s + suffix; }
const SOLUSD = 105;

class World {
  constructor(o = {}) {
    this.t0 = o.t0 || 1792500000;
    this.t = this.t0;
    this.strats = o.strategies || [...ST.e0All(), ST.HOLD];
    this.eng = o.engine || ENG.create({ strategies: this.strats, config: o.config, state: o.state });
    this.coins = new Map();
    this.q = [];                         // scheduled events [{ at, ev }]
    this.quoteLag = o.quoteLag != null ? o.quoteLag : 0.6;
    this.obsEvery = o.obsEvery || 5;
    this.solEvery = 30;
    this.down = [];                      // [from, to): the server is not running
    this.quotes = [];                    // answered quotes
    this.feed = true;                    // price observations on/off (or a function of time)
    this.solOn = true;                   // SOL/USD ticker on/off (or a function of time)
    this.evId = 0;
  }
  coin(o) {
    const c = Object.assign({ m: addr('pump'), bc: addr(), pool: null, sym: 'C' + seq, name: 'Tilly ' + ['Moon', 'Cat', 'Dog', 'Frog'][seq % 4], created: this.t0 - 600, grad: null, quote: 'ok',
      audit: { mintOff: true, freezeOff: true, dev: 2, top: 18, devMints: 3 }, holders: 120, org: 12, danger: [] }, o);
    this.coins.set(c.m, c);
    return c;
  }
  usd(c, t) { return c.price(t); }
  stage(c, t) { return c.grad != null && t >= c.grad ? 'pool' : 'curve'; }
  at(at, ev) { this.q.push({ at, ev: Object.assign({ at, req: at - 0.3 }, ev) }); return this; }
  offline(from, to) { this.down.push([from, to]); return this; }
  isDown(t) { return this.down.some(([a, b]) => t >= a && t < b); }
  pxEvent(c, t) {
    const usd = c.price(t) / 1e9; if (!(usd > 0)) return null;
    const p = { dex: 'pumpfun', pair: c.bc, quote: 'SOL', usd, native: usd / SOLUSD, mc: usd * 1e9, liq: null, b5: 40, s5: 22, v5: 1500, created: c.created, sym: c.sym, name: c.name, claims: null, bad: [] };
    const pairs = [p];
    if (this.stage(c, t) === 'pool') pairs.push(Object.assign({}, p, { dex: 'pumpswap', pair: c.pool, liq: { usd: 30000, base: 1.5e8, quote: 1.5e8 * usd / SOLUSD } }));
    return { type: 'px', m: c.m, pairs };
  }
  /* another coin sharing c's name crosses $7K at tCross (no checks, never traded): c then passes the legacy meme check */
  partner(c, tCross) {
    const created = tCross - 300;
    return this.coin({ name: c.name, sym: c.sym + 'X', created, price: t => t < tCross - 10 ? 3000 : 8000 });
  }
  /* Jupiter token snapshot at time t: audit (c.audit may change over time), 5-minute stats from c.stats(t) */
  jupEvent(c, extra, t) {
    t = t != null ? t : this.t;
    const audit = typeof c.audit === 'function' ? c.audit(t) : c.audit, mc = c.price(t);
    const s5 = c.stats ? c.stats(t) : { bv: 900, sv: 600, nb: 40, ns: 22, nt: 37, nnb: 10, hc: 2 };
    return Object.assign({ type: 'jup', m: c.m, sym: c.sym, name: c.name, dec: 6, audit: Object.assign({}, audit), holders: c.holders, org: c.org, usd: mc / 1e9, mc,
      claims: c.claims || { tw: null, web: null, tg: null }, s5, s1h: null, srcAt: t - 2, bad: [] }, extra || {});
  }
  rcEvent(c) { return { type: 'rc', m: c.m, score: 1, sn: 1, risks: c.danger.map(d => [d, 'danger']), danger: c.danger.slice() }; }
  /* the checks of coin c arrive at tAudit and tRc */
  checks(c, tAudit, tRc) { this.at(tAudit, this.jupEvent(c, null, tAudit)); this.at(tRc != null ? tRc : tAudit, this.rcEvent(c)); return this; }
  quoteFor(r, t) {
    const out = r.outMint === SOL_MINT ? r.inMint : r.outMint, c = this.coins.get(out);
    const base = { type: 'quote', inMint: r.inMint, outMint: r.outMint, amount: r.amount };
    if (!c) return Object.assign(base, { ok: false, why: 'no route' });
    const mode = typeof c.quote === 'function' ? c.quote(t, r) : c.quote;
    if (mode === 'none') return null;
    if (mode === 'noroute') return Object.assign(base, { ok: false, why: 'no route' });
    if (mode === 'limited') return Object.assign(base, { ok: false, why: 'rate limited', retry: true });
    if (mode === 'schema') return Object.assign(base, { ok: false, why: 'schema: outAmount/inAmount', schema: true });
    const usd = c.price(t) / 1e9; if (!(usd > 0)) return Object.assign(base, { ok: false, why: 'no route' });
    const st = this.stage(c, t), pSol = usd / SOLUSD, liq = st === 'pool' ? { base: 1.5e8, quote: 1.5e8 * pSol } : null;
    if (r.outMint === SOL_MINT) { const s = MODEL.sellOut(r.amount / 1e6, pSol, st, liq, t); return Object.assign(base, { ok: true, inAmount: r.amount, outAmount: Math.floor(s.sol * 1e9), impact: Math.max(0, s.impact), labels: [st === 'pool' ? 'Pump.fun Amm' : 'Pump.fun'] }); }
    const b = MODEL.buyOut(r.amount / 1e9, pSol, st, liq, t);
    return Object.assign(base, { ok: true, inAmount: r.amount, outAmount: Math.floor(b.tokens * 1e6), impact: Math.max(0, b.impact), labels: [st === 'pool' ? 'Pump.fun Amm' : 'Pump.fun'] });
  }
  /* Runs the world to time `until`, one second at a time. */
  run(until) {
    const E = this.eng;
    let wasDown = this.isDown(this.t);
    for (let t = this.t; t <= until; t += 1) {
      const down = this.isDown(t);
      if (wasDown && !down) E.ingest({ type: 'run_start', at: t, run: 'r' + t });
      wasDown = down;
      if (down) { this.q = this.q.filter(x => x.at >= t + 1 || (x.ev.type !== 'quote')); continue; }   // in-flight quotes die with the process
      if (t === this.t0) E.ingest({ type: 'run_start', at: t, run: 'r0' });
      const on = f => typeof f === 'function' ? f(t) : f;
      if (on(this.solOn) && (t - this.t0) % this.solEvery === 0) E.ingest({ type: 'sol', at: t, req: t - 0.2, px: SOLUSD });
      if (on(this.feed) && (t - this.t0) % this.obsEvery === 0) for (const c of this.coins.values()) { if (t < c.created) continue; const ev = this.pxEvent(c, t); if (ev) E.ingest(Object.assign({ at: t, req: t - 0.2 }, ev)); }
      // the runtime's Jupiter snapshots of the coins v11 watches or holds, every 20 s
      if ((t - this.t0) % 20 === 10 && this.snaps !== false) { const a = E.active(t); for (const m of [...a.hot, ...a.warm]) { const c = this.coins.get(m); if (c && t >= c.created) E.ingest(Object.assign({ at: t, req: t - 0.4 }, this.jupEvent(c, null, t))); } }
      const due = this.q.filter(x => x.at <= t).sort((a, b) => a.at - b.at);
      this.q = this.q.filter(x => x.at > t);
      for (const x of due) E.ingest(x.ev);
      E.tick(t + 0.5);
      for (const r of E.requests(t + 0.5)) {
        E.sent(r.key, t + 0.5);
        const ans = this.quoteFor(r, t + 0.5 + this.quoteLag);
        if (ans) { const at = t + 0.5 + this.quoteLag; this.quotes.push(Object.assign({ at, req: t + 0.5 }, ans)); this.q.push({ at, ev: Object.assign({ at, req: t + 0.5, id: 'q' + (++this.evId) }, ans) }); }
      }
    }
    this.t = until + 1;
    const bad = VERIFY.check(E.state(), E.C);
    if (bad.length) throw new Error('v11 invariants broken:\n' + bad.join('\n'));
    return this;
  }
  acct(id) { return this.eng.state().accts[id]; }
}
module.exports = { World, addr, SOLUSD, MODEL, ENG, ST };
