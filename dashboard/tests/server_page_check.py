"""The page in server mode: serves the simulated server's state (live/srv_sim, from server_sim_test.py) as if it came
from GitHub, plus the same synthetic market for the page's own live prices and candles. Checks that the page shows the
server's bots exactly, draws the charts, polls GitHub within its free limit, and switches from local mode to server
mode when the server appears. Screenshots go to live/."""
import json, sys, os, glob, re
from urllib.parse import urlparse
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import paths
_argv = sys.argv; sys.argv = [sys.argv[0]]
import sniper_sim as SS
import sniper_e2e as E2E
import sniper_e2e_busy as BUSY
sys.argv = _argv

PAGE = paths.PAGE
DIR = os.environ.get("SRV_DIR", paths.out("srv_sim"))
REPO = "AliMallick2008/meme-sniper"
H = {"access-control-allow-origin": "*"}


class SrvRun(E2E.Run):
    def __init__(self, mk, t0, width=1280, dark=False, up_at=None):
        super().__init__(mk, PAGE, t0, width=width, dark=dark)
        self.path = paths.out("_sniper_srv.html")
        open(self.path, "w").write(open(PAGE).read())
        self.state = open(f"{DIR}/state.json").read()
        self.up_at, self.gh = up_at, []

    def handle(self, route):
        u = urlparse(route.request.url)
        if u.netloc in ("api.github.com", "raw.githubusercontent.com"):
            now = float(route.request.headers.get("x-sim-now", self.now))
            self.gh.append((now, u.netloc, u.path))
            if self.up_at and now < self.up_at:
                return route.fulfill(status=404, json={"message": "Not Found"}, headers=H)
            if u.path.endswith("/state.json"):
                return route.fulfill(status=200, body=self.state, headers=dict(H, **{"content-type": "application/json"}))
            m = re.search(r"/tc/([1-9A-HJ-NP-Za-km-z]+)\.json$", u.path)
            if m and os.path.exists(f"{DIR}/tc/{m.group(1)}.json"):
                return route.fulfill(status=200, body=open(f"{DIR}/tc/{m.group(1)}.json").read(), headers=dict(H, **{"content-type": "application/json"}))
            return route.fulfill(status=404, json={"message": "Not Found"}, headers=H)
        return super().handle(route)


