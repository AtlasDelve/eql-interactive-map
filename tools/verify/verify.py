#!/usr/bin/env python3
"""Ad-hoc verification harness for the user-edition/overlay work.

Usage:
    python verify.py datacmp  A.html B.html   # injected-data equivalence + order
    python verify.py numcmp   A.html B.html   # equivalence after numeric type coercion
    python verify.py jsnum    ARTIFACT.html   # JS-canonical numeric spellings
    python verify.py lf       ARTIFACT.html   # no CR bytes in an LF artifact
    python verify.py strip    USER.html       # strip-completeness greps
    python verify.py linediff A.html B.html   # show changed lines (for small deltas)
    python verify.py hints                    # ref-hint collision check over data/
    python verify.py discoveryfresh           # discovered source bytes + fingerprints
    python verify.py travel                   # authored travel graph + expansion declaration
    python verify.py xpacs                    # just the expansion half (run.py folds it in)
"""
import hashlib
import json
import math
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))          # tools/verify/ -> repo root

# ---------------------------------------------------------------- data extract

def find_decl(text, prefix, openers):
    """Return the opener index of the first declaration using an allowed opener."""
    start = 0
    while True:
        try:
            at = text.index(prefix, start)
        except ValueError:
            raise ValueError("missing declaration %r with opener in %r" % (prefix, openers)) from None
        value_at = at + len(prefix)
        if value_at < len(text) and text[value_at] in openers:
            return value_at
        start = value_at


def extract(path, parse_float=None):
    """Pull the eight injected JSON blobs out of a built HTML file.

    The blobs are emitted by json.dumps with "</" escaped as "<\\/", so we undo
    that before parsing. Greedy/lazy matching is avoided by locating the exact
    declaration boundaries with a small scanner rather than a regex.
    """
    text = open(path, encoding="utf-8").read()
    out = {}

    def grab(prefix, opener):
        i = find_decl(text, prefix, opener)
        closer = {"{": "}", "[": "]"}[opener]
        depth, j, instr, esc = 0, i, False, False
        while True:
            ch = text[j]
            if instr:
                if esc:
                    esc = False
                elif ch == "\\":
                    esc = True
                elif ch == '"':
                    instr = False
            else:
                if ch == '"':
                    instr = True
                elif ch == opener:
                    depth += 1
                elif ch == closer:
                    depth -= 1
                    if depth == 0:
                        j += 1
                        break
            j += 1
        kwargs = {} if parse_float is None else {"parse_float": parse_float}
        return json.loads(text[i:j].replace("<\\/", "</"), **kwargs)

    out["ALL"] = grab("const ALL=", "{")
    out["META"] = grab(", META=", "{")
    out["DETAIL"] = grab(", DETAIL=", "{")
    out["HUBS"] = grab("const HUBS=", "{")
    out["UNIVERSE"] = grab("const UNIVERSE=", "[")
    out["WORLDLINKS"] = grab("const WORLDLINKS=", "[")
    out["TRAVEL"] = grab("const TRAVEL=", "{")
    out["XPACS"] = grab("const XPACS=", "{")
    return out


def cmd_datacmp(a, b):
    """Injected-data equivalence, including key ORDER (rendering depends on it)."""
    da, db = extract(a), extract(b)
    bad = 0
    for k in ("ALL", "META", "DETAIL", "HUBS", "UNIVERSE", "WORLDLINKS", "TRAVEL", "XPACS"):
        # canonical re-dump: same separators as build.py, order preserved
        sa = json.dumps(da[k], separators=(",", ":"), ensure_ascii=False)
        sb = json.dumps(db[k], separators=(",", ":"), ensure_ascii=False)
        ok = sa == sb
        print("%-11s %s  (%d vs %d bytes)" % (k, "OK " if ok else "DIFF", len(sa), len(sb)))
        if not ok:
            bad += 1
            for i in range(min(len(sa), len(sb))):
                if sa[i] != sb[i]:
                    print("   first diff at %d: ...%s... vs ...%s..."
                          % (i, sa[max(0, i - 60):i + 60], sb[max(0, i - 60):i + 60]))
                    break
    # continent order must be preserved
    oa, ob = list(da["ALL"].keys()), list(db["ALL"].keys())
    print("continent order %s" % ("OK" if oa == ob else "DIFF\n  %s\n  %s" % (oa, ob)))
    if oa != ob:
        bad += 1
    # per-continent zone draw order must be preserved
    for c in oa:
        za, zb = list(da["ALL"][c]["zones"].keys()), list(db["ALL"][c]["zones"].keys())
        if za != zb:
            print("zone order DIFF in %s" % c)
            bad += 1
    print("zone draw order OK" if not bad else "")
    print("\nRESULT: %s" % ("PASS" if bad == 0 else "FAIL (%d)" % bad))
    return 1 if bad else 0


