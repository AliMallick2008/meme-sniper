"""Synthetic pump.fun market + mock APIs for testing the Meme Sniper in headless Chromium with a fake clock.

Every coin has 1-minute candles (USD) defined by market-cap waypoints; inside a minute the price walks
open -> first extreme (20 s) -> second extreme (40 s) -> close (60 s), so partial candles and live prices are exact.
The mock APIs mirror the real response shapes seen on Oct 19 2026 (Jupiter tokens v2, DexScreener tokens/v1,
GeckoTerminal OHLCV, RugCheck summary, Coinbase SOL-USD)."""
import math, random, json, re
from urllib.parse import urlparse, parse_qs
from datetime import datetime, timezone

B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
SUPPLY = 1e9
SOL_USD = 105.0
GRAD_MC = 410.9 * SOL_USD  # bonding curve completes here
FLOOR_MC = 30 / 1.073e9 * 1e9 * SOL_USD  # launch price x supply: the lowest market cap on the curve


SOL_MINT = "So11111111111111111111111111111111111111112"
CURVE_K = 30 * 1.073e9          # pump.fun bonding curve: virtual SOL x virtual tokens
POOL_K = 85 * 206.9e6           # PumpSwap pool right after graduation
Q_TIERS = [(420, 0.0125), (1470, 0.012), (2460, 0.0115), (3440, 0.011), (4420, 0.0105), (9820, 0.01)]


def q_fee(mc_sol, pool):
    if not pool:
        return 0.0125
    for lim, f in Q_TIERS:
        if mc_sol < lim:
            return f
    return 0.0095


def b58(rng, n, suffix=""):
    return "".join(rng.choice(B58) for _ in range(n - len(suffix))) + suffix


