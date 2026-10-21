'use strict';
/* Research recorder: every coin the server sees cross $7K, with its point-in-time rug checks, plus its final 1-minute
   candles from launch to 2 h after the crossing (fetched 2 h 05 min after it, in GeckoTerminal slots the bots don't need).
   Saved as gzipped JSON lines on the `research` branch, one file per hour per run. Used to test rule changes later on
   coins the rules never saw. */
const zlib = require('zlib');
const DUE_S = 7500;

function create({ core, E, clock, log, put, run }) {
  const nowS = () => clock.now() / 1000;
  const r5 = v => +(+v).toPrecision(5);
  let Q = [], buf = [], bufH = 0, part = 0, done = 0, failed = 0, files = 0, lastFlush = 0, nextTry = 0, flushing = false, lastErr = '';
  function snap(k) {
    return { m: k.m, sym: k.sym, name: k.name, t: k.t, x: k.x, mcX: k.mcX, bc: k.bc, pool: k.pool || null, words: k.words, links: k.links || null,
      audit: k.audit, rc: k.rc, holders: k.holders, soc: k.soc, org: k.org, s5: k.s5, dev: k.dev, meme: k.meme, score: k.score,
      status: k.status, ok: k.ok, why: k.why };
  }
  function add(k) {
    if (!k || !k.x || !core.okAddr(k.bc) || Q.some(q => q.k.m === k.m)) return;
    Q.push({ due: k.x + DUE_S, tries: 0, k: snap(k) });
  }
  function load(a) { for (const q of (Array.isArray(a) ? a : [])) if (q && q.k && q.k.m && !Q.some(x => x.k.m === q.k.m)) Q.push(q); }
  // called by the candle loop when the bots need nothing from GeckoTerminal; true if it used the slot
  async function idle() {
    const t = nowS();
    if (Q.length && Q[0].due < t - 3 * 86400) Q = Q.filter(q => t - q.due < 3 * 86400);
    let q = null; for (const x of Q) if (x.due <= t && (!q || x.due < q.due)) q = x;
    if (!q) return false;
    try {
      const rec = await fetchCoin(q.k);
      Q = Q.filter(x => x !== q);
      if (rec) { if (!buf.length) bufH = Math.floor(nowS() / 3600); buf.push(JSON.stringify(rec)); done++; } else failed++;
    } catch (e) {
      q.tries++; q.due = t + 120 * q.tries; lastErr = String(e && e.message || e).slice(0, 80);
      if (q.tries >= 6) { Q = Q.filter(x => x !== q); failed++; }
    }
    return true;
  }
  async function fetchCoin(k) {
    // candles up to 2 h 2 min after the crossing; fetched 5 min after that, so every one of them is final
    const end = Math.floor((k.x + 7200) / 60) * 60 + 120;
    let pool = k.pool;
    if (!pool) {   // graduated since? DexScreener knows its PumpSwap pool
      const j = await core.getJSON('dex', `${core.API.dex}/tokens/v1/solana/${k.m}`);
      for (const p of (Array.isArray(j) ? j : [])) if (p && p.dexId === 'pumpswap' && core.okAddr(p.pairAddress)) pool = p.pairAddress;
    }
    const a = await core.ohlcv(k.bc, end);
    if (!a) return null;
    const b = pool ? ((await core.ohlcv(pool, end)) || []) : [];
    const from = Math.floor(k.t / 60) * 60 - 60;
    const cs = E.stitch(a, b).filter(c => c.every(v => isFinite(v)) && c[0] < end && c[0] >= from);
    if (cs.length) { try { await core.solRange(cs[0][0], cs[cs.length - 1][0]); } catch (e) { /* nearest SOL price is used */ } }
    return Object.assign({ v: 1, at: Math.round(nowS()), to: end, poolNow: pool || null }, k, {
      cs: cs.map(c => [c[0], r5(c[1] * E.SUPPLY), r5(c[2] * E.SUPPLY), r5(c[3] * E.SUPPLY), r5(c[4] * E.SUPPLY), Math.round(c[5] || 0), c[6], +core.solAt(c[0]).toFixed(2)]) });
  }
  async function maybeFlush(force) {
    if (!buf.length || flushing || (!force && nowS() < nextTry)) return;
    if (!force && Math.floor(nowS() / 3600) === bufH && buf.length < 400) return;
    flushing = true;
    const lines = buf, h0 = bufH; buf = [];
    try {
      const d = new Date(h0 * 3600e3).toISOString();
      const p = `research/${d.slice(0, 10)}/${d.slice(11, 13)}h-run${run}-${++part}.jsonl.gz`;
      await put(p, zlib.gzipSync(Buffer.from(lines.join('\n') + '\n')));
      files++; lastFlush = Math.round(nowS());
    } catch (e) {
      buf = lines.concat(buf); bufH = h0; nextTry = nowS() + 120;
      lastErr = 'upload: ' + String(e && e.message || e).slice(0, 70); log('research upload failed: ' + (e && e.message || e));
    } finally { flushing = false; }
  }
  const stats = () => ({ queued: Q.length, due: Q.filter(q => q.due <= nowS()).length, done, failed, files, buffered: buf.length, lastFlush, lastErr });
  return { add, load, out: () => Q, queued: () => Q.length, idle, maybeFlush, stats };
}
module.exports = { create, DUE_S };
