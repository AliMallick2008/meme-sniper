"""Drive the built page in headless Chromium against the synthetic market (sniper_sim.Market) with Playwright's fake
clock, then compare the page's trades with an independent Python replay of the locked rules."""
import json, sys, time, math, os
from urllib.parse import urlparse
from datetime import datetime, timezone
from playwright.sync_api import sync_playwright
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import paths
import sniper_sim as SS
import live_check as LC

H = {"access-control-allow-origin": "*"}
STAMP = """(() => { const f = window.fetch; window.fetch = (u, o) => { o = Object.assign({}, o || {}); o.headers = Object.assign({}, o.headers || {}, { 'x-sim-now': String(Date.now() / 1000) }); return f(u, o); }; })();"""


class Run:
    def __init__(self, market, page_path, t0, width=1280, dark=False, patches=None):
        self.mk, self.t0 = market, t0
        html = open(page_path).read()
        for a, b in (patches or []):
            assert a in html, a
            html = html.replace(a, b)
        self.path = paths.out("_sniper_e2e.html")
        open(self.path, "w").write(html)
        self.errs, self.calls, self.unmocked = [], 0, {}
        self.p = sync_playwright().start()
        self.b = paths.launch(self.p)
        self.ctx = self.b.new_context(viewport={"width": width, "height": 1000}, color_scheme="dark" if dark else "light")
        self.ctx.add_init_script(STAMP)
        self.ctx.route("**/*", self.handle)
        self.pg = None
        self.now = t0

    def handle(self, route):
        req = route.request
        u = urlparse(req.url)
        if u.scheme == "file":
            return route.continue_()
        if u.netloc in ("fonts.googleapis.com",):
            return route.fulfill(body="", content_type="text/css")
        if u.netloc in ("fonts.gstatic.com", "dexscreener.com", "www.geckoterminal.com"):
            return route.fulfill(body="<html><body style='background:#123'>embed</body></html>", content_type="text/html")
        now = float(req.headers.get("x-sim-now", self.now))
        self.calls += 1
        r = self.mk.handle(req.url, now)
        if r is not None:
            return route.fulfill(status=r[0], json=r[1], headers=H)
        # BTC side of the dashboard: serve the captured live candles (as the earlier checks do)
        if u.netloc == "api.exchange.coinbase.com":
            if u.path == "/time":
                return route.fulfill(json={"epoch": now}, headers=H)
            if u.path.endswith("/ticker"):
                return route.fulfill(json={"price": str(LC.META["price"]), "time": datetime.fromtimestamp(now, timezone.utc).isoformat()}, headers=H)
            if u.path.endswith("/stats"):
                return route.fulfill(json={"open": str(LC.META["price"])}, headers=H)
            if u.path.endswith("/candles") and "BTC-USD" in u.path:
                from urllib.parse import parse_qs
                q = parse_qs(u.query)
                g = int(q["granularity"][0])
                s = int(datetime.fromisoformat(q["start"][0].replace("Z", "+00:00")).timestamp())
                e = int(datetime.fromisoformat(q["end"][0].replace("Z", "+00:00")).timestamp())
                rows = [r for r in LC.D.get(g, []) if s <= r[0] <= e]
                return route.fulfill(json=[[int(r[0]), r[3], r[2], r[1], r[4], 0] for r in reversed(rows)], headers=H)
            return route.fulfill(status=404, json={"message": "NotFound"}, headers=H)
        self.unmocked[u.netloc + u.path[:40]] = self.unmocked.get(u.netloc + u.path[:40], 0) + 1
        return route.fulfill(status=404, body="")

    def open(self, at=None):
        if at is not None:
            self.now = at
        self.pg = self.ctx.new_page()
        self.pg.on("pageerror", lambda e: self.errs.append(("pageerror", str(e))))
        self.pg.on("console", lambda m: self.errs.append(("console", m.text)) if m.type == "error" and "404" not in m.text else None)
        self.pg.clock.install(time=datetime.fromtimestamp(self.now, timezone.utc))
        self.pg.goto("file://" + self.path)
        self.pg.wait_for_function("typeof SNIPER_UI !== 'undefined'", timeout=60000)

    def close(self):
        self.pg.close()
        self.pg = None

    def advance(self, seconds, step=5, every=None, cb=None):
        n = int(seconds // step)
        for i in range(n):
            self.pg.clock.run_for(step * 1000)
            self.now += step
            time.sleep(0.004)
            if every and cb and (i + 1) % every == 0:
                cb(self)

    def state(self):
        return self.pg.evaluate("""() => { const J = SNIPER_UI._J(), M = SNIPER_UI._M;
          const bots = {}; for (const [id, B] of Object.entries(J.bots)) bots[id] = { pos: B.pos, trades: B.trades, watch: B.watch, free: B.free, pending: B.pending || null, mark: B.mark || null };
          return { now: Date.now() / 1000, coins: J.coins, cross: J.cross, bots, ev: J.ev, young: M.young.size, errors: M.errors.slice(-10),
                   lanes: Object.fromEntries(Object.entries(SNIPER_UI._lanes ? SNIPER_UI._lanes() : {}).map(([k, v]) => [k, [v.ok, v.fail, v.lastErr]])) }; }""")

    def shot(self, path, full=True, sel=None):
        if sel:
            self.pg.locator(sel).screenshot(path=path)
        else:
            self.pg.screenshot(path=path, full_page=full)

    def stop(self):
        try:
            self.b.close()
        finally:
            self.p.stop()


# ---------------------------------------------------------------------- independent replay of the locked rules ("U")
FEE_CURVE = 0.0125
CURVE_K = 30 * 1.073e9
POOL_K = 85 * 206.9e6
TIERS = [[420, 0.0125], [1470, 0.012], [2460, 0.0115], [3440, 0.011], [4420, 0.0105], [9820, 0.01], [float("inf"), 0.0095]]


def fee_rate(mc_sol, curve):
    if curve:
        return 0.0125
    for lim, f in TIERS:
        if mc_sol < lim:
            return f
    return 0.0095


def buy(S, p, curve, ex):
    f = fee_rate(p * 1e9, curve)
    net = S - S * f
    q = p * (1 + ex)
    k = CURVE_K if curve else POOL_K
    R = math.sqrt(k * q)
    T = R / q
    return T - k / (R + net), S * f


def sell(Q, p, curve, ex):
    q = p * (1 - ex)
    k = CURVE_K if curve else POOL_K
    R = math.sqrt(k * q)
    T = R / q
    g = R - k / (T + Q)
    return g * (1 - fee_rate(p * 1e9, curve))


def price_for(Q, target, curve, ex):
    lo, hi = 1e-15, 10.0
    if sell(Q, hi, curve, ex) < target:
        return float("inf")
    for _ in range(90):
        m = math.sqrt(lo * hi)
        if sell(Q, m, curve, ex) >= target:
            hi = m
        else:
            lo = m
    return hi


def candles_of(c, upto):
    """Final 1-minute candles of a coin (curve then pool), [t, o, h, l, c, v, g] in USD, starting before upto."""
    out = []
    for m in sorted(c.cs):
        if m >= upto or m >= c.end_t:
            break
        g = 1 if (c.grad_t and m >= c.grad_t) else 0
        o, h, l, cl, v = c.cs[m]
        out.append([m, o, h, l, cl, v, g])
    return out


def ref_entry(cs, tw, b, P, sol):
    """First entry on one coin from watch start tw (seconds) for candles starting before b. Mirrors the locked rules."""
    t0 = math.ceil(tw / 60) * 60
    H = 0.0
    for x in cs:
        if x[0] >= t0:
            break
        H = max(H, x[2])
    if not H > 0:
        f = next((x for x in cs if t0 <= x[0] < b), None)
        H = f[1] if f else 0
    armed = False
    ready = not P.get("rearm", True)
    for x in cs:
        t, o, h, l, cl = x[0], x[1], x[2], x[3], x[4]
        if t < t0:
            continue
        if t >= b:
            break
        trig = (1 - P["dip"]) * H
        if not ready:
            if o > trig:
                ready = True
            else:
                if cl > trig:
                    ready = True
                H = max(H, h)
                continue
        fill = None
        if P.get("entry", "limit") == "limit":
            if l <= trig:
                fill = min(o, trig)
        else:
            if not armed and l <= trig:
                armed = True
            if armed and cl > o:
                fill = cl
        if fill is not None:
            return (t, fill, H, trig, x[6])
        H = max(H, h)
    return None


def ref_run(mk, watches, t_start, t_end, P, sol=SS.SOL_USD):
    """watches: [(mint, from, to)] in the order the page added them. One coin at a time; the first coin to dip wins."""
    free = t_start
    trades, done = [], set()
    while True:
        best = None
        for i, (m, a, b) in enumerate(watches):
            if i in done or b <= free:
                continue
            cs = candles_of(mk.by_mint(m), t_end)
            hit = ref_entry(cs, max(a, free), min(b, t_end), P, sol)
            if hit and (best is None or hit[0] < best[1][0]):
                best = (i, hit)
        if best is None:
            break
        i, (te, fill, H, trig, g) = best
        m = watches[i][0]
        done.add(i)
        cs = candles_of(mk.by_mint(m), t_end)
        curve0 = not g
        p = fill / sol
        qty, fee = buy(P["stake"], p, curve0, P["exec"])
        tgt = P["stake"] * (1 + P["tp"])
        tpc, tpp = price_for(qty, tgt, True, P["exec"]), price_for(qty, tgt, False, P["exec"])
        sl = (1 - P["sl"]) * p
        ex = None
        for x in cs:
            t, o, h, l, cl, v, gg = x
            if t < te:
                continue
            curve = not gg
            oS, hS, lS, cS = o / sol, h / sol, l / sol, cl / sol
            if t == te:
                if P.get("entry", "limit") == "limit" and lS <= sl:
                    ex = (t, "sl", cS if cS <= sl else sl, curve)
                    break
                continue
            tg = tpc if curve else tpp
            if lS <= sl:
                ex = (t, "sl", oS if oS <= sl else (cS if cS < sl else sl), curve)
                break
            if hS >= tg:
                ex = (t, "tp", max(oS, tg), curve)
                break
            if P.get("maxHold") and t + 60 - te >= P["maxHold"] * 60:
                ex = (t, "time", cS, curve)
                break
        if not ex:
            trades.append({"m": m, "entryT": te, "fill": fill, "qty": qty, "open": True})
            break
        proceeds = sell(qty, ex[2], ex[3], P["exec"])
        trades.append({"m": m, "entryT": te, "fill": fill, "qty": qty, "exitT": ex[0], "out": ex[1], "net": proceeds - P["stake"]})
        free = ex[0] + 60
    return trades
