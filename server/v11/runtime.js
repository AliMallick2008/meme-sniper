'use strict';
/* v11 inside the server process, beside the legacy bots (which it never touches).
   - observe(): every API response the process receives (the legacy bots' and v11's own) becomes timestamped events, so
     v11 sees exactly what arrived and when: crossings, audits, RugCheck reports, prices, candles, SOL/USD, quotes.
   - Its own calls share the legacy lanes (one Jupiter lane for tokens + quotes, spaced for the 30/min keyless limit):
     Jupiter snapshots of the coins it watches or holds (stats, audit re-checks), DexScreener prices for them every 5 s,
     and the quotes the engine asks for (exits first).
   - Saves: v11.json (full state) and a compact view inside state.json for the page; an append-only event log on the
     research branch (v11/events/<date>/<hour>h-run<id>-<n>.jsonl.gz).
   - Fault isolation: any v11 error is caught and counted; after 50 in one run, v11 stops for that run and the legacy
     bots carry on. Paper only: quotes are prices for exact sizes; nothing is ever signed or sent. */
const zlib = require('zlib');
const ENG = require('./engine.js');
const PARSE = require('./parse.js');
const ST = require('./strategies.js');
const VIEW = require('./view.js');

const JUP = 'https://lite-api.jup.ag', DEX = 'https://api.dexscreener.com';

function defaultStrategies() { return [...ST.e0All(), ST.HOLD, ...(ST.v2All ? ST.v2All() : [])]; }

/* o: { clock: { now(), sleep(ms) }, log(text), getJSON(lane, url), put(path, buffer), run, sha, state, strategies, config } */
function create(o) {
  const nowS = () => o.clock.now() / 1000;
  const eng = ENG.create({ strategies: o.strategies || defaultStrategies(), state: o.state || null, config: o.config });
  const st = { events: 0, errors: 0, quotes: 0, snaps: 0, dex: 0, files: 0, lines: 0, lastErr: '', lastFlush: 0, disabled: null };
  let seq = 0, stopped = false, buf = [], bufH = 0, part = 0, nextTry = 0, flushing = false, savedFills = eng.state().n.fills;
  function safe(fn) {
    if (st.disabled) return undefined;
    try { return fn(); } catch (e) {
      st.errors++; st.lastErr = String(e && e.message || e).slice(0, 160);
      if (st.errors <= 5) o.log('v11 error: ' + (e && e.stack || e).toString().split('\n').slice(0, 3).join(' | '));
      if (st.errors >= 50) { st.disabled = 'too many errors: ' + st.lastErr; o.log('v11 stopped for this run (' + st.disabled + '); the legacy bots carry on'); }
      return undefined;
    }
  }
  function ingest(ev) { ev.id = `${o.run}:${++seq}`; eng.ingest(ev); st.events++; }
  /* every response the process gets: url, { status, json }, request and receipt times in ms */
  function observe(url, res, reqMs, atMs) {
    safe(() => {
      const r = PARSE.parse(url, res, reqMs / 1000, atMs / 1000);
      for (const e of r.errors) eng.ctx.err('field ' + e);
      for (const ev of r.events) ingest(ev);
    });
  }
  // the run starts before anything else reaches the engine (the legacy bots' first calls come right after)
  safe(() => ingest({ type: 'run_start', at: nowS(), req: nowS(), run: o.run, sha: o.sha }));
  function start() { tickLoop(); quoteLoop(); snapLoop(); dexLoop(); }
  async function tickLoop() { while (!stopped && !st.disabled) { safe(() => eng.tick(nowS())); safe(() => { for (const r of eng.drain()) addLine(r); }); await o.clock.sleep(1000); } }
  async function quoteLoop() {
    while (!stopped && !st.disabled) {
      const r = safe(() => { const q = eng.requests(nowS())[0] || null; if (q) eng.sent(q.key, nowS()); return q; });
      if (!r) { await o.clock.sleep(1000); continue; }
      st.quotes++;
      try { await o.getJSON('jup', `${JUP}/swap/v1/quote?inputMint=${r.inMint}&outputMint=${r.outMint}&amount=${r.amount}&slippageBps=1000`); } catch (e) { /* observe() saw the status */ }
    }
  }
  async function snapLoop() {
    while (!stopped && !st.disabled) {
      const a = safe(() => eng.active(nowS())) || { hot: [], warm: [] };
      const ms = [...a.hot, ...a.warm].filter(PARSE.okAddr).slice(0, 100);
      for (let i = 0; i < ms.length && !stopped; i += 50) {
        st.snaps++;
        try { await o.getJSON('jup', `${JUP}/tokens/v2/search?query=${ms.slice(i, i + 50).join(',')}`); } catch (e) { /* retried next round */ }
      }
      await o.clock.sleep(ms.length ? 20000 : 5000);
    }
  }
  async function dexLoop() {
    for (let n = 0; !stopped && !st.disabled; n++) {
      const a = safe(() => eng.active(nowS())) || { hot: [], warm: [] };
      const ms = (n % 2 ? a.hot : [...a.hot, ...a.warm]).filter(PARSE.okAddr);   // held coins every 5 s, watched every 10 s
      for (let i = 0; i < ms.length && !stopped; i += 30) {
        st.dex++;
        try { await o.getJSON('dex', `${DEX}/tokens/v1/solana/${ms.slice(i, i + 30).join(',')}`); } catch (e) { /* next round */ }
      }
      await o.clock.sleep(5000);
    }
  }
  function addLine(r) { if (!buf.length) bufH = Math.floor(nowS() / 3600); buf.push(JSON.stringify(r)); st.lines++; }
  async function flush(force) {
    if (!buf.length || flushing || !o.put || (!force && nowS() < nextTry)) return;
    if (!force && Math.floor(nowS() / 3600) === bufH && buf.length < 5000) return;
    flushing = true;
    const lines = buf, h0 = bufH; buf = [];
    try {
      const d = new Date(h0 * 3600e3).toISOString();
      await o.put(`v11/events/${d.slice(0, 10)}/${d.slice(11, 13)}h-run${o.run}-${++part}.jsonl.gz`, zlib.gzipSync(Buffer.from(lines.join('\n') + '\n')));
      st.files++; st.lastFlush = Math.round(nowS());
    } catch (e) {
      buf = lines.concat(buf); bufH = h0; nextTry = nowS() + 120;
      st.lastErr = 'event log upload: ' + String(e && e.message || e).slice(0, 80);
    } finally { flushing = false; }
  }
  function stop() { stopped = true; safe(() => { eng.tick(nowS()); for (const r of eng.drain()) addLine(r); }); }
  /* a fill since the last save: the server saves within seconds, like the legacy bots */
  function urgent() { const f = eng.state().n.fills; return f !== savedFills; }
  function save() { savedFills = eng.state().n.fills; return safe(() => VIEW.persist(eng)) || null; }
  function view() { return safe(() => VIEW.page(eng, st)) || { v: 1, off: st.disabled || 'view failed' }; }
  return { observe, start, stop, flush, save, view, urgent, stats: () => st, engine: eng };
}
module.exports = { create, defaultStrategies };
