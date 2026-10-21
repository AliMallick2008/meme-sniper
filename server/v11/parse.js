'use strict';
/* API responses -> v11 events (audit Findings 09, 10, 20 and test T20). Every event carries `at` (when the response was
   received) and `req` (when the request was sent), so a decision can only use what had arrived by its time. A field with
   an unexpected type never becomes a pass: it is `null` (unknown) and the event lists it under `bad`; a response whose
   shape is wrong becomes one `schema` event with the reason, and nothing else. */
const ADDR = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const okAddr = a => typeof a === 'string' && ADDR.test(a);
const num = v => (typeof v === 'number' && isFinite(v)) ? v : (typeof v === 'string' && v.trim() !== '' && isFinite(+v)) ? +v : null;
const bool = v => typeof v === 'boolean' ? v : null;
const str = (v, n = 64) => typeof v === 'string' ? v.slice(0, n) : null;
const iso = v => { const t = typeof v === 'string' ? Date.parse(v) : NaN; return isFinite(t) ? t / 1000 : null; };

/* One field: value if it has the expected type, else null, and a note in `bad` when it was present with another type. */
function field(o, k, conv, bad, where) {
  if (!o || o[k] === undefined || o[k] === null) return null;
  const v = conv(o[k]);
  if (v === null) bad.push(`${where}${k}`);
  return v;
}
function stats(s, bad, w) {
  if (s == null) return null;
  if (typeof s !== 'object') { bad.push(w); return null; }
  const f = k => field(s, k, num, bad, w + '.');
  return { bv: f('buyVolume'), sv: f('sellVolume'), nb: f('numBuys'), ns: f('numSells'), nt: f('numTraders'), nnb: f('numNetBuyers'),
    hc: f('holderChange'), pc: f('priceChange'), lc: f('liquidityChange'), vc: f('volumeChange'), org: f('numOrganicBuyers') };
}
/* Jupiter tokens v2 token object (search, recent). */
function jupToken(x) {
  const bad = [];
  if (!x || typeof x !== 'object' || !okAddr(x.id)) return null;
  const a = x.audit;
  let audit;
  if (a == null) audit = { missing: true };
  else if (typeof a !== 'object') { bad.push('audit'); audit = { missing: true, invalid: true }; }
  else audit = {
    mintOff: field(a, 'mintAuthorityDisabled', bool, bad, 'audit.'), freezeOff: field(a, 'freezeAuthorityDisabled', bool, bad, 'audit.'),
    dev: field(a, 'devBalancePercentage', num, bad, 'audit.'), top: field(a, 'topHoldersPercentage', num, bad, 'audit.'),
    devMints: field(a, 'devMints', num, bad, 'audit.'),
  };
  const tw = str(x.twitter, 200), web = str(x.website, 200), tg = str(x.telegram, 200);
  return {
    m: x.id, sym: str(x.symbol, 24) || '', name: str(x.name, 48) || '', launchpad: str(x.launchpad, 24),
    t0: iso((x.firstPool && x.firstPool.createdAt) || x.createdAt), dec: field(x, 'decimals', num, bad, ''),
    usd: field(x, 'usdPrice', num, bad, ''), mc: field(x, 'mcap', num, bad, ''), liq: field(x, 'liquidity', num, bad, ''),
    holders: field(x, 'holderCount', num, bad, ''), org: field(x, 'organicScore', num, bad, ''), srcAt: iso(x.updatedAt),
    audit, s5: stats(x.stats5m, bad, 'stats5m'), s1h: stats(x.stats1h, bad, 'stats1h'),
    claims: { tw, web, tg }, dev: str(x.dev, 64), bad,
  };
}
/* DexScreener tokens/v1 pairs -> per-mint observation of its pump.fun curve pair and PumpSwap pool. */
function dexPairs(arr) {
  const by = new Map();
  for (const p of arr) {
    if (!p || typeof p !== 'object' || !p.baseToken || !okAddr(p.baseToken.address)) continue;
    if (p.dexId !== 'pumpfun' && p.dexId !== 'pumpswap') continue;
    const bad = [], w = p.dexId + '.';
    const liq = p.liquidity && typeof p.liquidity === 'object' ? { usd: field(p.liquidity, 'usd', num, bad, w + 'liquidity.'), base: field(p.liquidity, 'base', num, bad, w + 'liquidity.'), quote: field(p.liquidity, 'quote', num, bad, w + 'liquidity.') } : null;
    const tx = p.txns && p.txns.m5 && typeof p.txns.m5 === 'object' ? p.txns.m5 : null;
    const o = {
      dex: p.dexId, pair: okAddr(p.pairAddress) ? p.pairAddress : null, quote: str(p.quoteToken && p.quoteToken.symbol, 12),
      usd: field(p, 'priceUsd', num, bad, w), native: field(p, 'priceNative', num, bad, w), mc: num(p.marketCap) != null ? num(p.marketCap) : num(p.fdv),
      liq, b5: tx ? field(tx, 'buys', num, bad, w + 'm5.') : null, s5: tx ? field(tx, 'sells', num, bad, w + 'm5.') : null,
      v5: p.volume && typeof p.volume === 'object' ? field(p.volume, 'm5', num, bad, w + 'volume.') : null,
      claims: p.info && typeof p.info === 'object' ? {
        socials: (Array.isArray(p.info.socials) ? p.info.socials : []).slice(0, 6).map(s => [str(s && s.type, 16), str(s && s.url, 200)]),
        webs: (Array.isArray(p.info.websites) ? p.info.websites : []).slice(0, 4).map(s => str(s && s.url, 200)),
      } : null,
      sym: str(p.baseToken.symbol, 24), name: str(p.baseToken.name, 48), created: num(p.pairCreatedAt) > 0 ? num(p.pairCreatedAt) / 1000 : null, bad,
    };
    if (o.usd != null && !(o.usd > 0)) { o.bad.push(w + 'priceUsd'); o.usd = null; }
    const m = p.baseToken.address;
    if (!by.has(m)) by.set(m, []);
    by.get(m).push(o);
  }
  return by;
}
/* Jupiter swap quote (paper only: a quote is a price for an exact size; nothing is ever signed or sent). */
function quote(u, status, j) {
  const q = u.searchParams, inMint = q.get('inputMint'), outMint = q.get('outputMint'), amount = q.get('amount');
  const base = { inMint, outMint, amount: amount != null ? +amount : null };
  if (status === 429) return Object.assign(base, { ok: false, why: 'rate limited', retry: true });
  if (status < 200 || status >= 300 || !j) return Object.assign(base, { ok: false, why: status === 400 ? 'no route' : 'HTTP ' + status, retry: status !== 400 });
  if (typeof j !== 'object') return Object.assign(base, { ok: false, why: 'schema: not an object', schema: true });
  const out = num(j.outAmount), inA = num(j.inAmount), imp = num(j.priceImpactPct);
  if (!(out > 0) || !(inA > 0)) return Object.assign(base, { ok: false, why: 'schema: outAmount/inAmount', schema: true });
  const labels = (Array.isArray(j.routePlan) ? j.routePlan : []).map(r => str(r && r.swapInfo && r.swapInfo.label, 40)).filter(Boolean);
  return Object.assign(base, { ok: true, inAmount: inA, outAmount: out, impact: imp != null ? Math.abs(imp) : null, labels, slot: num(j.contextSlot) });
}

