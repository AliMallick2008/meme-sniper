"""Independent Python re-check of the live v11 E0 accounts (the legacy rules with honest timing) and HOLD.

It reads the engine inputs the server recorded (DIR/v11-inputs/**/*.jsonl.gz), feeds them through this separate
re-implementation of the E0/HOLD rules, restarts from each committed save the way the server does (bars cut to 20 and
rounded to 6 digits, `seen` cut to {at, pass}, JSON on the way), and compares every E0/HOLD account, every E0 order and
the coins they use with the state each later run loaded (`L` lines) and with the final DIR/v11.json.

Written from the rules (docs/v11 spec of the engine), not translated from server/v11. JS number semantics are copied
where they matter: toFixed/toPrecision round half up on the exact binary value, null counts as 0 and undefined as NaN in
arithmetic, NaN is falsy, Math.min/max return NaN when any argument is NaN, JSON turns NaN into null and drops undefined.

Not modelled: the V2 accounts A/B/C. They touch E0 only through coin pruning (a coin a V2 account holds is kept), which
can change S.lastFeedAt and the entries-halted state in a quiet market; both are compared at every restart and at the
end, so a divergence there shows up as a mismatch instead of passing silently.

Usage: python3 v11_e0_ref.py DIR [--live]   DIR holds v11-inputs/ and v11.json: the simulator output (dashboard/.out/srv_sim)
or real data (`server/tools/fetch_research.sh DIR` plus v11.json from the data branch). --live: the data branch's v11.json
is usually newer than the last uploaded input file; when it is, the end of the recording is compared with the JS engine's
own replay of the same inputs (server/v11/record.js replayExact, needs node) instead. Every run start is compared with
what the server loaded. Last line: ALL E0 MATCH or E0 DIFFERS."""
import copy, glob, gzip, json, math, os, re, subprocess, sys, time
from decimal import Decimal, ROUND_HALF_UP

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


# ------------------------------------------------------------------------------------------------ JS value semantics
class _Undef:
    __slots__ = ()
    def __repr__(self): return 'undefined'
    def __bool__(self): return False
UNDEF = _Undef()
NAN, INF = float('nan'), float('inf')


def g(d, k):
    """d[k] as JS reads it: undefined when the key is missing."""
    return d.get(k, UNDEF) if isinstance(d, dict) else UNDEF


def truthy(v):
    if v is None or v is UNDEF or v is False:
        return False
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        return not (v == 0 or v != v)
    if isinstance(v, str):
        return v != ''
    return True                      # objects and arrays, empty ones included


_NUMRE = re.compile(r'[+-]?(\d+\.?\d*([eE][+-]?\d+)?|\.\d+([eE][+-]?\d+)?)$')


def N(v):
    """JS ToNumber."""
    if v is None:
        return 0
    if v is UNDEF:
        return NAN
    if isinstance(v, bool):
        return 1 if v else 0
    if isinstance(v, (int, float)):
        return v
    if isinstance(v, str):
        s = v.strip(' \t\n\r\v\f ﻿')
        if s == '':
            return 0
        if s in ('Infinity', '+Infinity'):
            return INF
        if s == '-Infinity':
            return -INF
        if re.match(r'0[xX][0-9a-fA-F]+$', s):
            return int(s, 16)
        if re.match(r'0[oO][0-7]+$', s):
            return int(s, 8)
        if re.match(r'0[bB][01]+$', s):
            return int(s, 2)
        return float(s) if _NUMRE.match(s) else NAN
    return NAN


def isnan(x):
    return isinstance(x, float) and x != x


def jmin(*a):
    a = [N(x) for x in a]
    return NAN if any(isnan(x) for x in a) else min(a)


def jmax(*a):
    a = [N(x) for x in a]
    return NAN if any(isnan(x) for x in a) else max(a)


def fdiv(a, b):
    a, b = N(a), N(b)
    if b == 0:
        if a == 0 or isnan(a):
            return NAN
        return math.copysign(INF, a) * math.copysign(1.0, float(b))
    return a / b


def jsqrt(x):
    x = N(x)
    return NAN if isnan(x) or x < 0 else math.sqrt(x)


def jstr(v):
    """String(v) for the values that end up in ids and texts."""
    if v is None:
        return 'null'
    if v is UNDEF:
        return 'undefined'
    if isinstance(v, bool):
        return 'true' if v else 'false'
    if isinstance(v, float):
        if v != v:
            return 'NaN'
        if v in (INF, -INF):
            return 'Infinity' if v > 0 else '-Infinity'
        if v == int(v) and abs(v) < 1e21:
            return str(int(v))
        return repr(v)
    return str(v)


def to_fixed(x, d):
    x = N(x)
    if isnan(x):
        return 'NaN'
    if x in (INF, -INF):
        return 'Infinity' if x > 0 else '-Infinity'
    if abs(x) >= 1e21:
        return jstr(float(x))
    s = ''
    if x < 0:
        s, x = '-', -x
    q = Decimal(x).quantize(Decimal(1).scaleb(-d), rounding=ROUND_HALF_UP)
    return s + format(q, 'f')


def r6(v):
    """+v.toPrecision(6) for numbers, anything else unchanged."""
    if not isinstance(v, (int, float)) or isinstance(v, bool):
        return v
    if isnan(v) or v in (INF, -INF) or v == 0:
        return v
    d = Decimal(v)
    neg = d < 0
    d = abs(d)
    q = d.quantize(Decimal(1).scaleb(d.adjusted() - 5), rounding=ROUND_HALF_UP)
    return -float(q) if neg else float(q)


def js_round(x):
    f = math.floor(x)
    return f + 1 if x - f >= 0.5 else f


def jsonrt(x):
    """JSON.parse(JSON.stringify(x))."""
    if isinstance(x, dict):
        return {k: jsonrt(v) for k, v in x.items() if v is not UNDEF}
    if isinstance(x, list):
        return [None if v is UNDEF else jsonrt(v) for v in x]
    if isinstance(x, float):
        if x != x or x in (INF, -INF):
            return None
        return 0.0 if x == 0 else x
    return x


# ------------------------------------------------------------------------------------------------ the rules
STOP = {'the', 'and', 'for', 'you', 'are', 'with', 'this', 'that', 'from', 'have', 'not', 'but', 'all', 'can', 'its', 'was',
        'new', 'just', 'get', 'got', 'our', 'out', 'who', 'why', 'how', 'now', 'one', 'two', 'coin', 'token', 'sol',
        'solana', 'pump', 'fun', 'meme', 'official'}
