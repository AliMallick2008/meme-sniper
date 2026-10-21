"""Independent Python replay of the v11 E0 accounts (the 7 locked legacy rule sets under causal timing), written from the
spec in server/v11/strategies.js and engine.js, not translated from them. Input: the event trace the server wrote
(V11_TRACE: every event in the order the engine got it, plus its once-a-second ticks), the legacy rule sets, and the
saved v11.json. Output: per account, the reference trades vs the engine's, and whether they match exactly.

Spec, in short:
- a young pump.fun coin (seen by Jupiter /recent or a DexScreener pair under 75 min old) crosses when an observation
  shows a SOL pair, a curve pair and a market cap of $7K or more; the first audit and RugCheck report after that decide
  the legacy checks (missing dev % = pass, missing top % = pass, meme = another crossing sharing a name word within 2 h);
  the watch starts when the later of the two arrived and ends 2 h after the crossing; 6 slots, a stronger coin replaces
  the weakest one not near its buy zone;
- high = the highest price observed since the coin was first seen or in a final candle received; buy level = (1 - dip)
  x high; re-arm: an observation above the level first; limit rule: an observation at or under the level; green rule:
  armed by an observation at or under the level, then the first complete own 1-minute bar (2+ observations) closing
  above its open, from the arming minute on;
- a decision needs fresh data (price at most 30 s old, a SOL price, not graduating) and complete data overall (prices
  in the last 60 s, SOL/USD in the last 10 min); the order fills from the first quote for the same route and size
  requested after the decision, within 30 s: tokens = floor(out x 0.995), price at most 10% over the signal price;
  costs 0.0002 + 0.000005 SOL per swap and 0.00203928 SOL rent locked while holding;
- marks: a sell quote for the full size at most 20 s old, else the curve/pool model at a fresh price times the latest
  quote calibration (if at most 90 s old); exits: time limit, mark at the target (+tp after costs), price at the stop;
  a failed exit waits 15 s; a silence over 90 s is a gap: orders cancelled, watches re-armed; a server restart forgets
  young coins and keeps only recent history (as the saved state does)."""
import json, math, re, sys

SUPPLY, CURVE_K, POOL_K = 1e9, 30 * 1.073e9, 85 * 206.9e6
TIERS = [(420, 0.0125), (1470, 0.012), (2460, 0.0115), (3440, 0.011), (4420, 0.0105), (9820, 0.01)]
LAT, PRIO, NETFEE, RENT = 0.005, 0.0002, 0.000005, 0.00203928
FIXED = PRIO + NETFEE
SOL_MINT = "So11111111111111111111111111111111111111112"
GAP_S, TTL_S, FRESH_S, Q_DIRECT_S, Q_CAL_S, FEED_S, SOL_S, RETRY_S, LAND_S = 90, 30, 30, 20, 90, 60, 600, 15, 2
CROSS_MC, FOLLOW_S, MEME_S, WATCH_S, SLOTS, SLIP = 7000, 4500, 7200, 7200, 6, 0.10
STOP = set("the and for you are with this that from have not but all can its was new just get got our out who why how now one two coin token sol solana pump fun meme official".split())


def fee(mc_sol, stage):
    if stage == "curve":
        return 0.0125
    for lim, f in TIERS:
        if mc_sol < lim:
            return f
    return 0.0095


def sell_out(q, p, stage, liq):
    K = CURVE_K
    if stage == "pool":
        K = POOL_K
        if liq and (liq.get("quote") or 0) > 0 and (liq.get("base") or 0) > 0 and abs(liq["quote"] / liq["base"] / p - 1) < 0.15:
            K = liq["quote"] * liq["base"]
    R = math.sqrt(K * p)
    T = R / p
    return (R - K / (T + q)) * (1 - fee(p * SUPPLY, stage))


def progress(mc_sol):
    return max(0.0, min(1.0, (math.sqrt(CURVE_K * mc_sol / SUPPLY) - 30) / 85))


def words(name, sym):
    s = re.sub(r"([a-z])([A-Z])", r"\1 \2", f"{name or ''} {sym or ''}").lower()
    out = []
    for w in re.sub(r"[^a-z]+", " ", s).split(" "):
        if len(w) >= 3 and w not in STOP and w not in out:
            out.append(w)
    return out


