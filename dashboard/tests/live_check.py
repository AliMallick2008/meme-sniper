"""Replay the dashboard on the real Coinbase candles captured from the live API (live/*.txt, checksummed against the
browser copy), at the capture time, in headless Chromium. Prints every bot's state as the page computes it."""
import json, sys, time, os
from urllib.parse import urlparse, parse_qs
from datetime import datetime, timezone
from playwright.sync_api import sync_playwright

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import paths
L = os.path.join(paths.FIXTURES, "btc_capture")
META = json.load(open(f"{L}/meta.json"))
NOW = META["now"]


def load(name):
    out = []
    for part in name:
        s = open(f"{L}/{part}.txt").read().strip()
        out += [[float(x) for x in r.split(",")] for r in s.split(";")]
    return out  # [t, o, h, l, c]


D = {300: load(["m5a", "m5b", "m5c"]), 3600: load(["h1"]), 86400: load(["d1"])}
for g, rows in D.items():
    if os.path.exists(f"{L}/extra_{g}.txt"):
        have = {r[0] for r in rows}
        rows += [r for r in load([f"extra_{g}"]) if r[0] not in have]
        rows.sort(key=lambda r: r[0])
calls = []
H = {"access-control-allow-origin": "*"}


def handle(route):
    u = urlparse(route.request.url)
    q = parse_qs(u.query)
    calls.append(u.path)
    if u.path == "/time":
        return route.fulfill(json={"epoch": NOW, "iso": datetime.fromtimestamp(NOW, timezone.utc).isoformat()}, headers=H)
    if u.path.endswith("/ticker"):
        return route.fulfill(json={"price": str(META["price"]), "time": datetime.fromtimestamp(NOW, timezone.utc).isoformat()}, headers=H)
    if u.path.endswith("/stats"):
        return route.fulfill(json={"open": str(META.get("open24", META["price"]))}, headers=H)
    if u.path.endswith("/candles"):
        g = int(q["granularity"][0])
        if g not in D or "BTC-USD" not in u.path:
            return route.fulfill(status=404, json={"message": "NotFound"}, headers=H)
        s = int(datetime.fromisoformat(q["start"][0].replace("Z", "+00:00")).timestamp())
        e = int(datetime.fromisoformat(q["end"][0].replace("Z", "+00:00")).timestamp())
        if (e - s) / g > 300:
            return route.fulfill(status=400, json={"message": "too many candles"}, headers=H)
        rows = [r for r in D[g] if s <= r[0] <= e and r[0] <= NOW]
        # Coinbase format: [time, low, high, open, close, volume], newest first
        return route.fulfill(json=[[int(r[0]), r[3], r[2], r[1], r[4], 0] for r in reversed(rows)], headers=H)
    return route.fulfill(status=404, body="")


JS = """() => { const o = window.__BPL.out; if (!o.acc) return {started: o.started, err: o.err};
  const r = {};
  for (const k of Object.keys(o.acc)) { const a = o.acc[k];
    r[k] = {balance: a.balance, pnl: a.pnl, realized: a.realized, unreal: a.unreal, fees: a.fees, mdd: a.mdd, exposure: a.exposure,
      notStarted: !!a.notStarted, nTrades: a.trades.length, wins: a.wins, losses: a.losses,
      trades: a.trades.map(t => ({part: t.part || null, sleeve: t.sleeve == null ? null : t.sleeve, entryT: t.entryT, exitT: t.exitT, entryPx: t.entryPx, exitPx: t.exitPx, net: t.net, fees: t.fees, reason: t.reason, notional: t.notional})),
      opens: a.opens.map(op => ({part: op.part || null, sleeve: op.sleeve == null ? null : op.sleeve, entryT: op.entryT, entryPx: op.entryPx, qty: op.qty, notional: op.notional, unreal: op.unreal, stop: op.stop})),
      pendings: (a.pendings || []).map(p => ({part: p.part || null, side: p.side, px: p.px, limitUntil: p.limitUntil})),
      curve: a.curve.filter((p, i) => i % 12 === 0 || i === a.curve.length - 1)};
    if (a.parts) r[k].parts = {swing: {balance: a.parts.swing.balance, open: !!a.parts.swing.open}, futb: {balance: a.parts.futb.balance, open: !!a.parts.futb.open}};
  }
  const rows = [...document.querySelectorAll('#nowList .row')].map(e => e.innerText.replace(/\\s+/g, ' ').trim());
  const bays = [...document.querySelectorAll('.bay')].map(e => ({name: e.querySelector('.name').textContent, pill: e.querySelector('.pill').textContent, state: e.querySelector('.state').innerText}));
  return {started: o.started, now: o.now, price: o.price, acc: r, rows, bays, futPlan: o.futPlan, snap: o.snap,
          mtf: {hClose: o.mtf.hClose, hAvg: o.mtf.hAvg, rsi: o.mtf.rsi}, daily: document.querySelector('#dailyTable').innerText}; }"""


def run(path, width=1280, shot=None, tabs=()):
    errs = []
    p = sync_playwright().start()
    b = paths.launch(p)
    ctx = b.new_context(viewport={"width": width, "height": 1000})
    ctx.route("https://api.exchange.coinbase.com/**", handle)
    ctx.route("https://fonts.googleapis.com/**", lambda r: r.fulfill(body="", content_type="text/css"))
    ctx.route("https://fonts.gstatic.com/**", lambda r: r.abort())
    pg = ctx.new_page()
    pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.on("console", lambda m: errs.append("console." + m.type + ": " + m.text) if m.type == "error" else None)
    pg.goto("file://" + path)
    pg.wait_for_function("window.__BPL && window.__BPL.out && window.__BPL.out.acc", timeout=90000)
    pg.wait_for_timeout(1500)
    data = pg.evaluate(JS)
    if shot:
        pg.screenshot(path=shot, full_page=True)
    for tab, sp in tabs:
        pg.click(f"#t-{tab}")
        pg.wait_for_timeout(700)
        pg.screenshot(path=sp, full_page=True)
    b.close(); p.stop()
    return data, errs


if __name__ == "__main__":
    path = sys.argv[1] if len(sys.argv) > 1 else paths.PAGE
    out = sys.argv[2] if len(sys.argv) > 2 else f"{L}/live_state.json"
    data, errs = run(path, shot=out.replace(".json", ".png"))
    data["errors"] = errs
    json.dump(data, open(out, "w"))
    print("errors:", errs[:5], "| api calls:", len(calls))
    for k, v in data["acc"].items():
        print(f"{k:<10} ${v['balance']:>10,.2f}  {v['pnl']:+9.2f}  trades {v['nTrades']:>3}  open {len(v['opens'])}  pend {len(v['pendings'])}  mdd {v['mdd']*100:6.2f}%  {'NOT STARTED' if v['notStarted'] else ''}")