CHK = {'devMax': 10, 'topMax': 30, 'needMeme': 1}
BASE = {'dip': 0.40, 'tp': 0.01, 'sl': 0.90, 'maxHold': 0, 'entry': 'limit', 'stake': 1}
BOTS = [  # legacy id, rule changes from BASE, extra checks
    ('U', {}, {}),
    ('U2', {'maxHold': 120}, {}),
    ('U30', {'maxHold': 30}, {}),
    ('T25', {'tp': 0.25, 'maxHold': 120}, {}),
    ('D55', {'dip': 0.55, 'maxHold': 120}, {}),
    ('GRN', {'entry': 'green', 'maxHold': 120}, {}),
    ('STR', {'maxHold': 120}, {'minHolders': 50, 'social': True, 'devMints': 10, 'rcMax': 50}),
]
START_SOL = 10
WATCH_MS = 7200 * 1000
FRESH = 20000                    # decision price, invalid-data block, sell-order price
MARK_PRICE, MARK_QUOTE = 30000, 90000
FEE = 0.000005 + 0.0001          # network fee per swap
RENT = 0.00203928                # token account rent while holding
DRIFT = 0.005                    # landing drift
MAX_SLIP_BUY = 0.10
GAP_MS, ORDER_TTL, STALE_MS, EQ_EVERY = 90000, 30000, 60000, 120000
SUPPLY = 1e9
CURVE_K, POOL_K = 30 * 1.073e9, 85 * 206.9e6
CURVE_FLOOR = 30 / 1.073e9
GRAD_NEAR_SOL = 0.97 * 410.9
POOL_TIERS = [[420, 0.0125], [1470, 0.012], [2460, 0.0115], [3440, 0.011], [4420, 0.0105], [9820, 0.01], [14740, 0.0095],
              [19650, 0.009], [24560, 0.0085], [29470, 0.008], [34380, 0.0075], [39300, 0.007], [44210, 0.0065],
              [49120, 0.006], [54030, 0.0055], [58940, 0.00525], [63860, 0.005], [68770, 0.00475], [73681, 0.0045],
              [78590, 0.00425], [83500, 0.004], [88400, 0.00375], [93330, 0.0035], [98240, 0.00325], [INF, 0.003]]
DEDUP = {'crossing', 'audit', 'rugcheck', 'quote', 'rcreport'}


def account_defs():
    out = []
    for b, p, c in BOTS:
        P = dict(BASE, **p)
        out.append({'id': 'E0-' + b, 'exp': 'v11-e0/' + b, 'kind': 'e0', 'legacy': b, 'P': P, 'C': dict(CHK, **c), 'stake': P['stake']})
    out.append({'id': 'HOLD', 'exp': 'v11-hold', 'kind': 'hold'})
    return out


def words(name, sym):
    s = (name if truthy(name) else '') + ' ' + (sym if truthy(sym) else '')
    s = re.sub(r'[^a-z]+', ' ', re.sub(r'([a-z])([A-Z])', r'\1 \2', s).lower())
    return list(dict.fromkeys(w for w in s.split(' ') if len(w) >= 3 and w not in STOP))


def meme_score(ws, crosses, t, me, win=7200):
    score, word = 0, None
    for w in ws:
        n = sum(1 for tc, m, cw in crosses if m != me and tc < t and tc >= t - win and w in cw)
        if n > score:
            score, word = n, w
    return score


def fee_rate(venue, mc_sol):
    if venue != 'pool':
        return 0.0125
    for lim, f in POOL_TIERS:
        if mc_sol < lim:
            return f
    return POOL_TIERS[-1][1]


def reserves(ps, venue):
    R = jsqrt((POOL_K if venue == 'pool' else CURVE_K) * ps)
    return R, fdiv(R, ps)


def buy_out(sol, ps, venue):
    ps = N(ps)
    R, T = reserves(ps, venue)
    net = sol * (1 - fee_rate(venue, ps * SUPPLY))
    return T - fdiv(R * T, R + net)


def sell_out(q, ps, venue):
    ps = N(ps)
    R, T = reserves(ps, venue)
    gross = R - fdiv(R * T, T + q)
    return gross * (1 - fee_rate(venue, ps * SUPPLY))


def legacy_gates(c, C, crosses):
    """True when every v10 check passes (dev missing = 0%, top missing passes, meme = name-cluster score)."""
    au = c['audit']
    a = au['fields'] if au['valid'] else {'missing': True}
    devv, topv = g(a, 'devBalancePercentage'), g(a, 'topHoldersPercentage')
    dev = 0 if devv is None or devv is UNDEF else N(devv)
    top = None if topv is None or topv is UNDEF else N(topv)
    rc = c['rc'] if c['rc']['valid'] else {'missing': True, 'risks': []}
    danger = [r for r in rc['risks'] if r[1] == 'danger']
    sn = g(rc, 'sn')
    ok = g(a, 'mintAuthorityDisabled') is True and g(a, 'freezeAuthorityDisabled') is True
    ok = ok and dev <= C['devMax'] and (top is None or top <= C['topMax'])
    ok = ok and not truthy(g(rc, 'missing')) and not danger and (not C.get('rcMax') or (sn is not None and sn is not UNDEF and N(sn) <= C['rcMax']))
    ok = ok and meme_score(c['words'], crosses, c['xAt'] / 1000, c['m']) >= C['needMeme']
    f = au['fields'] if au['valid'] else {}
    if C.get('minHolders'):
        h = g(f, 'holders')
        ok = ok and N(h if truthy(h) else 0) >= C['minHolders']
    if C.get('social'):
        s = g(f, 'socials')
        ok = ok and truthy(s) and (truthy(g(s, 'tw')) or truthy(g(s, 'web')) or truthy(g(s, 'tg')))
    if C.get('devMints'):
        dm = g(f, 'devMints')
        ok = ok and dm is not None and dm is not UNDEF and N(dm) <= C['devMints']
    return bool(ok)


def fresh(c, at, ms):
    last = c.get('last') if c else None
    return last if truthy(last) and at - last['at'] <= ms else None


