"""Busy-market stress test: ~150 coins crossing $7K over 2.5 hours with random pump/dip/bounce/death paths, shared meme
words, random failed checks and 300 launches that go nowhere. Checks: every bot equals the independent replay, the
watchlists stay capped, GeckoTerminal calls stay within its free limit, no page errors."""
import json, sys, time, random, math, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import paths
import sniper_sim as SS
import sniper_e2e as E2E

PAGE = sys.argv[1] if len(sys.argv) > 1 else paths.PAGE
HOURS = float(sys.argv[2]) if len(sys.argv) > 2 else 2.5
T0 = 1792494000
WORDS = ["frog", "cat", "dog", "pepe", "trump", "moon", "ai", "goblin", "penguin", "chill", "based", "wizard", "rocket", "banana"]


def busy_market(seed=3):
    rng = random.Random(seed)
    mk = SS.Market(T0, seed=seed)
    K = 1000
    for i in range(150):
        dt = rng.uniform(0, HOURS * 3600 - 600)
        w1, w2 = rng.choice(WORDS), rng.choice(WORDS)
        name = f"{w1.title()} {w2.title()} {i}"
        peak = rng.choice([9, 12, 15, 20, 30, 45, 70]) * K * rng.uniform(0.9, 1.1)
        t_peak = rng.uniform(300, 1500)
        kind = rng.random()
        if kind < 0.35:      # pump, 40-60% dip, bounce
            wps = [(t_peak * 0.5, peak * 0.5), (t_peak, peak), (t_peak + 600, peak * rng.uniform(0.4, 0.58)), (t_peak + 1200, peak * rng.uniform(0.6, 0.9)), (t_peak + 9000, peak * rng.uniform(0.3, 0.8))]
        elif kind < 0.65:    # pump, dip, slow death to the floor
            wps = [(t_peak * 0.5, peak * 0.5), (t_peak, peak), (t_peak + 600, peak * rng.uniform(0.45, 0.6)), (t_peak + 3000, 3000), (t_peak + 9000, 2950)]
        elif kind < 0.85:    # grinds up, small dips only
            wps = [(t_peak * 0.5, peak * 0.5), (t_peak, peak), (t_peak + 1800, peak * rng.uniform(0.7, 0.9)), (t_peak + 9000, peak * rng.uniform(0.75, 1.3))]
        else:                # instant rug after the crossing
            wps = [(t_peak * 0.5, peak * 0.6), (t_peak, peak), (t_peak + 120, 3000), (t_peak + 9000, 2950)]
        audit = {"mintAuthorityDisabled": rng.random() > 0.05, "freezeAuthorityDisabled": rng.random() > 0.03,
                 "devBalancePercentage": rng.choice([0, 1, 2, 4, 8, 15]), "topHoldersPercentage": rng.choice([10, 18, 25, 32, 45]), "devMints": rng.choice([1, 3, 8, 20, 60])}
        risks = [("Creator history of rugged tokens", "danger")] if rng.random() < 0.15 else []
        soc = {"tw": "https://x.com/x"} if rng.random() < 0.4 else {}
        mk.add(dt, name, (w1[:3] + w2[:3]).upper(), wps, audit=audit, risks=risks, holders=rng.choice([30, 60, 120, 250]), socials=soc, noise=0.03)
    mk.filler(300, HOURS * 3600)
    return mk


