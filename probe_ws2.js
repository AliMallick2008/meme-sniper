'use strict';
/* Probe 2 (read-only, from a GitHub runner): can the public Solana RPC give a real-time tape for the coins we follow?
   1) 8 s of pump.fun program logs: decode TradeEvent/CreateEvent ("Program data:"), find the most active mints.
   2) Their bonding curves (DexScreener pairAddress), then for 60 s: accountSubscribe, logsSubscribe per curve,
      and HTTP getMultipleAccounts every second. Compare what each path sees and when.
   Paper only: no keys, no wallets, no transactions. */
const crypto = require('crypto');
const RPC = process.env.RPC || 'https://api.mainnet-beta.solana.com';
const WS = RPC.replace(/^http/, 'ws');
const PUMP = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const RUN_S = +(process.env.RUN_S || 60), FIRE_S = +(process.env.FIRE_S || 8), NCOIN = +(process.env.NCOIN || 8);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const out = { at: new Date().toISOString(), rpc: RPC };

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58(buf) {
  let n = BigInt('0x' + (buf.toString('hex') || '0')), s = '';
  while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
  for (const b of buf) { if (b === 0) s = '1' + s; else break; }
  return s;
}
const disc = n => crypto.createHash('sha256').update('event:' + n).digest().subarray(0, 8).toString('hex');
const D = { [disc('TradeEvent')]: 'trade', [disc('CreateEvent')]: 'create', [disc('CompleteEvent')]: 'complete', [disc('CreateEventV2')]: 'createV2' };
function readStr(b, o) { const n = b.readUInt32LE(o); return [b.subarray(o + 4, o + 4 + n).toString('utf8'), o + 4 + n]; }
function decode(b64) {
  const b = Buffer.from(b64, 'base64'); if (b.length < 8) return null;
  const kind = D[b.subarray(0, 8).toString('hex')]; if (!kind) return { kind: 'other', d: b.subarray(0, 8).toString('hex'), len: b.length };
  try {
    if (kind === 'trade') {
      let o = 8; const pk = () => { const v = b58(b.subarray(o, o + 32)); o += 32; return v; }, u64 = () => { const v = b.readBigUInt64LE(o); o += 8; return Number(v); }, i64 = () => { const v = b.readBigInt64LE(o); o += 8; return Number(v); };
      const e = { kind, len: b.length, mint: pk(), sol: u64(), tok: u64(), buy: b[o++] === 1, user: pk(), ts: i64(), vSol: u64(), vTok: u64(), rSol: u64(), rTok: u64(), feeRecipient: pk(), feeBps: u64(), fee: u64() };
      if (b.length >= o + 48) { e.creator = pk(); e.creatorFeeBps = u64(); e.creatorFee = u64(); }
      e.rest = b.length - o;
      return e;
    }
    if (kind === 'create' || kind === 'createV2') {
      let o = 8; let name, sym, uri; [name, o] = readStr(b, o); [sym, o] = readStr(b, o); [uri, o] = readStr(b, o);
      const pk = () => { const v = b58(b.subarray(o, o + 32)); o += 32; return v; };
      return { kind, len: b.length, name: name.slice(0, 32), sym: sym.slice(0, 16), mint: pk(), bondingCurve: pk(), user: pk(), rest: b.length - o };
    }
    return { kind, len: b.length };
  } catch (e) { return { kind, err: String(e.message || e), len: b.length }; }
}
function curve(b64) {
  const b = Buffer.from(b64, 'base64'); if (b.length < 49) return null;
  const u = o => Number(b.readBigUInt64LE(o));
  return { vTok: u(8), vSol: u(16), rTok: u(24), rSol: u(32), complete: b[48] === 1 };
}
function wsOpen() {
  return new Promise((res, rej) => { const ws = new WebSocket(WS); ws.onopen = () => res(ws); ws.onerror = e => rej(new Error('ws error')); setTimeout(() => rej(new Error('ws open timeout')), 15000); });
}
async function rpc(method, params) {
  const t = Date.now();
  const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(10000) });
  const j = await r.json().catch(() => null);
  return { http: r.status, ms: Date.now() - t, j };
}

