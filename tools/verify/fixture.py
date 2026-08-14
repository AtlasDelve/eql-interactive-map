#!/usr/bin/env python3
"""Build tiny synthetic map artifacts for fast behavioural tests.

The real build is 18 MB and takes ~60 s to load in jsdom. These fixtures use the same
template and the same strip_regions/inject code path, but with a handful of zones, so
tests run in about a second AND -- crucially -- the "canonical" data can be mutated to
simulate an author shipping an update (new hub, new connector, new zone, deleted hub).

Continent names need not be real any more -- the template derives ALTITUDES from each
continent's own META.alt -- but they stay real anyway: buildWorldCache() dereferences
ALL[name] for every continent in the realm, so every name here must exist in both maps.
"Antonica" carries the interesting geometry; "Kunark" is the gated one; the rest are stubs.

Usage: python fixture.py <outdir> [variant ...]
  variants: base add-hub add-conn add-zone del-hub add-worldlink script-label skip-zone
            (default: all)
"""
import copy
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "scripts"))
import build as B  # noqa: E402

NORRATH = ["Antonica", "Faydwer", "Odus", "Kunark", "Velious",
           "Ocean of Tears", "Erud's Crossing", "Timorous Deep"]
PLANES = ["Plane of Fear", "Plane of Hate", "Plane of Sky"]
LINK_THRESH = 120   # must match the template
# Everything is classic except Kunark, the fixture's expansion-gated continent: it holds a
# zone reachable ONLY through a route that leaves the graph at classic. Keeping every other
# continent classic is what lets the existing suites keep their hard-coded counts.
XPAC_OF = {"Kunark": "kunark"}
XPACS = {"order": ["classic", "kunark", "velious"], "default": "classic",
        "labels": {"classic": "Classic", "kunark": "Kunark", "velious": "Velious"}}


def box(x0, y0, x1, y1):
    """Closed rectangle as [x1,y1,x2,y2] segments, matching the real segs format."""
    return [[x0, y0, x1, y0], [x1, y0, x1, y1], [x1, y1, x0, y1], [x0, y1, x0, y0]]


