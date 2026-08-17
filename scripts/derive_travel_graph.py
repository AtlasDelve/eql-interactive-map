#!/usr/bin/env python3
"""Bootstrap (and later audit) the travel graph from committed map geometry.

The travel graph in data/travel.json is AUTHORED, not derived at build time - see
docs/internal/travel-guide.md for why. This script exists to make the first authoring
pass cheap, and afterwards to report drift:

    python scripts/derive_travel_graph.py                  # propose -> stdout summary + review report
    python scripts/derive_travel_graph.py --out PATH       # also write the proposal JSON
    python scripts/derive_travel_graph.py --audit          # diff proposal against authored data/travel.json
    python scripts/derive_travel_graph.py --recost         # rewrite the geometry-derived costs (walk + route access)
    python scripts/derive_travel_graph.py --scope all      # include Kunark + Velious (default: classic only)

Nothing here runs at build time. build.py reads data/travel.json verbatim.

Walk edges come from three sources, unioned:
  * geometric welds   - zone outlines within LINK_THRESH of each other
  * connectors        - each endpoint resolved to its nearest zone (the viewer's own rule)
  * manual links      - layout.json links flagged {"manual": true}

...minus the deleted-plus-no-connector case. layout.json's links[].deleted is an EDITOR
rigid-group signal, not a statement that two zones do not connect, so it cannot be
subtracted blindly: doing that shatters Antonica into 4 components. The rule applied here
is "deleted AND a connector exists -> still adjacent; deleted AND no connector -> drop".
It is right on most of the current 14 deleted entries but not all, which is exactly why
every one of them lands in the review report.

Python 3 standard library only.
"""
import argparse
import json
import math
import os
import re
import sys
from collections import defaultdict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import import_pack                                              # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")
TRAVEL = os.path.join(DATA, "travel.json")

# Hub labels carry em dashes and arrows, and the default Windows console codec is cp1252, so
# an unguarded print() of the hub inventory dies with UnicodeEncodeError the moment output is
# piped. Force UTF-8 on our own streams rather than mangling the data to suit the terminal.
for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):        # pre-3.7, or a stream that cannot be rewrapped
        pass

# Mirrors src/template.html: ANCHOR_THRESH/LINK_THRESH must stay in step with the viewer,
# because the edges proposed here are the ones the author sees drawn on the map.
LINK_THRESH = 120
ANCHOR_THRESH = 1200
SAMPLE_MAX = 700          # detectLinks() samples at most this many outline points per zone
COST_SAMPLE = 200         # outline points per zone for the closest-approach cost scan
REVIEW_DIST = 100         # connector endpoint further than this from its zone -> flag for review
COST_DIVERGE = 0.25       # untransformed vs transformed cost differing by more than this -> flag
NEARMISS_GAP = 20         # weld-only edge whose outlines stay this far apart -> flag for review

# Phase 1 routes the classic continents only. Kunark and Velious ship in the map but stay
# unrouted until EQL has them; the verify layer keeps that an explicit allowlist, not a gap.
CLASSIC = ["Antonica", "Faydwer", "Odus", "Ocean of Tears", "Erud's Crossing",
           "Timorous Deep", "Plane of Fear", "Plane of Hate", "Plane of Sky"]

# Nominal continent-frame units per cost unit. Cost is authored and hand-tunable; this only
# sets the bootstrap default, so it needs to be reasonable, not exact.
UNITS_PER_COST = 250.0


def load(path):
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def cont_dir(cont):
    return os.path.join(DATA, "continents", cont.replace(" ", "_").replace("'", ""))


def gen_dir(cont):
    """The regenerated half of a continent. Traces live in the cache, not in data/."""
    return os.path.join(DATA, import_pack.CACHE_DIRNAME, "continents",
                        cont.replace(" ", "_").replace("'", ""))


# ---------------------------------------------------------------- geometry (mirrors viewer)

def tpoint(z, x, y):
    """Apply a zone's render-time affine, exactly as the viewer's tPoint() does."""
    xf = z.get("xf") or {}
    s = xf.get("s", 1)
    s = 1 if s is None else s
    rot = xf.get("rot", 0)
    dx, dy = (x - z["cx"]) * s, (y - z["cy"]) * s
    c, si = math.cos(rot), math.sin(rot)
    return (z["cx"] + dx * c - dy * si + xf.get("tx", 0),
            z["cy"] + dx * si + dy * c + xf.get("ty", 0))


def tinv(z, X, Y):
    """Inverse of tpoint: a world point back into the zone's LOCAL frame."""
    xf = z.get("xf") or {}
    s = xf.get("s", 1)
    s = 1 if s is None else s
    rot = xf.get("rot", 0)
    dx, dy = X - z["cx"] - xf.get("tx", 0), Y - z["cy"] - xf.get("ty", 0)
    c, si = math.cos(-rot), math.sin(-rot)
    return (z["cx"] + (dx * c - dy * si) / s, z["cy"] + (dx * si + dy * c) / s)