def main():
    mk = BUSY.busy_market(3)
    st = json.loads(open(f"{DIR}/state.json").read())
    J, srv = st["J"], st["srv"]
    t_srv = srv["t"] / 1000
    print("server state:", round(len(open(f"{DIR}/state.json").read()) / 1024), "KB, saved at", t_srv - BUSY.T0, "s; trades", {k: len(B["trades"]) for k, B in J["bots"].items()})
    ok = True
    # 1) fresh browser, server up: server mode at once
    R = SrvRun(mk, t_srv + 40)
    R.open()
    R.advance(20, step=1)
    mode = R.pg.evaluate("SNIPER_UI._mode()")
    page = R.pg.evaluate("""() => { const J = SNIPER_UI._J(); return Object.fromEntries(Object.entries(J.bots).map(([k, B]) => [k, [B.trades.length, B.trades.reduce((s, x) => s + x.net, 0), B.pos ? B.pos.m : null]])); }""")
    for k, B in J["bots"].items():
        same = page[k][0] == len(B["trades"]) and abs(page[k][1] - sum(t["net"] for t in B["trades"])) < 1e-12 and page[k][2] == (B["pos"]["m"] if B["pos"] else None)
        ok = ok and same
        if not same:
            print("   DIFF", k, page[k], len(B["trades"]))
    hero = R.pg.inner_text("#snHero")
    print("mode", mode, "| bots identical to the server:", ok, "| hero:", hero.split("\n")[-1][:150] if "Running" not in hero else [l for l in hero.split("\n") if "Running" in l][0][:150])
    ok = ok and mode == "server" and "Running 24/7" in hero
    R.advance(300, step=5)
    shown = R.pg.evaluate("() => ({ m: SNIPER_UI._M.view.m, cs: (SNIPER_UI._M.cs.get(SNIPER_UI._M.view.m) || { cs: [] }).cs.length, empty: !document.getElementById('snChartEmpty').hidden })")
    print("chart:", shown)
    ok = ok and shown["cs"] > 0 and not shown["empty"]
    R.shot(paths.out("server_desktop.png"), full=True)
    # replay a trade of a bot that traded
    bid = next((k for k, B in J["bots"].items() if B["trades"]), None)
    if bid:
        R.pg.click(f'.sn-botchip[data-bot="{bid}"]'); R.advance(2, step=1)
        R.pg.click("#snTrades .sn-replay"); R.advance(15, step=1)
        rp = R.pg.evaluate("() => { const r = SNIPER_UI._M.view.replay; return r ? { m: r.m, t: r.t, to: r.to } : null; }")
        print("replay:", bid, rp)
        R.shot(paths.out("server_replay.png"), full=False, sel=".sn-chartcard")
        ok = ok and rp is not None
    # the v11 tab: the honest engine's accounts, trade audit and dossier, from the same state.json
    v11 = st.get("v11")
    if v11:
        R.pg.click("#t-v11"); R.advance(3, step=1)
        rows = R.pg.evaluate("document.querySelectorAll('#v11Accts tbody tr').length")
        pill = R.pg.inner_text("#v11Pill")
        print(f"v11 tab: {rows} account rows (state has {len(v11['accts'])}), status '{pill}'")
        ok = ok and rows == len(v11["accts"]) and pill in ("Forward paper", "Incomplete data")
        if R.pg.query_selector("#v11Trades tbody tr"):
            R.pg.click("#v11Trades tbody tr"); R.advance(1, step=1)
            det = R.pg.inner_text("#v11TradeDetail")
            R.pg.click("#v11TradeDetail [data-dossier]"); R.advance(1, step=1)
            dos = R.pg.inner_text("#v11Dossier")
            print("   trade detail:", det.split("\n")[0][:100], "| dossier:", "Evidence incomplete" in dos)
            ok = ok and "Decided" in det and "Evidence incomplete" in dos
        R.shot(paths.out("server_v11.png"), full=True)
        R.pg.click("#t-sniper"); R.advance(2, step=1)
    R.advance(3600, step=10)
    api = [g for g in R.gh if g[1] == "api.github.com"]
    span = (R.gh[-1][0] - R.gh[0][0]) / 3600 if len(R.gh) > 1 else 1
    print("GitHub requests in %.2f h: api %d, cdn %d -> %.0f API calls per hour" % (span, len(api), len(R.gh) - len(api), len(api) / max(span, 1e-9)))
    ok = ok and len(api) / max(span, 1e-9) <= 45
    errs = [e for e in R.errs if "404" not in e[1]]
    print("page errors:", errs[:5])
    ok = ok and not errs
    R.stop()
    # 2) phone, dark
    R = SrvRun(mk, t_srv + 40, width=390, dark=True)
    R.open(); R.advance(60, step=2)
    R.shot(paths.out("server_phone_dark.png"), full=True)
    w = R.pg.evaluate("document.documentElement.scrollWidth")
    print("phone page width:", w)
    ok = ok and w <= 392
    R.pg.click("#t-v11"); R.advance(3, step=1)
    R.shot(paths.out("server_v11_phone_dark.png"), full=True)
    w = R.pg.evaluate("document.documentElement.scrollWidth")
    print("phone v11 tab width:", w)
    ok = ok and w <= 392
    R.stop()
    # 3) the server appears while this browser runs the bots itself: it takes over
    R = SrvRun(mk, t_srv - 1800, up_at=t_srv - 1800 + 200)
    R.open(); R.advance(30, step=1)
    m1 = R.pg.evaluate("[SNIPER_UI._mode(), SNIPER_UI._leader()]")
    R.advance(330, step=5)
    m2 = R.pg.evaluate("[SNIPER_UI._mode(), SNIPER_UI._leader()]")
    note = R.pg.inner_text("#snLabNote")
    print("before the server:", m1, "after:", m2, "| lab note:", note[-220:])
    ok = ok and m1 == ["local", True] and m2 == ["server", False] and "this browser ran the bots itself" in note
    errs = [e for e in R.errs if "404" not in e[1]]
    print("page errors:", errs[:5])
    ok = ok and not errs
    R.stop()
    print("SERVER PAGE OK" if ok else "SERVER PAGE PROBLEMS")


if __name__ == "__main__":
    main()