def cmd_numcmp(a, b):
    """Injected-data equivalence after numeric coercion, preserving every key order.

    Like extract(), this explicitly knows the eight current structures; adding a ninth
    must extend this command as well as the other injection-aware verification sites.
    Integer coercion is sound only for artifacts satisfying jsnum's safe-integer rule.
    """
    da, db = extract(a), extract(b)

    def norm(v):
        if type(v) in (int, float):
            return ("number", float(v))
        if isinstance(v, dict):
            return ("object", [(k, norm(x)) for k, x in v.items()])
        if isinstance(v, list):
            return ("array", [norm(x) for x in v])
        return (type(v).__name__, v)

    bad = 0
    for k in ("ALL", "META", "DETAIL", "HUBS", "UNIVERSE", "WORLDLINKS", "TRAVEL", "XPACS"):
        ok = norm(da[k]) == norm(db[k])
        print("%-11s %s" % (k, "OK" if ok else "DIFF"))
        bad += not ok
    print("\nRESULT: %s" % ("PASS" if bad == 0 else "FAIL (%d)" % bad))
    return 1 if bad else 0


def cmd_jsnum(path):
    """Reject numeric spellings that cannot round-trip byte-identically through JS.

    This reuses extract(), which names the eight injected structures explicitly. A
    genuinely ninth structure must be added here and to every other extraction site.
    """
    data = extract(path, parse_float=float)
    bad = 0

    def walk(v, where):
        nonlocal bad
        if isinstance(v, dict):
            for k, x in v.items():
                walk(x, "%s.%s" % (where, k))
        elif isinstance(v, list):
            for i, x in enumerate(v):
                walk(x, "%s[%d]" % (where, i))
        elif type(v) is int and abs(v) > (1 << 53) - 1:
            print("NONCANON integer outside JS safe range at %s: %r" % (where, v))
            bad += 1
        elif type(v) is float:
            av = abs(v)
            if not math.isfinite(v):
                print("NONCANON non-finite float at %s: %r" % (where, v))
                bad += 1
            elif v == int(v):
                print("NONCANON integral float at %s: %r" % (where, v))
                bad += 1
            elif av < 1e-4:
                print("NONCANON lower exponent-range float at %s: %r" % (where, v))
                bad += 1

    for k in ("ALL", "META", "DETAIL", "HUBS", "UNIVERSE", "WORLDLINKS", "TRAVEL", "XPACS"):
        walk(data[k], k)
    print("\nRESULT: %s" % ("PASS" if bad == 0 else "FAIL (%d)" % bad))
    return 1 if bad else 0


def cmd_lf(path):
    """Reject CR bytes so the generated artifact is platform-independent LF."""
    data = open(path, "rb").read()
    bad = data.count(b"\r")
    if bad:
        print("NON-LF artifact contains %d CR byte(s)" % bad)
    print("\nRESULT: %s" % ("PASS" if bad == 0 else "FAIL (%d)" % bad))
    return 1 if bad else 0


FORBIDDEN = ["__AUTHOR__", "__END_AUTHOR__", "__USER__", "__END_USER__", "__CRED__", "__VERSION__",
             "layout.json", "world.json", "build.py",
             "buildLayoutObject", "buildWorldObject", "spliceBetween",
             "getPristine", "exportStandaloneHTML", "exportLayout", "exportWorld",
             "__DATA_ALL__", "__END_ALL__", "__DATA_HUBS__", "__END_HUBS__",
             "__DATA_WL__", "__END_WL__", "__DATA_UNI__", "__END_UNI__",
             "bExportHTML", "Save to repo", "Reset to committed", "into the repo"]
