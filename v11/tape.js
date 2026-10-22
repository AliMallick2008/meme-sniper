'use strict';
/* The tape lane (data only): exact bonding-curve reserves and every trade of the coins that matter, read from the public
   Solana RPC. Probed from a GitHub runner on Oct 22 2026 (branch probe-src): one websocket with a logs subscription per
   bonding curve delivered every trade of 8 busy coins (pump.fun TradeEvent in the "Program data:" log lines, decoded
   below), and getMultipleAccounts answered in 26 ms (p50), 60 calls in a row without a limit.

   What it adds over Jupiter (12 s) and DexScreener (lags ~46 s): each trade within about a second, with the trader, the
   side, the SOL and token amounts and the curve's reserves after it (so the exact price and the exact cost of any paper
   trade on the curve), and the coin's creator wallet. Not every pump.fun curve starts at 30 virtual SOL any more (64 of 99
   coins in a 20 s sample did; others started from about 1 to 830 SOL), so a model built on the classic curve misprices
   the rest; these reserves do not.

   Paper only: read-only RPC methods (logsSubscribe, getMultipleAccounts); no keys, no wallets, nothing is ever sent to
   the chain. Inputs to the engine (all recorded, replayable):
     { type: 'tape', at, m, slot, b (1 buy / 0 sell), s (micro-SOL), q (whole tokens), u (trader, 8 chars), vs (virtual
       SOL after the trade, micro-SOL), vt (virtual tokens after it, whole tokens), cr (creator, 8 chars: on the coin's
       first trade in this run) }
     { type: 'curve', at, m, slot, vs, vt, rs, rt (same units), done, src, cr }   polled, only when the state changed
     { type: 'tape_status', at, up, subs, why }                  the websocket went up or down
     { type: 'tape_sub', at, m, on }                             a coin's subscription was confirmed (on) or ended */
const crypto = require('crypto');

const PUMP = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const RPC_URL = 'https://api.mainnet-beta.solana.com';
const TAPE_MAX = 40;                 // logs subscriptions on the one connection (the busiest coins first)
const VIRT_TOKENS = 279.9e6;         // virtual-only tokens on every curve seen (vTok - rTok, 99 of 99 coins)

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58(buf) {
  let n = 0n; for (const x of buf) n = (n << 8n) + BigInt(x);
  let s = ''; while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
  for (const x of buf) { if (x === 0) s = '1' + s; else break; }
  return s;
}
function unb58(s) {
  let n = 0n; for (const ch of s) { const i = B58.indexOf(ch); if (i < 0) return null; n = n * 58n + BigInt(i); }
  const h = n.toString(16).padStart(64, '0'); return h.length === 64 ? Buffer.from(h, 'hex') : null;
}
const disc = name => crypto.createHash('sha256').update('event:' + name).digest().subarray(0, 8);
const D_TRADE = disc('TradeEvent'), D_COMPLETE = disc('CompleteEvent');

/* pump.fun TradeEvent (Anchor event, borsh): 8-byte discriminator, mint, sol_amount u64, token_amount u64, is_buy bool,
   user, timestamp i64, virtual_sol_reserves, virtual_token_reserves, real_sol_reserves, real_token_reserves (u64),
   fee_recipient, fee_basis_points u64, fee u64, creator (offset 177), ... (newer fields follow; only this prefix is read).
   Coins quoted in something other than SOL report 0 SOL reserves: they are skipped (the legacy discovery keeps SOL coins). */
function decodeTrade(buf, mintBytes) {
  if (buf.length < 225 || !buf.subarray(0, 8).equals(D_TRADE)) return null;
  if (mintBytes && !buf.subarray(8, 40).equals(mintBytes)) return null;
  const u64 = o => Number(buf.readBigUInt64LE(o));
  const t = { sol: u64(40), tok: u64(48), buy: buf[56] === 1, user: b58(buf.subarray(57, 89)), ts: Number(buf.readBigInt64LE(89)),
    vSol: u64(97), vTok: u64(105), rSol: u64(113), rTok: u64(121), creator: buf.length >= 209 ? b58(buf.subarray(177, 209)) : null };
  if (!(t.vSol > 0) || !(t.vTok > 0)) return null;
  return t;
}
// CompleteEvent: user, mint, bonding_curve, timestamp: the curve is done (the coin migrates to its pool)
function decodeComplete(buf, mintBytes) {
  if (buf.length < 112 || !buf.subarray(0, 8).equals(D_COMPLETE)) return null;
  return mintBytes && !buf.subarray(40, 72).equals(mintBytes) ? null : { done: true };
}
/* BondingCurve account: 8-byte discriminator, virtual_token_reserves, virtual_sol_reserves, real_token_reserves,
   real_sol_reserves, token_total_supply (u64), complete (bool), creator (32 bytes, since May 2025) */