def iso(t):
    return datetime.fromtimestamp(t, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


class Coin:
    def __init__(self, rng, t0, name, sym, waypoints, audit=None, risks=None, holders=120, socials=None, noise=0.01, seed=0):
        self.name, self.sym, self.created = name, sym, int(t0)
        self.mint = b58(rng, 44, "pump")
        self.bc = b58(rng, 44)
        self.pool = None          # PumpSwap pool after graduation
        self.grad_t = None
        self.audit = audit if audit is not None else {"mintAuthorityDisabled": True, "freezeAuthorityDisabled": True,
                                                      "devBalancePercentage": 2.0, "topHoldersPercentage": 18.0, "devMints": 3}
        self.risks = risks if risks is not None else []
        self.holders = holders
        self.socials = socials or {}
        self.icon = ""
        r = random.Random(seed or hash(self.mint) & 0xFFFFFFFF)
        # minute closes from waypoints (geometric interpolation + small noise)
        m0 = (self.created // 60) * 60
        wps = [(0, 2900.0)] + list(waypoints)
        end = wps[-1][0]
        closes = []
        for k in range(int(end // 60) + 2):
            tt = k * 60 + 60 - (self.created - m0)   # seconds since creation at this minute's close
            j = 0
            while j < len(wps) - 1 and wps[j + 1][0] < tt:
                j += 1
            if j >= len(wps) - 1:
                mc = wps[-1][1]
            else:
                (ta, a), (tb, b) = wps[j], wps[j + 1]
                f = min(1, max(0, (tt - ta) / (tb - ta))) if tb > ta else 1
                mc = a * (b / a) ** f
            closes.append(mc * (1 + r.uniform(-noise, noise)))
        self.cs = {}
        prev = 2900.0
        for k, c in enumerate(closes):
            t = m0 + k * 60
            o = prev
            w1, w2 = r.uniform(0, 0.02), r.uniform(0, 0.02)
            if self.grad_t is None:          # on the bonding curve the price can't go under the launch price
                c = max(c, FLOOR_MC * (1 + r.uniform(0, 0.004)))
            hi, lo = max(o, c) * (1 + w1), min(o, c) * (1 - w2)
            if self.grad_t is None:
                lo = max(lo, FLOOR_MC)
            v = r.uniform(2, 40) * SOL_USD * (1 + abs(c / o - 1) * 10)
            self.cs[t] = [o / SUPPLY, hi / SUPPLY, lo / SUPPLY, c / SUPPLY, v]
            prev = c
            if self.grad_t is None and c >= GRAD_MC:
                self.grad_t = t + 60     # graduates at the end of this minute
                self.pool = b58(rng, 44)
        self.end_t = m0 + len(closes) * 60

    def path(self, t):
        """(open, ext1, ext2, close) waypoints of the minute containing t."""
        m = (int(t) // 60) * 60
        o, h, l, c, v = self.cs[m]
        return m, ((o, h, l, c) if c < o else (o, l, h, c)), v

    def price(self, t):
        if t < self.created:
            return None
        if t >= self.end_t:
            return self.cs[self.end_t - 60][3]
        m, pts, _ = self.path(t)
        f = (t - m) / 60 * 3
        i = min(2, int(f))
        return pts[i] + (pts[i + 1] - pts[i]) * (f - i)

    def candle(self, m, now):
        """Candle starting at m as known at time now (partial if the minute is still forming)."""
        if m + 60 <= now:
            o, h, l, c, v = self.cs[m]
            return [m, o, h, l, c, v]
        _, pts, v = self.path(m)
        f = (now - m) / 60 * 3
        seen = [pts[0]]
        for i in range(3):
            if f >= i + 1:
                seen.append(pts[i + 1])
            else:
                seen.append(pts[i] + (pts[i + 1] - pts[i]) * max(0, f - i))
                break
        return [m, pts[0], max(seen), min(seen), seen[-1], v * min(1, (now - m) / 60)]

    def on_pool(self, t):
        return self.grad_t is not None and t >= self.grad_t


class Market:
    def __init__(self, t0, seed=1):
        self.t0 = t0
        self.rng = random.Random(seed)
        self.coins = []
        self.calls = {}
        self.gt_snap_offset = 10   # GeckoTerminal keyless cache: one snapshot a minute, 10 s after the minute

    def add(self, dt, name, sym, waypoints, **kw):
        c = Coin(self.rng, self.t0 + dt, name, sym, waypoints, seed=self.rng.randint(1, 1 << 30), **kw)
        self.coins.append(c)
        return c

    def filler(self, n, span):
        """Coins that never get anywhere (die under $5k)."""
        words = ["moon", "inu", "baby", "king", "doge", "chad", "pepe", "wojak", "elon", "trump", "based", "giga", "sigma"]
        for i in range(n):
            dt = self.rng.uniform(0, span)
            w = self.rng.choice(words) + str(i)
            peak = self.rng.uniform(3200, 5200)
            self.add(dt, w.title() + " Coin", w.upper()[:6], [(self.rng.uniform(60, 240), peak), (self.rng.uniform(300, 900), 2950)])

    # ------------------------------------------------------------------ API responses
    def by_mint(self, m):
        for c in self.coins:
            if c.mint == m:
                return c
        return None

    def by_pool(self, p):
        for c in self.coins:
            if c.bc == p or c.pool == p:
                return c
        return None

    def jup_token(self, c, now, full=False):
        px = c.price(now) or c.cs[min(c.cs)][0]
        d = {"id": c.mint, "name": c.name, "symbol": c.sym, "icon": c.icon, "decimals": 6, "launchpad": "pump.fun",
             "circSupply": SUPPLY, "totalSupply": SUPPLY, "mcap": px * SUPPLY, "fdv": px * SUPPLY, "usdPrice": px,
             "firstPool": {"createdAt": iso(c.created), "id": c.mint}, "createdAt": iso(c.created),
             "audit": dict(c.audit), "organicScore": 12.5, "organicScoreLabel": "low", "tags": ["unknown", "token-2022"],
             "twitter": c.socials.get("tw"), "website": c.socials.get("web"), "telegram": c.socials.get("tg"), "dev": "Dev" + c.mint[:8]}
        if full:
            d["holderCount"] = c.holders
            d["stats5m"] = self.stats5m(c, now)
        return d

    def stats5m(self, c, now):
        """Jupiter's rolling 5-minute stats, made up from the price path: rising -> buyers' notional dominates."""
        p1, p0 = c.price(now), c.price(max(c.created, now - 300))
        if not p1 or not p0:
            return {"numBuys": 0, "numSells": 0, "numTraders": 0}
        m = (int(now) // 60) * 60
        vol = sum(c.cs[t][4] for t in range(m - 300, m, 60) if t in c.cs) or 1.0
        r = p1 / p0 - 1
        share = min(0.9, max(0.1, 0.5 + 1.5 * r))
        nt = int(vol / 60) + 5
        return {"buyVolume": round(vol * share, 2), "sellVolume": round(vol * (1 - share), 2), "numBuys": int(nt * share * 1.4), "numSells": int(nt * (1 - share) * 1.4),
                "numTraders": nt, "numNetBuyers": int((share - 0.5) * nt), "holderChange": int((share - 0.5) * nt), "priceChange": round(r * 100, 3)}

    def dex_pairs(self, c, now):
        out = []
        if now < c.created + 20:      # DexScreener indexes a new pair within ~20 s
            return out
        on_pool = c.on_pool(now)
        tcurve = min(now, c.grad_t) if c.grad_t else now
        pc = c.price(tcurve - (1 if on_pool else 0))
        mk = lambda px: {"chainId": "solana", "baseToken": {"address": c.mint, "name": c.name, "symbol": c.sym},
                         "quoteToken": {"address": "So11111111111111111111111111111111111111112", "name": "Wrapped SOL", "symbol": "SOL"},
                         "priceNative": f"{px * SUPPLY / SUPPLY / SOL_USD:.12f}", "priceUsd": f"{px:.10f}",
                         "txns": {"m5": {"buys": 40, "sells": 22}, "h1": {"buys": 300, "sells": 180}}, "volume": {"m5": 1500, "h1": 15000},
                         "priceChange": {"m5": 1.0, "h1": 20.0}, "fdv": px * SUPPLY, "marketCap": px * SUPPLY,
                         "pairCreatedAt": c.created * 1000, "info": None}
        p = mk(pc)
        p.update({"dexId": "pumpfun", "url": f"https://dexscreener.com/solana/{c.bc}", "pairAddress": c.bc})
        out.append(p)
        if on_pool:
            q = mk(c.price(now))
            q.update({"dexId": "pumpswap", "url": f"https://dexscreener.com/solana/{c.pool}", "pairAddress": c.pool,
                      "liquidity": {"usd": 30000, "base": 1e8, "quote": 150}, "pairCreatedAt": c.grad_t * 1000})
            out.append(q)
        return out

    def ohlcv(self, pool, now, before=None, limit=1000, empty=False):
        c = self.by_pool(pool)
        if not c:
            return None
        snap = ((int(now) - self.gt_snap_offset) // 60) * 60 + self.gt_snap_offset   # last GT snapshot
        if snap > now:
            snap -= 60
        start = c.created // 60 * 60 if pool == c.bc else c.grad_t
        stop = (c.grad_t if (pool == c.bc and c.grad_t) else c.end_t)
        rows = []
        m = start
        while m < stop and m <= snap - 1:
            if before and m >= before:
                break
            if m in c.cs:
                cd = c.candle(m, snap)
                if empty or cd[5] > 0:
                    rows.append(cd)
            m += 60
        rows = rows[-limit:]
        return {"data": {"id": "x", "type": "ohlcv_request_response", "attributes": {"ohlcv_list": [r for r in reversed(rows)]}},
                "meta": {"base": {"name": c.name, "symbol": c.sym, "address": c.mint}, "quote": {"symbol": "SOL"}}}

    def rugcheck(self, c):
        return {"tokenProgram": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb", "tokenType": "",
                "risks": [{"name": n, "value": "", "description": n, "score": 5000, "level": lv} for n, lv in c.risks],
                "score": 1 + 5000 * len(c.risks), "score_normalised": min(100, 1 + 20 * len(c.risks)), "lpLockedPct": 0}

    def quote(self, q, now):
        """Jupiter swap quote for an exact size: constant-product math on the coin's curve (or PumpSwap pool after
        graduation) at the price at `now`, venue fee inside outAmount, like the real endpoint. 400 when there is no route."""
        inm, outm, amt = q.get("inputMint", [""])[0], q.get("outputMint", [""])[0], int(q.get("amount", ["0"])[0] or 0)
        mint = outm if inm == SOL_MINT else inm
        c = self.by_mint(mint)
        if not c or now < c.created + 5 or amt <= 0:
            return 400, {"error": "Could not find any route", "errorCode": "COULD_NOT_FIND_ANY_ROUTE"}
        p = c.price(now) / SOL_USD
        pool = c.on_pool(now)
        k = POOL_K if pool else CURVE_K
        R = math.sqrt(k * p)
        T = R / p
        f = q_fee(p * SUPPLY, pool)
        if inm == SOL_MINT:
            net = amt / 1e9 * (1 - f)
            tok = T - k / (R + net)
            out, impact = int(tok * 1e6), (net / tok) / p - 1
        else:
            Q = amt / 1e6
            g = R - k / (T + Q)
            out, impact = int(g * (1 - f) * 1e9), 1 - (g / Q) / p
        label = "Pump.fun Amm" if pool else "Pump.fun"
        return 200, {"inputMint": inm, "inAmount": str(amt), "outputMint": outm, "outAmount": str(out), "otherAmountThreshold": str(int(out * 0.9)),
                     "swapMode": "ExactIn", "slippageBps": 1000, "priceImpactPct": f"{impact:.8f}",
                     "routePlan": [{"swapInfo": {"ammKey": c.pool if pool else c.bc, "label": label, "inputMint": inm, "outputMint": outm, "inAmount": str(amt), "outAmount": str(out), "feeAmount": "0", "feeMint": SOL_MINT}, "percent": 100}],
                     "contextSlot": int(now * 2.5), "timeTaken": 0.002}

    def handle(self, url, now):
        """Return (status, json) for a mocked API URL at time now, or None if not mocked."""
        u = urlparse(url)
        q = parse_qs(u.query)
        host, path = u.netloc, u.path
        key = host + re.sub(r"/[1-9A-HJ-NP-Za-km-z]{32,44}(pump)?", "/{id}", path)
        self.calls[key] = self.calls.get(key, 0) + 1
        if host == "lite-api.jup.ag":
            if path.endswith("/swap/v1/quote"):
                return self.quote(q, now)
            if path.endswith("/recent"):
                fresh = [c for c in self.coins if now - 45 <= c.created <= now]
                fresh.sort(key=lambda c: -c.created)
                return 200, [self.jup_token(c, now) for c in fresh[:30]]
            if path.endswith("/search"):
                ids = q.get("query", [""])[0].split(",")
                return 200, [self.jup_token(c, now, True) for c in (self.by_mint(i) for i in ids) if c and c.created <= now]
            if "/toptraded/" in path or "/toptrending/" in path or "/toporganicscore/" in path:
                return 200, []
            return 404, {"error": "not found"}
        if host == "api.dexscreener.com":
            m = re.match(r"/tokens/v1/solana/(.+)", path)
            if m:
                out = []
                for i in m.group(1).split(","):
                    c = self.by_mint(i)
                    if c:
                        out += self.dex_pairs(c, now)
                return 200, out
            return 404, {}
        if host == "api.geckoterminal.com":
            m = re.match(r"/api/v2/networks/solana/pools/([^/]+)/ohlcv/minute", path)
            if m:
                bt = q.get("before_timestamp")
                r = self.ohlcv(m.group(1), now, int(bt[0]) if bt else None, int(q.get("limit", ["100"])[0]),
                               q.get("include_empty_intervals", ["false"])[0] == "true")
                return (200, r) if r else (404, {"errors": [{"status": "404"}]})
            return 404, {}
        if host == "api.rugcheck.xyz":
            m = re.match(r"/v1/tokens/([^/]+)/report/summary", path)
            c = self.by_mint(m.group(1)) if m else None
            return (200, self.rugcheck(c)) if c else (404, {})
        if host == "api.exchange.coinbase.com" and "SOL-USD" in path:
            if path.endswith("/ticker"):
                return 200, {"price": f"{SOL_USD:.2f}", "time": iso(now)}
            if path.endswith("/candles"):
                s = int(datetime.fromisoformat(q["start"][0].replace("Z", "+00:00")).timestamp())
                e = int(datetime.fromisoformat(q["end"][0].replace("Z", "+00:00")).timestamp())
                rows = [[t, SOL_USD - .2, SOL_USD + .2, SOL_USD, SOL_USD, 100] for t in range(s // 60 * 60, min(e, int(now)) + 1, 60)]
                return 200, list(reversed(rows))
        return None