REQUIRED = ["const ALL=", "const META=" , "const HUBS=", "const UNIVERSE=",
            "const WORLDLINKS=", "const TRAVEL=", "const XPACS=", "downloadBlob",
            "buildEditState", "detectLinks"]


def cmd_strip(path):
    """User-edition strip completeness: forbidden tokens absent, load-critical present.

    FORBIDDEN is checked against the CODE only (the injected map data is excised first,
    so an arbitrary zone label can never raise a false positive). REQUIRED is checked
    against the whole text, since the declarations themselves live inside that excision.
    """
    text = open(path, encoding="utf-8").read()
    all_prefix = "const ALL="
    all_at = find_decl(text, all_prefix, "{_") - len(all_prefix)
    world_at = find_decl(text, "const WORLDLINKS=", "[_")
    head = text[:all_at] + text[text.index(";", world_at):]
    bad = 0
    for tok in FORBIDDEN:
        n = head.count(tok)
        if n:
            print("FORBIDDEN %-22s x%d" % (tok, n))
            # show the first offending context so it is actionable
            i = head.index(tok)
            print("            ...%s..." % head[max(0, i - 70):i + 70].replace("\n", "\\n"))
            bad += 1
    for tok in REQUIRED:
        # META is declared inline as ", META=" - accept either form
        probe = (", META=", "const META=") if tok == "const META=" else (tok,)
        if not any(p in text for p in probe):
            print("MISSING   %-22s" % tok)
            bad += 1
    print("\nRESULT: %s" % ("PASS" if bad == 0 else "FAIL (%d)" % bad))
    return 1 if bad else 0


def cmd_linediff(a, b):
    import difflib
    la = open(a, encoding="utf-8").read().split("\n")
    lb = open(b, encoding="utf-8").read().split("\n")
    d = [l for l in difflib.unified_diff(la, lb, lineterm="", n=0)
         if l[:1] in "+-" and not l.startswith(("+++", "---"))]
    print("changed lines: %d" % len(d))
    for l in d:
        print(repr(l[:200]))
    return 0


# ------------------------------------------------------------------ ref hints

def cont_dir(c):
    return os.path.join(REPO, "data", "continents",
                        c.replace(" ", "_").replace("'", ""))


def cmd_hints():
    """Verify ref-hint uniqueness for hubs / connectors / world links."""
    world = json.load(open(os.path.join(REPO, "data", "world.json"), encoding="utf-8"))
    bad = 0
    for c in world["order"]:
        lay = json.load(open(os.path.join(cont_dir(c), "layout.json"), encoding="utf-8"))
        hubs = lay.get("hubs", []) or []
        hh = [h.get("kind", "") + "|" + (h.get("label", "") or "") for h in hubs]
        conns = lay.get("connectors", []) or []
        ch = ["%d,%d|%d,%d" % (c2["a"][0], c2["a"][1], c2["b"][0], c2["b"][1]) for c2 in conns]
        for name, arr in (("hubs", hh), ("conns", ch)):
            u = len(set(arr))
            flag = "" if u == len(arr) else "  <-- COLLISION"
            if u != len(arr):
                bad += 1
                dupes = sorted({x for x in arr if arr.count(x) > 1})
                flag += " " + repr(dupes[:4])
            if arr:
                print("%-16s %-6s %d/%d unique%s" % (c, name, u, len(arr), flag))
    wl = world.get("worldLinks", []) or []
    wh = ["%s,%s|%s,%s" % (round(l["a"][0], 1), round(l["a"][1], 1),
                           round(l["b"][0], 1), round(l["b"][1], 1)) for l in wl]
    u = len(set(wh))
    print("%-16s %-6s %d/%d unique%s" % ("(world)", "wconn", u, len(wh),
                                         "" if u == len(wh) else "  <-- COLLISION"))
    if u != len(wh):
        bad += 1
    print("\nRESULT: %s" % ("PASS" if bad == 0 else "FAIL (%d)" % bad))
    return 1 if bad else 0


