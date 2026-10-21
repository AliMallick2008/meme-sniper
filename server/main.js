'use strict';
/* The server loop shared by GitHub Actions (run.js) and the simulator (sim.js): loads the journal, runs the same bot
   core as the page (sniper_core.js) for runS seconds, saves the state every couple of minutes and records research
   data, then hands over to the next run. Paper only: no wallet, no keys, no orders. */
const E = require('./sniper.js');
const CORE = require('./sniper_core.js');
const RESEARCH = require('./research.js');
const V11 = require('./v11/runtime.js');
const VERSION = '10.1';

/* o: { clock: { now(), sleep(ms) }, http(url) -> { status, json }, store: { load(), save(snapshot), putResearch(path, buf) },
        runS, log(text), info: { run, sha }, saveEvery (ms), handover(why), checkUpdate() -> bool, shouldStop() -> bool } */
async function runServer(o) {
  const { clock, store, log } = o;
  const nowMs = () => clock.now();
  const started = nowMs(), deadline = started + o.runS * 1000;
  const saveEvery = o.saveEvery || 120000;
  let dirty = true, urgent = false, lastSave = 0, saving = null, lastUpd = started, lastLog = started, research = null, v11 = null;
  const core = CORE.create({
    now: () => clock.now(), sleep: ms => clock.sleep(ms), http: o.http,
    save: force => { dirty = true; if (force) urgent = true; },
    dirty: () => { dirty = true; },
    gapText: a => `The bot server was offline for ${a}. Coins the bots held or watched are caught up from their 1-minute candles; launches in that time were not scanned.`,
    onDecide: k => { if (research) research.add(k); if (v11) v11.hooks.onDecide(k); },
    gtIdle: () => research ? research.idle() : Promise.resolve(false),
    // the v11 engine (beside the legacy bots) hears about crossings and checks the moment they arrive
    onCross: (k, c, t) => { if (v11) v11.hooks.onCross(k, c, t); },
    onAudit: (k, reqAt, at, missing) => { if (v11) v11.hooks.onAudit(k, reqAt, at, missing); },
    onRugcheck: (k, reqAt, at) => { if (v11) v11.hooks.onRugcheck(k, reqAt, at); },
  });
  research = RESEARCH.create({ core, E, clock, log, put: store.putResearch, run: o.info.run });
  v11 = V11.createRuntime({ core, clock, log, store, run: o.info.run, sha: o.info.sha });

  const st = await store.load();
  if (st) {
    const J = st.state.J; J.tc = st.tc || {};
    core.setJ(J); core.youngIn(st.young); research.load(st.rq);
    log(`loaded the journal: started ${new Date(J.start * 1000).toISOString()}, ${tradeCount()} trades, ${core.M.young.size} coins followed, ${research.queued()} research coins queued`);
  } else log('no saved journal: fresh start with 10 paper SOL per bot');
  v11.load(st && st.extra ? st.extra['v11.json'] : null);
  core.resume();
  try { await core.solTicker(); } catch (e) { /* its loop retries */ }
  try { await core.bootstrap(); } catch (e) { core.note('bootstrap: ' + (e.message || e)); }

  const L = core.loopEvery;
  L(core.discover, 12000, 'discover');
  L(core.follow, 15000, 'follow');
  L(core.pricePoll, 8000, 'prices');
  L(core.solTicker, 30000, 'sol');
  L(async () => { core.schedule(); core.stepAll(); }, 4000, 'schedule');
  core.checkLoop(); core.rcLoop(); core.gtLoop();
  v11.start(L);
  // one GeckoTerminal call a minute in, so its health shows on the page before any coin passes the checks
  clock.sleep(60000).then(async () => {
    const c = [...core.M.young.values()].find(x => core.okAddr(x.bc));
    if (!c) return;
    try { const a = await core.ohlcv(c.bc); log(`GeckoTerminal check: ${a ? a.length + ' candles' : 'no data'} for ${c.sym}`); }
    catch (e) { log('GeckoTerminal check failed: ' + (e.message || e)); }
  });

  let why = 'time';
  for (;;) {
    await clock.sleep(5000);
    const t = nowMs();
    if (t >= deadline) break;
    if (o.shouldStop && o.shouldStop()) { why = 'signal'; break; }
    if (v11.urgent()) urgent = true;
    if ((urgent && t - lastSave >= 15000) || (dirty && t - lastSave >= saveEvery) || t - lastSave >= 300000) await persist();
    await research.maybeFlush(false);
    await v11.flush(false, store.putResearch);
    if (o.checkUpdate && t - lastUpd >= 300000) { lastUpd = t; if (await o.checkUpdate()) { why = 'update'; break; } }
    if (t - lastLog >= 3600000) { lastLog = t; log(summary()); }
  }
  log(`stopping (${why})`);
  core.stop();
  await clock.sleep(3000);            // let calls in flight finish
  if (o.handover) { try { await o.handover(why); } catch (e) { log('handover: ' + (e.message || e)); } }
  await persist();
  await research.maybeFlush(true);
  await v11.flush(true, store.putResearch);
  log(summary());
  return { why, core, research };

  function tradeCount() { return Object.values(core.J().bots).reduce((n, B) => n + B.trades.length, 0); }
  async function persist() {
    if (saving) { await saving; return; }
    saving = (async () => {
      const wasUrgent = urgent;
      try {
        core.prune();
        const J = core.J(), { tc, ...rest } = J;
        dirty = false; urgent = false;
        const v11state = v11.save();
        try {
          await store.save({ state: { v: 1, exp: 'legacy-v10', srv: srvInfo(), J: rest, v11: v11.view() }, young: core.youngOut(), rq: research.out(), tc,
            extra: { 'v11.json': v11state } });
        } catch (e) { v11.committed(false); throw e; }
        v11.committed(true);
        lastSave = nowMs();
      } catch (e) {
        dirty = true; urgent = urgent || wasUrgent; lastSave = nowMs() - saveEvery + 30000;
        log('save failed: ' + (e.message || e)); core.note('save: ' + (e.message || e));
      }
    })();
    try { await saving; } finally { saving = null; }
  }
  function srvInfo() {
    const lanes = {};
    for (const [k, Ln] of Object.entries(core.LANES)) lanes[k] = [Ln.ok, Ln.fail, Ln.lastErr, Ln.lastOk, Ln.lastFail, Ln.limited, Ln.gap];
    return { v: VERSION, t: nowMs(), started, ends: deadline, run: o.info.run, sha: o.info.sha, lanes, young: core.M.young.size,
      errors: core.M.errors.slice(-12), research: research.stats(), sol: core.solNow(), gtQ: core.M.gtQ.size };
  }
  function summary() {
    const J = core.J(), l = core.LANES;
    const bots = Object.entries(J.bots).map(([id, B]) => `${id} ${(10 + B.trades.reduce((s, x) => s + x.net, 0)).toFixed(3)}/${B.trades.length}${B.pos ? '+' : ''}`).join(' ');
    return `bots ${bots} | launches ${J.n.launch} crossed ${J.n.cross} passed ${J.n.pass} | following ${core.M.young.size} | api ` +
      Object.entries(l).map(([k, x]) => `${k} ${x.ok}/${x.fail}${x.limited ? ' 429x' + x.limited : ''}`).join(', ') + ` | research ${JSON.stringify(research.stats())}` +
      ` | v11 ${Object.values(v11.engine.state().accts).map(A => `${A.id} ${(A.cash + A.rent).toFixed(3)}/${A.trades.length}${A.pos ? '+' : ''}`).join(' ')} ${JSON.stringify(v11.stats)}`;
  }
}
module.exports = { runServer, VERSION };