def zone(name, x0, y0, x1, y1, color):
    return {"name": name, "segs": box(x0, y0, x1, y1),
            "cx": (x0 + x1) // 2, "cy": (y0 + y1) // 2, "color": color}


def stub_cont(label):
    return {"zones": {"only": zone(label, 0, 0, 400, 400, "#888")},
            "bbox": [0, 0, 400, 400], "connectors": [], "placed": [], "unplaced": []}


def base_data():
    ALL, META, HUBS = {}, {}, {}

    # --- Antonica: the continent under test -------------------------------
    # alpha and beta sit 50 apart -> the detector welds them (< LINK_THRESH).
    # gamma is far away -> no weld, and it ships a NON-IDENTITY published xf so the
    # "compare against published, not identity" sparseness rule is exercised.
    zs = {
        "alpha": zone("Alpha Fields", 0, 0, 1000, 1000, "#7fb0e6"),
        "beta":  zone("Beta Hills", 1050, 0, 2050, 1000, "#7bd88f"),
        "gamma": zone("Gamma Wastes", 5000, 0, 6000, 1000, "#e6a87f"),
    }
    zs["gamma"]["xf"] = {"tx": 300, "ty": -100, "s": 1.0, "rot": 0.0}
    ALL["Antonica"] = {
        "zones": zs,
        "bbox": [0, 0, 6300, 1000],
        "connectors": [{"a": [1000, 500], "b": [1050, 500]},
                       {"a": [2050, 500], "b": [5300, 400]}],
        # a published lock EXCEPTION: alpha|beta welds but ships unlocked
        "links": [{"z1": "alpha", "z2": "beta", "locked": False},
                  {"z1": "beta", "z2": "gamma", "locked": True, "manual": True}],
        "placed": ["alpha", "beta", "gamma"], "unplaced": [],
    }
    HUBS["Antonica"] = [
        {"x": 500, "y": 500, "kind": "boat", "label": "Alpha Docks"},
        {"x": 1550, "y": 500, "kind": "spire", "label": "Beta Spires"},
        {"x": 5500, "y": 500, "kind": "portal", "label": "Gamma Portal", "letter": "G"},
    ]

    # --- Faydwer: a second real continent, so multi-continent state is covered.
    # `zeta` is the travel graph's ISOLATED node -- no walk edge, not a route stop -- and it
    # lives here rather than on Antonica because the overlay/hide-io/author-guards suites
    # hard-code Antonica's zone and hub counts. It sits far from delta so no weld forms.
    ALL["Faydwer"] = {
        "zones": {"delta": zone("Delta Coast", 0, 0, 800, 800, "#c9a0dc"),
                  "zeta": zone("Zeta Hollow", 3000, 0, 3800, 800, "#a0c9dc")},
        "bbox": [0, 0, 3800, 800],
        "connectors": [{"a": [0, 400], "b": [800, 400]}],
        "placed": ["delta", "zeta"], "unplaced": [],
    }
    # The note lives on the arrival anchor of boat-alpha-delta, so alpha->delta carries it
    # and delta->alpha does not. That direction-sensitivity is the assertion.
    # Faydwer:1 is the hidden hub in an IN-RANGE continent -- Faydwer is classic, but this dock
    # exists only to serve the route to Kunark, so it goes when that route does. It is the one
    # case the hub rule is really about, and it is separable only because it is its own hub.
    HUBS["Faydwer"] = [{"x": 400, "y": 400, "kind": "ring", "label": "Delta Ring",
                        "note": "Ring of Delta\nMossy Shard (consumed)"},
                       {"x": 700, "y": 400, "kind": "boat", "label": "Delta Far Docks"}]

    # --- Kunark: the GATED continent. Its one zone is reachable only through a route whose
    # far end is here, so at the first expansion the route leaves the graph and the zone -- the
    # boat-to-an-expansion-continent shape the whole feature exists for, in miniature. A real
    # continent rather than a stub because a stub's zone key is shared by every other stub.
    kunark = {"zones": {"fieldofbone": zone("Field of Bone", 0, 0, 900, 900, "#d0b070")},
              "bbox": [0, 0, 900, 900], "connectors": [],
              "placed": ["fieldofbone"], "unplaced": []}

    for n in NORRATH:
        if n not in ALL:
            ALL[n] = copy.deepcopy(kunark) if n == "Kunark" else stub_cont(n)
    for n in PLANES:
        ALL[n] = stub_cont(n)

    # META is written in a DIFFERENT order from ALL on purpose. The real data/ has exactly this
    # skew (its meta block lists Odus before Faydwer while the draw order is the reverse), and
    # the template derives ALTITUDES by iterating `names` precisely because iterating META would
    # silently reorder the globe draw and label passes. Emitting both in the same order here
    # would make the fixture unable to tell the correct derivation from the broken one.
    meta_order = [n for n in NORRATH + PLANES if n != "Faydwer"]
    meta_order.insert(4, "Faydwer")
    for n in meta_order:
        i = (NORRATH + PLANES).index(n)     # position keyed on the NAME, so reordering moves nothing
        # gw/gh are the globe FOOTPRINT, and their only runtime consumer is the world-link
        # endpoint match. They were 100 here, which made every continent's box overlap every
        # other and the match meaningless; 6 against a 7-unit spacing keeps them disjoint.
        META[n] = {"pos": [10.0 + i * 7, 30.0 + (i % 3) * 8], "uc": 0, "vc": 0,
                   "gscale": 0.001, "gw": 6, "gh": 6,
                   "alt": "The Planes" if n in PLANES else "Norrath",
                   "xpac": XPAC_OF.get(n, "classic")}

    UNIVERSE = [
        {"name": "Norrath", "kind": "globe", "cx": 0.35, "cy": 0.5, "r": 0.16,
         "active": True, "alt": "Norrath"},
        {"name": "The Planes", "kind": "portal", "cx": 0.7, "cy": 0.5, "r": 0.1,
         "active": True, "alt": "The Planes"},
    ]
    # Endpoints land inside the globe box of the continent each names, so the filter can
    # resolve them. Link 0 joins two classic continents and never hides; link 1 reaches the
    # gated one and hides with it.
    WORLDLINKS = [
        {"a": [10.0, 30.0], "b": [17.0, 38.0], "alt": "Norrath"},   # Antonica <-> Faydwer
        {"a": [10.0, 30.0], "b": [31.0, 30.0], "alt": "Norrath"},   # Antonica <-> Kunark
    ]
    # Travel graph. In the real tree this is authored in data/travel.json, so the fixture only
    # needs a structurally valid one over its own zones - but it is shaped to make the four
    # pathfinder semantics assertable without the 18 MB artifact, where an alternate path
    # almost always exists and masks the bug.
    #
    # `zeta` is reachable ONLY as an `anywhere` destination is reachable: it has no walk edge
    # and is no route's stop, and it enters the roster through a group, which is exactly how
    # verify.py's roster check admits an edge-less zone. That makes zeta->beta (port in from
    # anywhere) succeed while beta->zeta fails, which is the directedness invariant. Asserting
    # it the other way round would assert something FALSE: two stops of one `anywhere` route
    # legitimately do reach each other, because the route adds u->stop for every u.
    #
    # Route ORDER is load-bearing. The cheap parallel edge is written first and the expensive
    # one last in each pair, so a neighbour-keyed map written last-wins keeps the wrong cost
    # and the wrong step metadata, and the parallel-edge test fails instead of passing by luck.
    TRAVEL = {
        "version": 1,
        "groups": {"The Alphas": ["alpha", "beta"], "The Reaches": ["delta", "zeta"]},
        "capabilities": [{"id": "druid", "label": "Druid ports", "gated": True},
                         {"id": "wizard", "label": "Wizard ports", "gated": True}],
        "walk": [{"z": ["alpha", "beta"], "cost": 4.2, "at": [[1000, 500], [1050, 500]]},
                 {"z": ["beta", "gamma"], "cost": 13.0}],
        "routes": [
            # cheap arrival first; wizard-network below is the expensive parallel. No hub, so
            # the reagent note stays unique to the boat leg AND the hub-less route path runs.
            {"id": "druid-network", "kind": "ring", "capability": "druid",
             "topology": "anywhere", "name": "Druid ports", "stops": ["beta"],
             "hubs": [None], "cost": 1},
            # cheap adjacency first, and the only one of the pair with a hub, so the reagent
            # note proves it is the leg that was actually chosen
            {"id": "boat-alpha-delta", "kind": "boat", "capability": None,
             "topology": "line", "name": "Alpha ⇄ Delta", "stops": ["alpha", "delta"],
             "hubs": ["Antonica:0", "Faydwer:0"], "cost": 10},
            {"id": "ferry-alpha-delta", "kind": "boat", "capability": None,
             "topology": "line", "name": "Slow Ferry", "stops": ["alpha", "delta"],
             "hubs": [None, None], "cost": 12},
            {"id": "wizard-network", "kind": "spire", "capability": "wizard",
             "topology": "anywhere", "name": "Wizard ports", "stops": ["beta"],
             "hubs": ["Antonica:1"], "cost": 3},
            # The GATED route. Ungated by capability on purpose, so a trip that fails at the
            # first expansion fails for that and not for something the player could switch on --
            # which is exactly the confusion the endpoint check exists to prevent. Its departure
            # hub is the only reason Faydwer:1 exists, so that hub hides with it.
            {"id": "boat-delta-fieldofbone", "kind": "boat", "capability": None,
             "topology": "line", "name": "Delta ⇄ Field of Bone",
             "stops": ["delta", "fieldofbone"], "hubs": ["Faydwer:1", None], "cost": 8},
        ],
    }
    return ALL, META, {}, HUBS, UNIVERSE, WORLDLINKS, TRAVEL, XPACS


def variant(name, data):
    """Simulate an author shipping an update, so R5 (additive survival) can be tested."""
    ALL, META, DETAIL, HUBS, UNIVERSE, WORLDLINKS, TRAVEL, XPACS = copy.deepcopy(data)
    if name == "base":
        pass
    elif name == "add-hub":
        # inserted in the MIDDLE, so a naive index-keyed overlay would misapply
        HUBS["Antonica"].insert(1, {"x": 900, "y": 900, "kind": "boat",
                                    "label": "Newly Added Docks"})
    elif name == "add-conn":
        ALL["Antonica"]["connectors"].insert(0, {"a": [10, 10], "b": [990, 990]})
    elif name == "add-zone":
        # a new zone adjacent to beta, so seeding should pick beta as the neighbour
        ALL["Antonica"]["zones"]["epsilon"] = zone("Epsilon Reach", 2100, 0, 2600, 600, "#dcd0a0")
    elif name == "del-hub":
        del HUBS["Antonica"][1]           # remove the MIDDLE hub (Beta Spires)
    elif name == "add-worldlink":
        WORLDLINKS.insert(0, {"a": [50.0, 50.0], "b": [60.0, 55.0], "alt": "Norrath"})
    elif name == "script-label":
        # A hub label that would terminate the <script> element it is injected into,
        # unless escaped. Two independent defences must hold, and they escape
        # differently: build.inject() rewrites "</" as "<\/" (build.py), while the
        # client-side exportStandaloneHTML() escapes every "<" as a JSON unicode
        # escape (template.html). No test covered either until this variant existed.
        HUBS["Antonica"][0]["label"] = "Docks </script><b>x</b>"
    elif name == "skip-zone":
        del ALL["Antonica"]["zones"]["gamma"]
        ALL["Antonica"]["skipped"] = ["gamma"]
        ALL["Antonica"]["links"] = [l for l in ALL["Antonica"]["links"]
                                      if l["z1"] != "gamma" and l["z2"] != "gamma"]
        TRAVEL["routes"].extend([
            {"id": "spire-beta-gamma", "kind": "spire", "capability": None,
             "topology": "anywhere", "name": "Beta/Gamma spires",
             "stops": ["beta", "gamma"], "hubs": ["Antonica:1", "Antonica:2"],
             "cost": 5},
            {"id": "line-beta-gamma-zeta", "kind": "boat", "capability": None,
             "topology": "line", "name": "Beta ⇄ Gamma ⇄ Zeta",
             "stops": ["beta", "gamma", "zeta"], "hubs": [None, None, None],
             "cost": 6},
        ])
    else:
        raise SystemExit("unknown variant " + name)
    return ALL, META, DETAIL, HUBS, UNIVERSE, WORLDLINKS, TRAVEL, XPACS


def emit(path, edition, data):
    with open(B.TEMPLATE, "r", encoding="utf-8") as f:
        tpl = f.read()
    tpl = B.strip_regions(tpl, edition)
    html = B.inject(tpl, *data, credit="EQL · fixture map data", version=B.read_version())
    with open(path, "w", encoding="utf-8") as f:
        f.write(html)
    return len(html)


if __name__ == "__main__":
    outdir = sys.argv[1]
    variants = sys.argv[2:] or ["base", "add-hub", "add-conn", "add-zone", "del-hub",
                                "add-worldlink", "script-label", "skip-zone"]
    os.makedirs(outdir, exist_ok=True)
    base = base_data()
    for v in variants:
        d = variant(v, base)
        for ed in ("user", "author"):
            p = os.path.join(outdir, "fx-%s.%s.html" % (v, ed))
            n = emit(p, ed, d)
            print("wrote %-34s %7d bytes" % (os.path.basename(p), n))
