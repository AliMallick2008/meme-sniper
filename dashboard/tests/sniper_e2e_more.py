"""Harder sniper scenarios on the same scripted market:
  A) GeckoTerminal answers 429 (rate limited) 20% of the time, RugCheck fails 15% of the time.
  B) The page is reloaded mid-trade, and later closed for 40 minutes and reopened (catch-up from candles).
  C) A second tab is opened: it must only watch; when the first tab closes, it takes over without double trades.
Every bot's trades must still equal the independent replay of the rules."""
import json, sys, time, random
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import paths
import sniper_sim as SS
import sniper_e2e as E2E
from sniper_e2e_run import market, T0

PAGE = sys.argv[1] if len(sys.argv) > 1 else paths.PAGE
OUT = paths.out("sniper_more")


class Flaky(SS.Market):
    def handle(self, url, now):
        if "geckoterminal" in url and random.random() < 0.20:
            return 429, {"status": {"error_code": 429, "error_message": "rate limited"}}
        if "rugcheck" in url and random.random() < 0.15:
            return 500, {"error": "boom"}
        return super().handle(url, now)


def compare(R, mk, st, label):
    sym = {m: k.get("sym") for m, k in st["coins"].items()}
    BOTP = {b["id"]: b for b in R.pg.evaluate("() => SNIPER_UI.BOTS.map(b => ({ id: b.id, P: b.P }))")}
    allok, lines = True, []
    for bid, B in st["bots"].items():
        P = BOTP[bid]["P"]
        watches = [(w["m"], w["from"], w["to"]) for w in B["watch"]]
        ref = E2E.ref_run(mk, watches, (T0 - 30) // 60 * 60, st["now"] - 150, P)
        ok = len(ref) == len(B["trades"]) + (1 if B["pos"] else 0)
        for a, b in zip(B["trades"], ref):
            same = a["m"] == b["m"] and a["entryT"] == b["entryT"] and a["exitT"] == b.get("exitT") and a["out"] == b.get("out") and abs(a["net"] - b["net"]) < 1e-9
            ok = ok and same
        if B["pos"] and len(ref) > len(B["trades"]):
            r = ref[len(B["trades"])]
            ok = ok and bool(r.get("open")) and r["m"] == B["pos"]["m"] and r["entryT"] == B["pos"]["entryT"]
        lines.append(f"  {bid:<4} page {[(sym.get(t['m']), round(t['entryT'] - T0), t['out']) for t in B['trades']]}{' + open ' + str(sym.get(B['pos']['m'])) if B['pos'] else ''} | ref {[(sym.get(t['m']), round(t['entryT'] - T0), t.get('out', 'open')) for t in ref]} -> {'ok' if ok else 'DIFF'}")
        allok = allok and ok
    print(f"[{label}]", "ALL MATCH" if allok else "MISMATCH")
    print("\n".join(lines))
    return allok


def main():
    random.seed(11)
    base = market()
    mk = Flaky(T0, seed=7)
    mk.coins = base.coins
    R = E2E.Run(mk, PAGE, T0 - 30)
    res = {}
    R.open()
    # A) flaky APIs for the first 55 minutes, then a reload mid-trade (FROGG is bought around +53 min)
    R.advance(55 * 60)
    st = R.state(); res["A_before_reload"] = compare(R, mk, st, "A: flaky APIs, 55 min")
    R.pg.reload()
    R.pg.wait_for_function("typeof SNIPER_UI !== 'undefined'", timeout=60000)
    R.advance(20 * 60)
    st = R.state(); res["B_after_reload"] = compare(R, mk, st, "B: reloaded at 55 min, now 75 min")
    # B) close for 40 minutes, reopen
    R.close()
    R.now += 40 * 60
    R.open()
    R.advance(25 * 60)
    st = R.state(); res["B_after_gap"] = compare(R, mk, st, "B: closed 75-115 min, reopened, now 140 min")
    gap_ev = [e for e in st["ev"] if e[2] == "gap"]
    print("gap event:", gap_ev[-1][3] if gap_ev else None)
    # C) a second tab: it must stay a viewer while the first one runs
    R2 = R.ctx.new_page()
    R2.on("pageerror", lambda e: R.errs.append(("pageerror2", str(e))))
    R2.clock.install(time=__import__("datetime").datetime.fromtimestamp(R.now, __import__("datetime").timezone.utc))
    R2.goto("file://" + R.path)
    R2.wait_for_function("typeof SNIPER_UI !== 'undefined'", timeout=60000)
    for i in range(int(6 * 60 / 5)):
        R.pg.clock.run_for(5000); R2.clock.run_for(5000); R.now += 5; time.sleep(0.004)
    lead1, lead2 = R.pg.evaluate("SNIPER_UI._leader()"), R2.evaluate("SNIPER_UI._leader()")
    print("leaders: tab1", lead1, "tab2", lead2)
    res["C_one_leader"] = lead1 is True and lead2 is False
    n_ev_1 = len(R.state()["ev"])
    # close the first tab; the second takes over within ~15 s
    R.pg.close()
    for i in range(int(20 * 60 / 5)):
        R2.clock.run_for(5000); R.now += 5; time.sleep(0.004)
    R.pg = R2
    print("tab2 leader now:", R2.evaluate("SNIPER_UI._leader()"))
    st = R.state(); res["C_takeover"] = compare(R, mk, st, "C: tab 1 closed, tab 2 drives, now 166 min")
    dup = {}
    for e in st["ev"]:
        if e[2] in ("buy", "win", "loss"):
            dup[(e[1], e[3])] = dup.get((e[1], e[3]), 0) + 1
    res["C_no_duplicate_events"] = all(v == 1 for v in dup.values())
    print("duplicate trade events:", [k for k, v in dup.items() if v > 1])
    R2.screenshot(path=OUT + "_tab2.png", full_page=True)
    print("errors:", R.errs[:6])
    print("lanes:", st["lanes"])
    print(json.dumps(res, indent=1))
    R.stop()


if __name__ == "__main__":
    main()