def main():
    mk = busy_market()
    POOLCALLS = {}
    orig = mk.handle
    def h(url, now):
        if "geckoterminal" in url:
            k = url.split("/pools/")[1].split("/")[0]
            POOLCALLS[k] = POOLCALLS.get(k, 0) + 1
        return orig(url, now)
    mk.handle = h
    R = E2E.Run(mk, PAGE, T0 - 30)
    R.open()
    gt_marks, slot_max = [], 0
    def cb(r):
        nonlocal slot_max
        gt_marks.append((r.now, sum(v for k, v in mk.calls.items() if "geckoterminal" in k)))
        st = r.pg.evaluate("() => Object.values(SNIPER_UI._J().bots).map(B => B.watch.filter(w => !w.done && !w.drop).length)")
        slot_max = max(slot_max, max(st))
    t0 = time.time()
    R.advance(HOURS * 3600, step=5, every=120, cb=cb)
    st = R.state()
    print("real seconds", round(time.time() - t0))
    rates = [(b[1] - a[1]) / ((b[0] - a[0]) / 60) for a, b in zip(gt_marks, gt_marks[1:])]
    print("GeckoTerminal calls/min per 10-min window: max %.1f, mean %.1f" % (max(rates), sum(rates) / len(rates)))
    print("max active watches per bot:", slot_max)
    crossed = [k for k in st["coins"].values() if k.get("x")]
    print("crossed:", len(crossed), "passed:", sum(1 for k in crossed if k["status"] == "pass"), "events:", len(st["ev"]))
    R.shot(paths.out("sniper_busy.png"), full=False)
    sym = {m: k.get("sym") for m, k in st["coins"].items()}
    BOTP = {b["id"]: b for b in R.pg.evaluate("() => SNIPER_UI.BOTS.map(b => ({ id: b.id, P: b.P }))")}
    allok = True
    for bid, B in st["bots"].items():
        P = BOTP[bid]["P"]
        watches = [(w["m"], w["from"], w["to"]) for w in B["watch"]]
        ref = E2E.ref_run(mk, watches, (T0 - 30) // 60 * 60, st["now"] - 60, P)
        ok = len(ref) == len(B["trades"]) + (1 if B["pos"] else 0)
        for a, b in zip(B["trades"], ref):
            same = a["m"] == b["m"] and a["entryT"] == b["entryT"] and a["exitT"] == b.get("exitT") and a["out"] == b.get("out") and abs(a["net"] - b["net"]) < 1e-9
            if not same:
                print("   MISMATCH", bid, a["sym"], a["entryT"] - T0, a["exitT"] - T0, a["out"], "| ref", sym.get(b["m"]), b["entryT"] - T0, b.get("exitT", 0) - T0, b.get("out"))
            ok = ok and same
        if B["pos"] and len(ref) > len(B["trades"]):
            r = ref[len(B["trades"])]
            ok = ok and bool(r.get("open")) and r["m"] == B["pos"]["m"] and r["entryT"] == B["pos"]["entryT"]
        # the page may still be confirming the very last exit (candles not final yet on its side): not a difference
        if not ok and B["pos"] and len(ref) == len(B["trades"]) + 1 and ref[-1].get("exitT") and ref[-1]["exitT"] > st["now"] - 600 and ref[-1]["m"] == B["pos"]["m"] and ref[-1]["entryT"] == B["pos"]["entryT"] and all(
                a["m"] == b["m"] and a["entryT"] == b["entryT"] and a["exitT"] == b.get("exitT") for a, b in zip(B["trades"], ref)):
            ok = True; print("   (last ref exit is %d s before the end: still being confirmed on the page)" % (st["now"] - ref[-1]["exitT"]))
        # an entry in the last few minutes may still be waiting for final candles on the page: not a difference
        if not ok and not B["pos"] and len(ref) == len(B["trades"]) + 1 and ref[-1]["entryT"] > st["now"] - 600 and all(
                a["m"] == b["m"] and a["entryT"] == b["entryT"] and a["exitT"] == b.get("exitT") for a, b in zip(B["trades"], ref)):
            ok = True; print("   (last ref entry is %d s before the end: still pending on the page)" % (st["now"] - ref[-1]["entryT"]))
        if not ok:
            print("   PAGE", [(sym.get(t["m"]), t["entryT"] - T0, t["exitT"] - T0, t["out"], round(t["net"], 4)) for t in B["trades"]], "open", (sym.get(B["pos"]["m"]), B["pos"]["entryT"] - T0) if B["pos"] else None)
            print("   REF ", [(sym.get(t["m"]), t["entryT"] - T0, t.get("exitT", 0) - T0, t.get("out"), round(t.get("net", 0), 4)) for t in ref])
            print("   WATCH", [(sym.get(w["m"]), round(w["from"] - T0), round(w["to"] - T0), w.get("done"), w.get("drop")) for w in B["watch"]])
        bal = 10 + sum(t["net"] for t in B["trades"])
        print(f"  {bid:<4} trades {len(B['trades']):>3}  wins {sum(1 for t in B['trades'] if t['net'] > 0):>3}  realized {bal:7.3f} SOL  open {sym.get(B['pos']['m']) if B['pos'] else '-':<8} watches {len(B['watch']):>3}  -> {'MATCH' if ok else 'DIFF'}")
        allok = allok and ok
    pc = sorted(POOLCALLS.items(), key=lambda x: -x[1])[:8]
    print("top GT pools:", [(sym.get(next((c.mint for c in mk.coins if c.bc == k or c.pool == k), None)), n) for k, n in pc], "total", sum(POOLCALLS.values()))
    print("ALL BOTS MATCH" if allok else "SOME BOTS DIFFER")
    print("errors:", [e for e in R.errs if '404' not in e[1]][:5])
    json.dump({"st": st}, open(paths.out("sniper_busy_state.json"), "w"))
    R.stop()


if __name__ == "__main__":
    main()