# ------------------------------------------------------------------------------------------------ engine (E0 + HOLD)
class Engine:
    def __init__(self):
        self.S = None
        self.made = []           # every order id this replay created (rolled-back runs included), for diagnostics

    def init(self, at):
        self.S = {'lastAt': at, 'run': None, 'coins': {}, 'crosses': [], 'accts': {}, 'orders': {}, 'seen': {}, 'gaps': [],
                  'halted': None, 'lastFeedAt': 0}
        for d in account_defs():
            self.S['accts'][d['id']] = self.new_account(d, at)

    @staticmethod
    def new_account(d, at):
        A = copy.deepcopy(d)
        A.update({'startedAt': at, 'cash': START_SOL, 'rent': 0, 'pos': None, 'pending': None, 'watch': {}, 'seen': {}, 'trades': [],
                  'fails': [], 'eq': [[at, START_SOL, START_SOL]], 'peak': START_SOL, 'mdd': 0, 'n': {'orders': 0, 'fills': 0, 'fails': 0}})
        return A

    def load(self, st):
        """st: a saved state (JSON values, bars already unpacked). Only its E0/HOLD accounts and E0 orders are used."""
        S = {k: st.get(k) for k in ('lastAt', 'run', 'coins', 'crosses', 'seen', 'gaps', 'halted', 'lastFeedAt')}
        S['accts'] = {}
        defs = {d['id']: d for d in account_defs()}
        for k, A in st['accts'].items():
            if k in defs:
                A = dict(A)
                A['P'], A['C'] = copy.deepcopy(defs[k].get('P')), copy.deepcopy(defs[k].get('C'))   # rules come from this file
                if A['P'] is None:
                    del A['P'], A['C']
                S['accts'][k] = A
        for d in account_defs():
            if d['id'] not in S['accts']:
                S['accts'][d['id']] = self.new_account(d, S['lastAt'])
        S['orders'] = {k: o for k, o in st['orders'].items() if o['acct'] in S['accts']}
        self.S = S

    def snapshot(self):
        """What the server saves: JSON, the last 20 bars rounded to 6 digits and packed, seen cut to {at, pass}."""
        s = jsonrt(self.S)
        for c in s['coins'].values():
            c['bars'] = [[b['t'], r6(b['o']), r6(b['h']), r6(b['l']), r6(b['c']), b['n']] for b in c['bars'][-20:]]
        for A in s['accts'].values():
            for k in list(A['seen']):
                A['seen'][k] = {'at': A['seen'][k]['at'], 'pass': A['seen'][k]['pass']}
        return jsonrt(s)

    def accts(self):
        return list(self.S['accts'].values())

    # -------------------------------------------------------------------------------------------- events
    def ingest(self, ev):
        S, t = self.S, ev.get('type')
        if truthy(g(ev, 'id')) and t in DEDUP:
            if truthy(S['seen'].get(ev['id'])):
                return
            S['seen'][ev['id']] = ev['at']
        if t == 'run_start':
            return self.run_start(ev)
        if ev['at'] > S['lastAt']:
            S['lastAt'] = ev['at']
        if t == 'crossing':
            self.crossing(ev)
        elif t == 'audit':
            c = S['coins'].get(ev['m'])
            if c:
                if not truthy(c['audit']):
                    fl = g(ev, 'fields')
                    c['audit'] = {'reqAt': g(ev, 'reqAt'), 'at': ev['at'], 'valid': g(ev, 'valid') is not False,
                                  'reason': g(ev, 'reason') if truthy(g(ev, 'reason')) else None, 'fields': fl if truthy(fl) else {}}
                self.admit(c)
        elif t == 'rugcheck':
            c = S['coins'].get(ev['m'])
            if c:
                if not truthy(c['rc']):
                    rk = g(ev, 'risks')
                    c['rc'] = {'reqAt': g(ev, 'reqAt'), 'at': ev['at'], 'valid': g(ev, 'valid') is not False,
                               'reason': g(ev, 'reason') if truthy(g(ev, 'reason')) else None, 'risks': rk if truthy(rk) else [],
                               'score': g(ev, 'score'), 'sn': g(ev, 'sn')}
                self.admit(c)
        elif t == 'snapshot':
            c = S['coins'].get(ev['m'])
            if c:
                self.observe(c, ev)
                if g(ev, 'valid') is not False:
                    S['lastFeedAt'] = jmax(S['lastFeedAt'], ev['at'])
        elif t == 'quote':
            self.quote(ev)
        # sol and rcreport: nothing E0 reads

    def run_start(self, ev):
        S = self.S
        gap = ev['at'] - S['lastAt']
        for o in list(S['orders'].values()):
            if o['status'] == 'requested':
                self.cancel(o, 'server offline' if gap > GAP_MS else 'server restarted', ev['at'])
        if gap > GAP_MS:
            G = {'from': S['lastAt'], 'to': ev['at'], 'held': []}
            for A in self.accts():
                if A['pos']:
                    G['held'].append({'acct': A['id'], 'm': A['pos']['m'], 'sym': A['pos']['sym']})
                    gm = A['pos'].get('gapMs')
                    A['pos']['gapMs'] = (gm if truthy(gm) else 0) + gap
            S['gaps'].append(G)
        S['lastAt'] = max(S['lastAt'], ev['at'])
        S['run'] = g(ev, 'run')

    def crossing(self, ev):
        S = self.S
        if truthy(g(ev, 'boot')):
            return
        m = ev['m']
        if m not in S['coins']:
            hm = g(ev, 'hiMc')
            S['coins'][m] = {'m': m, 'sym': ev['sym'] if truthy(g(ev, 'sym')) else '', 'xAt': ev['at'],
                             'words': words(g(ev, 'name'), g(ev, 'sym')),
                             'hi': {'p': hm / SUPPLY, 'at': ev['at'], 'src': 'follow'} if N(hm) > 0 else None,
                             'audit': None, 'rc': None, 'bars': [], 'last': None, 'stage': 'curve', 'stageAt': ev['at'],
                             'pool': None, 'invalid': None}
        S['crosses'].append([ev['at'] / 1000, m, S['coins'][m]['words']])

    def admit(self, c):
        if not truthy(c['audit']) or not truthy(c['rc']):
            return
        crosses = [x for x in self.S['crosses'] if x[0] * 1000 < c['xAt']]
        for A in self.accts():
            if A['kind'] != 'e0' or truthy(A['watch'].get(c['m'])) or truthy(A['seen'].get(c['m'])):
                continue
            ok = legacy_gates(c, A['C'], crosses)
            at = max(c['xAt'], c['audit']['at'], c['rc']['at'])
            A['seen'][c['m']] = {'at': at, 'pass': ok}
            if ok:
                A['watch'][c['m']] = {'m': c['m'], 'from': at, 'to': at + WATCH_MS, 'armed': None, 'dipAt': None, 'done': None, 'failUntil': 0}

    def observe(self, c, o):
        if not truthy(g(o, 'valid')):
            c['invalid'] = {'at': o['at'], 'reason': o['reason'] if truthy(g(o, 'reason')) else 'invalid data', 'src': g(o, 'src')}
            return
        if truthy(c['invalid']) and c['invalid']['src'] == g(o, 'src'):
            c['invalid'] = None
        p = N(g(o, 'p'))
        if p > 0 and (not truthy(c['hi']) or p > N(c['hi']['p'])):
            c['hi'] = {'p': o['p'], 'at': o['at'], 'src': g(o, 'src')}
        if p > 0:
            L = c['last']
            if N(g(o, 'ps')) > 0:
                ps = o['ps']
            elif truthy(L) and N(L['ps']) > 0 and N(L['p']) > 0:
                ps = L['ps'] * o['p'] / L['p']
            else:
                ps = None
            c['last'] = {'at': o['at'], 'p': o['p'], 'ps': ps, 'mc': g(o, 'mc'), 'src': g(o, 'src')}
            t = math.floor(o['at'] / 60000) * 60
            b = c['bars'][-1] if c['bars'] else None
            if b and b['t'] == t:
                b['h'], b['l'], b['c'], b['n'] = jmax(b['h'], p), jmin(b['l'], p), o['p'], b['n'] + 1
            elif not b or t > b['t']:
                c['bars'].append({'t': t, 'o': o['p'], 'h': o['p'], 'l': o['p'], 'c': o['p'], 'n': 1})
                if len(c['bars']) > 240:
                    del c['bars'][:len(c['bars']) - 240]
            mc = o['mc'] if N(g(o, 'mc')) > 0 else p * SUPPLY
            if mc >= 5000:
                c['lowSince'] = None
            elif not truthy(c.get('lowSince')):
                c['lowSince'] = o['at']
            elif not truthy(c.get('deadAt')) and o['at'] - c['lowSince'] >= 300000:
                c['deadAt'] = o['at']
        v = g(o, 'venue')
        if v == 'pool':
            if c['stage'] != 'pool':
                c['stage'], c['stageAt'] = 'pool', o['at']
            if truthy(g(o, 'pool')):
                c['pool'] = o['pool']
        elif v == 'curve' and c['stage'] != 'pool':
            L = c['last']
            ms = L['ps'] * SUPPLY if truthy(L) and N(L['ps']) > 0 else None
            st = 'migrating' if ms is not None and ms >= GRAD_NEAR_SOL else 'curve'
            if st != c['stage']:
                c['stage'], c['stageAt'] = st, o['at']

    # -------------------------------------------------------------------------------------------- orders and fills
    def order(self, A, side, sig, at):
        S = self.S
        c = S['coins'][sig['m']]
        venue = 'pool' if c['stage'] == 'pool' else 'curve'
        oid = f"{A['id']}:{sig['m']}:{side}:{jstr(at)}"
        o = {'id': oid, 'acct': A['id'], 'exp': A['exp'], 'm': sig['m'], 'sym': c['sym'], 'side': side, 'reqAt': at, 'status': 'requested',
             'why': sig['why'], 'reason': sig.get('reason') if truthy(sig.get('reason')) else None,
             'decision': {'at': at, 'sigAt': sig['sigAt'] if truthy(sig.get('sigAt')) else at, 'p': sig['p'], 'ps': sig['ps'],
                          'priceAge': at - c['last']['at'] if truthy(c['last']) else None, 'venue': venue}}
        if side == 'buy':
            o['size'] = jmin(A['stake'] if truthy(A.get('stake')) else 1, A['cash'] - FEE - RENT, INF)
            o['decision']['expectOut'] = buy_out(o['size'], sig['ps'], venue)
        else:
            o['size'] = A['pos']['qty']
            o['decision']['expectOut'] = sell_out(o['size'], sig['ps'], venue)
        S['orders'][oid] = o
        A['pending'] = oid
        A['n']['orders'] += 1
        self.made.append(oid)

    def cancel(self, o, why, at):
        o['status'], o['reason'], o['doneAt'] = 'cancelled', why, at
        A = self.S['accts'].get(o['acct'])
        if A and A['pending'] == o['id']:
            A['pending'] = None

    def fail(self, o, why, at):
        o['status'], o['reason'], o['doneAt'] = 'failed', why, at
        A = self.S['accts'][o['acct']]
        if A['pending'] == o['id']:
            A['pending'] = None
        A['n']['fails'] += 1
        A['fails'].append({'at': at, 'id': o['id'], 'm': o['m'], 'sym': o['sym'], 'side': o['side'], 'why': why})
        if len(A['fails']) > 100:
            A['fails'].pop(0)
        if o['side'] == 'buy':
            w = A['watch'].get(o['m'])
            if w:
                w['failUntil'] = at + 60000
        elif A['pos']:
            ef = A['pos'].get('exitFail')
            A['pos']['exitFail'] = {'at': at, 'why': why, 'n': ((ef['n'] if truthy(ef) and truthy(ef.get('n')) else 0)) + 1}
            A['pos']['state'] = 'exit_unavailable'

    def quote(self, ev):
        S = self.S
        if not truthy(g(ev, 'orderId')):
            return self.mark_quote(ev)
        o = S['orders'].get(ev['orderId'])
        if not o or o['status'] != 'requested' or ev['at'] < o['reqAt']:
            return
        at = ev['at']
        if g(ev, 'valid') is False:
            r = g(ev, 'reason')
            return self.fail(o, 'quote failed validation: ' + (jstr(r) if truthy(r) else 'bad data'), at)
        if not truthy(g(ev, 'ok')):
            e = g(ev, 'err')
            why = 'quote unavailable: ' + jstr(e) if truthy(g(ev, 'transport')) else 'no executable route: ' + (jstr(e) if truthy(e) else 'quote error')
            return self.fail(o, why, at)
        A, c = S['accts'][o['acct']], S['coins'].get(o['m'])
        if c and c['stage'] == 'migrating':
            return self.fail(o, 'coin is graduating: venue uncertain', at)
        out, imp, route, ven, slot = g(ev, 'outAmount'), g(ev, 'impactPct'), g(ev, 'route'), g(ev, 'venue'), g(ev, 'slot')
        if o['side'] == 'buy':
            tokens = N(out) / 1000000 * (1 - DRIFT)
            exp = N(o['decision']['expectOut'])
            if tokens < exp * (1 - MAX_SLIP_BUY):
                return self.fail(o, f"price moved: quote gives {to_fixed((1 - fdiv(tokens, exp)) * 100, 1)}% fewer tokens than expected at the decision", at)
            A['cash'] = N(A['cash']) - (o['size'] + FEE + RENT)
            A['rent'] = N(A['rent']) + RENT
            venue = ven if truthy(ven) else o['decision']['venue']
            dps = o['decision']['ps']
            A['pos'] = {'m': o['m'], 'sym': o['sym'], 'qty': tokens, 'cost': o['size'] + FEE, 'rent': RENT, 'openAt': at, 'orderId': o['id'],
                        'sigAt': o['decision']['sigAt'], 'decidedAt': o['reqAt'], 'entryPs': fdiv(o['size'], tokens), 'entrySpot': dps,
                        'venue': venue, 'route': route, 'impact': imp, 'state': 'holding', 'mark': None, 'mae': 0, 'mfe': 0,
                        'peak': o['size'] + FEE, 'gapMs': 0}
            if truthy(A['P']['sl']) and venue == 'curve' and (1 - A['P']['sl']) * N(dps) < CURVE_FLOOR:
                A['pos']['stopUnreachable'] = True
            w = A['watch'].get(o['m'])
            if w:
                w['done'] = 'bought'
            o['status'], o['doneAt'] = 'filled', at
            o['fill'] = {'at': at, 'delayMs': at - o['reqAt'], 'quoteAt': at, 'out': tokens, 'impact': imp, 'route': route, 'venue': ven,
                         'slot': slot, 'drift': DRIFT, 'networkFee': FEE, 'rent': RENT}
            A['pending'] = None
            A['n']['fills'] += 1
            return
        p = A['pos']
        sol = N(out) / 1e9 * (1 - DRIFT) - FEE
        A['cash'] = N(A['cash']) + (sol + N(p['rent']))
        A['rent'] = N(A['rent']) - N(p['rent'])
        exp = o['decision']['expectOut']
        gm = p.get('gapMs')
        A['trades'].append({
            'acct': A['id'], 'exp': A['exp'], 'm': p['m'], 'sym': p['sym'], 'qty': p['qty'], 'cost': p['cost'], 'proceeds': sol,
            'net': sol - p['cost'], 'ret': fdiv(sol, p['cost']) - 1, 'sigAt': p['sigAt'], 'decidedAt': p['decidedAt'], 'openAt': p['openAt'],
            'exitSigAt': o['decision']['sigAt'], 'exitDecidedAt': o['reqAt'], 'closeAt': at, 'entryPs': p['entryPs'],
            'exitPs': fdiv(sol + FEE, p['qty']), 'entryRoute': p['route'], 'exitRoute': route, 'entryImpact': p.get('impact', UNDEF),
            'exitImpact': imp, 'exitReason': o['reason'], 'exitWhy': o['why'], 'mae': jmin(p['mae'], fdiv(sol, p['cost']) - 1),
            'mfe': jmax(p['mfe'], fdiv(sol, p['cost']) - 1), 'gapMs': gm if truthy(gm) else 0, 'stopUnreachable': truthy(p.get('stopUnreachable')),
            'slipVsDecision': fdiv(sol, exp) - 1 if N(exp) > 0 else None, 'fees': {'network': 2 * FEE, 'drift': DRIFT, 'venue': 'inside quotes'}})
        A['pos'] = None
        A['pending'] = None
        A['n']['fills'] += 1
        o['status'], o['doneAt'] = 'filled', at
        o['fill'] = {'at': at, 'delayMs': at - o['reqAt'], 'out': sol, 'impact': imp, 'route': route, 'venue': ven, 'slot': slot}

    def mark_quote(self, ev):
        """A sell quote not tied to an order: what a held position would fetch right now; two plain failures = no route."""
        S = self.S
        c = S['coins'].get(g(ev, 'm'))
        evok = g(ev, 'ok')
        good = truthy(evok) and g(ev, 'valid') is not False
        if c and g(ev, 'side') == 'sell' and not truthy(g(ev, 'transport')):
            okv = (g(ev, 'valid') is not False) if truthy(evok) else evok
            imp = g(ev, 'impactPct')
            fin = imp is None or (isinstance(imp, (int, float)) and not isinstance(imp, bool) and math.isfinite(imp))
            err = next((x for x in (g(ev, 'err'), g(ev, 'reason')) if truthy(x)), 'no route')
            c['mq'] = {'at': ev['at'], 'ok': okv, 'err': None if good else err, 'route': g(ev, 'route') if truthy(g(ev, 'route')) else None,
                       'venue': g(ev, 'venue') if truthy(g(ev, 'venue')) else None, 'qty': N(g(ev, 'inAmount')) / 1000000,
                       'sol': N(g(ev, 'outAmount')) / 1e9 if good else None, 'impact': imp if (good and fin) else None}
            if good:
                c['routeFails'], c['routeLostAt'] = 0, None
            else:
                rf = c.get('routeFails')
                c['routeFails'] = (rf if truthy(rf) else 0) + 1
                if c['routeFails'] >= 2 and not truthy(c.get('routeLostAt')):
                    c['routeLostAt'] = ev['at']
        for A in self.accts():
            p = A['pos']
            if not p or p['m'] != g(ev, 'm') or g(ev, 'side') != 'sell':
                continue
            raw = p['qty'] * 1000000
            if abs(N(g(ev, 'inAmount')) - math.floor(raw)) > jmax(1, raw * 0.001):
                continue
            if good:
                p['quote'] = {'at': ev['at'], 'sol': N(g(ev, 'outAmount')) / 1e9 * (1 - DRIFT) - FEE, 'impact': g(ev, 'impactPct'), 'route': g(ev, 'route')}
            else:
                err = next((x for x in (g(ev, 'err'), g(ev, 'reason')) if truthy(x)), 'no route')
                p['quote'] = {'at': ev['at'], 'sol': None, 'err': err}

    # -------------------------------------------------------------------------------------------- marks and ledger
    def mark(self, A, at):
        p = A['pos']
        c = self.S['coins'].get(p['m'])
        venue = 'pool' if c and c['stage'] == 'pool' else 'curve'
        pm = p.get('mark')
        prev = {'value': pm['value'], 'at': pm['at']} if truthy(pm) and pm.get('value') is not None else ((pm.get('last') if truthy(pm) else None) or None)
        if c and truthy(c.get('routeLostAt')):
            p['priced'] = False
            p['mark'] = {'at': at, 'value': None, 'src': 'route-lost', 'distressed': True, 'since': c['routeLostAt'], 'last': prev, 'lo': 0, 'floor': 0}
            return
        q = p.get('quote')
        q = q if truthy(q) and q.get('sol') is not None and at - q['at'] <= MARK_QUOTE else None
        last = fresh(c, at, MARK_PRICE) if c else None
        model_ok = bool(last) and N(last['ps']) > 0 and c['stage'] != 'migrating'
        m = None
        if q and (not model_ok or q['at'] + 5000 >= last['at']):
            m = {'at': at, 'value': q['sol'], 'src': 'quote', 'age': at - q['at']}
        elif model_ok:
            m = {'at': at, 'value': sell_out(p['qty'], last['ps'], venue) * (1 - DRIFT) - FEE, 'src': 'model', 'age': at - last['at']}
        floor = sell_out(p['qty'], CURVE_FLOOR, 'curve') if venue == 'curve' else 0
        if m:
            m['lo'] = jmin(m['value'], jmax(floor, 0) if floor > 0 else 0)
            m['floor'] = floor
            p['mark'], p['priced'] = m, True
            r = fdiv(m['value'], p['cost']) - 1
            p['mae'], p['mfe'], p['peak'] = jmin(p['mae'], r), jmax(p['mfe'], r), jmax(p['peak'], m['value'])
        else:
            p['priced'] = False
            p['mark'] = {'at': at, 'value': None, 'src': 'unpriceable', 'last': prev, 'lo': floor, 'floor': floor}

    def equity(self, A, at):
        v = N(A['cash']) + N(A['rent'])
        lo, known = v, True
        if A['pos']:
            m = A['pos'].get('mark')
            if truthy(m) and m.get('value') is not None:
                v += N(m['value'])
                lo += N(g(m, 'lo'))
            else:
                known = False
                x = m.get('lo') if truthy(m) else 0
                lo += N(x) if truthy(x) else 0
        if known:
            if truthy(A.get('lastEqAt')) and v < N(A['peak']) - 1e-9:
                u = A.get('underwaterMs')
                A['underwaterMs'] = (u if truthy(u) else 0) + (at - A['lastEqAt'])
            A['peak'] = jmax(A['peak'], v)
            A['mdd'] = jmin(A['mdd'], fdiv(v, A['peak']) - 1)
        if A['pos'] and truthy(A.get('lastEqAt')):
            e = A.get('exposureMs')
            A['exposureMs'] = (e if truthy(e) else 0) + (at - A['lastEqAt'])
        A['lastEqAt'] = at
        eq = A['eq']
        if not eq or at - eq[-1][0] >= EQ_EVERY:
            eq.append([at, float(to_fixed(v, 6)) if known else None, float(to_fixed(lo, 6))])
            if len(eq) > 4000:
                n = len(eq)
                A['eq'] = [x for i, x in enumerate(eq) if i % 2 == 0 or i > n - 2000]

    # -------------------------------------------------------------------------------------------- decisions
    def signal(self, A, w, c, at):
        P = A['P']
        if truthy(w['done']) or at < w['from']:
            return None
        if at >= w['to']:
            w['done'] = 'nodip'
            return None
        last = fresh(c, at, FRESH)
        inv = c.get('invalid')
        if not last or not truthy(c['hi']) or c['stage'] == 'migrating' or (truthy(inv) and at - inv['at'] < FRESH):
            return None
        trig = (1 - P['dip']) * c['hi']['p']
        w['trig'], w['H'] = trig, c['hi']['p']
        if w['armed'] is None:
            w['armed'] = last['p'] > trig
        if not truthy(w['armed']):
            if last['p'] > trig:
                w['armed'] = True
            return None
        if at < N(w['failUntil']):
            return None
        zone = jstr(js_round(P['dip'] * 100))
        if P['entry'] == 'green':
            if not truthy(w['dipAt']) and last['p'] <= trig:
                w['dipAt'] = last['at']
            if not truthy(w['dipAt']):
                return None
            start = math.floor(w['dipAt'] / 60000) * 60000
            for b in c['bars']:
                if (b['t'] + 60) * 1000 > at:
                    continue
                if b['t'] * 1000 >= start and b['c'] > b['o'] and (b['t'] + 60) * 1000 > w['dipAt']:
                    end = (b['t'] + 60) * 1000
                    hhmm = time.strftime('%H:%M', time.gmtime(int(end) // 1000))
                    return {'m': c['m'], 'sigAt': end, 'p': last['p'], 'ps': last['ps'],
                            'why': f"first green minute after the {zone}% dip closed at {hhmm} UTC"}
            return None
        if last['p'] <= trig:
            return {'m': c['m'], 'sigAt': last['at'], 'p': last['p'], 'ps': last['ps'],
                    'why': f"price seen {to_fixed((1 - last['p'] / c['hi']['p']) * 100, 1)}% under its high (buy zone {zone}%)"}
        return None

    def entry(self, A, at):
        best = None
        for w in list(A['watch'].values()):
            c = self.S['coins'].get(w['m'])
            if not c:
                continue
            s = self.signal(A, w, c, at)
            if s and (best is None or s['sigAt'] < best['sigAt']):
                best = s
        return best

    def review(self, A, pos, c, at):
        P = A['P']
        if c['stage'] == 'migrating':
            return {'state': 'paused'}
        last = fresh(c, at, FRESH)
        if last and N(last['ps']) > 0:
            venue = 'pool' if c['stage'] == 'pool' else 'curve'
            if truthy(P['sl']) and last['ps'] <= (1 - P['sl']) * N(g(pos, 'entrySpot')):
                return {'exit': 'sl', 'why': f"price {to_fixed((fdiv(last['ps'], g(pos, 'entrySpot')) - 1) * 100, 0)}% from the buy: stop"}
            est = sell_out(pos['qty'], last['ps'], venue) * (1 - DRIFT) - FEE
            if est >= pos['cost'] * (1 + P['tp']):
                return {'exit': 'tp', 'why': f"selling now should return {to_fixed(est, 3)} SOL, at least the {to_fixed(P['tp'] * 100, 0)}% target after costs"}
        if truthy(P['maxHold']) and at >= pos['openAt'] + P['maxHold'] * 60000:
            return {'exit': 'time', 'why': f"{jstr(P['maxHold'])} minute limit reached"}
        return {'state': 'unpriceable' if not last else 'holding'}

    def tick(self, at):
        S = self.S
        if at < S['lastAt']:
            at = S['lastAt']
        S['lastAt'] = at
        for o in list(S['orders'].values()):
            if o['status'] == 'requested' and at - o['reqAt'] > ORDER_TTL:
                self.fail(o, 'no quote within 30 s', at)
        halted = len(S['coins']) > 0 and at - N(S['lastFeedAt']) > STALE_MS
        if halted and not truthy(S['halted']):
            S['halted'] = {'at': at, 'why': 'no valid market data for 60 s: new entries halted'}
        if not halted and truthy(S['halted']):
            S['halted'] = None
        for A in self.accts():
            if A['kind'] == 'hold' or not A['pos']:
                continue
            self.mark(A, at)
            if A['pending']:
                continue
            pos = A['pos']
            c = S['coins'].get(pos['m'])
            r = self.review(A, pos, c, at) if c else {'state': 'unpriceable'}
            if c and truthy(c.get('routeLostAt')) and not r.get('exit'):
                r['state'] = 'exit_unavailable'
            if r.get('exit'):
                ef = pos.get('exitFail')
                if truthy(ef) and at - ef['at'] < 15000:
                    continue
                last = fresh(c, at, FRESH) or c['last'] or {}
                ps = g(last, 'ps')
                self.order(A, 'sell', {'m': pos['m'], 'p': g(last, 'p'), 'ps': ps if truthy(ps) else g(pos, 'entrySpot'), 'why': r['why'],
                                       'reason': r['exit'], 'sigAt': at}, at)
                pos['state'] = 'exit_pending'
            else:
                pos['state'] = 'exit_unavailable' if truthy(pos.get('exitFail')) and pos['state'] == 'exit_unavailable' else r['state']
        for A in self.accts():
            if A['kind'] != 'hold' and not A['pos'] and not A['pending'] and not truthy(S['halted']) and A['cash'] > 0.06:
                sig = self.entry(A, at)
                if sig:
                    self.order(A, 'buy', sig, at)
            self.equity(A, at)
        self.prune(at)

    def prune(self, at):
        S = self.S
        S['crosses'] = [x for x in S['crosses'] if at / 1000 - x[0] < 9000]
        for k, t in list(S['seen'].items()):
            if at - t > 10800000:
                del S['seen'][k]
        for k, o in list(S['orders'].items()):
            if o['status'] != 'requested' and at - o['reqAt'] > 86400000:
                del S['orders'][k]
        keep = set()
        for A in self.accts():
            if A['pos']:
                keep.add(A['pos']['m'])
            for w in A['watch'].values():
                if not truthy(w['done']) or at - w['to'] < 3600000:
                    keep.add(w['m'])
        for A in self.accts():
            for m, w in list(A['watch'].items()):
                if truthy(w['done']) and at - w['to'] > 21600000:
                    del A['watch'][m]
        for m, c in list(S['coins'].items()):
            alive = not truthy(c.get('deadAt')) and (at - c['xAt'] < 10800000 or (c['stage'] == 'pool' and at - c['xAt'] < 28800000))
            watched = any(m in A['watch'] for A in self.accts())
            if m not in keep and not alive and at - c['xAt'] > (10800000 if watched else 1200000):
                del S['coins'][m]
        for A in self.accts():
            for m, s in list(A['seen'].items()):
                if at - s['at'] > 10800000:
                    del A['seen'][m]


# ------------------------------------------------------------------------------------------------ recorded inputs
def unflat(keys, vals):
    o = {}
    for k, v in zip(keys, vals):
        ps, x = k.split('/'), o
        for p in ps[:-1]:
            if not truthy(x.get(p, UNDEF)):
                x[p] = {}
            x = x[p]
        x[ps[-1]] = v
    return o


MARKS = {'~NaN': NAN, '~Inf': INF, '~-Inf': -INF}


def revive(x):
    if isinstance(x, str):
        return MARKS.get(x, x)
    if isinstance(x, list):
        return [revive(v) for v in x]
    if isinstance(x, dict):
        return {k: revive(v) for k, v in x.items()}
    return x


def decode(files):
    mints, shapes, prev = {}, {}, {}
    for f in files:
        for line in gzip.decompress(open(f, 'rb').read()).decode('utf-8', 'surrogatepass').split('\n'):
            if not line:
                continue
            x = revive(json.loads(line))
            t = x[0]
            if t == 'M':
                mints[x[1]] = x[2]
            elif t == 'K':
                shapes[x[1]] = x[2]
            elif t == 't':
                yield ('tick', x[1])
            elif t == 's':
                yield ('save', x[1], x[2])
            elif t == 'S':
                yield ('commit', x[1], x[2], x[3])
            elif t == 'L':
                yield ('load', x[1], x[2])
            elif t == 'V':
                yield ('version', x[1], x[2])
            elif t == 'e':
                yield ('event', x[1])
            elif t in ('d', 'j'):
                m, key = mints.get(x[1]), f"{x[1]}{t}"
                p = prev.get(key)
                if not m or x[2] not in shapes:
                    continue
                ev = {'m': m}
                ev.update(unflat(shapes[x[2]], x[3]))
                if ev.get('audit') == '=':
                    ev['audit'] = jsonrt(p['ev']['audit']) if p and truthy(g(p['ev'], 'audit')) else None
                prev[key] = {'m': m, 'ev': copy.deepcopy(ev)}
                ev['id'], ev['type'] = f"{t}:{m}:{jstr(ev['at'])}", 'snapshot'
                yield ('event', ev)
            elif t == '=':
                p = prev.get(f"{x[1]}{x[2]}")
                if not p:
                    continue
                ev = copy.deepcopy(p['ev'])
                ev['at'] = x[3]
                ev['id'], ev['type'] = f"{x[2]}:{p['m']}:{jstr(x[3])}", 'snapshot'
                yield ('event', ev)


def unpack(st):
    for c in (st.get('coins') or {}).values():
        c['bars'] = [{'t': b[0], 'o': b[1], 'h': b[2], 'l': b[3], 'c': b[4], 'n': b[5]} if isinstance(b, list) else b for b in (c.get('bars') or [])]
    return st


# ------------------------------------------------------------------------------------------------ comparison
COIN_KEYS = ('xAt', 'words', 'hi', 'audit', 'rc', 'last', 'bars', 'stage', 'stageAt', 'invalid', 'lowSince', 'deadAt', 'mq',
             'routeFails', 'routeLostAt')
SKIP_ACCT = ('name', 'desc', 'P', 'C')


def e0_view(st):
    """The E0/HOLD part of a saved state."""
    accts = {k: {kk: vv for kk, vv in A.items() if kk not in SKIP_ACCT} for k, A in st['accts'].items() if k.startswith('E0-') or k == 'HOLD'}
    used = set()
    for A in accts.values():
        if A.get('pos'):
            used.add(A['pos']['m'])
        used |= {w['m'] for w in A['watch'].values() if not w.get('done')}
    return {'accts': accts, 'orders': {k: o for k, o in st['orders'].items() if o['acct'].startswith('E0-')},
            'halted': st.get('halted'), 'lastFeedAt': st.get('lastFeedAt'), 'lastAt': st.get('lastAt'),
            'crosses': st.get('crosses'), 'seen': st.get('seen'),
            'gaps': [{'from': x['from'], 'to': x['to'], 'held': [h for h in x['held'] if h['acct'].startswith('E0-')]} for x in st.get('gaps', [])],
            'used': used, 'coins': st['coins']}


def same(a, b):
    if isinstance(a, bool) or isinstance(b, bool):
        return isinstance(a, bool) and isinstance(b, bool) and a == b
    if isinstance(a, (int, float)) and isinstance(b, (int, float)):
        return a == b or (isnan(a) and isnan(b))
    return type(a) == type(b) and a == b


def diff(a, b, path, out, limit=25):
    if len(out) >= limit:
        return
    if isinstance(a, dict) and isinstance(b, dict):
        for k in dict.fromkeys(list(a) + list(b)):
            va, vb = a.get(k, UNDEF), b.get(k, UNDEF)
            if va is UNDEF and vb is UNDEF:
                continue
            diff(va, vb, f"{path}.{k}", out, limit)
        return
    if isinstance(a, list) and isinstance(b, list):
        if len(a) != len(b):
            out.append((path + '.length', len(a), len(b)))
        for i in range(min(len(a), len(b))):
            diff(a[i], b[i], f"{path}[{i}]", out, limit)
        return
    if not same(a, b):
        out.append((path, a, b))


def compare(mine, live, limit=25):
    """Differences between this replay's committed state and a state the server saved, E0/HOLD part only."""
    x, y = e0_view(mine), e0_view(live)
    out = []
    for k in ('accts', 'orders', 'halted', 'lastFeedAt', 'lastAt', 'gaps', 'crosses', 'seen'):
        diff(x[k], y[k], k, out, limit)
    for m in sorted(x['used'] | y['used']):
        cx, cy = x['coins'].get(m), y['coins'].get(m)
        if cx is None or cy is None:
            out.append((f"coins.{m}", 'present' if cx else 'missing', 'present' if cy else 'missing'))
            continue
        diff({k: cx.get(k, UNDEF) for k in COIN_KEYS}, {k: cy.get(k, UNDEF) for k in COIN_KEYS}, f"coins.{m}", out, limit)
    return out


def rules_check(st):
    """The rules each saved E0 account runs (the server keeps them in the save) are the locked ones this file uses."""
    bad = []
    defs = {d['id']: d for d in account_defs()}
    for k, A in st['accts'].items():
        d = defs.get(k)
        if not d or 'P' not in d:
            continue
        for key, v in d['P'].items():
            if not same(A['P'].get(key), v):
                bad.append(f"{k}.P.{key}: saved {A['P'].get(key)!r}, locked {v!r}")
        for key, v in d['C'].items():
            if not same(A['C'].get(key), v):
                bad.append(f"{k}.C.{key}: saved {A['C'].get(key)!r}, locked {v!r}")
        for key in A['C']:
            if key not in d['C'] and truthy(A['C'][key]):
                bad.append(f"{k}.C.{key}: saved {A['C'][key]!r}, not in the locked checks")
    return bad


def js_last_save(files):
    """The JS engine's last committed save after replaying the same inputs (record.js replayExact), and its run-start checks."""
    code = ("const REC = require(process.argv[1]), fs = require('fs');"
            "const r = REC.replayExact(process.argv.slice(2).map(f => fs.readFileSync(f)));"
            "process.stdout.write(JSON.stringify({ save: r.lastSave, checks: r.checks.map(c => c.same) }));")
    try:
        p = subprocess.run(['node', '-e', code, os.path.join(REPO, 'server/v11/record.js')] + files, capture_output=True, text=True)
    except OSError as e:
        return {'save': None, 'err': repr(e)}
    if p.returncode != 0:
        return {'save': None, 'err': p.stderr[-400:]}
    return json.loads(p.stdout)


def short(v):
    s = repr(v)
    return s if len(s) <= 140 else s[:137] + '...'


# ------------------------------------------------------------------------------------------------ the check
def check(DIR, live=False, log=print):
    files = sorted(glob.glob(os.path.join(DIR, 'v11-inputs', '**', '*.jsonl.gz'), recursive=True))
    if not files:
        log('E0 ref: no recorded inputs')
        return False
    eng, pending, committed = None, {}, None
    loads, ticks, events, problems = 0, 0, 0, []
    # scripted recordings also keep every save the engine made: then every save is compared, not only restarts and the end
    saves, saved_n, points = {}, 0, 0
    sp = os.path.join(DIR, 'v11-saves.jsonl.gz')
    if os.path.exists(sp):
        for line in gzip.open(sp, 'rt').read().splitlines():
            if line.strip():
                r, n, at, ok, st = json.loads(line)
                saves[(int(r), n)] = st
    quoted = set()
    started = time.time()
    try:
        for item in decode(files):
            k = item[0]
            if k == 'load':
                loads += 1
                at, st = item[1], item[2]
                if eng is None:
                    eng = Engine()
                    if st and truthy(st.get('v')) and truthy(st.get('accts')):
                        problems += [('rules', b, '') for b in rules_check(st)]
                        eng.load(unpack(jsonrt(st)))
                    else:
                        eng.init(at)
                    continue
                if st:
                    problems += [('rules', b, '') for b in rules_check(st)]
                if (committed is None) != (not st):
                    problems.append((f"run start {loads}: " + ('the server loaded no v11 state although a save was committed' if committed is not None
                                                               else 'the server loaded a state but no save was committed'), '', ''))
                if committed is not None and st:
                    d = compare(unpack(copy.deepcopy(committed)), unpack(jsonrt(st)))
                    points += 1
                    log(f"   E0 ref: run start {loads}: {'same as the state the server loaded' if not d else str(len(d)) + '+ differences'}")
                    problems += [(f"run start {loads}: " + p, a, b) for p, a, b in d]
                made = eng.made
                eng = Engine()
                eng.made = made
                if committed is not None:
                    eng.load(unpack(copy.deepcopy(committed)))
                else:
                    eng.init(at)
                continue
            if eng is None:
                continue
            if k == 'event':
                ev = item[1]
                events += 1
                if ev.get('type') == 'quote' and str(ev.get('orderId') or '').startswith('E0-'):
                    quoted.add(ev['orderId'])
                eng.ingest(ev)
            elif k == 'tick':
                ticks += 1
                eng.tick(item[1])
            elif k == 'save':
                pending[item[2]] = eng.snapshot()
                want = saves.get((loads, item[2]))
                if want is not None:
                    saved_n += 1
                    d = compare(unpack(copy.deepcopy(pending[item[2]])), unpack(jsonrt(want)))
                    problems += [(f"save {item[2]} of run {loads} at {item[1]}: " + p, a, b) for p, a, b in d[:5]]
            elif k == 'commit':
                if item[3] and item[2] in pending:
                    committed = pending[item[2]]
                pending.pop(item[2], None)
    except Exception as e:
        import traceback
        traceback.print_exc()
        log(f"   E0 ref: replay stopped by an exception: {e!r}")
        return False
    final_path = os.path.join(DIR, 'v11.json')
    if committed is None or not os.path.exists(final_path):
        log('   E0 ref: no committed save or no v11.json to compare with')
        return False
    final = json.load(open(final_path))
    problems += [('rules', b, '') for b in rules_check(final)]
    if live and final['lastAt'] > committed['lastAt']:
        # the server saves every 2 min but uploads its inputs once an hour: the data branch is ahead of the recording. The
        # end of the recording is then compared with the JS engine's own replay of the same inputs (record.js replayExact,
        # the code the server runs), whose run starts must in turn equal what the server loaded.
        js = js_last_save(files)
        log(f"   E0 ref: v11.json is {(final['lastAt'] - committed['lastAt']) / 60000:.0f} min newer than the recorded inputs: the end of the "
            f"recording is compared with the JS engine's replay of the same inputs instead")
        if js is None or js['save'] is None:
            problems.append(('the JS replay of the inputs failed', js and js.get('err'), ''))
        else:
            if not all(js['checks']):
                problems.append(('the JS replay itself differs from what the server loaded at a run start', js['checks'], ''))
            d = compare(unpack(copy.deepcopy(committed)), unpack(jsonrt(js['save'])))
            problems += [('end of the recording (JS replay): ' + p, a, b) for p, a, b in d]
            points += 1
    else:
        d = compare(unpack(copy.deepcopy(committed)), unpack(jsonrt(final)))
        problems += [('final: ' + p, a, b) for p, a, b in d]
        points += 1
    if not points:
        problems.append(('nothing to compare: no run start after the first and no final state', '', ''))
    # the server's own error notes: an exception inside its engine would make any comparison meaningless
    for f in sorted(glob.glob(os.path.join(DIR, 'sim_out_*.json'))):
        errs = [e for e in (json.load(open(f)).get('errors') or []) if 'v11' in json.dumps(e)]
        problems += [('server v11 error in ' + os.path.basename(f), short(e), '') for e in errs]
    made = set(eng.made)
    if saves:
        log(f"   E0 ref: compared at {saved_n} of {len(saves)} saves the engine made")
        if saved_n != len(saves):
            problems.append(('saves recorded but not reached by the replay', len(saves) - saved_n, ''))
    log(f"   E0 ref: {len(files)} input files, {loads} loads, {events} events, {ticks} ticks in {time.time() - started:.1f} s; "
        f"{len(made)} E0 orders made here, {len(quoted)} E0 order ids quoted by the server, "
        f"{len(quoted - made)} quoted but never made here, {len(made - quoted)} made here without a recorded quote")
    for oid in sorted(quoted - made)[:5]:
        problems.append(('order the server made and this replay did not', oid, ''))
    fin = e0_view(committed)
    for aid, A in fin['accts'].items():
        net = sum(t['net'] for t in A['trades'])
        hold = f", holding {A['pos']['sym']}" if A.get('pos') else ''
        log(f"   {aid:<7} cash {A['cash']:.4f} SOL, {len(A['trades'])} trades, net {net:+.4f}{hold}, orders {A['n']['orders']}, fails {A['n']['fails']}")
    for p, a, b in problems[:25]:
        log(f"   E0 MISMATCH {p}: mine {short(a)} | server {short(b)}")
    if len(problems) > 25:
        log(f"   ... {len(problems) - 25} more")
    return not problems


if __name__ == '__main__':
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(2)
    ok = check(sys.argv[1], live='--live' in sys.argv)
    print('ALL E0 MATCH' if ok else 'E0 DIFFERS')
    sys.exit(0 if ok else 1)