class Coin:
    def __init__(self, m, sym, name, t0, at):
        self.m, self.sym, self.name, self.t0, self.first = m, sym or "", name or "", t0, at
        self.quote = self.bc = self.pool = None
        self.last, self.hi, self.chi = None, 0.0, 0.0
        self.stage, self.stage_at = "curve", at
        self.bars, self.bar = [], None          # complete own bars [t, o, h, l, c, n], the forming one
        self.cross = self.audit = self.rc = None
        self.decided = False
        self.dec, self.sq, self.sq_fails, self.sq_fail_at, self.invalid = 6, None, 0, None, False

    def add_obs(self, at, usd):
        t = at // 60 * 60
        if self.bar and self.bar[0] != t:
            self.bars.append(self.bar); self.bar = None
        if not self.bar:
            self.bar = [t, usd, usd, usd, usd, 0]
        b = self.bar
        b[2], b[3], b[4], b[5] = max(b[2], usd), min(b[3], usd), usd, b[5] + 1

    def last_bar(self, at):
        if self.bar and self.bar[0] + 60 <= at:
            self.bars.append(self.bar); self.bar = None
        return self.bars[-1] if self.bars else None


class Ref:
    def __init__(self, bots):
        self.bots = bots
        self.last = None
        self.coins, self.young, self.crosses = {}, {}, []
        self.sol_at = self.last_px = None
        self.schema = []
        self.orders = []
        self.seen = set()
        self.A = {b["id"]: {"id": b["id"], "P": b["P"], "C": b["C"], "cash": 10.0, "pos": None, "trades": [], "watch": [], "start": None} for b in bots}

    # ------------------------------------------------------------------ helpers
    def sol_ok(self):
        return self.sol_at is not None and self.last - self.sol_at <= SOL_S

    def halted(self, at):
        if self.last_px is None or at - self.last_px > FEED_S or not self.sol_ok():
            return True
        return len([e for e in self.schema if e > at - 120]) >= 3

    def blocked(self, k, at):
        p = k.last
        return (not p) or k.invalid or at - p["at"] > FRESH_S or k.stage == "migrating" or not p["sol"]

    def gap(self, frm, to):
        for o in list(self.orders):
            self.fail(o, to, "gap")
        for A in self.A.values():
            for w in A["watch"]:
                if not w["done"]:
                    w["ready"] = False; w["armed"] = False; w["rearm"] = to

    def restart(self):
        """A new server process: young coins are forgotten; inactive coins lose their bars."""
        self.young = {}
        act = set()
        for A in self.A.values():
            if A["pos"]:
                act.add(A["pos"]["m"])
            act.update(w["m"] for w in A["watch"] if not w["done"])
        act.update(o["m"] for o in self.orders)
        for m, k in self.coins.items():
            if m in act:
                k.bars = k.bars[-6:]
            else:
                k.bars, k.bar = [], None

    # ------------------------------------------------------------------ observations
    def observe(self, k, pairs, at):
        pf = next((p for p in pairs if p["dex"] == "pumpfun"), None)
        ps = next((p for p in pairs if p["dex"] == "pumpswap"), None)
        main = ps or pf
        if pf and pf.get("pair"):
            k.bc = pf["pair"]
        if ps and ps.get("pair"):
            k.pool = ps["pair"]
        k.quote = (pf or main).get("quote") or k.quote
        if not ((main.get("usd") or 0) > 0):
            k.invalid = True
            return False
        k.invalid = False
        usd = main["usd"]
        if main.get("quote") == "SOL" and (main.get("native") or 0) > 0:
            sol = main["native"]
        else:
            sol = None   # (the simulator's pairs are all SOL-quoted)
        mc = main["mc"] if (main.get("mc") or 0) > 0 else usd * SUPPLY
        k.last = {"at": at, "usd": usd, "sol": sol, "mc": mc, "liq": main.get("liq")}
        k.hi = max(k.hi, usd)
        k.add_obs(at, usd)
        prog = progress(sol * SUPPLY) if sol else 0
        st = "pool" if (ps or k.stage == "pool") else "migrating" if (prog >= 0.999 or (k.stage == "migrating" and prog >= 0.98)) else "curve"
        if st != k.stage:
            k.stage, k.stage_at = st, at
        return True

    def gates(self, k):
        """Legacy checks once both first reports are in; the watch starts when the later one arrived."""
        if k.decided or not k.audit or not k.rc:
            return
        k.decided = True
        best, word = 0, None
        for w in k.words:
            n = sum(1 for tc, m, cw in self.crosses if m != k.m and k.cross["at"] - MEME_S <= tc < k.cross["at"] and w in cw)
            if n > best:
                best, word = n, w
        a = None if k.audit.get("missing") else k.audit
        rc = None if k.rc.get("missing") else k.rc
        soc = (a or {}).get("soc") or {}
        score = float(f"{best * 10 + min(10, ((a or {}).get('holders') or 0) / 20) + (3 if any(soc.values()) else 0) + min(5, ((a or {}).get('org') or 0) / 10):.2f}")
        elig = max(k.cross["at"], k.audit["at"], k.rc["at"])
        for A in self.A.values():
            C = A["C"]
            ok = bool(a and a.get("mintOff") is True and a.get("freezeOff") is True)
            ok = ok and (a.get("dev") is None or a["dev"] <= C["devMax"]) and (a.get("top") is None or a["top"] <= C["topMax"])
            ok = ok and bool(rc) and not rc["danger"] and (not C.get("rcMax") or (rc.get("sn") is not None and rc["sn"] <= C["rcMax"]))
            ok = ok and best >= C["needMeme"]
            if C.get("minHolders"):
                ok = ok and (a.get("holders") or 0) >= C["minHolders"]
            if C.get("social"):
                ok = ok and any(soc.values())
            if C.get("devMints"):
                ok = ok and a.get("devMints") is not None and a["devMints"] <= C["devMints"]
            if ok and A["start"] is not None:
                self.watch(A, k, elig, score)

    def watch(self, A, k, elig, score):
        if any(w["m"] == k.m for w in A["watch"]):
            return
        to = k.cross["at"] + WATCH_S
        if elig >= to:
            return
        live = [w for w in A["watch"] if not w["done"] and w["to"] > elig]
        if len(live) >= SLOTS:
            def near(w):
                c = self.coins.get(w["m"])
                if not c or not c.last or not (w.get("trig") or 0) > 0:
                    return True
                return c.last["usd"] <= w["trig"] * 1.25 if w["ready"] else c.last["usd"] >= w["trig"] * 0.95
            far = sorted([w for w in live if not near(w)], key=lambda w: w["score"])
            if not far or far[0]["score"] >= score:
                return
            far[0]["done"] = "dropped"
        A["watch"].append({"m": k.m, "from": elig, "to": to, "ready": not A["P"]["rearm"], "armed": False, "done": None, "score": score})

    # ------------------------------------------------------------------ orders
    def fail(self, o, at, why):
        self.orders.remove(o)
        A = self.A[o["acct"]]
        if o["side"] == "sell":
            if A["pos"]:
                A["pos"]["retry"] = at + RETRY_S
        else:
            for w in A["watch"]:
                if w["m"] == o["m"] and not w["done"]:
                    w["fail_at"], w["cool"] = at, at + 10
                    break

    def quote(self, ev, at):
        key = (ev["inMint"], ev["outMint"], ev["amount"])
        sell_of = ev["inMint"] if ev["outMint"] == SOL_MINT else None
        k = self.coins.get(sell_of or ev["outMint"])
        if k and ev.get("ok") and ev.get("labels"):
            if any(re.search("pump", l, re.I) and re.search("amm|swap", l, re.I) for l in ev["labels"]) and k.stage != "pool":
                k.stage, k.stage_at = "pool", at
        if k and sell_of:
            if ev.get("ok"):
                p = k.last if (k.last and at - k.last["at"] <= FRESH_S and k.last["sol"]) else None
                cal = None
                if p:
                    mod = sell_out(ev["amount"] / 10 ** k.dec, p["sol"], "pool" if k.stage == "pool" else "curve", p["liq"] if k.stage == "pool" else None)
                    if mod > 0:
                        cal = max(0.2, min(1.5, ev["outAmount"] / 1e9 / mod))
                k.sq = {"at": at, "amount": ev["amount"], "out": ev["outAmount"] / 1e9, "cal": cal}
                k.sq_fails = 0
            elif not ev.get("retry"):
                k.sq_fails += 1; k.sq_fail_at = at
        if k and not ev.get("ok") and not ev.get("retry") and k.stage == "curve" and k.last and k.last["sol"] and progress(k.last["sol"] * SUPPLY) >= 0.98:
            k.stage, k.stage_at = "migrating", at
        for o in list(self.orders):
            if o["key"] != key or not (ev["req"] >= o["at"]):
                continue
            if not ev.get("ok"):
                if not ev.get("retry"):
                    self.fail(o, at, ev.get("why"))
                continue
            A, c = self.A[o["acct"]], self.coins[o["m"]]
            if o["side"] == "buy":
                if A["pos"] or (c.stage == "migrating" and not any(re.search("amm|swap", l, re.I) for l in ev.get("labels") or [])):
                    self.fail(o, at, "no"); continue
                raw = math.floor(ev["outAmount"] * (1 - LAT))
                qty = raw / 10 ** c.dec
                px = o["stake"] / qty if qty > 0 else math.inf
                if qty <= 0 or px > o["max_px"] or A["cash"] < o["stake"] + FIXED + RENT - 1e-12:
                    self.fail(o, at, "no"); continue
                self.orders.remove(o)
                A["cash"] -= o["stake"] + FIXED + RENT
                mkt = c.last["sol"] if (c.last and at - c.last["at"] <= FRESH_S) else None
                P = A["P"]
                cost = o["stake"] + FIXED
                A["pos"] = {"m": o["m"], "sig_at": o["sig_at"], "at": o["at"], "quote_at": at, "fill_at": at + LAND_S, "stake": o["stake"], "qty": qty, "raw": raw,
                            "cost": cost, "tp_val": cost * (1 + P["tp"]), "sl_px": (1 - P["sl"]) * (mkt or px) if P["sl"] else None,
                            "max_hold": P["maxHold"] * 60 if P["maxHold"] else None, "retry": None, "mark": None}
                for w in A["watch"]:
                    if w["m"] == o["m"] and not w["done"]:
                        w["done"] = "bought"; break
                self.mark(A, at)
            else:
                pos = A["pos"]
                if not pos or pos["m"] != o["m"]:
                    self.fail(o, at, "no"); continue
                self.orders.remove(o)
                proceeds = ev["outAmount"] / 1e9 * (1 - LAT)
                A["cash"] += proceeds - FIXED + RENT
                A["trades"].append({"m": pos["m"], "sigAt": pos["sig_at"], "at": pos["at"], "quoteAt": pos["quote_at"], "exitAt": o["at"], "exitQuoteAt": at,
                                    "reason": o["reason"], "net": proceeds - FIXED - pos["cost"]})
                A["pos"] = None
                for w in A["watch"]:
                    if not w["done"]:
                        if w["to"] <= at + 60:
                            w["done"] = "missed"
                        else:
                            w["ready"] = not A["P"]["rearm"]; w["armed"] = False; w["rearm"] = at

    def mark(self, A, at):
        pos = A["pos"]
        k = self.coins[pos["m"]]
        p = k.last if (k.last and at - k.last["at"] <= FRESH_S and not k.invalid and k.last["sol"]) else None
        sq, v = k.sq, None
        if k.stage == "migrating":
            if sq and sq["at"] > max(k.stage_at, k.sq_fail_at or 0) and sq["amount"] == pos["raw"] and at - sq["at"] <= Q_DIRECT_S:
                v = sq["out"] * (1 - LAT) - FIXED
        elif sq and sq["amount"] == pos["raw"] and at - sq["at"] <= Q_DIRECT_S:
            v = sq["out"] * (1 - LAT) - FIXED
        elif p:
            v = sell_out(pos["qty"], p["sol"], "pool" if k.stage == "pool" else "curve", p["liq"] if k.stage == "pool" else None) * (1 - LAT)
            if sq and sq["cal"] and at - sq["at"] <= Q_CAL_S:
                v *= sq["cal"]
            v -= FIXED
        pos["mark"] = max(0.0, v) if v is not None else None

    # ------------------------------------------------------------------ decisions
    def evaluate(self, at):
        for A in self.A.values():
            pos = A["pos"]
            if A["start"] is None or not pos:
                continue
            self.mark(A, at)
            if any(o["acct"] == A["id"] for o in self.orders) or (pos["retry"] and at < pos["retry"]):
                continue
            k, why = self.coins[pos["m"]], None
            if pos["max_hold"] and at >= pos["fill_at"] + pos["max_hold"]:
                why = "time"
            elif pos["mark"] is not None and pos["mark"] >= pos["tp_val"]:
                why = "tp"
            elif pos["sl_px"] and not self.blocked(k, at) and k.last["sol"] <= pos["sl_px"]:
                why = "sl"
            if why:
                self.orders.append({"acct": A["id"], "side": "sell", "m": pos["m"], "at": at, "ttl": at + TTL_S, "key": (pos["m"], SOL_MINT, pos["raw"]), "reason": why})
        for A in self.A.values():
            if A["start"] is None or A["pos"] or any(o["acct"] == A["id"] for o in self.orders):
                continue
            self.entry(A, at)

    def entry(self, A, at):
        if self.halted(at):
            return
        P = A["P"]
        stake = min(P["stake"], A["cash"] - PRIO - NETFEE - RENT)
        for w in A["watch"]:
            if w["done"]:
                continue
            if at >= w["to"]:
                w["done"] = "nodip"; continue
            if at < w["from"] or (w.get("cool") and at < w["cool"]):
                continue
            k = self.coins.get(w["m"])
            if not k or not k.last:
                continue
            H = max(k.hi, k.chi)
            if not H > 0:
                continue
            trig, p = (1 - P["dip"]) * H, k.last
            w["trig"] = trig
            if p["at"] < max(w["from"], w.get("rearm") or 0, w.get("fail_at") or 0):
                continue
            if not w["ready"]:
                if p["usd"] > trig:
                    w["ready"] = True
                else:
                    continue
            sig = False
            if P["entry"] == "limit":
                sig = p["usd"] <= trig
            else:
                if not w["armed"] and p["usd"] <= trig:
                    w["armed"], w["arm_at"] = True, p["at"]
                if w["armed"]:
                    b = k.last_bar(at)
                    if b and b[0] >= w["arm_at"] // 60 * 60 and b[0] > (w.get("bar_used") or 0) and b[5] >= 2 and b[4] > b[1]:
                        w["bar_used"], sig = b[0], True
            if not sig or self.blocked(k, at):
                continue
            if not stake >= 0.05:
                return
            amount = math.floor(stake * 1e9 + 0.5)   # JavaScript's Math.round
            self.orders.append({"acct": A["id"], "side": "buy", "m": k.m, "at": at, "ttl": at + TTL_S, "key": (SOL_MINT, k.m, amount), "stake": stake,
                                "sig_at": p["at"], "max_px": p["sol"] * (1 + SLIP)})
            return

    # ------------------------------------------------------------------ the event loop
    def run(self, events):
        for ev in events:
            typ = ev["type"]
            if typ == "tick":
                at = self.advance(ev["at"], typ)
                for o in list(self.orders):
                    if at > o["ttl"]:
                        self.fail(o, at, "ttl")
                self.evaluate(at)
                continue
            if ev.get("id") in self.seen:
                continue
            self.seen.add(ev.get("id"))
            prev = self.last
            at = self.advance(ev["at"], typ)
            if typ == "run_start":
                if prev is not None:
                    self.restart()
                    if ev["at"] - prev > GAP_S:
                        self.gap(prev, ev["at"])
                for A in self.A.values():
                    if A["start"] is None:
                        A["start"] = ev["at"]
            elif typ == "coin":
                if ev["m"] not in self.coins and ev["m"] not in self.young and ev.get("t0") and at - ev["t0"] < FOLLOW_S:
                    self.young[ev["m"]] = Coin(ev["m"], ev.get("sym"), ev.get("name"), ev["t0"], at)
            elif typ == "px":
                k = self.coins.get(ev["m"])
                pf = next((p for p in ev["pairs"] if p["dex"] == "pumpfun"), None)
                if not k and ev["m"] not in self.young:
                    if not pf or not pf.get("created") or at - pf["created"] > FOLLOW_S:
                        self.evaluate(at); continue
                    self.young[ev["m"]] = Coin(ev["m"], pf.get("sym"), pf.get("name"), pf["created"], at)
                self.last_px = at
                if k:
                    self.observe(k, ev["pairs"], at)
                else:
                    y = self.young[ev["m"]]
                    if self.observe(y, ev["pairs"], at):
                        if y.t0 and at - y.t0 > FOLLOW_S:
                            del self.young[ev["m"]]
                        elif y.quote == "SOL" and y.bc and y.last["mc"] >= CROSS_MC:
                            del self.young[ev["m"]]
                            y.cross, y.words = {"at": at, "mc": y.last["mc"]}, words(y.name, y.sym)
                            self.coins[y.m] = y
                            self.crosses.append((at, y.m, y.words))
            elif typ == "jup":
                k = self.coins.get(ev["m"])
                if k:
                    if ev.get("dec") is not None and 0 <= ev["dec"] <= 12:
                        k.dec = ev["dec"]
                    if not k.audit:
                        cl = ev.get("claims") or {}
                        k.audit = dict(ev["audit"], at=at, holders=ev.get("holders"), org=ev.get("org"), soc={"tw": bool(cl.get("tw")), "web": bool(cl.get("web")), "tg": bool(cl.get("tg"))})
                    self.gates(k)
            elif typ == "rc":
                k = self.coins.get(ev["m"])
                if k:
                    if not k.rc:
                        k.rc = {"at": at, "missing": True} if ev.get("missing") else {"at": at, "danger": ev.get("danger") or [], "sn": ev.get("sn")}
                    self.gates(k)
            elif typ == "quote":
                self.quote(ev, at)
            elif typ == "sol":
                self.sol_at = at
            elif typ == "candles":
                k = next((c for c in self.coins.values() if c.bc == ev["pool"] or c.pool == ev["pool"]), None)
                if k:
                    for r in ev["rows"]:
                        if r[0] + 120 <= at:
                            k.chi = max(k.chi, r[2])
            elif typ == "schema":
                self.schema.append(at)
            self.evaluate(at)

    def advance(self, t, typ):
        if self.last is not None and typ != "run_start" and t - self.last > GAP_S:
            self.gap(self.last, t)
        if self.last is None or t > self.last:
            self.last = t
        return self.last