def cmd_discoveryfresh(data=None):
    """Recompute every discovered input's metadata and per-continent content digest."""
    data = data or os.path.join(REPO, "data")
    mpath = os.path.join(data, "_generated", "manifest.json")
    try:
        with open(mpath, "r", encoding="utf-8") as f:
            manifest = json.load(f)
    except (OSError, ValueError) as exc:
        print("FAIL  cannot read discovery manifest: %s" % exc)
        print("\nRESULT: FAIL (1)")
        return 1

    bad = compared = catalogs = 0
    for cont, entry in manifest.get("continents", {}).items():
        sources = entry.get("discoveredSources")
        if sources is None:
            if entry.get("discovered"):
                print("FAIL  %s has discovered entries but no discoveredSources" % cont)
                bad += 1
            continue
        catalogs += 1
        pairs = []
        for name, expected in sorted(sources.items()):
            tag = expected.get("from")
            srcdir = manifest.get("pack") if tag == "pack" else manifest.get("root")
            if tag not in ("pack", "root") or not srcdir:
                print("FAIL  %s/%s has unusable source tag %r" % (cont, name, tag))
                bad += 1
                continue
            path = os.path.join(srcdir, name)
            try:
                size = os.path.getsize(path)
                h = hashlib.sha256()
                with open(path, "rb") as f:
                    for chunk in iter(lambda: f.read(65536), b""):
                        h.update(chunk)
                digest = h.hexdigest()
            except OSError as exc:
                print("FAIL  cannot read %s/%s: %s" % (cont, name, exc))
                bad += 1
                continue
            compared += 1
            pairs.append((name, digest))
            if size != expected.get("bytes") or digest != expected.get("sha256"):
                print("FAIL  discovered source changed: %s/%s" % (cont, name))
                bad += 1
        digest = hashlib.sha256()
        for name, source_hash in pairs:
            digest.update(("%s %s\n" % (name, source_hash)).encode("utf-8"))
        if entry.get("discoveredSourceCount") != len(pairs):
            print("FAIL  %s discoveredSourceCount: %r vs recomputed %d"
                  % (cont, entry.get("discoveredSourceCount"), len(pairs)))
            bad += 1
        if entry.get("discoveredSourceFingerprint") != digest.hexdigest():
            print("FAIL  %s discoveredSourceFingerprint differs from disk" % cont)
            bad += 1

    print("compared %d discovered source file(s) across %d continent catalog(s)"
          % (compared, catalogs))
    print("\nRESULT: %s" % ("PASS" if bad == 0 else "FAIL (%d)" % bad))
    return 1 if bad else 0


# Continents the travel graph is expected to route. Kunark and Velious ship in the map but stay
# deliberately unrouted, so they are an explicit allowlist rather than a silent gap - routing one
# later has to be a deliberate edit here.
TRAVEL_ROUTED = ("Antonica", "Faydwer", "Odus", "Ocean of Tears", "Erud's Crossing",
                 "Timorous Deep", "Plane of Fear", "Plane of Hate", "Plane of Sky")
TRAVEL_UNROUTED = ("Kunark", "Velious")

# Zones inside a routed continent with no way in yet, because the transport leg that reaches
# them is not recoverable from data/. Empty as of the classic pass: every routed zone has a
# route. Declared rather than tolerated - a zone that falls out of the graph is a hard failure,
# and the check also fails if a zone listed here becomes routed, so the list cannot rot.
TRAVEL_AWAITING = ()


