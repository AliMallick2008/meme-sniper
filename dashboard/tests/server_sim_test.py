"""Server bots in the simulator: the busy synthetic market from the page's stress test (~150 coins crossing $7K in
2.5 hours, 300 duds), run by the Node server (meme-sniper/server/sim.js) on a virtual clock in three runs: a 50-second
handover between runs 1 and 2 and a 22-minute outage between runs 2 and 3. Then every bot is compared with the
independent Python replay of the locked rules, the research records are checked against the market's candles, and the
GeckoTerminal load and file sizes are reported.  Usage: python3 server_sim_test.py [hours] [seed]"""
import json, sys, os, threading, subprocess, shutil, gzip, glob, time
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import paths
_argv = sys.argv; sys.argv = [sys.argv[0]]
import sniper_sim as SS
import sniper_e2e as E2E
import sniper_e2e_busy as BUSY
sys.argv = _argv

HOURS = float(sys.argv[1]) if len(sys.argv) > 1 else 2.5
SEED = int(sys.argv[2]) if len(sys.argv) > 2 else 3
BUSY.HOURS = HOURS
T0 = BUSY.T0
REPO = paths.REPO
DIR = paths.out("srv_sim")


def compare(mk, st, label=""):
    sym = {m: k.get("sym") for m, k in st["coins"].items()}
    allok = True
    for bid, B in st["bots"].items():
        P = st["P"][bid]
        watches = [(w["m"], w["from"], w["to"]) for w in B["watch"]]
        ref = E2E.ref_run(mk, watches, (st["start"]) // 60 * 60, st["now"] - 60, P)
        ok = len(ref) == len(B["trades"]) + (1 if B["pos"] else 0)
        for a, b in zip(B["trades"], ref):
            same = a["m"] == b["m"] and a["entryT"] == b["entryT"] and a["exitT"] == b.get("exitT") and a["out"] == b.get("out") and abs(a["net"] - b["net"]) < 1e-9
            if not same:
                print("   MISMATCH", bid, a.get("sym"), a["entryT"] - T0, a["exitT"] - T0, a["out"], "| ref", sym.get(b["m"]), b["entryT"] - T0, b.get("exitT", 0) - T0, b.get("out"))
            ok = ok and same
        if B["pos"] and len(ref) > len(B["trades"]):
            r = ref[len(B["trades"])]
            ok = ok and bool(r.get("open")) and r["m"] == B["pos"]["m"] and r["entryT"] == B["pos"]["entryT"]
        if not ok and B["pos"] and len(ref) == len(B["trades"]) + 1 and ref[-1].get("exitT") and ref[-1]["exitT"] > st["now"] - 600 and ref[-1]["m"] == B["pos"]["m"] and ref[-1]["entryT"] == B["pos"]["entryT"] and all(
                a["m"] == b["m"] and a["entryT"] == b["entryT"] and a["exitT"] == b.get("exitT") for a, b in zip(B["trades"], ref)):
            ok = True; print("   (last ref exit is %d s before the end: still being confirmed)" % (st["now"] - ref[-1]["exitT"]))
        if not ok and not B["pos"] and len(ref) == len(B["trades"]) + 1 and ref[-1]["entryT"] > st["now"] - 600 and all(
                a["m"] == b["m"] and a["entryT"] == b["entryT"] and a["exitT"] == b.get("exitT") for a, b in zip(B["trades"], ref)):
            ok = True; print("   (last ref entry is %d s before the end: still pending)" % (st["now"] - ref[-1]["entryT"]))
        if not ok:
            print("   SERVER", [(sym.get(t["m"]), t["entryT"] - T0, t["exitT"] - T0, t["out"], round(t["net"], 4)) for t in B["trades"]], "open", (sym.get(B["pos"]["m"]), B["pos"]["entryT"] - T0) if B["pos"] else None)
            print("   REF   ", [(sym.get(t["m"]), t["entryT"] - T0, t.get("exitT", 0) - T0, t.get("out"), round(t.get("net", 0), 4)) for t in ref])
        bal = 10 + sum(t["net"] for t in B["trades"])
        print(f"  {label}{bid:<4} trades {len(B['trades']):>3}  wins {sum(1 for t in B['trades'] if t['net'] > 0):>3}  realized {bal:7.3f} SOL  open {sym.get(B['pos']['m']) if B['pos'] else '-':<8} watches {len(B['watch']):>3}  -> {'MATCH' if ok else 'DIFF'}")
        allok = allok and ok
    return allok


def main():
    mk = BUSY.busy_market(SEED)
    lock = threading.Lock()
    gt_times, calls = [], {"n": 0}

    class Hd(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"
        def log_message(self, *a):
            pass
        def do_POST(self):
            req = json.loads(self.rfile.read(int(self.headers.get("content-length", 0))))
            with lock:
                r = mk.handle(req["url"], req["now"])
                calls["n"] += 1
                if "geckoterminal" in req["url"]:
                    gt_times.append(req["now"])
            out = json.dumps({"status": r[0], "json": r[1]} if r else {"status": 404, "json": None}).encode()
            self.send_response(200); self.send_header("content-type", "application/json"); self.send_header("content-length", str(len(out))); self.end_headers(); self.wfile.write(out)

    srv = ThreadingHTTPServer(("127.0.0.1", 0), Hd)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    port = srv.server_address[1]
    shutil.rmtree(DIR, ignore_errors=True); os.makedirs(DIR)
    # run 3 goes on 2 h 10 min past the last launch, so every crossed coin's research record comes due
    L = int(HOURS * 3600)
    end = T0 + L + 7800
    segs = [(T0 - 30, T0 + int(L * 0.47), "1"), (T0 + int(L * 0.47) + 50, T0 + int(L * 0.73), "2"), (T0 + int(L * 0.73) + 22 * 60, end, "3")]
    for a, b, name in segs:
        t = time.time()
        p = subprocess.run(["node", f"{REPO}/server/sim.js", "--port", str(port), "--t0", str(a), "--until", str(b), "--dir", DIR, "--run", name], capture_output=True, text=True, timeout=7200)
        o = json.load(open(f"{DIR}/sim_out_{name}.json"))
        print(f"run {name}: {a - T0:+} s .. {b - T0:+} s  exit {p.returncode}  real {time.time() - t:.0f} s  timer pops {o['pops']}  research {o['research']}")
        if p.returncode:
            print(p.stderr[-2000:]); sys.exit(1)
        for l in o["logs"]:
            print("   ", l[:260])
        print("    lanes", o["lanes"], "errors", [e[1] for e in (o["errors"] or [])][-5:])
    J = o["J"]
    st = {"bots": J["bots"], "coins": J["coins"], "now": o["now"], "start": J["start"],
          "P": {b["id"]: b["P"] for b in json.loads(subprocess.check_output(["node", "-e", "console.log(JSON.stringify(require(process.argv[1]).RULES.BOTS))", os.path.join(REPO, "server", "sniper.js")]))}}
    print("crossed", J["n"]["cross"], "passed", J["n"]["pass"], "launches", J["n"]["launch"], "events", len(J["ev"]), "gap events", [e[3][:60] for e in J["ev"] if e[2] == "gap"])
    ok = compare(mk, st)
    # GeckoTerminal load: calls per minute in 10-minute windows of virtual time
    gt_times.sort()
    w = {}
    for t in gt_times:
        w[int((t - T0) // 600)] = w.get(int((t - T0) // 600), 0) + 1
    print("GeckoTerminal calls/min per 10-min window: max %.1f mean %.1f (total %d, all calls %d)" % (max(w.values()) / 10, sum(w.values()) / len(w) / 10, len(gt_times), calls["n"]))
    print("file sizes (max):", o["sizes"])
    # research records vs the market
    recs = []
    for f in sorted(glob.glob(f"{DIR}/research/**/*.gz", recursive=True)):
        recs += [json.loads(l) for l in gzip.open(f, "rt").read().splitlines() if l.strip()]
    rq = json.load(open(f"{DIR}/rq.json"))
    bad = 0
    for r in recs:
        c = mk.by_mint(r["m"])
        ref = E2E.candles_of(c, r["to"])
        ref = [x for x in ref if x[0] >= r["t"] // 60 * 60 - 60]
        got = r["cs"]
        if len(ref) != len(got) or any(abs(a[4] / (b[4] * 1e9) - 1) > 1e-4 or a[0] != b[0] or a[6] != b[6] for a, b in zip(got, ref)):
            bad += 1
            if bad <= 3:
                print("   research mismatch", r["sym"], len(got), len(ref))
    seen = {r["m"] for r in recs}
    late = [q for q in rq if q["due"] < o["now"] - 900]
    print(f"research: {len(recs)} records in {len(glob.glob(f'{DIR}/research/**/*.gz', recursive=True))} files, {bad} differ from the market, {len(rq)} still queued ({len(late)} overdue > 15 min), duplicates {len(recs) - len(seen)}")
    print("ALL BOTS MATCH" if ok else "SOME BOTS DIFFER")
    v11ok = check_v11(mk, J, o)
    print("V11 OK" if v11ok else "V11 PROBLEMS")
    srv.shutdown()


def check_v11(mk, J, o):
    """v11 ran beside the legacy bots: its state must satisfy the invariants (every trade justified by data received before
    its decision, nothing booked inside the outage, books add up), and every E0 account is compared with its legacy bot."""
    f = f"{DIR}/v11.json"
    if not os.path.exists(f):
        print("v11: no v11.json saved"); return False
    r = json.loads(subprocess.check_output(["node", os.path.join(REPO, "server", "v11", "check.js"), f]))
    sym = {c.mint: c.sym for c in mk.coins}
    print(f"v11: status {r['status']['state']} {r['status']['why']}  counts {r['n']}  duplicates {r['dup']}  runtime {o.get('v11')}")
    for g in r["gaps"]:
        print(f"   gap {g['from'] - T0:+.0f} s .. {g['to'] - T0:+.0f} s ({g['why']}): {g['cancelled']} orders cancelled, {g['open']} positions open, hypothetical {g['hypo']}")
    for A in r["accts"]:
        leg = J["bots"].get(A["id"][3:]) if A["id"].startswith("E0-") else None
        ltxt = f" | legacy {len(leg['trades'])} trades, {10 + sum(t['net'] for t in leg['trades']):.3f} SOL realized" if leg else ""
        print(f"   {A['id']:<7} trades {A['trades']:>3} wins {A['wins']:>3} realized {10 + A['realized']:7.3f} SOL  open {(A['open'] or {}).get('sym', '-'):<8} signals {A['n']['signals']:>3} orders {A['n']['orders']:>3} fails {A['n']['fails']:>3} mdd {A['mdd'] * 100:6.2f}%{ltxt}")
        for t in A["list"][:6]:
            print(f"      {sym.get(t['m'], '?'):<8} signal {t['sigAt'] - T0:+8.1f}  quote {t['quoteAt'] - T0:+8.1f}  exit {t['exitQuoteAt'] - T0:+8.1f} {t['reason']:<5} net {t['net']:+.4f}  slip {t['slip'] * 100:5.1f}%  mae {t['mae'] * 100:6.1f}%")
    if r["violations"]:
        print("   VIOLATIONS:"); [print("     ", v) for v in r["violations"][:20]]
    if r["errors"]:
        print("   last errors:", [e[1][:90] for e in r["errors"]])
    sizes = o.get("sizes", {})
    print(f"   v11.json max {sizes.get('v11', 0)} bytes, page view max {sizes.get('v11view', 0)} bytes")
    return not r["violations"] and r["n"]["cross"] > 0


if __name__ == "__main__":
    main()