def sampled_points(z):
    """Transformed outline points, sampled the same way detectLinks() samples them."""
    pts = []
    for s in z["segs"]:
        pts.append((s[0], s[1]))
        pts.append((s[2], s[3]))
    if len(pts) > SAMPLE_MAX:
        step = len(pts) / SAMPLE_MAX
        pts = [pts[int(i * step)] for i in range(SAMPLE_MAX)]
    return [tpoint(z, p[0], p[1]) for p in pts]


def dist_to_zone(z, px, py, ceiling=None):
    """Min distance from a point to a zone's transformed outline.

    `ceiling` lets the caller skip a zone that cannot beat the current best; the AABB test
    is exact enough to prune hard without changing the answer.
    """
    if ceiling is not None:
        xs = [p[0] for p in z["_pts"]]
        ys = [p[1] for p in z["_pts"]]
        gx = max(0.0, min(xs) - px, px - max(xs))
        gy = max(0.0, min(ys) - py, py - max(ys))
        if math.hypot(gx, gy) > ceiling:
            return None
    best = float("inf")
    for s in z["segs"]:
        ax, ay = tpoint(z, s[0], s[1])
        bx, by = tpoint(z, s[2], s[3])
        dx, dy = bx - ax, by - ay
        l2 = dx * dx + dy * dy
        t = ((px - ax) * dx + (py - ay) * dy) / l2 if l2 else 0.0
        t = 0.0 if t < 0 else (1.0 if t > 1 else t)
        qx, qy = ax + t * dx, ay + t * dy
        d = (px - qx) ** 2 + (py - qy) ** 2
        if d < best:
            best = d
    return math.sqrt(best)


def nearest_zone(zones, px, py):
    best, bd = None, float("inf")
    for k, z in zones.items():
        d = dist_to_zone(z, px, py, ceiling=bd)
        if d is not None and d < bd:
            bd, best = d, k
    return best, bd