/* url, response { status, json }, request and receipt times (seconds) -> { events, errors } */
function parse(url, res, req, at) {
  const out = { events: [], errors: [] };
  let u; try { u = new URL(url); } catch (e) { return out; }
  const st = res ? res.status : 0, j = res ? res.json : null, h = u.hostname, p = u.pathname;
  const ev = o => out.events.push(Object.assign({ at, req }, o));
  const schema = (src, why) => { out.errors.push(`${src}: ${why}`); ev({ type: 'schema', src, why }); };
  if (h === 'lite-api.jup.ag' || h === 'api.jup.ag') {
    if (p.endsWith('/swap/v1/quote')) { ev(Object.assign({ type: 'quote' }, quote(u, st, j))); return out; }
    if (!(st >= 200 && st < 300)) return out;
    if (p.endsWith('/tokens/v2/recent')) {
      if (!Array.isArray(j)) { schema('jupiter recent', 'not a list'); return out; }
      for (const x of j) { const t = jupToken(x); if (t && t.launchpad === 'pump.fun') ev({ type: 'coin', m: t.m, sym: t.sym, name: t.name, t0: t.t0, src: 'jup' }); }
    } else if (p.endsWith('/tokens/v2/search')) {
      if (!Array.isArray(j)) { schema('jupiter search', 'not a list'); return out; }
      for (const x of j) {
        const t = jupToken(x);
        if (!t) { if (x && typeof x === 'object' && x.id) schema('jupiter search', 'token id'); continue; }
        if (t.bad.length) out.errors.push(`jupiter ${t.sym}: unexpected ${t.bad.join(', ')}`);
        ev(Object.assign({ type: 'jup' }, t));
      }
    }
    return out;
  }
  if (h === 'api.dexscreener.com') {
    const mm = p.match(/^\/tokens\/v1\/solana\/(.+)$/);
    if (!mm || !(st >= 200 && st < 300)) return out;
    if (!Array.isArray(j)) { schema('dexscreener', 'not a list'); return out; }
    for (const [m, pairs] of dexPairs(j)) {
      const bad = [].concat(...pairs.map(x => x.bad));
      if (bad.length) out.errors.push(`dexscreener ${pairs[0].sym}: unexpected ${bad.join(', ')}`);
      ev({ type: 'px', m, pairs });
    }
    return out;
  }
  if (h === 'api.rugcheck.xyz') {
    const mm = p.match(/^\/v1\/tokens\/([^/]+)\/report\/summary$/);
    if (!mm || !okAddr(mm[1])) return out;
    if (st === 404) { ev({ type: 'rc', m: mm[1], missing: true }); return out; }
    if (!(st >= 200 && st < 300)) return out;
    if (!j || typeof j !== 'object' || (j.risks != null && !Array.isArray(j.risks))) { schema('rugcheck', 'report shape'); ev({ type: 'rc', m: mm[1], missing: true, invalid: true }); return out; }
    const risks = (j.risks || []).slice(0, 20).map(r => [str(r && r.name, 60) || '', str(r && r.level, 12) || '']);
    ev({ type: 'rc', m: mm[1], score: num(j.score), sn: num(j.score_normalised), risks, danger: risks.filter(r => r[1] === 'danger').map(r => r[0]) });
    return out;
  }
  if (h === 'api.exchange.coinbase.com' && p.includes('/products/SOL-USD/')) {
    if (!(st >= 200 && st < 300)) return out;
    if (p.endsWith('/ticker')) { const px = num(j && j.price); if (px > 0) ev({ type: 'sol', px }); else schema('coinbase ticker', 'price'); }
    else if (p.endsWith('/candles')) {
      if (!Array.isArray(j)) { schema('coinbase candles', 'not a list'); return out; }
      const rows = j.filter(r => Array.isArray(r) && num(r[0]) != null && num(r[4]) > 0).map(r => [num(r[0]), num(r[4])]);
      ev({ type: 'solc', rows });
    }
    return out;
  }
  if (h === 'api.geckoterminal.com') {
    const mm = p.match(/\/networks\/solana\/pools\/([^/]+)\/ohlcv\/minute$/);
    if (!mm || !(st >= 200 && st < 300)) return out;
    const l = j && j.data && j.data.attributes && j.data.attributes.ohlcv_list;
    if (!Array.isArray(l)) { schema('geckoterminal', 'ohlcv_list'); return out; }
    const rows = l.filter(r => Array.isArray(r) && r.slice(0, 5).every(v => num(v) != null)).map(r => r.slice(0, 6).map(v => num(v) || 0));
    ev({ type: 'candles', pool: mm[1], rows });
    return out;
  }
  return out;
}
module.exports = { parse, jupToken, dexPairs, quote, okAddr, SOL_MINT };
