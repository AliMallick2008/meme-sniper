'use strict';
/* Read-only probe of public Solana RPC endpoints from a GitHub runner (the bots' network): HTTP reads and websocket
   subscriptions (slot, pump.fun bonding-curve accounts of coins the server follows, pump.fun program logs).
   Paper only: no keys, no wallets, no transactions. Prints one JSON report. */
const PUMP = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const RPCS = (process.env.RPCS || 'https://api.mainnet-beta.solana.com https://solana-rpc.publicnode.com').split(/\s+/).filter(Boolean);
const ACCT_S = +(process.env.ACCT_S || 60), LOGS_S = +(process.env.LOGS_S || 15);
const out = { at: new Date().toISOString(), node: process.version, ws: typeof WebSocket, coins: [], rpcs: {} };
const sleep = ms => new Promise(r => setTimeout(r, ms));

function curve(b64) {
  const b = Buffer.from(b64, 'base64');
  if (b.length < 49) return { len: b.length };
  const u = o => Number(b.readBigUInt64LE(o));
  const vTok = u(8), vSol = u(16);
  return { len: b.length, vTok, vSol, rTok: u(24), rSol: u(32), supply: u(40), complete: b[48] === 1, pxSol: vTok ? (vSol / 1e9) / (vTok / 1e6) : null };
}

async function rpc(url, method, params) {
  const t = Date.now();
  try {
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(15000) });
    const txt = await r.text();
    let j = null; try { j = JSON.parse(txt); } catch (e) { /* not json */ }
    return { http: r.status, ms: Date.now() - t, result: j && j.result, error: j ? j.error : txt.slice(0, 300) };
  } catch (e) { return { http: 0, ms: Date.now() - t, error: String(e.message || e) }; }
}

function wsProbe(url, coins) {
  const wsUrl = url.replace(/^http/, 'ws');
  return new Promise(resolve => {
    const R = { url: wsUrl, open: false, errors: [], slot: { n: 0 }, acct: { subs: 0, n: 0, perCoin: {}, samples: [], gapsMs: [] }, logs: { n: 0, bytes: 0, withData: 0, errs: 0 } };
    let ws;
    try { ws = new WebSocket(wsUrl); } catch (e) { R.errors.push('ctor ' + (e.message || e)); return resolve(R); }
    const subs = {}; let id = 10; const t0 = Date.now(); const lastAt = {};
    const send = (method, params, tag) => { const i = ++id; subs[i] = tag; ws.send(JSON.stringify({ jsonrpc: '2.0', id: i, method, params })); return i; };
    const subTag = {};
    ws.onopen = async () => {
      R.open = true; R.openMs = Date.now() - t0;
      send('slotSubscribe', [], 'slot');
      for (const c of coins) send('accountSubscribe', [c.bc, { encoding: 'base64', commitment: 'processed' }], 'acct:' + c.sym);
      await sleep(5000);
      const lid = send('logsSubscribe', [{ mentions: [PUMP] }, { commitment: 'processed' }], 'logs');
      await sleep(LOGS_S * 1000);
      for (const [s, tag] of Object.entries(subTag)) if (tag === 'logs') ws.send(JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'logsUnsubscribe', params: [+s] }));
      for (const [s, tag] of Object.entries(subTag)) if (tag === 'slot') ws.send(JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'slotUnsubscribe', params: [+s] }));
      await sleep(Math.max(0, ACCT_S * 1000 - (Date.now() - t0)));
      R.elapsedS = Math.round((Date.now() - t0) / 1000);
      try { ws.close(); } catch (e) { /* closing */ }
      resolve(R);
    };
    ws.onerror = e => { R.errors.push('error ' + (e && e.message || 'ws error')); if (!R.open) resolve(R); };
    setTimeout(() => { R.timedOut = true; try { ws.close(); } catch (e) { /* closing */ } resolve(R); }, (ACCT_S + 30) * 1000);
    ws.onclose = e => { R.closed = { code: e.code, reason: String(e.reason || '').slice(0, 200), atS: Math.round((Date.now() - t0) / 1000) }; if (!R.open) resolve(R); };
    ws.onmessage = ev => {
      let j; try { j = JSON.parse(ev.data); } catch (e) { return; }
      if (j.id && subs[j.id]) {
        const tag = subs[j.id];
        if (j.error) R.errors.push(tag + ': ' + JSON.stringify(j.error).slice(0, 200));
        else if (typeof j.result === 'number') { subTag[j.result] = tag.startsWith('acct') ? 'acct' : tag; if (tag.startsWith('acct')) { R.acct.subs++; subTag[j.result] = tag; } }
        return;
      }
      const p = j.params; if (!p) return;
      const tag = subTag[p.subscription] || '?';
      if (j.method === 'slotNotification') R.slot.n++;
      else if (j.method === 'logsNotification') {
        R.logs.n++; R.logs.bytes += String(ev.data).length;
        const v = p.result && p.result.value; if (v && v.err) R.logs.errs++;
        if (v && v.logs && v.logs.some(l => l.startsWith('Program data: '))) R.logs.withData++;
      } else if (j.method === 'accountNotification') {
        R.acct.n++; R.acct.perCoin[tag] = (R.acct.perCoin[tag] || 0) + 1;
        const now = Date.now(); if (lastAt[tag]) R.acct.gapsMs.push(now - lastAt[tag]); lastAt[tag] = now;
        const v = p.result && p.result.value;
        if (R.acct.samples.length < 6 && v && v.data) R.acct.samples.push({ tag, slot: p.result.context.slot, atS: Math.round((now - t0) / 100) / 10, ...curve(v.data[0]) });
      }
    };
  });
}

(async () => {
  // coins the server follows right now (young.json on the data branch: [m, sym, name, icon, t, mc, max, quote, bc, pool, seen, links])
  try {
    const r = await fetch('https://raw.githubusercontent.com/AliMallick2008/meme-sniper/data/young.json', { signal: AbortSignal.timeout(15000) });
    const y = await r.json();
    out.youngCount = y.length;
    out.coins = y.filter(x => x[8] && !x[9] && x[7] === 'SOL').sort((a, b) => b[5] - a[5]).slice(0, 6).map(x => ({ m: x[0], sym: x[1], mc: x[5], bc: x[8] }));
  } catch (e) { out.coinsError = String(e.message || e); }
  await Promise.all(RPCS.map(async url => {
    const R = { http: {} };
    R.http.getVersion = await rpc(url, 'getVersion', []);
    R.http.getSlot = await rpc(url, 'getSlot', [{ commitment: 'processed' }]);
    if (out.coins[0]) {
      const a = await rpc(url, 'getAccountInfo', [out.coins[0].bc, { encoding: 'base64', commitment: 'processed' }]);
      const v = a.result && a.result.value;
      R.http.getAccountInfo = { http: a.http, ms: a.ms, error: a.error, owner: v && v.owner, curve: v && v.data ? curve(v.data[0]) : null };
    }
    const m = await rpc(url, 'getMultipleAccounts', [out.coins.map(c => c.bc), { encoding: 'base64', commitment: 'processed' }]);
    R.http.getMultipleAccounts = { http: m.http, ms: m.ms, error: m.error, n: m.result && m.result.value ? m.result.value.filter(Boolean).length : null };
    R.ws = out.ws === 'function' ? await wsProbe(url, out.coins) : 'no WebSocket';
    out.rpcs[url] = R;
  }));
  console.log(JSON.stringify(out, null, 1));
  process.exit(0);
})();
