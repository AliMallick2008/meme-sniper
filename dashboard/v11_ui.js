/* v11 tab: the honest paper engine that runs on the server beside the legacy bots (audit Section G).
   It shows what the server saved in state.json > v11: the V2 strategies (A, B, C), the seven legacy rule sets under
   honest timing (E0), and the hold-SOL baseline. Every number comes from the server; this page computes nothing new
   except formatting. Paper only. */
const V11_UI = (() => {
  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const MINUS = '−', TZ = 'America/Toronto';
  const F = { t: new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit', second: '2-digit' }),
    dt: new Intl.DateTimeFormat('en-US', { timeZone: TZ, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) };
  const fT = ms => ms ? F.t.format(new Date(ms)) : '–', fDT = ms => ms ? F.dt.format(new Date(ms)) : '–';
  const HM = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' }), fHM = ms => HM.format(new Date(ms));
  const sol = (v, d = 3) => v == null || !isFinite(v) ? '–' : v.toFixed(d);
  const sSol = (v, d = 3) => v == null || !isFinite(v) ? '–' : (v > 0.0005 ? '+' : v < -0.0005 ? MINUS : '') + Math.abs(v).toFixed(d);
  const sPct = (v, d = 1) => v == null || !isFinite(v) ? '–' : (v > 0.00005 ? '+' : v < -0.00005 ? MINUS : '') + Math.abs(v * 100).toFixed(d) + '%';
  const cls = v => v > 1e-9 ? 'up' : v < -1e-9 ? 'down' : 'flat';
  const age = s => !isFinite(s) ? '–' : s < 60 ? Math.max(0, Math.round(s)) + 's' : s < 3600 ? Math.floor(s / 60) + 'm' : s < 86400 ? Math.floor(s / 3600) + 'h ' + String(Math.floor(s % 3600 / 60)).padStart(2, '0') + 'm' : Math.floor(s / 86400) + 'd ' + Math.floor(s % 86400 / 3600) + 'h';
  const short = m => m ? m.slice(0, 4) + '…' + m.slice(-4) : '';
  const COLOR = { A: '--c-swing', B: '--c-half', C: '--c-lev', HOLD: '--c-hold', 'E0-U': '--c-snipe', 'E0-U2': '--l1', 'E0-U30': '--l3', 'E0-T25': '--l2', 'E0-D55': '--l4', 'E0-GRN': '--l5', 'E0-STR': '--l6' };
  const cssv = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  const REASON = { tp: 'target', sl: 'stop', time: 'time limit', thesis: 'thesis broken', emergency: 'emergency', risk: 'loss limit', stagnation: 'no progress', trail: 'profit protection' };

  let S = null, J = null, srv = null, openTrade = null, chart = null, series = {}, chartKey = '', dossierFor = null;

  function onServer(full) { S = full.v11 || null; J = full.J || null; srv = full.srv || null; if (visible()) render(); }
  const visible = () => { const p = $('p-v11'); return !!p && !p.hidden; };

  // ------------------------------------------------------------------ status
  function status() {
    if (!S) return { pill: 'No data yet', kind: 'off', line: 'The server has not saved a v11 state yet.' };
    const now = Date.now(), feedAge = (now - (S.lastFeedAt || 0)) / 1000, saveAge = srv ? (now - srv.t) / 1000 : NaN;
    const stale = S.halted || feedAge > 120 || !(saveAge < 600);
    const why = S.halted ? S.halted.why : feedAge > 120 ? `no fresh market data for ${age(feedAge)}` : !(saveAge < 600) ? `the server's last save is ${age(saveAge)} old` : '';
    return { pill: stale ? 'Incomplete data' : 'Forward paper', kind: stale ? 'wait' : 'in', why,
      line: `Engine ${esc(S.v)}${S.upgradedAt ? ` · accounts since ${fDT(S.upgradedAt)} ET` : ` · running since ${fDT(S.startedAt)} ET`} · server run ${esc(S.run || '–')} · saved ${age(saveAge)} ago · newest market data ${age(feedAge)} old · ${S.gaps.length} coverage gap${S.gaps.length === 1 ? '' : 's'}` };
  }

  // ------------------------------------------------------------------ render
  function shell() {
    const root = $('v11'); if (!root || root.dataset.built) return;
    root.dataset.built = '1';
    root.innerHTML = `
      <div class="panel v11-status"><div class="ph"><div><h2>Honest engine <span class="pill" id="v11Pill">…</span></h2><p id="v11Line"></p></div></div>
        <p class="v11-note">Decisions use only data the server had received at that moment, buys and sells fill only at the next real Jupiter quote, and time the server was not running is never credited. Unknown safety data counts as unknown, never as safe. Paper money only.</p></div>
      <div class="panel"><div class="ph"><div><h2>Strategies</h2><p>Every account started with 10 paper SOL. Value counts an open position at what it would sell for now; the worst case is in brackets. Small samples prove nothing: no winner badges.</p></div></div>
        <div class="tablewrap" id="v11Accts"></div></div>
      <div class="panel"><div class="ph"><div><h2>Profit by day</h2><p>The goal is a bot that makes money every day. Each cell is the change in the account's value over that Toronto day, open positions marked at what they would sell for.</p></div></div>
        <div class="tablewrap" id="v11Days"></div></div>
      <div class="panel"><div class="ph"><div><h2>Balance over time</h2><p>Marked every 2 minutes, open positions included. Dotted: the legacy rules under honest timing (E0).</p></div></div>
        <div class="chart" id="v11Eq" style="height:260px"></div><div class="legend" id="v11EqLegend" style="margin-top:8px"></div></div>
      <div class="panel"><div class="ph"><div><h2>Open positions</h2><p>Why each one was bought, whether that reason still holds, and what would make it sell.</p></div></div><div id="v11Pos"></div></div>
      <div class="panel"><div class="ph"><div><h2>Trade audit</h2><p>Newest first. Tap a trade for its full record: what was known when, the plan, the quotes, why it sold.</p></div></div>
        <div class="tablewrap" id="v11Trades"></div><div id="v11TradeDetail"></div></div>
      <div class="two">
        <div class="panel"><div class="ph"><div><h2>What the V2 strategies looked at</h2><p>Coins in each strategy's range, and how far they got through the checks.</p></div></div><div class="tablewrap" id="v11Funnel"></div></div>
        <div class="panel"><div class="ph"><div><h2>Coverage gaps</h2><p>Times the server was not running. Nothing inside them counts.</p></div></div><div id="v11Gaps"></div></div>
      </div>
      <div class="panel" id="v11Dossier" hidden></div>`;
    root.addEventListener('click', e => {
      const tr = e.target.closest('tr[data-trade]'); if (tr) { openTrade = openTrade === tr.dataset.trade ? null : tr.dataset.trade; renderTrades(); return; }
      const d = e.target.closest('[data-dossier]'); if (d) { dossierFor = d.dataset.dossier; renderDossier(); $('v11Dossier').scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
      if (e.target.closest('[data-close-dossier]')) { dossierFor = null; renderDossier(); }
    });
  }
  function render() {
    shell();
    if (!$('v11')) return;
    const st = status();
    $('v11Pill').textContent = st.pill; $('v11Pill').className = 'pill ' + st.kind;
    $('v11Line').innerHTML = esc(st.line) + (st.why ? `<br><b class="down">${esc(st.why)}</b>` : '');
    if (!S) return;
    renderAccts(); renderDays(); renderEquity(); renderPos(); renderTrades(); renderFunnel(); renderGaps(); renderDossier();
  }
  const group = A => A.kind === 'v2' ? 0 : A.kind === 'hold' ? 1 : 2;
  function renderAccts() {
    const rows = S.accts.slice().sort((a, b) => group(a) - group(b));
    const legacy = id => { const B = J && J.bots && J.bots[id]; return B ? B.trades.reduce((s, t) => s + t.net, 0) : null; };
    $('v11Accts').innerHTML = `<table><thead><tr><th>Account</th><th class="n">Value now</th><th class="n">Closed P&amp;L</th><th class="n">Trades</th><th>Open</th><th class="n">Max drawdown</th><th class="n">Orders failed</th><th class="n">Legacy bot</th></tr></thead><tbody>${rows.map(A => {
      const v = A.value, ret = v != null ? v / 10 - 1 : null;
      const lg = A.legacy ? legacy(A.legacy) : null;
      const open = A.pos ? `${esc(A.pos.sym)} <span class="faint">${esc(A.pos.state || '')}</span>` : A.pending ? `<span class="faint">order pending</span>` : '–';
      return `<tr><td style="box-shadow: inset 3px 0 0 var(${COLOR[A.id] || '--line'})"><b>${esc(A.name)}</b><div class="faint v11-desc">${esc(A.desc || '')}</div></td>
        <td class="n">${v != null ? sol(v) : '<span class="down">unknown</span>'} <span class="${cls(ret)}">${sPct(ret)}</span><div class="faint">(${sol(A.lo)})</div></td>
        <td class="n ${cls(A.realized)}">${sSol(A.realized)}</td><td class="n">${A.nTrades}${A.nTrades ? ` <span class="faint">${A.wins}W</span>` : ''}</td><td>${open}</td>
        <td class="n">${sPct(A.mdd)}</td><td class="n">${A.n && A.n.orders ? `${A.n.fails}/${A.n.orders}` : '–'}</td><td class="n">${lg == null ? '–' : `<span class="${cls(lg)}">${sSol(lg)}</span>`}</td></tr>`;
    }).join('')}</tbody></table><p class="faint v11-foot">"Legacy bot" is the same rule set as the original bot, scored the old way (candles, checks backdated, fills inside the minute). The gap between it and its E0 row is what honest timing changes.</p>${archive()}`;
  }
  // results under an older engine, kept apart (11.0 read a lagging DexScreener price as current)
  function archive() {
    const a = S.archive || []; if (!a.length) return '';
    const by = {}; for (const x of a) (by[x.engine + '|' + x.to] = by[x.engine + '|' + x.to] || []).push(x);
    return Object.values(by).map(rows => `<details class="v11-archive"><summary>Engine ${esc(rows[0].engine)} results, ${fDT(rows[0].from)} to ${fDT(rows[0].to)} ET (archived: that engine read DexScreener's lagging price as current)</summary>
      <table><thead><tr><th>Account</th><th class="n">Value at the end</th><th class="n">Closed P&amp;L</th><th class="n">Trades</th><th>Open then</th></tr></thead><tbody>${rows.map(x =>
        `<tr><td>${esc(x.name || x.acct)}</td><td class="n">${x.value != null ? sol(x.value) : 'unknown'}</td><td class="n ${cls(x.net)}">${sSol(x.net)}</td><td class="n">${x.trades}${x.trades ? ` <span class="faint">${x.wins || 0}W</span>` : ''}</td><td>${x.open ? esc(x.open.sym) : '–'}</td></tr>`).join('')}</tbody></table></details>`).join('');
  }
  function renderEquity() {
    const el = $('v11Eq'); if (!el || typeof LightweightCharts === 'undefined') return;
    const key = S.accts.map(A => A.id + A.eq.length + (A.eq[A.eq.length - 1] || [])[0]).join('|') + document.documentElement.dataset.theme;
    if (key === chartKey) return; chartKey = key;
    if (!chart) {
      chart = LightweightCharts.createChart(el, { autoSize: true, layout: { background: { color: 'transparent' }, textColor: cssv('--muted'), fontFamily: cssv('--font-body') },
        grid: { vertLines: { color: cssv('--line-2') }, horzLines: { color: cssv('--line-2') } }, rightPriceScale: { borderColor: cssv('--line') },
        timeScale: { borderColor: cssv('--line'), timeVisible: true, secondsVisible: false, tickMarkFormatter: t => fHM(t * 1000) },
        localization: { priceFormatter: p => p.toFixed(2) + ' SOL', timeFormatter: t => fDT(t * 1000) } });
    }
    for (const A of S.accts) {
      const color = cssv(COLOR[A.id] || '--muted');
      if (!series[A.id]) series[A.id] = chart.addLineSeries({ color, lineWidth: A.kind === 'v2' ? 2 : 1, lineStyle: A.kind === 'e0' ? 1 : 0, priceLineVisible: false, lastValueVisible: A.kind !== 'e0', title: A.id });
      const pts = []; let last = -1;
      for (const [t, v] of A.eq) { const s = Math.floor(t / 1000); if (s <= last) continue; last = s; pts.push(v == null ? { time: s } : { time: s, value: v }); }
      series[A.id].setData(pts);
    }
    $('v11EqLegend').innerHTML = S.accts.map(A => `<span class="lg" style="--lc: var(${COLOR[A.id] || '--muted'})">${esc(A.id)}</span>`).join(' ');
  }
  function famChips(th) {
    if (!th) return '';
    const lab = { ok: 'ok', flag: 'warning', confirmed: 'confirmed', unknown: 'no data' };
    return `<span class="v11-fams">${Object.entries(th).map(([k, v]) => `<span class="v11-fam ${v}">${esc(k)}: ${lab[v] || esc(v)}</span>`).join('')}</span>`;
  }
  function renderPos() {
    const held = S.accts.filter(A => A.pos);
    if (!held.length) { $('v11Pos').innerHTML = '<p class="faint">No account holds a coin right now. Cash is a position too.</p>'; return; }
    $('v11Pos').innerHTML = held.map(A => {
      const p = A.pos, c = S.coins[p.m] || {}, mk = p.mark || {}, now = Date.now();
      const val = mk.value, ret = val != null ? val / p.cost - 1 : null;
      const k = p.contract;
      const sell = c.mq ? (c.mq.ok ? `last sell quote ${age((now - c.mq.at) / 1000)} ago` : `<b class="down">last sell quote found no route</b>`) : 'no sell quote yet';
      const safe = p.state === 'exit_unavailable' || mk.src === 'route-lost' ? '<b class="down">Not safe to sell: no executable route</b>' : mk.value == null ? '<b class="down">Not enough current data to confirm it can be sold</b>' : '';
      const plan = k ? k.plan : null;
      const ahead = plan ? [`loss limit at ${sol(p.cost * (1 - plan.maxLoss))} SOL`, `horizon ends ${fT(p.openAt + plan.horizonMin * 60000)}`, `profit protection after +${Math.round(plan.trail[0] * 100)}%`].join(' · ')
        : A.P ? [A.P.tp != null ? `target +${(A.P.tp * 100).toFixed(0)}%` : '', A.P.sl ? `stop ${(A.P.sl * 100).toFixed(0)}% down${p.stopUnreachable ? ' (under the curve floor: can never trigger)' : ''}` : '', A.P.maxHold ? `time limit ${fT(p.openAt + A.P.maxHold * 60000)}` : 'no time limit'].filter(Boolean).join(' · ') : '';
      return `<div class="v11-pos" style="--bc: var(${COLOR[A.id] || '--line'})">
        <div class="v11-pos-h"><b>${esc(A.name)}</b> holds <b>${esc(p.sym)}</b> <span class="faint mono">${esc(short(p.m))}</span> since ${fT(p.openAt)} (${age((now - p.openAt) / 1000)}) <button class="v11-link" data-dossier="${esc(p.m)}">Dossier</button></div>
        <div class="v11-grid">
          <div><span class="label">Paid</span><div class="mono">${sol(p.cost)} SOL</div></div>
          <div><span class="label">Worth if sold now</span><div class="mono">${val != null ? sol(val) + ' SOL' : 'unknown'} <span class="${cls(ret)}">${sPct(ret)}</span></div><div class="faint">${esc(mk.src || '')}${mk.age != null ? ', ' + age(mk.age / 1000) + ' old' : ''}</div></div>
          <div><span class="label">Worst case</span><div class="mono">${sol(mk.lo)} SOL</div></div>
          <div><span class="label">Stage</span><div>${esc(c.stage || '–')}</div></div>
        </div>
        <p><span class="label">Why it was bought</span><br>${k ? `${esc(k.setup)}: ${k.confirmed.slice(0, 6).map(x => `${esc(x[0])} (${esc(x[1])})`).join(', ')}${k.confirmed.length > 6 ? '…' : ''}` : esc(A.desc || 'legacy rules')}</p>
        ${p.thesis ? `<p><span class="label">Is the reason still true?</span> ${esc(p.thesis.state)} ${famChips(p.thesis.families)}</p>` : ''}
        <p class="faint">${esc(ahead)}${ahead ? ' · ' : ''}${sell}</p>${safe ? `<p>${safe}</p>` : ''}</div>`;
    }).join('');
  }
  function allTrades() {
    const out = [];
    for (const A of S.accts) for (const t of A.trades) out.push(Object.assign({ acctName: A.name, kind: A.kind }, t));
    return out.sort((a, b) => b.closeAt - a.closeAt).slice(0, 60);
  }
  function renderTrades() {
    const ts = allTrades();
    if (!ts.length) { $('v11Trades').innerHTML = '<p class="faint">No closed trades yet.</p>'; $('v11TradeDetail').innerHTML = ''; return; }
    const id = t => `${t.acct}:${t.m}:${t.openAt}`;
    $('v11Trades').innerHTML = `<table class="v11-trades"><thead><tr><th>Account</th><th>Coin</th><th>Decided</th><th class="n">Fill delay</th><th>Sold</th><th>Why</th><th class="n">Net</th><th class="n">Return</th><th class="n">Worst / best inside</th></tr></thead><tbody>${ts.map(t =>
      `<tr data-trade="${esc(id(t))}" class="${openTrade === id(t) ? 'on' : ''}"><td style="box-shadow: inset 3px 0 0 var(${COLOR[t.acct] || '--line'})">${esc(t.acct)}</td><td><b>${esc(t.sym)}</b></td><td>${fT(t.decidedAt)}</td>
        <td class="n">${((t.openAt - t.decidedAt) / 1000).toFixed(1)}s</td><td>${fT(t.closeAt)}</td><td>${esc(REASON[t.exitReason] || t.exitReason)}</td><td class="n ${cls(t.net)}">${sSol(t.net)}</td><td class="n ${cls(t.ret)}">${sPct(t.ret)}</td>
        <td class="n"><span class="down">${sPct(t.mae, 0)}</span> / <span class="up">${sPct(t.mfe, 0)}</span></td></tr>`).join('')}</tbody></table>`;
    const t = ts.find(x => id(x) === openTrade);
    $('v11TradeDetail').innerHTML = t ? tradeDetail(t) : '';
  }
  function tradeDetail(t) {
    const v = t.v2, rows = [
      ['Signal', fT(t.sigAt)], ['Decided', fT(t.decidedAt)], ['Filled', `${fT(t.openAt)} (${((t.openAt - t.decidedAt) / 1000).toFixed(1)} s later, route ${esc((t.entryRoute || []).join(' > ') || '–')}, impact ${sPct(t.entryImpact)})`],
      ['Exit decided', `${fT(t.exitDecidedAt)}: ${esc(t.exitWhy || REASON[t.exitReason] || t.exitReason)}`], ['Sold', `${fT(t.closeAt)} (route ${esc((t.exitRoute || []).join(' > ') || '–')}, impact ${sPct(t.exitImpact)}, ${sPct(t.slipVsDecision)} vs the estimate at the decision)`],
      ['Money', `paid ${sol(t.cost)} SOL, got ${sol(t.proceeds)} SOL: ${sSol(t.net)} SOL (${sPct(t.ret)}). Venue fees are inside the quotes; plus 2 network fees and ${(t.fees.drift * 100).toFixed(1)}% landing drift each way.`],
      ['Inside the trade', `worst ${sPct(t.mae)}, best ${sPct(t.mfe)}${t.gapMs ? `, ${age(t.gapMs / 1000)} of it while the server was down` : ''}${t.stopUnreachable ? '. Its stop was under the curve floor and could never trigger.' : ''}`],
    ];
    if (v) {
      rows.splice(1, 0, ['Why bought', esc(v.why || v.setup)]);
      rows.push(['Plan', `size ${sol(v.plan.size, 2)} SOL, loss limit ${Math.round(v.plan.maxLoss * 100)}% (${sol(v.plan.lossAtLimit)} SOL with costs), worst case ${sol(v.plan.worstCase)} SOL (${esc(v.plan.worstWhy)}), round trip ${sPct(v.plan.roundTripCost)}, horizon ${v.plan.horizonMin} min`]);
      rows.push(['Ranked', `score ${v.score}, first of ${v.n} qualifying coin${v.n === 1 ? '' : 's'}`]);
      if (v.thesis) rows.push(['Thesis at exit', `${esc(v.thesis.state)} ${famChips(v.thesis.families)}`]);
      if (v.alt) rows.push(['A fixed target instead', `+${Math.round(v.alt.tp * 100)}% would have sold at ${fT(v.alt.at)} for ${sol(v.alt.value)} SOL (${sPct(v.alt.ret)}), assessed as it happened; the actual exit got ${sPct(t.ret)}. Best mark seen: ${sPct(v.peakRet)}.`]);
    }
    return `<div class="v11-detail"><h3>${esc(t.acctName)}: ${esc(t.sym)} <span class="faint mono">${esc(t.m)}</span> <button class="v11-link" data-dossier="${esc(t.m)}">Dossier</button></h3>
      <dl class="v11-dl">${rows.map(([k, x]) => `<dt>${k}</dt><dd>${x}</dd>`).join('')}</dl></div>`;
  }
  // value change per Toronto day from the equity points (start of day = last value before it, else 10 SOL at the start)
  const DAYF = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }), DAYL = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short', month: 'short', day: 'numeric' });
  function daysOf(A) {
    const out = new Map(); let prev = 10;
    for (const [t, v] of A.eq) { if (v == null) continue; const d = DAYF.format(new Date(t)); if (!out.has(d)) out.set(d, { open: prev, close: v, t }); else out.get(d).close = v; prev = v; }
    if (A.value != null) { const d = DAYF.format(new Date()); if (!out.has(d)) out.set(d, { open: prev, close: A.value, t: Date.now() }); else out.get(d).close = A.value; }
    return out;
  }
  function renderDays() {
    const rows = S.accts.slice().sort((a, b) => group(a) - group(b)).map(A => ({ A, d: daysOf(A) }));
    const days = [...new Set(rows.flatMap(r => [...r.d.keys()]))].sort().slice(-7);
    if (!days.length) { $('v11Days').innerHTML = '<p class="faint">No full day yet.</p>'; return; }
    const today = DAYF.format(new Date());
    $('v11Days').innerHTML = `<table><thead><tr><th>Account</th>${days.map(d => `<th class="n">${esc(DAYL.format(new Date(d + 'T12:00:00')))}${d === today ? ' (so far)' : ''}</th>`).join('')}<th class="n">Green days</th></tr></thead><tbody>${rows.map(({ A, d }) => {
      let green = 0, n = 0;
      const cells = days.map(day => { const x = d.get(day); if (!x) return '<td class="n faint">–</td>'; const ch = x.close - x.open; if (day !== today) { n++; if (ch > 1e-9) green++; } return `<td class="n ${cls(ch)}">${sSol(ch)}</td>`; }).join('');
      return `<tr><td style="box-shadow: inset 3px 0 0 var(${COLOR[A.id] || '--line'})">${esc(A.id)}</td>${cells}<td class="n">${n ? `${green}/${n}` : '–'}</td></tr>`;
    }).join('')}</tbody></table><p class="faint v11-foot">"Green days" counts finished days only; an account's first day is partial (it started mid-day).</p>`;
  }
  function renderFunnel() {
    const v2 = S.accts.filter(A => A.kind === 'v2');
    const f = A => A.funnel || {};
    $('v11Funnel').innerHTML = `<table><thead><tr><th>Strategy</th><th class="n">In range</th><th class="n">Checks passed</th><th class="n">Setup</th><th class="n">Buying</th><th class="n">Cost OK</th><th class="n">Bought</th></tr></thead><tbody>${v2.map(A =>
      `<tr><td>${esc(A.name)}</td><td class="n">${f(A).coins || 0}</td><td class="n">${f(A).gates || 0}</td><td class="n">${f(A).setup || 0}</td><td class="n">${f(A).demand || 0}</td><td class="n">${f(A).cost || 0}</td><td class="n">${f(A).entered || 0}</td></tr>`).join('')}</tbody></table>
      <p class="faint v11-foot">Counted once per coin. "Checks passed" needs every safety fact known: a coin whose dev wallet share nobody reports stays out until RugCheck's full report supplies it.</p>`;
  }
  function renderGaps() {
    const g = S.gaps.slice().reverse();
    $('v11Gaps').innerHTML = g.length ? `<ul class="v11-gaps">${g.map(x => `<li>${fDT(x.from)} to ${fT(x.to)} ET (${age((x.to - x.from) / 1000)})${x.held && x.held.length ? `: held ${x.held.map(h => esc(h.acct + ' ' + h.sym)).join(', ')}` : ''}</li>`).join('')}</ul>` : '<p class="faint">None since the engine started.</p>';
  }
  function renderDossier() {
    const el = $('v11Dossier'); if (!el) return;
    const c = dossierFor && S.coins[dossierFor];
    if (!c) { el.hidden = true; return; }
    const d = c.dossier || {};
    const claims = d.claims || [];
    el.hidden = false;
    el.innerHTML = `<div class="ph"><div><h2>Narrative dossier: ${esc(c.sym)}</h2><p class="down"><b>${esc(d.warning || 'Evidence incomplete.')}</b></p></div><button class="v11-link" data-close-dossier="1">Close</button></div>
      <dl class="v11-dl">
        <dt>Identity</dt><dd>mint <span class="mono">${esc(c.m)}</span>${c.bc ? `, curve <span class="mono">${esc(short(c.bc))}</span>` : ''}. Identified by mint address, never by ticker.</dd>
        <dt>Social attention</dt><dd>${esc(d.attention ? d.attention.status : 'unavailable')}: ${esc(d.attention ? d.attention.why : 'no approved data source')}</dd>
        <dt>Claims in its metadata</dt><dd>${claims.length ? claims.map(x => `${esc(x.label)}${x.url ? ` <span class="mono">${esc(x.url)}</span>` : ''}: <b>${esc(x.status)}</b>`).join('<br>') : 'none'}<div class="faint">Anyone can put any link in a token's metadata; it is not checked against the account or site.</div></dd>
        <dt>Name cluster</dt><dd>${d.nameCluster ? esc(d.nameCluster.note) : '–'}. Not social proof.</dd>
      </dl>`;
  }
  function onShow() { render(); if (chart) setTimeout(() => chart.timeScale().fitContent(), 50); }
  return { onServer, onShow, render };
})();