def detect_welds(zones):
    """Zone pairs whose outlines come within LINK_THRESH, plus the nearest-approach points.

    Grid-bucketed at cell size LINK_THRESH so this is O(total points) rather than the
    viewer's O(pairs x points^2) - the viewer can afford the naive form because it runs
    once per edit session on one continent.
    """
    grid = defaultdict(list)
    for k, z in zones.items():
        for x, y in z["_pts"]:
            grid[(int(x // LINK_THRESH), int(y // LINK_THRESH))].append((k, x, y))
    best = {}
    for (cx, cy), bucket in grid.items():
        neigh = []
        for ox in (-1, 0, 1):
            for oy in (-1, 0, 1):
                neigh.extend(grid.get((cx + ox, cy + oy), ()))
        for k1, x1, y1 in bucket:
            for k2, x2, y2 in neigh:
                if k1 >= k2:
                    continue
                d = math.hypot(x1 - x2, y1 - y2)
                if d > LINK_THRESH:
                    continue
                pair = (k1, k2)
                if pair not in best or d < best[pair][0]:
                    best[pair] = (d, (x1, y1), (x2, y2))
    return best


# ---------------------------------------------------------------- derivation

def load_continent(cont):
    base = cont_dir(cont)
    meta = load(os.path.join(base, "continent.json"))
    layout = load(os.path.join(base, "layout.json"))
    xfs = layout.get("zoneXf", {}) or {}
    gen = gen_dir(cont)
    azones = meta.get("zones") or {}
    zones = {}
    for zk in meta["zoneOrder"]:
        z = import_pack.compose_zone(azones[zk],
                                     load(os.path.join(gen, "geometry", zk + ".json")),
                                     xfs.get(zk))
        z["_pts"] = sampled_points(z)
        zones[zk] = z
    return zones, layout, meta


# ------------------------------------------------- zone transitions (mirrors the viewer)
# A zone's detail map marks its own exits with `to_`/`from_` labels, and that is the primary
# source for WHERE a zone line is. Resolving those labels needs the viewer's own name index, so
# the four pieces below mirror src/template.html: znorm, ZIDX built from DETAIL zone names,
# ZALIAS, LINK_OVERRIDE. Two copies of a table is a drift risk, so travel-full.test.js checks
# the authored costs against the RUNTIME's own resolution - if these fall out of step with the
# template, the costs written here stop matching and that test fails.
#
# ZIDX is first-wins and its keys genuinely collide (all three Neriak quarters normalise to
# "neriak"). This copy walks world.json order and zoneOrder within each continent; the viewer
# instead walks DETAIL in detailZones order. The colliding groups retain the same relative order
# today, so the two copies agree by coincidence rather than by construction.
_SPELL = [("forrest", "forest"), ("excile", "exile"), ("cablis", "cabilis"),
          ("toxullia", "toxxulia"), ("feerott", "feerrott"), ("aquaduct", "aqueduct"),
          ("northern", "north"), ("southern", "south"), ("eastern", "east"),
          ("western", "west")]
ZALIAS = {"butcherblock": "butcherblock mountains", "kerra ridge": "kerra isle",
          "castle of mistmoore": "castle mistmoore", "city of guk": "upper guk",
          "erudin city": "erudin", "erudin docks": "erudin",
          "north ro": "north desert of ro", "south ro": "south desert of ro",
          "permafrost keep": "permafrost caverns", "temple of cazic-thule": "cazic-thule",
          "skyshrine lower level": "skyshrine", "ruins of old guk": "lower guk",
          "ruins of old paineel": "warrens", "ruins of sebilis": "old sebilis",
          "city of thurgadin": "thurgadin", "qeynos aqueduct system": "qeynos catacombs",
          "liberated citadel of runnyeye": "runnyeye citadel",
          "valley of king xorbb": "gorge of king xorbb"}
LINK_OVERRIDE = {"kithicor|to_The_Commonlands": "commons",
                 "befallen|to_The_Commonlands": "commons"}


def znorm(s):
    s = s.lower().replace("`", "'").replace("_", " ")
    s = re.sub(r"^\s*(to|from)\s+", "", s)
    s = re.sub(r"\(.*?\)", "", s)
    s = re.sub(r":.*$", "", s)
    s = re.sub(r"\bone[- ]way\b", "", s).replace("&", " ").replace(" - ", " ")
    for a, b in _SPELL:
        s = s.replace(a, b)
    s = s.replace("plains of karana", "karana")
    s = re.sub(r"^(the|clan)\s+", "", s)
    return re.sub(r"\s+", " ", s).strip(" -")


def build_zidx(conts):
    """Name -> zone key over detail maps, in authored zoneOrder insertion order."""
    idx = {}

    def put(k, v):
        k = k.strip()
        if k and k not in idx:
            idx[k] = v
    for cont in conts:
        base = cont_dir(cont)
        cj = os.path.join(base, "continent.json")
        if not os.path.exists(cj):
            continue
        cmeta = load(cj)
        for zk in cmeta["zoneOrder"]:
            # Gate on the zone having a detail map, not merely being in zoneOrder: the
            # viewer builds ZIDX from DETAIL and this index must mirror it key for key,
            # because put() is first-wins over genuine collisions. The name comes from the
            # authored layer now - the cached detail file carries no name of its own.
            if not os.path.exists(os.path.join(gen_dir(cont), "detail", zk + ".json")):
                continue
            nm = (cmeta.get("zones") or {})[zk]["name"]
            nl = nm.lower()
            put(znorm(nm), (cont, zk))
            mm = re.search(r"\((north|south|east|west)\)", nl)
            if mm:
                b = znorm(re.sub(r"\s*\((north|south|east|west)\)", "", nl))
                put(mm.group(1) + " " + b, (cont, zk))
                put(b + " " + mm.group(1), (cont, zk))
            m2 = re.search(r"neriak \((.*)\)", nl)
            if m2:
                put("neriak " + m2.group(1), (cont, zk))
    return idx


def resolve_zone(idx, lab):
    n = znorm(lab)
    if n in idx:
        return idx[n]
    a = ZALIAS.get(n)
    return idx.get(a) if a else None


def transition_targets(idx, zk, full):
    """Zone keys a detail label is a doorway to. Mirrors the viewer's transitionTargets()."""
    if not re.match(r"^(to|from)_", full, re.I):
        return []
    ov = LINK_OVERRIDE.get(zk + "|" + full)
    if ov:
        return [ov]
    amp = full.find("&")
    if amp < 0:
        t = resolve_zone(idx, full)
        return [t[1]] if t else []
    out = []
    for part in (full[:amp], full[amp + 1:]):
        t = resolve_zone(idx, part)
        if t:
            out.append(t[1])
    return out


def detail_offset(z, det):
    """Detail frame -> continent frame. A pure translation, recovered from one segment pair.

    Confirmed against a second, well-separated segment before it is trusted: one pair is enough
    to RECOVER a translation and not enough to know there is one, and a re-import that reordered
    or dropped a segment would give a plausible offset that silently misplaced every exit in the
    zone. Mirrors the viewer's detailOffset(), including giving up rather than guessing.
    """
    if not z["segs"] or not det["segs"]:
        return None
    ox = z["segs"][0][0] - det["segs"][0][0]
    oy = z["segs"][0][1] - det["segs"][0][1]
    m = min(len(z["segs"]), len(det["segs"])) // 2
    a, b = z["segs"][m], det["segs"][m]
    if abs((a[0] - b[0]) - ox) > 1.5 or abs((a[1] - b[1]) - oy) > 1.5:
        return None
    return ox, oy


def exit_points(cont, zones, idx, meta):
    """{(from_key, to_key): (x, y)} in LOCAL continent coords, from the detail-map labels.

    Composed, not read raw: an authored label is a doorway too, and reading the cache directly
    here would make the audit blind to exactly the markers a human added because the pack
    lacked them.
    """
    gen = gen_dir(cont)
    azones = meta.get("zones") or {}
    palette_path = os.path.join(gen, "palette.json")
    palette = load(palette_path) if os.path.exists(palette_path) else []
    out = {}
    for zk, z in zones.items():
        dp = os.path.join(gen, "detail", zk + ".json")
        if not os.path.exists(dp):
            continue
        det = import_pack.compose_detail(azones[zk], load(dp), palette)
        off = detail_offset(z, det)
        if not off:
            continue
        for lab in det["labels"]:
            for tgt in transition_targets(idx, zk, lab[4]):
                out.setdefault((zk, tgt), (lab[0] + off[0], lab[1] + off[1]))
    return out


def nearest_outline_point(z, px, py, transformed):
    """The point of z's outline nearest (px,py), in the same frame the caller is working in.

    Scans EVERY segment endpoint rather than cost_points()' 200-point sample. That sample exists
    for the O(n*m) closest-approach scan; this is O(n), so thinning it buys nothing and only costs
    accuracy - and it runs at most twice per one-sided edge, of which there are two.
    """
    best, bp = float("inf"), (z["cx"], z["cy"])
    for s in z["segs"]:
        for p in ((s[0], s[1]), (s[2], s[3])):
            q = tpoint(z, p[0], p[1]) if transformed else p
            d = (q[0] - px) ** 2 + (q[1] - py) ** 2
            if d < best:
                best, bp = d, q
    return bp


def cost_points(z, transformed):
    """Outline points for the cost measurement, thinned for an O(n*m) closest-pair scan.

    Separate from `_pts` because that one is always transformed and sampled for weld
    detection. A few units of imprecision is irrelevant after dividing by UNITS_PER_COST.
    """
    key = "_cpts_t" if transformed else "_cpts"
    if key not in z:
        pts = []
        for s in z["segs"]:
            pts.append((s[0], s[1]))
            pts.append((s[2], s[3]))
        if len(pts) > COST_SAMPLE:
            step = len(pts) / COST_SAMPLE
            pts = [pts[int(i * step)] for i in range(COST_SAMPLE)]
        z[key] = [tpoint(z, p[0], p[1]) for p in pts] if transformed else pts
    return z[key]


def cost_between(zones, k1, k2, transformed, exits=None):
    """Default walk cost: centroid -> the doorway each zone names -> centroid, / UNITS_PER_COST.

    NOT centroid separation. The continental stitch does not place zones at true relative
    distance - Innothule Swamp and South Desert of Ro are drawn 13 800 units apart with
    nothing between them - so centroid separation bills the traveller for empty canvas. A
    connector between two zones means they are directly connected, whatever the drawing puts
    between them, so the void must not be priced.

    The doorway comes from the zone's OWN detail map: its `to_X`/`from_X` label marks where that
    exit physically is, resolved through the viewer's name index and placed on the continent map
    by detail_offset(). On current data 72 of 74 edges name it from both sides and none from
    neither.

    Geometric closest approach is the FALLBACK, because it is only a valid proxy for a zone line
    where the outlines actually touch. Where a stitch void separates them it returns whichever
    flanks happen to face each other - a fact about relative box placement, not about the game.
    It put the South Ro crossing on Innothule's east flank beside the Guk and Grobb city
    entrances, 3 096 units from the northern entrance the zone itself names. With one label, the
    unnamed end is the point of that outline nearest the named doorway, so it stays pinned to a
    real exit rather than to bounding-box geometry.

    The edge's stored `at` is not the doorway either: it holds the drawn connector's endpoints,
    which on Innothule/South Ro sit 16 553 apart - further than the centroids themselves - and
    land on neither outline.

    transformed=False is what ships. Rotation and scale are about the centroid so they cannot
    move it, but tx/ty can - so a transformed cost would shift whenever an author drags a zone
    for looks. Untransformed stored geometry is stable. Both are computed so the review report
    can flag where they disagree.
    """
    z1, z2 = zones[k1], zones[k2]
    fwd = (lambda z, p: tpoint(z, p[0], p[1])) if transformed else (lambda z, p: p)
    c1, c2 = fwd(z1, (z1["cx"], z1["cy"])), fwd(z2, (z2["cx"], z2["cy"]))
    e1 = (exits or {}).get((k1, k2))
    e2 = (exits or {}).get((k2, k1))
    if e1 and e2:
        pa, pb = fwd(z1, e1), fwd(z2, e2)
    elif e1:
        pa = fwd(z1, e1)
        pb = nearest_outline_point(z2, pa[0], pa[1], transformed)
    elif e2:
        pb = fwd(z2, e2)
        pa = nearest_outline_point(z1, pb[0], pb[1], transformed)
    else:
        A, B = cost_points(z1, transformed), cost_points(z2, transformed)
        best, pa, pb = float("inf"), c1, c2
        for ax, ay in A:
            for bx, by in B:
                d = (ax - bx) ** 2 + (ay - by) ** 2
                if d < best:
                    best, pa, pb = d, (ax, ay), (bx, by)
    reach = math.hypot(c1[0] - pa[0], c1[1] - pa[1]) \
        + math.hypot(pb[0] - c2[0], pb[1] - c2[1])
    return reach / UNITS_PER_COST


def derive(conts):
    walk, notes, hub_rows = [], [], []
    # Built once over every continent, because the viewer's index is global and first-wins:
    # restricting it per continent would resolve a colliding name to a different zone here than
    # in the map, which is the one way this could disagree with what the player sees.
    zidx = build_zidx(load(os.path.join(DATA, "world.json"))["order"])
    for cont in conts:
        zones, layout, meta = load_continent(cont)
        exits = exit_points(cont, zones, zidx, meta)
        keys = set(zones)
        welds = detect_welds(zones)

        # connectors -> zone pairs, using the viewer's nearest-zone rule
        conn_pairs, conn_at, loose = {}, {}, []
        for i, c in enumerate(layout.get("connectors", [])):
            ka, da = nearest_zone(zones, c["a"][0], c["a"][1])
            kb, db = nearest_zone(zones, c["b"][0], c["b"][1])
            if ka is None or kb is None or da > ANCHOR_THRESH or db > ANCHOR_THRESH:
                notes.append((cont, "connector-unresolved",
                              "connector %d: %s(%.0f) / %s(%.0f) exceeds ANCHOR_THRESH"
                              % (i, ka, da, kb, db)))
                continue
            if ka == kb:
                notes.append((cont, "connector-self",
                              "connector %d resolves to %s at both ends - drawn inside one zone"
                              % (i, ka)))
                continue
            pair = (ka, kb) if ka < kb else (kb, ka)
            conn_pairs.setdefault(pair, []).append(i)
            if pair not in conn_at:
                # store per-zone LOCAL coords so the point follows its zone, exactly as
                # connector anchors (la/lb) already do
                pa = tinv(zones[pair[0]], *(c["a"] if pair[0] == ka else c["b"]))
                pb = tinv(zones[pair[1]], *(c["b"] if pair[0] == ka else c["a"]))
                conn_at[pair] = [[round(pa[0], 1), round(pa[1], 1)],
                                 [round(pb[0], 1), round(pb[1], 1)]]
            if max(da, db) > REVIEW_DIST:
                loose.append((i, pair, da, db))

        manual, deleted = set(), set()
        for l in layout.get("links", []):
            if l["z1"] not in keys or l["z2"] not in keys:
                continue
            pair = (l["z1"], l["z2"]) if l["z1"] < l["z2"] else (l["z2"], l["z1"])
            if l.get("deleted"):
                deleted.add(pair)
            elif l.get("manual"):
                manual.add(pair)

        edges = set(welds) | set(conn_pairs) | manual
        for pair in sorted(deleted):
            if pair in conn_pairs:
                notes.append((cont, "deleted-kept",
                              "%s <-> %s: weld deleted but a connector is drawn -> kept as adjacent"
                              % pair))
            else:
                edges.discard(pair)
                notes.append((cont, "deleted-dropped",
                              "%s <-> %s: weld deleted and no connector -> dropped as a "
                              "proximity false positive" % pair))
        for i, pair, da, db in loose:
            notes.append((cont, "loose-endpoint",
                          "connector %d (%s <-> %s) resolved at %.0f / %.0f units - verify it "
                          "joins these zones" % (i, pair[0], pair[1], da, db)))

        for pair in sorted(edges):
            k1, k2 = pair
            src = []
            if pair in welds:
                src.append("weld")
            if pair in conn_pairs:
                src.append("connector")
            if pair in manual:
                src.append("manual")
            c_plain = cost_between(zones, k1, k2, False, exits)
            c_xf = cost_between(zones, k1, k2, True, exits)
            at = conn_at.get(pair)
            if at is None and pair in welds:
                _, p1, p2 = welds[pair]
                a1 = tinv(zones[k1], *p1)
                a2 = tinv(zones[k2], *p2)
                at = [[round(a1[0], 1), round(a1[1], 1)], [round(a2[0], 1), round(a2[1], 1)]]
            entry = {"z": [k1, k2], "cost": round(max(c_plain, 0.1), 1)}
            if at:
                entry["at"] = at
            walk.append(entry)
            hi = max(c_plain, c_xf)
            if hi > 0 and abs(c_plain - c_xf) / hi > COST_DIVERGE:
                notes.append((cont, "cost-diverges",
                              "%s <-> %s: untransformed cost %.1f vs transformed %.1f - the "
                              "author's xf moved these apart; confirm the shipped value"
                              % (k1, k2, c_plain, c_xf)))
            # A weld-only edge is not inherently suspect - touching outlines are usually a real
            # zone line, and 2/3 of the graph arrives that way. What discriminates is the GAP:
            # outlines that actually meet sit near 0, while a near-miss at the top of the
            # LINK_THRESH band is where the false positives live. Only those are worth a human.
            if src == ["weld"]:
                gap = welds[pair][0]
                if gap >= NEARMISS_GAP:
                    notes.append((cont, "weld-nearmiss",
                                  "%s <-> %s: outlines never meet - closest approach %.0f units "
                                  "(threshold %d), no connector drawn. Verify this is a real zone "
                                  "line." % (k1, k2, gap, LINK_THRESH)))

        for i, h in enumerate(layout.get("hubs", [])):
            k, d = nearest_zone(zones, h["x"], h["y"])
            hub_rows.append({"ref": "%s:%d" % (cont, i), "kind": h["kind"],
                             "label": h.get("label", ""), "host": k, "dist": round(d)})
            if h.get("label") and k and zones[k]["name"].lower() not in h["label"].lower():
                notes.append((cont, "hub-host-mismatch",
                              "hub %d %r resolves to host %s (%s) - label names a different zone"
                              % (i, h["label"], k, zones[k]["name"])))

        # a zone reachable by nothing is a hard stop for routing, not a style note
        touched = {k for e in walk for k in e["z"]}
        for zk in meta["zoneOrder"]:
            if zk not in touched and len(meta["zoneOrder"]) > 1:
                notes.append((cont, "isolated",
                              "%s has no proposed walk edge - needs a transport route or a "
                              "manual link" % zk))
    return walk, notes, hub_rows


def scaffold_routes(hub_rows):
    """Turn the hub inventory into route stubs.

    Deliberately does NOT invent destinations. Ring/spire hubs are a destination set, so they
    scaffold cleanly. Boats and portals need real game knowledge that is not in data/ - most
    boat hubs name no destination at all - so they come out as explicit TODOs rather than
    guesses dressed up as data.
    """
    routes, caps = [], []
    by_kind = defaultdict(list)
    for h in hub_rows:
        by_kind[h["kind"]].append(h)

    for kind, cap_id, label in (("ring", "druid", "Druid ports"),
                                ("spire", "wizard", "Wizard ports")):
        rows = by_kind.get(kind, [])
        if not rows:
            continue
        caps.append({"id": cap_id, "label": label, "gated": True})
        seen, stops, hubs = set(), [], []
        for h in rows:
            if h["host"] in seen:
                continue
            seen.add(h["host"])
            stops.append(h["host"])
            hubs.append(h["ref"])
        routes.append({"id": "%s-network" % cap_id, "kind": kind, "capability": cap_id,
                       "topology": "anywhere", "name": label,
                       "stops": stops, "hubs": hubs, "cost": 3})

    for h in by_kind.get("portal", []):
        routes.append({"id": "TODO-portal-%s" % h["host"], "kind": "portal",
                       "capability": "TODO", "topology": "line",
                       "name": h["label"], "stops": [h["host"], "TODO-destination-zone-key"],
                       "hubs": [h["ref"], None], "cost": 3,
                       "_TODO": "destination zone key is not in data/; label says %r" % h["label"]})

    boats = by_kind.get("boat", [])
    if boats:
        routes.append({"id": "TODO-boat-routes", "kind": "boat", "capability": None,
                       "topology": "line", "name": "TODO", "stops": ["TODO"], "cost": 10,
                       "_TODO": "author one route per boat line. Dock hubs found: "
                                + "; ".join("%s -> %s (%s)" % (b["ref"], b["host"], b["label"])
                                            for b in boats)
                                + ". Waypoint zones (oot / erudsxing / timorous) carry no hub "
                                  "and must appear as stops anyway."})
    return routes, caps


def build_proposal(conts):
    walk, notes, hub_rows = derive(conts)
    routes, caps = scaffold_routes(hub_rows)
    return {"version": 1, "groups": {}, "capabilities": caps,
            "walk": sorted(walk, key=lambda e: e["z"]), "routes": routes}, notes, hub_rows


def print_report(proposal, notes, hub_rows, conts):
    print("=" * 78)
    print("TRAVEL GRAPH PROPOSAL - review before authoring data/travel.json")
    print("=" * 78)
    print("continents routed : %d (%s)" % (len(conts), ", ".join(conts)))
    print("walk edges        : %d" % len(proposal["walk"]))
    print("route stubs       : %d" % len(proposal["routes"]))
    print("hubs inventoried  : %d" % len(hub_rows))
    by_kind = defaultdict(int)
    for n in notes:
        by_kind[n[1]] += 1
    print("\nreview items      : %d" % len(notes))
    for k in sorted(by_kind):
        print("   %-22s %d" % (k, by_kind[k]))
    order = ["isolated", "connector-unresolved", "connector-self", "deleted-dropped",
             "deleted-kept", "loose-endpoint", "hub-host-mismatch", "weld-nearmiss",
             "cost-diverges"]
    for kind in order + [k for k in sorted(by_kind) if k not in order]:
        rows = [n for n in notes if n[1] == kind]
        if not rows:
            continue
        print("\n--- %s (%d) ---" % (kind, len(rows)))
        for cont, _, msg in rows:
            print("   [%s] %s" % (cont, msg))
    print("\n--- hub inventory ---")
    for h in sorted(hub_rows, key=lambda r: (r["kind"], r["ref"])):
        print("   %-16s %-7s host=%-14s d=%-5s %s"
              % (h["ref"], h["kind"], h["host"], h["dist"], h["label"]))


def cmd_audit(proposal):
    """Report proposal-vs-authored drift. Reports only - never rewrites authored data."""
    if not os.path.exists(TRAVEL):
        print("no %s yet - nothing to audit (run without --audit to propose one)" % TRAVEL)
        return 1
    authored = load(TRAVEL)
    pa = {tuple(sorted(e["z"])) for e in proposal["walk"]}
    au = {tuple(sorted(e["z"])) for e in authored.get("walk", [])}
    # Deliberate rulings the author already made against a past proposal. Without subtracting
    # these, every correction becomes permanent audit noise and the audit stops being read -
    # which is the staleness failure it exists to prevent, inverted.
    ov = authored.get("overrides", {}) or {}
    ruled_add = {tuple(sorted(p)) for p in ov.get("added", [])}
    ruled_del = {tuple(sorted(p)) for p in ov.get("removed", [])}
    # Which pack this proposal came from. Every geometric claim below is a fact about THIS
    # cache, so two audits that disagree need to be comparable - and the path alone will not
    # do it, since the same path can hold a different revision and the same pack can sit at
    # different paths. The fingerprint is the identity; the path is a hint for a human.
    mpath = os.path.join(DATA, import_pack.CACHE_DIRNAME, "manifest.json")
    if os.path.exists(mpath):
        man = load(mpath)
        print("map pack            : %s" % man.get("pack", "?"))
        print("source fingerprint  : %s  (%d files)"
              % ((man.get("sourceFingerprint") or "?")[:16], man.get("sourceCount", 0)))
    print("authored walk edges : %d" % len(au))
    print("proposed walk edges : %d" % len(pa))
    print("recorded rulings    : %d added, %d removed" % (len(ruled_add), len(ruled_del)))
    new_derivable = (pa - au) - ruled_del
    lost = (au - pa) - ruled_add
    print("\n--- derivable now, absent from travel.json (%d) ---" % len(new_derivable))
    for a, b in sorted(new_derivable):
        print("   + %s <-> %s" % (a, b))
    print("\n--- authored, no longer derivable (%d) ---" % len(lost))
    for a, b in sorted(lost):
        print("   - %s <-> %s" % (a, b))
    stale = sorted((ruled_del & (au & pa)) | {p for p in ruled_add if p in pa})
    if stale:
        # Deliberately NOT "drop this entry". A ruling exists because some pack's geometry
        # could not derive the edge, and whether that is still true is a fact about the pack
        # in front of you. Under multi-pack support this proposal agreeing is not evidence
        # that every pack's does, so the advice is to review, never to remove.
        print("\n--- rulings this pack's proposal no longer needs (%d) ---" % len(stale))
        for a, b in stale:
            print("   ? %s <-> %s: this cache's proposal agrees with the authored edge. Review "
                  "the ruling across the packs you support before removing it." % (a, b))
    pc = {tuple(sorted(e["z"])): e.get("cost") for e in proposal["walk"]}
    drift = [(k, authored_cost, pc[k]) for k, authored_cost in
             ((tuple(sorted(e["z"])), e.get("cost")) for e in authored.get("walk", []))
             if k in pc and authored_cost is not None and pc[k] is not None
             and abs(authored_cost - pc[k]) > max(1.0, 0.25 * max(authored_cost, pc[k]))]
    print("\n--- cost drift beyond 25%% (%d) ---" % len(drift))
    for (a, b), was, now in sorted(drift):
        print("   %s <-> %s: authored %.1f, derivable %.1f" % (a, b, was, now))
    print("\nNOTE: differences are for a human to adjudicate. This command never writes.")
    return 0


def access_cost(zones, layout, stop, anchor):
    """In-zone walk between a stop's centroid and the hub you board or arrive at, / UNITS_PER_COST.

    A vehicle does not pick you up at the middle of the zone. The dock, ring or spire sits
    somewhere in it, and reaching or leaving it is real walking that the flat vehicle cost never
    priced: measured on current data these run 1.1 to 32.4 cost units, and West Karana's wizard
    spire alone is 8 097 units from that zone's centroid - more than a whole port.

    Untransformed stored centroid and the hub's published x,y, for the same reason walk cost is
    untransformed: a user can drag a hub in their own copy, and their customisation must not
    reprice their routing.

    A stop whose hub is absent from data/ costs 0 - not because there is no walk, but because
    nobody has placed the pier. East Freeport is the live case. Inventing an x,y to close the gap
    would be worse than recording it as zero.
    """
    if not anchor:
        return 0.0
    cont, _, idx = anchor.rpartition(":")
    hubs = layout.get("hubs") or []
    if not idx.isdigit() or int(idx) >= len(hubs):
        return 0.0
    h = hubs[int(idx)]
    z = zones.get(stop)
    if z is None:
        return 0.0
    return math.hypot(h["x"] - z["cx"], h["y"] - z["cy"]) / UNITS_PER_COST


def cmd_recost(conts):
    """Recompute the geometry-derived costs in place: walk doorways and route access.

    Distinct from --audit in two ways, both deliberate. It writes, because it is the explicit
    "re-derive my costs" action an author invokes and reads back through git, where --audit is
    the passive drift report that must never touch authored data. And it works over the AUTHORED
    edge set rather than the proposal, so it also prices the edges in overrides.added - which
    geometry does not derive by construction, yet whose doorways their zones name perfectly well
    (guktop|innothule, feerrott|rathemtn). Nothing but `cost` is rewritten: topology, `at`,
    overrides, routes, groups and capabilities all pass through untouched.
    """
    authored = load(TRAVEL)
    zidx = build_zidx(load(os.path.join(DATA, "world.json"))["order"])
    zones_by, exits_by, layout_by = {}, {}, {}
    for cont in conts:
        zones, layout, _meta = load_continent(cont)
        zones_by[cont] = zones
        layout_by[cont] = layout
        exits_by[cont] = exit_points(cont, zones, zidx, _meta)
    changed, missed, total_old, total_new = [], [], 0.0, 0.0
    for e in authored.get("walk", []):
        k1, k2 = e["z"]
        host = next((c for c in conts if k1 in zones_by[c] and k2 in zones_by[c]), None)
        if host is None:
            missed.append((k1, k2))
            continue
        new = round(max(cost_between(zones_by[host], k1, k2, False, exits_by[host]), 0.1), 1)
        old = e.get("cost")
        total_old += old or 0
        total_new += new
        if old is None or abs(old - new) > 0.05:
            changed.append(((k1, k2), old, new))
        e["cost"] = new
    # Route ACCESS costs are walk costs too - the in-zone leg to or from the vehicle - so they are
    # re-derived here. The vehicle's own `cost` (port 30, boat 45, portal 3) is hand-set against the
    # calibration and is never touched by this command.
    racc = []
    for r in authored.get("routes", []):
        anchors = r.get("hubs") or [None] * len(r["stops"])
        old = r.get("access")
        new = []
        for i, s in enumerate(r["stops"]):
            host = next((c for c in conts if s in zones_by[c]), None)
            new.append(round(access_cost(zones_by[host], layout_by[host], s,
                                         anchors[i] if i < len(anchors) else None), 1)
                       if host else 0.0)
        if old != new:
            racc.append((r["id"], old, new))
        r["access"] = new
    print("authored walk edges : %d" % len(authored.get("walk", [])))
    print("costs rewritten     : %d" % len(changed))
    print("sum of walk costs   : %.1f -> %.1f  (%+.1f%%)"
          % (total_old, total_new, (total_new / total_old - 1) * 100 if total_old else 0))
    if missed:
        print("\n--- NOT recosted: both zones not found in one routed continent (%d) ---"
              % len(missed))
        for a, b in missed:
            print("   ? %s <-> %s" % (a, b))
    print("\n--- changed (%d), largest first ---" % len(changed))
    for (a, b), old, new in sorted(changed, key=lambda c: -abs(c[2] - (c[1] or 0))):
        print("   %-28s %6.1f -> %6.1f  (%+.1f)" % (a + " <-> " + b, old or 0, new, new - (old or 0)))
    if racc:
        print("\n--- route access costs (in-zone walk to/from the vehicle) (%d) ---" % len(racc))
        for rid, old, new in racc:
            print("   %-24s %s -> %s" % (rid, old if old is not None else "(none)", new))
    # newline="\n" explicitly: data/travel.json is committed with LF, and the platform default on
    # Windows rewrites all 1 486 lines as CRLF - which git normalises away on add, so the commit
    # looks right while the working file flip-flops on every run.
    with open(TRAVEL, "w", encoding="utf-8", newline="\n") as f:
        json.dump(authored, f, indent=1, ensure_ascii=False)
        f.write("\n")
    print("\nrewrote %s (walk[].cost + routes[].access)" % TRAVEL)
    print("Each route's VEHICLE cost is NOT touched: it is hand-set against the walk scale. "
          "Re-check the calibration and the declared port exemptions after this.")
    return 0


def refuse_partial_cache(data):
    mpath = os.path.join(data, import_pack.CACHE_DIRNAME, "manifest.json")
    if not os.path.exists(mpath):
        raise SystemExit(
            "cannot derive the travel graph: map cache manifest is missing at %s. "
            "Run 'python scripts/import_pack.py --pack DIR' with a complete pack first."
            % mpath)
    partial = {cont: zones for cont, zones in import_pack.cache_skips(data).items() if zones}
    if partial:
        summary = ", ".join("%s (%d)" % (cont, len(partial[cont]))
                            for cont in sorted(partial))
        raise SystemExit("cannot derive the travel graph from a partial map cache; "
                         "missing roster zones in: %s. Re-import with a complete pack first."
                         % summary)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--scope", choices=("classic", "all"), default="classic",
                    help="classic (default): the phase-1 continents. all: include Kunark + Velious.")
    ap.add_argument("--out", default=None, help="write the proposal JSON here")
    ap.add_argument("--audit", action="store_true",
                    help="diff the proposal against the authored data/travel.json and report")
    ap.add_argument("--recost", action="store_true",
                    help="rewrite the geometry-derived costs in place: walk[].cost from the "
                         "detail-map doorways, routes[].access from the hub positions")
    ap.add_argument("--quiet", action="store_true", help="skip the review report")
    args = ap.parse_args()

    refuse_partial_cache(DATA)

    order = load(os.path.join(DATA, "world.json"))["order"]
    conts = order if args.scope == "all" else [c for c in CLASSIC if c in order]
    missing = [c for c in CLASSIC if c not in order] if args.scope == "classic" else []
    if missing:
        raise SystemExit("world.json order is missing expected classic continents: %s" % missing)

    if args.recost:
        return cmd_recost(conts)
    proposal, notes, hub_rows = build_proposal(conts)
    if args.audit:
        return cmd_audit(proposal)
    if not args.quiet:
        print_report(proposal, notes, hub_rows, conts)
    if args.out:
        with open(args.out, "w", encoding="utf-8", newline="\n") as f:   # LF, as data/ is committed
            json.dump(proposal, f, indent=1, ensure_ascii=False)
            f.write("\n")
        print("\nwrote proposal -> %s" % args.out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
