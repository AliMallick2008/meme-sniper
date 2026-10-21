"""Scenario test: scripted coins (win, stop, rug-flagged, no meme, no dip, graduation, busy-bot) + filler launches.
Usage: python3 sniper_e2e_run.py [page] [hours]"""
import json, sys, time, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import paths
import sniper_sim as SS
import sniper_e2e as E2E

PAGE = sys.argv[1] if len(sys.argv) > 1 else paths.PAGE
HOURS = float(sys.argv[2]) if len(sys.argv) > 2 else 3.2
T0 = 1792494000  # Tue Oct 20 2026 10:00 UTC (6:00 AM ET), a round hour
OUT = paths.out("sniper_e2e")


def market():
    mk = SS.Market(T0, seed=7)
    K = lambda v: v * 1000
    mk.add(0, "Frog Alpha", "FROGA", [(240, K(9)), (600, K(12)), (1200, K(15)), (3600, K(14)), (9000, K(13))])           # passes, never dips 40%
    mk.add(120, "Frog Beta", "FROGB", [(300, K(9)), (900, K(20)), (1500, K(10.5)), (2100, K(16)), (9000, K(15))])        # dip -> buy -> profit
    mk.add(600, "Frog Rug", "FROGR", [(300, K(9)), (900, K(25)), (1500, K(5)), (9000, K(3))],
           audit={"mintAuthorityDisabled": False, "freezeAuthorityDisabled": True, "devBalancePercentage": 1, "topHoldersPercentage": 10, "devMints": 1})
    mk.add(900, "Frog Danger", "FROGD", [(300, K(9)), (900, K(25)), (1500, K(12)), (9000, K(10))],
           risks=[("Creator history of rugged tokens", "danger")])
    mk.add(1200, "Lonely Walrus", "WALRUS", [(300, K(9)), (900, K(25)), (1500, K(12)), (9000, K(10))])                  # no meme match
    mk.add(1800, "Frog Gamma", "FROGG", [(300, K(9)), (900, K(30)), (1500, K(16)), (2400, K(3.0)), (9000, K(2.9))])     # dip -> buy -> dies at the curve floor
    mk.add(1850, "Frog Late", "FROGL", [(300, K(9)), (1200, K(28)), (1700, K(15)), (2600, K(14)), (3400, K(19)), (9000, K(18))])  # dips while busy
    mk.add(5400, "Frog Grad", "FROGX", [(300, K(9)), (900, K(30)), (1500, K(70)), (2100, K(40)), (2700, K(2)), (9000, K(1.5))])  # graduates, buy on the pool, crash -> stop
    mk.filler(60, HOURS * 3600)
    return mk


def main():
    mk = market()
    R = E2E.Run(mk, PAGE, T0 - 30)
    t_start = time.time()
    try:
        R.open()
        snaps = []
        def cb(r):
            s = r.state()
            B = s["bots"].get("U", {})
            snaps.append((round(s["now"]), len(s["coins"]), len(B.get("watch", [])), len(B.get("trades", [])), bool(B.get("pos")), s["errors"][-2:]))
        R.advance(HOURS * 3600, step=5, every=360, cb=cb)
        st = R.state()
        R.shot(OUT + "_desk.png")
        print("real seconds", round(time.time() - t_start))
    finally:
        pass
    for x in snaps:
        print(x)
    print("page errors:", R.errs[:8])
    print("unmocked:", R.unmocked)
    print("calls:", json.dumps(mk.calls, indent=0)[:1500])
    coins = st["coins"]
    sym = {m: k.get("sym") for m, k in coins.items()}
    print("\nCROSSED:", [(k["sym"], round(k["x"] - T0), k["status"], k.get("why")) for k in sorted(coins.values(), key=lambda k: k.get("x", 0)) if k.get("x")])
    BOTP = {b["id"]: b for b in R.pg.evaluate("() => SNIPER_UI.BOTS.map(b => ({ id: b.id, P: b.P }))")}
    allok = True
    for bid, B in st["bots"].items():
        P = BOTP[bid]["P"]
        print(f"\n=== {bid}  P={ {k: P[k] for k in ('dip', 'tp', 'sl', 'maxHold', 'entry')} }")
        print("  WATCH:", [(sym.get(w["m"]), round(w["from"] - T0), w.get("done")) for w in B["watch"]])
        for t in B["trades"]:
            print("  PAGE ", t["sym"], round(t["entryT"] - T0), round(t["exitT"] - T0), t["out"], round(t["net"], 6), "mc", round(t["entryMc"]), "->", round(t["exitMc"]))
        if B["pos"]:
            print("  PAGE  OPEN", sym.get(B["pos"]["m"]), round(B["pos"]["entryT"] - T0))
        watches = [(w["m"], w["from"], w["to"]) for w in B["watch"]]
        ref = E2E.ref_run(mk, watches, (T0 - 30) // 60 * 60, st["now"] - 150, P)
        for t in ref:
            print("  REF  ", sym.get(t["m"]), round(t["entryT"] - T0), round(t.get("exitT", 0) - T0) if t.get("exitT") else "open", t.get("out"), round(t.get("net", 0), 6))
        ok = len(ref) == len(B["trades"]) + (1 if B["pos"] else 0)
        for a, b in zip(B["trades"], ref):
            same = a["m"] == b["m"] and a["entryT"] == b["entryT"] and a["exitT"] == b.get("exitT") and a["out"] == b.get("out") and abs(a["net"] - b["net"]) < 1e-9
            ok = ok and same
            if not same:
                print("  MISMATCH", a["sym"], a["entryT"], b)
        if B["pos"] and len(ref) > len(B["trades"]):
            r = ref[len(B["trades"])]
            ok = ok and r.get("open") and r["m"] == B["pos"]["m"] and r["entryT"] == B["pos"]["entryT"]
        print("  ->", "MATCH" if ok else "NO MATCH")
        allok = allok and ok
    print("\nALL BOTS MATCH" if allok else "\nSOME BOTS DIFFER")
    json.dump(st, open(OUT + "_state.json", "w"))
    R.stop()


if __name__ == "__main__":
    main()