(async () => {
  // 1) the program firehose for a few seconds: which mints trade the most, and does the decoder hold up?
  const F = { n: 0, failedTx: 0, events: {}, others: {}, trades: 0, creates: 0, perMint: {}, sample: [], restLens: {} };
  try {
    const ws = await wsOpen();
    let subId = null;
    ws.onmessage = ev => {
      const j = JSON.parse(ev.data);
      if (j.id === 1) { subId = j.result; return; }
      const v = j.params && j.params.result && j.params.result.value; if (!v) return;
      F.n++; if (v.err) { F.failedTx++; return; }
      let inPump = false;
      for (const l of v.logs || []) {
        if (l.startsWith('Program ' + PUMP + ' invoke')) inPump = true;
        if (!l.startsWith('Program data: ')) continue;
        const e = decode(l.slice(14));
        if (!e) continue;
        F.events[e.kind] = (F.events[e.kind] || 0) + 1;
        if (e.kind === 'other') { F.others[e.d] = (F.others[e.d] || 0) + 1; continue; }
        if (e.kind === 'trade') { F.trades++; F.perMint[e.mint] = (F.perMint[e.mint] || 0) + 1; F.restLens[e.rest] = (F.restLens[e.rest] || 0) + 1; if (F.sample.length < 3) F.sample.push(e); }
        if (e.kind === 'create' || e.kind === 'createV2') { F.creates++; if (F.sample.length < 5) F.sample.push(e); }
      }
    };
    ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'logsSubscribe', params: [{ mentions: [PUMP] }, { commitment: 'processed' }] }));
    await sleep(FIRE_S * 1000);
    ws.close();
  } catch (e) { F.error = String(e.message || e); }
  F.distinctMints = Object.keys(F.perMint).length;
  const top = Object.entries(F.perMint).sort((a, b) => b[1] - a[1]).slice(0, 25);
  F.top = top.slice(0, 12);
  delete F.perMint;
  out.fire = F;

  // 2) bonding curves of the most active mints (DexScreener pairAddress for the pumpfun pair)
  const coins = [];
  try {
    const r = await fetch('https://api.dexscreener.com/tokens/v1/solana/' + top.map(x => x[0]).join(','), { signal: AbortSignal.timeout(15000) });
    const pairs = await r.json();
    for (const [m, n] of top) {
      const p = (pairs || []).find(p => p && p.baseToken && p.baseToken.address === m && p.dexId === 'pumpfun');
      if (p && coins.length < NCOIN) coins.push({ m, sym: p.baseToken.symbol, fireTrades: n, bc: p.pairAddress, mc: p.marketCap });
    }
  } catch (e) { out.dexError = String(e.message || e); }
  out.coins = coins;
  if (!coins.length) { console.log(JSON.stringify(out, null, 1)); process.exit(0); }

  // 3) three ways to follow them for RUN_S seconds
  const S = {}; for (const c of coins) S[c.bc] = { sym: c.sym, acctN: 0, acctChanges: 0, logsN: 0, logsFailed: 0, trades: 0, tradeMintMismatch: 0, httpChanges: 0, firstAcctAt: null, lastVSol: null, httpLastVSol: null, wsLastVSol: null, lagSamples: [] };
  const bySub = {};
  const t0 = Date.now();
  const ws = await wsOpen().catch(e => { out.wsError = String(e.message || e); return null; });
  const seenByWs = new Map();   // vSol value -> first time seen on the account stream (per curve)
  const H = { calls: 0, errs: 0, http: {}, ms: [] };
  if (ws) {
    let id = 100; const pend = {};
    ws.onmessage = ev => {
      const j = JSON.parse(ev.data);
      if (j.id && pend[j.id]) { if (j.error) (out.subErrors = out.subErrors || []).push(JSON.stringify(j.error).slice(0, 150)); else bySub[j.result] = pend[j.id]; return; }
      const p = j.params; if (!p) return; const tag = bySub[p.subscription]; if (!tag) return;
      const s = S[tag.bc], now = Date.now() - t0;
      if (tag.kind === 'acct') {
        s.acctN++; const v = p.result.value && p.result.value.data ? curve(p.result.value.data[0]) : null;
        if (v && v.vSol !== s.wsLastVSol) { s.acctChanges++; s.wsLastVSol = v.vSol; const k = tag.bc + ':' + v.vSol; if (!seenByWs.has(k)) seenByWs.set(k, now); }
      } else {
        const v = p.result.value; s.logsN++; if (v.err) { s.logsFailed++; return; }
        for (const l of v.logs || []) if (l.startsWith('Program data: ')) { const e = decode(l.slice(14)); if (e && e.kind === 'trade') { s.trades++; const c = coins.find(c => c.bc === tag.bc); if (c && e.mint !== c.m) s.tradeMintMismatch++; if (!s.tradeSample) s.tradeSample = { buy: e.buy, sol: e.sol / 1e9, user: e.user.slice(0, 6), vSol: e.vSol, atS: now / 1000, ts: e.ts }; } }
      }
    };
    for (const c of coins) {
      pend[++id] = { kind: 'acct', bc: c.bc }; ws.send(JSON.stringify({ jsonrpc: '2.0', id, method: 'accountSubscribe', params: [c.bc, { encoding: 'base64', commitment: 'processed' }] }));
      pend[++id] = { kind: 'logs', bc: c.bc }; ws.send(JSON.stringify({ jsonrpc: '2.0', id, method: 'logsSubscribe', params: [{ mentions: [c.bc] }, { commitment: 'processed' }] }));
    }
  }
  // HTTP polling every second, in parallel with the websocket
  while (Date.now() - t0 < RUN_S * 1000) {
    const t1 = Date.now();
    try {
      const r = await rpc('getMultipleAccounts', [coins.map(c => c.bc), { encoding: 'base64', commitment: 'processed' }]);
      H.calls++; H.http[r.http] = (H.http[r.http] || 0) + 1; H.ms.push(r.ms);
      const vals = r.j && r.j.result && r.j.result.value;
      if (vals) vals.forEach((v, i) => {
        const s = S[coins[i].bc]; const cv = v && v.data ? curve(v.data[0]) : null; if (!cv) return;
        if (cv.vSol !== s.httpLastVSol) {
          s.httpChanges++; s.httpLastVSol = cv.vSol;
          const k = coins[i].bc + ':' + cv.vSol, w = seenByWs.get(k);
          if (w != null && s.lagSamples.length < 30) s.lagSamples.push(Date.now() - t0 - w);   // how much later polling saw the same state
        }
      });
    } catch (e) { H.errs++; }
    await sleep(Math.max(0, 1000 - (Date.now() - t1)));
  }
  if (ws) ws.close();
  H.ms.sort((a, b) => a - b); H.msP50 = H.ms[H.ms.length >> 1]; H.msP90 = H.ms[Math.floor(H.ms.length * 0.9)]; delete H.ms;
  out.http = H;
  for (const s of Object.values(S)) { const l = s.lagSamples.sort((a, b) => a - b); s.lagP50 = l[l.length >> 1]; s.lagMax = l[l.length - 1]; delete s.lagSamples; }
  out.follow = S;
  console.log(JSON.stringify(out, null, 1));
  process.exit(0);
})();
