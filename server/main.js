'use strict';
/* The server loop shared by GitHub Actions (run.js) and the simulator (sim.js): loads the journal, runs the same bot
   core as the page (sniper_core.js) for runS seconds, saves the state every couple of minutes and records research
   data, then hands over to the next run. Paper only: no wallet, no keys, no orders. */
const E = require('./sniper.js');
const CORE = require('./sniper_core.js');
const RESEARCH = require('./research.js');
const VERSION = '10.1';

/* o: { clock: { now(), sleep(ms) }, http(url) -> { status, json }, store: { load(), save(snapshot), putResearch(path, buf) },
        runS, log(text), info: { run, sha }, saveEvery (ms), handover(why), checkUpdate() -> bool, shouldStop() -> bool } */
async function runServer(o) {
  const { clock, store, log } = o;
  const nowMs = () => clock.now();
  const started = nowMs(), deadline = started + o.runS * 1000;
  const saveEvery = o.saveEvery || 120000;
  let dirty = true, urgent = false, lastSave = 0, saving = null, lastUpd = started, lastLog = started, research = null;
  const core = CORE.create({
    now: () => clock.now(), sleep: ms => clock.sleep(ms), http: o.http,
    save: force => { dirty = true; if (force) urgent = true; },
    dirty: () => { dirty = true; },
    gapText: a => `The bot server was offline for ${a}. Coins the bots held or watched are caught up from their 1-minute candles; launches in that time were not scanned.`,
    onDecide: k => { if (research) research.add(k); },
    gtIdle: () => research ? research.idle() : Promise.resolve(false),
  });
  research = RESEARCH.create({ core, E, clock, log, put: store.putResearch, run: o.info.run });

  const st = await store.load();
  if (st) {
    const J = st.state.J; J.tc = st.tc || {};
    core.setJ(J); core.youngIn(st.young); research.load(st.rq);
    log(`loaded the journal: started ${new Date(J.start * 1000).toISOString()}, ${tradeCount()} trades, ${core.M.young.size} coins followed, ${research.queued()} research coins queued`);
  } else log('no saved journal: fresh start with 10 paper SOL per bot');
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

  let why = 'time';
  for (;;) {
    await clock.sleep(5000);
    const t = nowMs();
    if (t >= deadline) break;
    if (o.shouldStop && o.shouldStop()) { why = 'signal'; break; }
    if ((urgent && t - lastSave >= 15000) || (dirty && t - lastSave >= saveEvery) || t - lastSave >= 300000) await persist();
    await research.maybeFlush(false);
    if (o.checkUpdate && t - lastUpd >= 300000) { lastUpd = t; if (await o.checkUpdate()) { why = 'update'; break; } }
    if (t - lastLog >= 3600000) { lastLog = t; log(summary()); }
  }
  log(`stopping (${why})`);
  core.stop();
  await clock.sleep(3000);            // let calls in flight finish
  if (o.handover) { try { await o.handover(why); } catch (e) { log('handover: ' + (e.message || e)); } }
  await persist();
  await research.maybeFlush(true);
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
        await store.save({ state: { v: 1, srv: srvInfo(), J: rest }, young: core.youngOut(), rq: research.out(), tc });
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
      Object.entries(l).map(([k, x]) => `${k} ${x.ok}/${x.fail}${x.limited ? ' 429x' + x.limited : ''}`).join(', ') + ` | research ${JSON.stringify(research.stats())}`;
  }
}
module.exports = { runServer, VERSION };
