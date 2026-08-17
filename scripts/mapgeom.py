"""Reusable map geometry, walk-cost, and zone-name-resolution helpers.

This module depends only on the Python standard library so both travel derivation and map-pack
conversion can import it without creating a repository-internal import cycle.

Most helpers operate only on records supplied by the caller. ``cost_points`` deliberately
memoises sampled points into those zone records under the private ``_cpts`` or ``_cpts_t`` key;
callers must not serialize a record after passing it here without removing private keys.
"""
import math
import re


COST_SAMPLE = 200         # outline points per zone for the closest-approach cost scan
UNITS_PER_COST = 250.0


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


def zidx_from(entries):
    """Build a first-wins name index from ``(continent, zone key, name)`` entries."""
    idx = {}

    def put(k, v):
        k = k.strip()
        if k and k not in idx:
            idx[k] = v

    for cont, zk, nm in entries:
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


def exit_points_from(zk, zone_record, composed_detail, idx):
    """Return ``{(from_key, to_key): (x, y)}`` from one zone's composed detail.

    An unrecoverable detail offset returns an empty mapping. If more than one label names the same
    target, ``setdefault`` preserves the first label in the caller-supplied detail order.
    """
    off = detail_offset(zone_record, composed_detail)
    if not off:
        return {}
    out = {}
    for lab in composed_detail["labels"]:
        for tgt in transition_targets(idx, zk, lab[4]):
            out.setdefault((zk, tgt), (lab[0] + off[0], lab[1] + off[1]))
    return out


def nearest_outline_point(z, px, py, transformed):
    """The point of z's outline nearest (px,py), in the caller's working frame.

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

    Separate from ``_pts`` because that one is always transformed and sampled for weld detection.
    A few units of imprecision is irrelevant after dividing by UNITS_PER_COST. This function
    memoises its result into the caller's record under ``_cpts`` or ``_cpts_t``.
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
