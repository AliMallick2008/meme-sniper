'use strict';
/* Test entry: the same server loop on a virtual clock, against a mock market that the test harness serves over HTTP
   (every request carries the virtual time). State lives in a local folder, so a run can stop and the next one resume.
   node server/sim.js --port P --t0 SECONDS --until SECONDS --dir FOLDER --run NAME */
const fs = require('fs'), path = require('path'), http = require('http');
const { runServer } = require('./main.js');
const arg = k => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : null; };
const PORT = +arg('port'), T0 = +arg('t0'), UNTIL = +arg('until'), DIR = arg('dir'), RUN = arg('run') || 'sim';

const clock = { t: T0 * 1000, timers: [], seq: 0, inflight: 0 };
clock.now = () => clock.t;
clock.sleep = ms => new Promise(res => clock.timers.push({ at: clock.t + Math.max(0, ms || 0), seq: clock.seq++, res }));
const agent = new http.Agent({ keepAlive: true, maxSockets: 8 });
// every call takes 150 ms of virtual time, like a real network round trip
async function bridge(url) { const r = await bridgeNow(url); await clock.sleep(150); return r; }
function bridgeNow(url) {
  clock.inflight++;
  const body = JSON.stringify({ url, now: clock.t / 1000 });
  return new Promise((res, rej) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, method: 'POST', path: '/', agent, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, r => {
      const chunks = [];
      r.on('data', c => chunks.push(c));
      r.on('end', () => { clock.inflight--; try { const o = JSON.parse(Buffer.concat(chunks).toString()); res({ status: o.status, json: o.status >= 200 && o.status < 300 ? o.json : null }); } catch (e) { rej(e); } });
    });
    req.on('error', e => { clock.inflight--; rej(e); });
    req.end(body);
  });
}
const sizes = { state: 0, young: 0, rq: 0, saves: 0 };
const rd = f => { try { return JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')); } catch (e) { return null; } };
const store = {
  async load() {
    const state = rd('state.json'); if (!state) return null;
    const tc = {}, td = path.join(DIR, 'tc');
    if (fs.existsSync(td)) for (const f of fs.readdirSync(td)) tc[f.replace(/\.json$/, '')] = rd('tc/' + f);
    return { state, young: rd('young.json') || [], rq: rd('rq.json') || [], tc, extra: { 'v11.json': rd('v11.json') } };
  },
  async save({ state, young, rq, tc, extra }) {
    const s = [JSON.stringify(state), JSON.stringify(young), JSON.stringify(rq)];
    for (const [f, obj] of Object.entries(extra || {})) if (obj) { const x = JSON.stringify(obj); fs.writeFileSync(path.join(DIR, f), x); sizes[f] = Math.max(sizes[f] || 0, x.length); }
    fs.mkdirSync(path.join(DIR, 'tc'), { recursive: true });
    fs.writeFileSync(path.join(DIR, 'state.json'), s[0]); fs.writeFileSync(path.join(DIR, 'young.json'), s[1]); fs.writeFileSync(path.join(DIR, 'rq.json'), s[2]);
    for (const [m, v] of Object.entries(tc || {})) fs.writeFileSync(path.join(DIR, 'tc', m + '.json'), JSON.stringify(v));
    for (const f of fs.readdirSync(path.join(DIR, 'tc'))) if (!(tc || {})[f.replace(/\.json$/, '')]) fs.unlinkSync(path.join(DIR, 'tc', f));
    sizes.state = Math.max(sizes.state, s[0].length); sizes.young = Math.max(sizes.young, s[1].length); sizes.rq = Math.max(sizes.rq, s[2].length); sizes.saves++;
    await clock.sleep(1500);   // a git push takes a moment
  },
  async putResearch(p, buf) { const f = path.join(DIR, p); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, buf); await clock.sleep(800); },
};
const logs = [];
(async () => {
  fs.mkdirSync(DIR, { recursive: true });
  let done = false, out = null, err = null;
  // the tape lane reads the real Solana RPC on the real clock, so the simulator runs without it (its own tests cover it)
  runServer({ clock, http: bridge, store, runS: UNTIL - T0, log: s => logs.push(`${new Date(clock.t).toISOString()} ${s}`), info: { run: RUN, sha: 'sim' }, tape: false })
    .then(r => { done = true; out = r; }, e => { done = true; err = e; });
  const tick = () => new Promise(r => setImmediate(r));
  let pops = 0;
  while (!done) {
    for (let idle = 0; idle < 3;) { await tick(); if (clock.inflight > 0) { idle = 0; await new Promise(r => setTimeout(r, 0)); } else idle++; }
    if (done) break;
    if (!clock.timers.length) { err = new Error('nothing scheduled: the loop stalled'); break; }
    let k = 0; for (let i = 1; i < clock.timers.length; i++) { const a = clock.timers[i], b = clock.timers[k]; if (a.at < b.at || (a.at === b.at && a.seq < b.seq)) k = i; }
    const nx = clock.timers.splice(k, 1)[0];
    clock.t = Math.max(clock.t, nx.at); pops++;
    nx.res();
  }
  const J = out ? out.core.J() : null;
  fs.writeFileSync(path.join(DIR, `sim_out_${RUN}.json`), JSON.stringify({ now: clock.t / 1000, J, research: out && out.research.stats(), v11: rd('v11.json'), lanes: out && Object.fromEntries(Object.entries(out.core.LANES).map(([k, L]) => [k, [L.ok, L.fail, L.limited, L.lastErr]])), errors: out && out.core.M.errors, sizes, pops, logs }));
  if (err) { console.error(String(err && err.stack || err)); process.exit(1); }
  console.log(logs.slice(-3).join('\n'));
  process.exit(0);
})();