def cmd_xpacs(world=None):
    """Schema of the expansion declaration, and the realm invariant it holds AT EVERY ONE.

    Folded into cmd_travel rather than added as a separate runner step, because that command
    already loads world.json and run.py invokes a fixed list - a command nothing runs is dead
    code. Returns a failure count instead of an exit status, so the caller can add it in.
    """
    standalone = world is None
    if standalone:
        world = json.load(open(os.path.join(REPO, "data", "world.json"), encoding="utf-8"))
    bad = 0
    xpacs = world.get("xpacs") or {}
    order = xpacs.get("order") or []
    if not isinstance(order, list) or not order or len(set(order)) != len(order):
        print("FAIL  xpacs.order must be a non-empty list of distinct ids: %r" % (order,))
        return bad + 1
    if xpacs.get("default") not in order:
        print("FAIL  xpacs.default %r is not one of xpacs.order" % (xpacs.get("default"),))
        bad += 1
    for e in order:
        if not (xpacs.get("labels") or {}).get(e):
            print("FAIL  xpacs.labels has no display name for %r" % e)
            bad += 1

    meta = world.get("meta") or {}
    for c in world["order"]:
        m = meta.get(c) or {}
        if not m.get("alt"):
            print("FAIL  meta[%r] has no alt (realm)" % c)
            bad += 1
        if m.get("xpac") not in order:
            print("FAIL  meta[%r] xpac %r is not one of xpacs.order" % (c, m.get("xpac")))
            bad += 1

    # The realm check runs BOTH ways, at every expansion. Forwards: a continent may not name a
    # realm no active entity offers. Backwards: an active entity's realm must yield at least one
    # continent - the world view dereferences ALTITUDES[alt] with no guard, so a realm emptied by
    # an expansion filter is a thrown error rather than an empty globe.
    active = [e for e in world.get("universe", []) if e.get("active") and e.get("alt")]
    offered = {e["alt"] for e in active}
    for c in world["order"]:
        a = (meta.get(c) or {}).get("alt")
        if a and a not in offered:
            print("FAIL  meta[%r] names realm %r, which no active realm entity offers" % (c, a))
            bad += 1
    for e in active:
        for xpac in order:
            rank = order.index(xpac)
            n = sum(1 for c in world["order"]
                    if (meta.get(c) or {}).get("alt") == e["alt"]
                    and (meta.get(c) or {}).get("xpac") in order
                    and order.index(meta[c]["xpac"]) <= rank)
            if not n:
                print("FAIL  realm %r has no continent at xpac %r" % (e["alt"], xpac))
                bad += 1
    if not bad:
        print("xpacs: %d declared (%s), default %r; every realm is non-empty at each"
              % (len(order), ", ".join(order), xpacs.get("default")))
    if standalone:
        print("\nRESULT: %s" % ("PASS" if bad == 0 else "FAIL (%d)" % bad))
    return bad