def compare(trace_path, v11_path, bots):
    events = [json.loads(l) for l in open(trace_path) if l.strip()]
    ref = Ref(bots)
    ref.run(events)
    S = json.load(open(v11_path))
    ok_all, out = True, []
    for b in bots:
        aid = "E0-" + b["id"]
        R, E = ref.A[b["id"]], S["accts"][aid]
        et = E["trades"]
        same = len(R["trades"]) == len(et)
        for x, y in zip(R["trades"], et):
            same = same and x["m"] == y["m"] and abs(x["at"] - y["at"]) < 1e-6 and abs(x["quoteAt"] - y["quoteAt"]) < 1e-6 and abs(x["exitAt"] - y["exitAt"]) < 1e-6 \
                and abs(x["exitQuoteAt"] - y["exitQuoteAt"]) < 1e-6 and x["reason"] == y["exitReason"] and abs(x["net"] - y["net"]) < 1e-9
        ep, rp = E["pos"], R["pos"]
        same = same and (ep is None) == (rp is None) and (ep is None or (ep["m"] == rp["m"] and abs(ep["at"] - rp["at"]) < 1e-6))
        same = same and abs(R["cash"] - E["cash"]) < 1e-9
        ok_all = ok_all and same
        out.append((aid, len(R["trades"]), len(et), R["cash"], E["cash"], same, R["trades"], et))
    return ok_all, out, len(events)


if __name__ == "__main__":
    bots = json.loads(sys.argv[3]) if len(sys.argv) > 3 else None
    ok, rows, n = compare(sys.argv[1], sys.argv[2], bots)
    for r in rows:
        print(r[0], r[1], r[2], round(r[3], 9), round(r[4], 9), "MATCH" if r[5] else "DIFF")
    print("E0 REFERENCE MATCH" if ok else "E0 REFERENCE DIFF", n, "events")