function decodeCurve(b64) {
  const b = Buffer.from(b64, 'base64'); if (b.length < 49) return null;
  const u = o => Number(b.readBigUInt64LE(o));
  return { vTok: u(8), vSol: u(16), rTok: u(24), rSol: u(32), supply: u(40), done: b[48] === 1, creator: b.length >= 81 ? b58(b.subarray(49, 81)) : null };
}
const uSol = lamports => Math.round(lamports / 1000);   // micro-SOL: 1e-6 SOL precision is plenty and records shorter
const tok = raw => Math.round(raw / 1e6);                // whole tokens (6 decimals): 1 in 1e9 of the supply
const short = w => (w ? String(w).slice(0, 8) : null);

/* createTape(opts)
     now()            clock (ms)
     ingest(ev)       records the event and feeds it to the engine (runtime.js)
     log(text)
     fetch(url, init) HTTP (global fetch); WS: WebSocket constructor (global in Node 22); url: RPC base URL
   Returns { want(list of { m, bc }), poll(), maintain(), start(L, plan), stats, stop() }. Nothing throws out of it. */
function createTape(opts) {
  const now = opts.now, log = opts.log || (() => {}), ingest = opts.ingest;
  const url = opts.url || RPC_URL, WSImpl = opts.WS || (typeof WebSocket === 'function' ? WebSocket : null), fetchImpl = opts.fetch || (typeof fetch === 'function' ? fetch : null);
  const stats = { up: false, subs: 0, trades: 0, failedTx: 0, decodeMiss: 0, curves: 0, polls: 0, pollFails: 0, reconnects: 0, lastMsgAt: null, lastTradeAt: null, subErrors: 0, creatorMismatch: 0 };
  let ws = null, wsUp = false, backoff = 0, reqId = 0, closing = false, retryAt = 0, openedAt = 0;
  const desired = new Map();     // bc -> { m, bc, mintBytes }
  const subs = new Map();        // bc -> { id (request), sub (subscription id) }
  const bySub = new Map();       // subscription id -> bc
  const pendingReq = new Map();  // request id -> { bc, kind: 'sub' | 'unsub' }
  const last = new Map();        // m -> { slot, vs, vt } (the newest state sent to the engine)
  const crSent = new Set();      // coins whose creator was sent this run

  const status = (up, why) => { if (stats.up === up && !why) return; stats.up = up; ingest({ type: 'tape_status', at: now(), up, subs: subs.size, why: why || null }); };
  function send(o) { try { if (ws && wsUp) { ws.send(JSON.stringify(o)); return true; } } catch (e) { /* the close handler reconnects */ } return false; }
  function subscribe(bc) {
    if (subs.has(bc)) return;
    const id = ++reqId; pendingReq.set(id, { bc, kind: 'sub' }); subs.set(bc, { id, sub: null });
    if (!send({ jsonrpc: '2.0', id, method: 'logsSubscribe', params: [{ mentions: [bc] }, { commitment: 'processed' }] })) { subs.delete(bc); pendingReq.delete(id); }
  }
  function unsubscribe(bc, m) {
    const s = subs.get(bc); if (!s) return;
    subs.delete(bc);
    if (s.sub != null && m) ingest({ type: 'tape_sub', at: now(), m, on: false });
    if (s.sub != null) { bySub.delete(s.sub); const id = ++reqId; pendingReq.set(id, { bc, kind: 'unsub' }); send({ jsonrpc: '2.0', id, method: 'logsUnsubscribe', params: [s.sub] }); }
  }
  function newer(m, slot, vs, vt) {
    const p = last.get(m);
    if (p && (slot < p.slot || (p.vs === vs && p.vt === vt))) return false;
    last.set(m, { slot, vs, vt }); return true;
  }
  function onLogs(p) {
    const bc = bySub.get(p.subscription), d = bc && desired.get(bc); if (!d) return;
    const v = p.result && p.result.value, slot = p.result && p.result.context ? p.result.context.slot : null;
    if (!v) return;
    if (v.err) { stats.failedTx++; return; }
    const at = now();
    for (const l of v.logs || []) {
      if (typeof l !== 'string' || !l.startsWith('Program data: ')) continue;
      let buf; try { buf = Buffer.from(l.slice(14), 'base64'); } catch (e) { continue; }
      const t = decodeTrade(buf, d.mintBytes);
      if (t) {
        stats.trades++; stats.lastTradeAt = at;
        const ev = { type: 'tape', at, m: d.m, slot, b: t.buy ? 1 : 0, s: uSol(t.sol), q: tok(t.tok), u: short(t.user), vs: uSol(t.vSol), vt: tok(t.vTok) };
        if (!crSent.has(d.m) && t.creator) { ev.cr = short(t.creator); crSent.add(d.m); }
        last.set(d.m, { slot, vs: ev.vs, vt: ev.vt });
        ingest(ev);
        continue;
      }
      if (decodeComplete(buf, d.mintBytes)) ingest({ type: 'curve', at, m: d.m, slot, done: true, src: 'event' });
      else if (buf.length >= 8 && buf.subarray(0, 8).equals(D_TRADE)) stats.decodeMiss++;
    }
  }
  function connect() {
    if (!WSImpl || closing) return;
    try { ws = new WSImpl(url.replace(/^http/, 'ws')); openedAt = now(); } catch (e) { ws = null; scheduleRetry('websocket: ' + (e.message || e)); return; }
    const me = ws;
    me.onopen = () => {
      if (me !== ws) return;
      wsUp = true; backoff = 0; subs.clear(); bySub.clear(); pendingReq.clear();
      for (const bc of desired.keys()) subscribe(bc);
      status(true, 'connected');
    };
    me.onmessage = ev => {
      if (me !== ws) return;
      stats.lastMsgAt = now();
      let j; try { j = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data)); } catch (e) { return; }
      try {
        if (j.id != null && pendingReq.has(j.id)) {
          const r = pendingReq.get(j.id); pendingReq.delete(j.id);
          if (r.kind === 'sub') {
            const s = subs.get(r.bc);
            if (j.error) { stats.subErrors++; subs.delete(r.bc); }
            else if (s && s.id === j.id) {
              s.sub = j.result; bySub.set(j.result, r.bc);
              // the engine trusts the coin's tape only after a curve state received from now on: the next poll sends one
              // even if nothing changed
              const d = desired.get(r.bc); if (d) { last.delete(d.m); pollSoon = true; ingest({ type: 'tape_sub', at: now(), m: d.m, on: true }); }
            }
            else send({ jsonrpc: '2.0', id: ++reqId, method: 'logsUnsubscribe', params: [j.result] });   // no longer wanted
          }
          stats.subs = subs.size;
          return;
        }
        if (j.method === 'logsNotification' && j.params) onLogs(j.params);
      } catch (e) { /* a bad message never stops the lane */ }
    };
    me.onerror = () => {};
    me.onclose = e => {
      if (me !== ws) return;
      const code = e && e.code, reason = e && e.reason ? String(e.reason).slice(0, 80) : '';
      stats.lastClose = { at: now(), code: code || null, reason, afterMs: now() - openedAt };
      const was = wsUp; wsUp = false; ws = null; subs.clear(); bySub.clear(); pendingReq.clear(); stats.subs = 0;
      if (was) status(false, `disconnected (code ${code || '?'}${reason ? ': ' + reason : ''})`);
      scheduleRetry();
    };
  }
  function scheduleRetry(why) {
    if (closing) return;
    stats.reconnects++;
    // the public RPC drops idle-or-not connections every 10-20 s at busy hours (code 1006, Oct 22 2026 probe), so the first
    // retry is quick; repeated failures back off to 30 s
    backoff = Math.min(30000, backoff ? backoff * 2 : 500);
    retryAt = now() + backoff;
    if (why) log('tape: ' + why);
  }
  // a socket that never opened within 20 s, or went silent for 5 minutes while following busy coins, is replaced
  function watchdog() {
    if (!ws) return;
    const t = now(), silent = wsUp && subs.size > 0 && stats.lastMsgAt != null && t - stats.lastMsgAt > 300000;
    if ((!wsUp && t - openedAt > 20000) || silent) {
      const old = ws; ws = null; const was = wsUp; wsUp = false; subs.clear(); bySub.clear(); pendingReq.clear(); stats.subs = 0;
      try { old.close(); } catch (e) { /* closing */ }
      if (was) status(false, silent ? 'silent for 5 minutes' : 'disconnected');
      scheduleRetry(silent ? 'websocket silent, reconnecting' : 'websocket did not open');
    }
  }
  // the coins to follow: [{ m, bc }] in priority order (engine.tapePlan); at most TAPE_MAX
  function want(list) {
    watchdog();
    const next = new Map();
    for (const x of list || []) {
      if (next.size >= TAPE_MAX) break;
      if (!x || !x.bc || !x.m || next.has(x.bc)) continue;
      const mb = desired.get(x.bc) ? desired.get(x.bc).mintBytes : unb58(x.m);
      if (!mb) continue;
      next.set(x.bc, { m: x.m, bc: x.bc, mintBytes: mb });
    }
    for (const [bc, d] of [...desired.entries()]) if (!next.has(bc)) { desired.delete(bc); unsubscribe(bc, d.m); }
    for (const [bc, d] of next) if (!desired.has(bc)) { desired.set(bc, d); if (wsUp) subscribe(bc); }
    for (const m of [...last.keys()]) if (![...desired.values()].some(d => d.m === m)) last.delete(m);
    maintain();
  }
  // replace a dead socket, reconnect when the backoff allows (called every second and from want)
  function maintain() {
    watchdog();
    if (!ws && !closing && desired.size && now() >= retryAt) connect();
  }
  // the same curves over HTTP every 2 s (at once after a (re)subscription): fills any gap in the logs, keeps the exact
  // curve state fresh while the socket is down, and reports completion
  let polling = false, lastPollAt = -Infinity, pollSoon = false;
  const doneSent = new Set();
  async function poll() {
    if (polling || !fetchImpl || !desired.size) return;
    if (!pollSoon && now() - lastPollAt < 1900) return;
    pollSoon = false; lastPollAt = now();
    polling = true;
    try {
      const ds = [...desired.values()];
      for (let i = 0; i < ds.length; i += 100) {
        const batch = ds.slice(i, i + 100);
        let j = null;
        try {
          const r = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(8000),
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getMultipleAccounts', params: [batch.map(d => d.bc), { encoding: 'base64', commitment: 'processed' }] }) });
          if (r.status !== 200) { stats.pollFails++; continue; }
          j = await r.json();
        } catch (e) { stats.pollFails++; continue; }
        stats.polls++;
        const vals = j && j.result && Array.isArray(j.result.value) ? j.result.value : null, slot = j && j.result && j.result.context ? j.result.context.slot : null;
        if (!vals) { stats.pollFails++; continue; }
        const at = now();
        vals.forEach((v, k) => {
          const d = batch[k]; if (!d || !desired.has(d.bc) || !v || v.owner !== PUMP || !v.data) return;
          const c = decodeCurve(v.data[0]); if (!c || !(c.vSol > 0) || !(c.vTok > 0)) return;
          const vs = uSol(c.vSol), vt = tok(c.vTok);
          if (!newer(d.m, slot, vs, vt) && !(c.done && !doneSent.has(d.m))) return;
          if (c.done) doneSent.add(d.m);
          stats.curves++;
          const ev = { type: 'curve', at, m: d.m, slot, vs, vt, rs: uSol(c.rSol), rt: tok(c.rTok), done: c.done, src: 'poll' };
          if (!crSent.has(d.m) && c.creator) { ev.cr = short(c.creator); crSent.add(d.m); }
          ingest(ev);
        });
      }
    } finally { polling = false; }
  }
  function start(L, plan) {
    if (!WSImpl && !fetchImpl) { log('tape: no WebSocket or fetch available, lane off'); return; }
    L(async () => { want(plan()); }, 3000, 'v11-tape');
    L(async () => { maintain(); await poll(); }, 1000, 'v11-curve');
  }
  function stop() { closing = true; try { if (ws) ws.close(); } catch (e) { /* closing */ } }
  return { want, poll, maintain, start, stop, stats, desired };
}

module.exports = { createTape, decodeTrade, decodeComplete, decodeCurve, b58, unb58, PUMP, RPC_URL, TAPE_MAX, VIRT_TOKENS, D_TRADE, D_COMPLETE };