def cmd_travel():
    """Structural integrity of the authored travel graph in data/travel.json.

    Enforces what can be enforced (roster, schema, dangling references) and REPORTS what
    cannot (how much of the transport network is authored yet). Reachability is checked
    against a declared expectation rather than "every continent's walk graph is one
    component", which would force a fictional walk edge the first time a zone is
    legitimately transport-only.
    """
    dpath = os.path.join(REPO, "data")
    world = json.load(open(os.path.join(dpath, "world.json"), encoding="utf-8"))
    xpac_bad = cmd_xpacs(world)
    tpath = os.path.join(dpath, "travel.json")
    if not os.path.exists(tpath):
        print("MISSING %s" % tpath)
        print("\nRESULT: FAIL (1)")
        return 1
    T = json.load(open(tpath, encoding="utf-8"))
    bad, warn = xpac_bad, 0

    zone_cont = {}
    for c in world["order"]:
        for zk in json.load(open(os.path.join(cont_dir(c), "continent.json"),
                                 encoding="utf-8"))["zoneOrder"]:
            zone_cont[zk] = c
    routed = {zk for zk, c in zone_cont.items() if c in TRAVEL_ROUTED}
    unrouted = {zk for zk, c in zone_cont.items() if c in TRAVEL_UNROUTED}

    missing_cont = [c for c in TRAVEL_ROUTED + TRAVEL_UNROUTED if c not in world["order"]]
    if missing_cont:
        print("FAIL  travel continent lists name continents absent from world.json: %s"
              % missing_cont)
        bad += 1

    # --- schema sanity -----------------------------------------------------
    caps = {c["id"] for c in T.get("capabilities", [])}
    seen_pairs, seen_ids = set(), set()
    for e in T.get("walk", []):
        z = e.get("z") or []
        if len(z) != 2 or z[0] == z[1]:
            print("FAIL  walk entry is not a distinct zone pair: %r" % (e,))
            bad += 1
            continue
        key = tuple(sorted(z))
        if key in seen_pairs:
            print("FAIL  duplicate walk pair %s|%s" % key)
            bad += 1
        seen_pairs.add(key)
        cost = e.get("cost")
        if not isinstance(cost, (int, float)) or cost < 0 or cost != cost or cost in (
                float("inf"), float("-inf")):
            print("FAIL  walk %s|%s has a non-finite or negative cost %r" % (key + (cost,)))
            bad += 1
    for r in T.get("routes", []):
        rid = r.get("id")
        if not rid or rid in seen_ids:
            print("FAIL  route id missing or duplicated: %r" % rid)
            bad += 1
        seen_ids.add(rid)
        if r.get("topology") not in ("line", "clique", "anywhere"):
            print("FAIL  route %s has unknown topology %r" % (rid, r.get("topology")))
            bad += 1
        capref = r.get("capability")
        if capref is not None and capref not in caps:
            print("FAIL  route %s references undeclared capability %r" % (rid, capref))
            bad += 1
        hubs = r.get("hubs")
        if hubs is not None and len(hubs) != len(r.get("stops", [])):
            print("FAIL  route %s: hubs/stops length mismatch (%d vs %d)"
                  % (rid, len(hubs), len(r.get("stops", []))))
            bad += 1
        cost = r.get("cost")
        if not isinstance(cost, (int, float)) or cost < 0:
            print("FAIL  route %s has a non-finite or negative cost %r" % (rid, cost))
            bad += 1
        # access[i] is the in-zone walk to or from stop i's hub, and it is indexed in lockstep
        # with stops, so a length mismatch silently prices the wrong stop's walk onto a leg.
        acc = r.get("access")
        if acc is not None:
            if len(acc) != len(r.get("stops", [])):
                print("FAIL  route %s: access/stops length mismatch (%d vs %d)"
                      % (rid, len(acc), len(r.get("stops", []))))
                bad += 1
            for i, a in enumerate(acc):
                if not isinstance(a, (int, float)) or a < 0 or a != a:
                    print("FAIL  route %s: access[%d] is not a non-negative number: %r"
                          % (rid, i, a))
                    bad += 1

    # --- hiding a route whole must never cost an edge that still exists ----
    # The runtime hides a route when ANY in-build stop's zone is out of range. For a two-stop
    # boat that is exactly right and the straddle is the POINT: Butcherblock is first-expansion,
    # Timorous is
    # not, and the boat between them should vanish with its far end. "No route may span two
    # expansions" would therefore fail the one route the feature was built for.
    #
    # The real hazard is bluntness on a longer route: hide a three-stop line whose last stop is
    # a later expansion and the first two lose a leg that was fine, and one later-expansion stop
    # added to a druid-ring route would take every already-existing destination with it. So the
    # check is stated as the consequence rather than as the shape - fail when hiding the route
    # would remove a connection BOTH of whose ends exist at that point. No authored route trips
    # it, and the day one would, that is a decision to make rather than a rule to discover.
    xpac_of = {}
    for c in world["order"]:
        xpac_of[c] = ((world.get("meta") or {}).get(c) or {}).get("xpac")
    eorder = ((world.get("xpacs") or {}).get("order")) or []
    for r in T.get("routes", []):
        stops = [s for s in r.get("stops", []) if s in zone_cont]
        for xpac in eorder:
            rank = eorder.index(xpac)

            def live(s, _r=rank):
                e = xpac_of.get(zone_cont.get(s))
                return e in eorder and eorder.index(e) <= _r

            if all(live(s) for s in stops):
                continue                      # route survives here; nothing is lost
            if r.get("topology") == "anywhere":
                lost = [s for s in stops if live(s)]          # each stop is its own arrival
            elif r.get("topology") == "line":
                lost = [(a, b) for a, b in zip(stops, stops[1:]) if live(a) and live(b)]
            else:                                             # clique
                lost = [(a, b) for i, a in enumerate(stops)
                        for b in stops[i + 1:] if live(a) and live(b)]
            if lost:
                print("FAIL  route %s is hidden at xpac %r, but %d of its connection(s) join "
                      "zones that both exist then: %s. Hiding it whole would drop them - split "
                      "the route, or teach the runtime per-stop filtering deliberately."
                      % (r.get("id"), xpac, len(lost), lost[:3]))
                bad += 1
                break

    # --- overrides block ---------------------------------------------------
    # Deliberate rulings against a past bootstrap proposal, so --audit reports genuine drift
    # instead of re-flagging every correction forever. Validated here because a ruling naming
    # a zone that no longer exists is silent rot: audit would keep subtracting a dead pair.
    ov = T.get("overrides", {}) or {}
    for side in ("added", "removed"):
        for pair in ov.get(side, []):
            if not isinstance(pair, list) or len(pair) != 2 or pair[0] == pair[1]:
                print("FAIL  overrides.%s entry is not a distinct zone pair: %r" % (side, pair))
                bad += 1
                continue
            for zk in pair:
                if zk not in zone_cont:
                    print("FAIL  overrides.%s names unknown zone key %r" % (side, zk))
                    bad += 1
    both = ({tuple(sorted(p)) for p in ov.get("added", []) if isinstance(p, list) and len(p) == 2}
            & {tuple(sorted(p)) for p in ov.get("removed", []) if isinstance(p, list) and len(p) == 2})
    for pair in sorted(both):
        print("FAIL  overrides lists %s|%s as both added and removed" % pair)
        bad += 1
    for pair in ov.get("added", []):
        if isinstance(pair, list) and len(pair) == 2 and tuple(sorted(pair)) not in seen_pairs:
            print("FAIL  overrides.added %s|%s is not actually in walk[]" % tuple(sorted(pair)))
            bad += 1
    for pair in ov.get("removed", []):
        if isinstance(pair, list) and len(pair) == 2 and tuple(sorted(pair)) in seen_pairs:
            print("FAIL  overrides.removed %s|%s is present in walk[]" % tuple(sorted(pair)))
            bad += 1

    # --- roster, both directions -------------------------------------------
    # A zone dropped from zoneOrder leaves dangling references, the same class of failure
    # as a zone added, so neither direction can be skipped.
    referenced = {zk for e in T.get("walk", []) for zk in (e.get("z") or [])}
    for r in T.get("routes", []):
        referenced |= {s for s in r.get("stops", []) if isinstance(s, str)}
    for members in T.get("groups", {}).values():
        referenced |= set(members)

    dangling = sorted(zk for zk in referenced if zk not in zone_cont)
    if dangling:
        for zk in dangling:
            print("FAIL  travel.json references unknown zone key %r" % zk)
        bad += len(dangling)
    stowaway = sorted(zk for zk in referenced if zk in unrouted)
    if stowaway:
        for zk in stowaway:
            print("FAIL  %r is in a deliberately unrouted continent (%s) but is referenced"
                  % (zk, zone_cont[zk]))
        bad += len(stowaway)
    absent = sorted(zk for zk in routed if zk not in referenced)
    for zk in absent:
        if zk in TRAVEL_AWAITING:
            warn += 1
            print("await %r (%s) has no route yet - declared in TRAVEL_AWAITING"
                  % (zk, zone_cont[zk]))
        else:
            print("FAIL  routed zone %r (%s) has no walk edge, route stop or group entry"
                  % (zk, zone_cont[zk]))
            bad += 1
    stale = [zk for zk in TRAVEL_AWAITING if zk in referenced]
    if stale:
        # the gap closed; the declaration has to go so the roster check regains its teeth
        for zk in stale:
            print("FAIL  %r is now routed - remove it from TRAVEL_AWAITING" % zk)
        bad += len(stale)

    # --- reachability across continents ------------------------------------
    adj = {}

    def link(a, b):
        adj.setdefault(a, set()).add(b)
        adj.setdefault(b, set()).add(a)

    for e in T.get("walk", []):
        z = e.get("z") or []
        if len(z) == 2:
            link(z[0], z[1])
    ungated = {c["id"] for c in T.get("capabilities", []) if not c.get("gated")}

    def is_open(r):
        capref = r.get("capability")
        return capref is None or capref in ungated

    # `anywhere` is DIRECTED - "reachable from any zone" lets you port TO a stop from wherever
    # you stand, but the edge does not run backwards, so it cannot be used to travel between two
    # arbitrary zones. Only walk / line / clique edges are genuinely bidirectional and belong in
    # a component computation; `anywhere` stops are tracked as "has a way in" instead. Modelling
    # them as an undirected clique over-reports connectivity. Phase 2 must honour the same
    # asymmetry: union the destinations into each node's neighbours during the search, per-hop,
    # rather than baking them into the adjacency.
    def add_routes(target_link, gated_too):
        arrivals = set()
        for r in T.get("routes", []):
            if not gated_too and not is_open(r):
                continue
            stops = [s for s in r.get("stops", []) if isinstance(s, str) and s in zone_cont]
            topo = r.get("topology")
            if topo == "anywhere":
                arrivals |= set(stops)
            elif topo == "line":
                for a, b in zip(stops, stops[1:]):
                    target_link(a, b)
            else:                                    # clique
                for i, a in enumerate(stops):
                    for b in stops[i + 1:]:
                        target_link(a, b)
        return arrivals

    arrivals_open = add_routes(link, False)

    # Second pass with gated routes included. A zone that only becomes reachable once a
    # capability is granted is correct behaviour (a plane you need a portal for), NOT an
    # authoring gap - reporting the two identically makes the expected case look broken.
    adj_all = {k: set(v) for k, v in adj.items()}

    def link_all(a, b):
        adj_all.setdefault(a, set()).add(b)
        adj_all.setdefault(b, set()).add(a)

    arrivals_all = add_routes(link_all, True)

    def components(graph):
        seen, out = set(), []
        for zk in sorted(routed):
            if zk in seen:
                continue
            stack, comp = [zk], []
            seen.add(zk)
            while stack:
                cur = stack.pop()
                comp.append(cur)
                for n in graph.get(cur, ()):
                    if n in routed and n not in seen:
                        seen.add(n)
                        stack.append(n)
            out.append(sorted(comp))
        return out

    comps, comps_all = components(adj), components(adj_all)
    # "has a way in" = in a multi-zone component, or the arrival end of an `anywhere` route.
    open_ok = {zk for c in comps if len(c) > 1 for zk in c} | arrivals_open
    any_ok = {zk for c in comps_all if len(c) > 1 for zk in c} | arrivals_all
    print("reachability over %d routed zones: %d bidirectional component(s) ungated; "
          "%d zone(s) with no way in at all" % (len(routed), len(comps),
                                                len(routed - any_ok)))
    for comp in sorted(comps, key=lambda c: -len(c)):
        conts = ", ".join(sorted({zone_cont[z] for z in comp}))
        if len(comp) > 1:
            tag = ""
        elif comp[0] not in any_ok:
            tag = "  (no way in by any route)"
        elif comp[0] not in open_ok:
            tag = "  (gated-only - needs a capability, expected)"
        else:
            tag = "  (arrival-only - reachable from anywhere, no onward walk)"
        print("   %3d zones  %s%s" % (len(comp), conts, tag))
    orphans = sorted(routed - any_ok)
    if orphans:
        warn += 1
        print("   NOTE: no way in even with every capability granted: %s."
              % ", ".join(orphans))
        print("   Each needs a transport route authored - see docs/internal/travel-guide.md.")

    print("\nwalk edges %d | routes %d | groups %d | capabilities %d"
          % (len(T.get("walk", [])), len(T.get("routes", [])),
             len(T.get("groups", {})), len(caps)))
    print("RESULT: %s%s" % ("PASS" if bad == 0 else "FAIL (%d)" % bad,
                            "  [%d warning(s)]" % warn if warn else ""))
    return 1 if bad else 0


if __name__ == "__main__":
    cmd = sys.argv[1]
    sys.exit(globals()["cmd_" + cmd](*sys.argv[2:]))
