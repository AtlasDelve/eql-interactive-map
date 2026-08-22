#!/usr/bin/env python3
"""Unit tests for scripts/import_pack.py against a hand-written synthetic pack.

Layer 1: stdlib only, runs from a bare clone. The fixture under packfx/ is deliberately
persistent rather than generated, because half of what it pins is about *bytes on disk* -
a UTF-8 BOM, a Latin-1 label - which a generated fixture would round-trip away.

Every expectation below is written out by hand. The point is that a converter change which
alters output has to change a number here too, so the diff says what moved.
"""
import json
import io
import os
import shutil
import sys
import tempfile
from contextlib import redirect_stderr, redirect_stdout

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, os.path.join(REPO, "scripts"))
import import_pack as IP                                       # noqa: E402
import pack_colors                                             # noqa: E402
import build as BUILD                                          # noqa: E402
import derive_travel_graph as DTG                              # noqa: E402

FX = os.path.join(HERE, "packfx")
PACK = os.path.join(FX, "pack")
BADPACK = os.path.join(FX, "badpack")
EMPTY = os.path.join(FX, "empty")

fails = []


def check(label, got, want):
    if got == want:
        print("  OK   " + label)
    else:
        fails.append(label)
        print("  FAIL " + label)
        print("        got  %r" % (got,))
        print("        want %r" % (want,))


def raises(label, fn, needle):
    try:
        fn()
    except SystemExit as exc:
        if needle in str(exc):
            print("  OK   " + label)
        else:
            fails.append(label)
            print("  FAIL %s: message %r lacks %r" % (label, str(exc), needle))
        return
    fails.append(label)
    print("  FAIL %s: no SystemExit" % label)


# --------------------------------------------------------------------- rounding
# Half-to-even, not floor(x+0.5). This is the single highest-value assertion in the file:
# on real data the two rules disagree on 95 of 118 zones, and the JS twin's Math.round is
# the wrong one. Each pair below is a case where they differ.
print("\nrounding is half-to-even (Python round), not JS Math.round")
check("round(0.5) -> 0  (Math.round gives 1)", IP._r(0.5), 0)
check("round(1.5) -> 2", IP._r(1.5), 2)
check("round(2.5) -> 2  (Math.round gives 3)", IP._r(2.5), 2)
check("round(-3.5) -> -4  (Math.round gives -3)", IP._r(-3.5), -4)

# --------------------------------------------------------------------- grammar
print("\nrecord grammar: hard error on malformed, count the unknown")
raises("a short L line names file and line",
       lambda: IP.parse_zone(BADPACK, "alpha"), "alpha.txt:3")
recs, unknown = IP.parse_zone(PACK, "alpha")
check("alpha parses 4 L + 1 P across its four layers", len(recs), 5)
check("no unknown record types in the good pack", unknown, {})

# A label's text may contain commas; splitting on every one and rejoining would rewrite
# spacing. 1605 pack lines look like "Locked_Door_(Quests,Unpickable)".
brecs, _ = IP.parse_zone(PACK, "beta")
label = [r for r in brecs if r[1] == "P"][0]
check("label text keeps its internal comma and spacing", label[2][3], "Bank, Guild")

# --------------------------------------------------------------------- encoding
print("\nencoding: a BOM is stripped, Latin-1 is a fallback not a failure")
grecs, _ = IP.parse_zone(PACK, "gamma")
check("BOM does not break the first record of gamma.txt",
      [r[1] for r in grecs], ["L", "P"])
check("Latin-1 label decodes", [r for r in grecs if r[1] == "P"][0][2][3], "Café \x92")

# --------------------------------------------------------------------- conversion
print("\nfull conversion of the synthetic continent")
tmp = tempfile.mkdtemp(prefix="packfx-")
try:
    data = os.path.join(tmp, "data")
    shutil.copytree(os.path.join(FX, "data"), data)

    # -- pass-A discovery index --------------------------------------
    # The viewer builds ZIDX from DETAIL, so conversion must use detailZones order and omit
    # roster entries whose selected source is absent.  Pin the first-wins collision too: a
    # plausible index can still resolve the wrong zone if either ordering rule drifts.
    with open(os.path.join(data, "world.json"), encoding="utf-8") as f:
        iworld = json.load(f)
    ientries = IP.discovery_index_entries(PACK, None, data, iworld)
    check("discovery index follows detailZones order",
          ientries,
          [("Testland", "beta", "Beta"),
           ("Testland", "alpha", "Alpha"),
           ("Testland", "gamma", "Gamma")])
    check("discovery index resolves a known authored name",
          IP.mapgeom.resolve_zone(IP.mapgeom.zidx_from(ientries), "Beta"),
          ("Testland", "beta"))

    index_cpath = os.path.join(data, "continents", "Testland", "continent.json")
    with open(index_cpath, encoding="utf-8") as f:
        index_meta = json.load(f)
    original_index_meta = json.loads(json.dumps(index_meta))
    index_meta["zoneOrder"].append("epsilon")
    index_meta["detailZones"].append("epsilon")
    index_meta["zones"]["epsilon"] = {
        "name": "Epsilon", "color": "#5fb95f", "cx": 0, "cy": 0, "off": [0, 0]}
    with open(index_cpath, "w", encoding="utf-8") as f:
        json.dump(index_meta, f)
    check("discovery index omits a detail zone whose source is missing",
          [e[1] for e in IP.discovery_index_entries(PACK, None, data, iworld)],
          ["beta", "alpha", "gamma"])

    collision_meta = json.loads(json.dumps(original_index_meta))
    collision_meta["zones"]["alpha"]["name"] = "Beta"
    with open(index_cpath, "w", encoding="utf-8") as f:
        json.dump(collision_meta, f)
    collision_entries = IP.discovery_index_entries(PACK, None, data, iworld)
    check("discovery index collision is first-wins in detailZones order",
          IP.mapgeom.resolve_zone(IP.mapgeom.zidx_from(collision_entries), "Beta"),
          ("Testland", "beta"))
    with open(index_cpath, "w", encoding="utf-8") as f:
        json.dump(original_index_meta, f)

    manifest = IP.convert(PACK, data, quiet=True)
    gen = os.path.join(data, IP.CACHE_DIRNAME, "continents", "Testland")

    def load(*parts):
        with open(os.path.join(gen, *parts), encoding="utf-8") as f:
            return json.load(f)

    # -- palette ------------------------------------------------------
    # Allocation is first-seen over detailZones x layers x L AND P records. The fixture's
    # detailZones (beta, alpha, gamma) is deliberately NOT its zoneOrder (alpha, beta,
    # gamma): iterating zoneOrder yields a palette of the same LENGTH with every index
    # permuted, which is corruption with nothing to notice it by. That is a real hazard,
    # not a hypothetical - Odus's two lists differ in exactly this way.
    check("palette is first-seen over detailZones, and P colours count",
          load("palette.json"),
          ["#08ce08",    # 0  (0,204,0)     beta base       <- beta is FIRST in detailZones
           "#ffffff",    # 1  (255,255,255) beta _1 label   <- a P colour, same namespace
           "#ff4545",    # 2  (255,0,0)     alpha base
           "#afafaf",    # 3  (0,0,0)       alpha base      <- black is its own case
           "#cdcdcd"])   # 4  (150,150,150) alpha _2
    # gamma reuses (0,204,0) and (255,255,255): already seen, so no new entries.

    # -- detail: layer concatenation, palette indices, rounding -------
    alpha = load("detail", "alpha.json")
    check("detail = base + _1 + _2 + _3, in that order",
          alpha["seglayer"], [0, 0, 2, 3])
    check("labels carry their own layer", alpha["lablayer"], [1])
    check("detail segs: y negated, half-to-even, palette index in slot 4",
          alpha["segs"],
          [[0, 2, 2, 2, 2],      # 0.5->0, 1.5->2, 2.5->2, 2.5->2   (all Math.round-different)
           [2, 0, 0, -4, 3],     # 1.5->2, -0.5->0, -0.5->0, -3.5->-4
           [20, 0, 20, 8, 4],    # _2 grid layer
           [-1, 1, -1, 2, 0]])   # _3, colour already seen -> index 0
    check("detail label: [x, -y, paletteIdx, size, text]",
          alpha["labels"], [[-9, -5, 2, 3, "to_Beta"]])

    # -- the cache is lossless where the committed data was not -------
    check("Z is kept per segment", alpha["segz"],
          [[10.0, 11.0], [12.0, 13.0], [0.0, 0.0], [0.0, 0.0]])

    # -- bbox ---------------------------------------------------------
    # Raw floats, over segments AND labels. From the rounded segs alone this would be
    # [-1, -4, 20, 8]; the label at (-9.25, -4.75) is what makes the difference visible.
    check("bbox is raw min/max over segs and labels, unrounded",
          alpha["bbox"], [-9.25, -4.75, 20.0, 8.0])

    # -- geometry: base layer only, float offset applied BEFORE rounding
    # alpha's off is (0.5, -0.25). Rounding the detail value and then adding an integer
    # offset cannot produce these, which is the point: 104 of 118 real offsets are
    # fractional, and treating them as integers reproduces only 20 of 120 zones.
    check("geometry is the base layer alone, translated then rounded",
          load("geometry", "alpha.json")["segs"],
          [[1, 1, 3, 2],         # (0.5+0.5, 1.5-0.25, 2.5+0.5, 2.5-0.25)
           [2, -1, 0, -4]])      # (1.5+0.5, -0.5-0.25, -0.5+0.5, -3.5-0.25)
    check("geometry excludes the _1/_2/_3 layers",
          len(load("geometry", "alpha.json")["segs"]), 2)
    check("integral offsets still work", load("geometry", "beta.json")["segs"],
          [[1, 7, 3, 9]])        # (3-2, 4+3, 5-2, 6+3)

    # -- authored labels: supply what the pack lacks, yield when it does not
    # Both directions matter and the second is a multi-pack requirement, not leniency:
    # whether a pack ships a given label varies BY PACK, so erroring on a collision would
    # turn a richer pack into a build failure for whoever installed it.
    pal = load("palette.json")
    az = dict(json.load(open(os.path.join(data, "continents", "Testland",
                                          "continent.json"), encoding="utf-8"))["zones"]["alpha"])
    cached = load("detail", "alpha.json")
    az["labels"] = [[7, 7, pal[0], 2, "to_Nowhere"]]
    composed = IP.compose_detail(az, cached, pal)
    check("an authored label the pack lacks is appended",
          composed["labels"][-1], [7, 7, 0, 2, "to_Nowhere"])
    check("...and its colour is resolved from the hex, not stored as an index",
          composed["labels"][-1][2], pal.index(pal[0]))

    az["labels"] = [[7, 7, pal[0], 2, "to_Beta"]]        # the pack DOES carry to_Beta
    composed = IP.compose_detail(az, cached, pal)
    check("an authored label the pack also supplies is dropped, pack wins",
          [l for l in composed["labels"] if l[4] == "to_Beta"],
          [l for l in cached["labels"] if l[4] == "to_Beta"])
    check("...and does not duplicate", len(composed["labels"]), len(cached["labels"]))

    # Assert the recording against a manifest confirmed NON-empty, not against []. An empty
    # list would pass with the whole feature deleted - the false-pass trap in README.md.
    cpath2 = os.path.join(data, "continents", "Testland", "continent.json")
    with open(cpath2, encoding="utf-8") as f:
        cm = json.load(f)
    cm["zones"]["alpha"]["labels"] = [[7, 7, pal[0], 2, "to_Beta"]]     # the pack has this
    with open(cpath2, "w", encoding="utf-8") as f:
        json.dump(cm, f)
    m2 = IP.convert(PACK, data, quiet=True)
    check("a collision is recorded with continent, zone and label text",
          m2["authoredLabelCollisions"], ["Testland/alpha: to_Beta"])
    cm["zones"]["alpha"].pop("labels")
    with open(cpath2, "w", encoding="utf-8") as f:
        json.dump(cm, f)
    check("...and a pack with no collision records none",
          IP.convert(PACK, data, quiet=True)["authoredLabelCollisions"], [])

    cm["zones"]["alpha"]["labels"] = [[7, 7, "#123456", 2, "to_Nowhere"]]
    with open(cpath2, "w", encoding="utf-8") as f:
        json.dump(cm, f)
    IP.convert(PACK, data, quiet=True)
    check("a surviving authored label colour is appended after traced palette entries",
          load("palette.json")[-1], "#123456")
    check("the appended colour lets the authored label compose",
          IP.compose_detail(cm["zones"]["alpha"], load("detail", "alpha.json"),
                            load("palette.json"))["labels"][-1],
          [7, 7, 5, 2, "to_Nowhere"])
    cm["zones"]["alpha"].pop("labels")
    with open(cpath2, "w", encoding="utf-8") as f:
        json.dump(cm, f)
    IP.convert(PACK, data, quiet=True)

    az["labels"] = [[7, 7, "#123456", 2, "to_Nowhere"]]
    raises("a colour the palette lacks is a hard error, not a guess",
           lambda: IP.compose_detail(az, cached, pal), "#123456")

    # -- manifest -----------------------------------------------------
    check("manifest records the schema", manifest["schema"], IP.SCHEMA)
    check("manifest fingerprints the pack by content, not by path",
          len(manifest["sourceFingerprint"]) == 64 and manifest["sourceCount"] == 8, True)
    check("manifest records every source file",
          sorted(manifest["continents"]["Testland"]["sources"]),
          ["alpha.txt", "alpha_1.txt", "alpha_2.txt", "alpha_3.txt",
           "beta.txt", "beta_1.txt", "gamma.txt", "gamma_1.txt"])
    check("every fixture colour is in the shipped table", manifest["unseenColors"], [])

    # -- cache validation ---------------------------------------------
    print("\ncache validation refuses a cache that does not match the authored roster")
    ok, why = IP.validate_cache(data)
    check("a fresh cache validates", (ok, why), (True, "ok"))

    mpath = os.path.join(data, IP.CACHE_DIRNAME, "manifest.json")
    with open(mpath, encoding="utf-8") as f:
        man = json.load(f)

    check("cache_skips exposes the declared per-continent set",
          IP.cache_skips(data), {"Testland": set()})

    good_skips = man["continents"]["Testland"]["skippedZones"]
    for label, bad in (("a non-list skippedZones is rejected", "alpha"),
                       ("a non-string skipped zone is rejected", [1]),
                       ("duplicate skipped zones are rejected", ["alpha", "alpha"]),
                       ("a skipped zone outside the roster is rejected", ["epsilon"])):
        man["continents"]["Testland"]["skippedZones"] = bad
        with open(mpath, "w", encoding="utf-8") as f:
            json.dump(man, f)
        check(label, IP.validate_cache(data)[0], False)
    man["continents"]["Testland"]["skippedZones"] = good_skips
    with open(mpath, "w", encoding="utf-8") as f:
        json.dump(man, f)
    check("a restored empty skip list validates", IP.validate_cache(data)[0], True)

    man["schema"] = IP.SCHEMA + 1
    with open(mpath, "w", encoding="utf-8") as f:
        json.dump(man, f)
    check("a future schema is rejected", IP.validate_cache(data)[0], False)

    man["schema"] = IP.SCHEMA
    man["continents"]["Testland"]["zones"] = ["alpha", "beta"]      # gamma dropped
    with open(mpath, "w", encoding="utf-8") as f:
        json.dump(man, f)
    ok, why = IP.validate_cache(data)
    check("a roster that lost a zone is rejected", ok, False)
    check("...and says which continent", "Testland" in why, True)

    # A matching roster is not sufficient. A zone whose offset could not be resolved is
    # still listed in the roster but has no geometry file, so the roster check alone
    # passes on a cache build() would then crash on. Both stale zones in the real data
    # are exactly this shape, so it is the live case rather than a hypothetical.
    man["continents"]["Testland"]["zones"] = ["alpha", "beta", "gamma"]
    with open(mpath, "w", encoding="utf-8") as f:
        json.dump(man, f)
    os.remove(os.path.join(gen, "geometry", "beta.json"))
    ok, why = IP.validate_cache(data)
    check("a roster that matches but lacks a geometry file is rejected", ok, False)
    check("...and names the zone", "Testland/beta" in why, True)

    os.remove(os.path.join(gen, "detail", "gamma.json"))
    shutil.copyfile(os.path.join(gen, "geometry", "alpha.json"),
                    os.path.join(gen, "geometry", "beta.json"))
    check("a missing detail file is rejected too",
          "Testland/gamma" in IP.validate_cache(data)[1], True)

    # The authored half of the same pairing. Adding a zone means touching zoneOrder, placed
    # AND zones; forgetting the last would otherwise be a bare KeyError from inside build()'s
    # composition loop rather than a message naming the file and the fix.
    shutil.copyfile(os.path.join(gen, "detail", "alpha.json"),
                    os.path.join(gen, "detail", "gamma.json"))
    check("a complete tree validates again", IP.validate_cache(data)[0], True)
    cpath = os.path.join(data, "continents", "Testland", "continent.json")
    with open(cpath, encoding="utf-8") as f:
        cmeta = json.load(f)
    dropped = cmeta["zones"].pop("gamma")
    with open(cpath, "w", encoding="utf-8") as f:
        json.dump(cmeta, f)
    ok, why = IP.validate_cache(data)
    check("a zone in zoneOrder with no authored entry is rejected", ok, False)
    check("...and names the zone and the command that fixes it",
          "'gamma'" in why and "--print-authored" in why, True)

    cmeta["zones"]["gamma"] = dict(dropped)
    del cmeta["zones"]["gamma"]["off"]
    with open(cpath, "w", encoding="utf-8") as f:
        json.dump(cmeta, f)
    check("...and an entry present but missing `off` is rejected too",
          "missing off" in IP.validate_cache(data)[1], True)

    # Put the fixture back: the checks above deliberately damaged it, and everything below
    # converts for real.
    cmeta["zones"]["gamma"] = dropped
    with open(cpath, "w", encoding="utf-8") as f:
        json.dump(cmeta, f)
    IP.convert(PACK, data, quiet=True)
    check("the damaged fixture is restored and converts", IP.validate_cache(data)[0], True)

    # -- promotion is atomic and leaves nothing behind ----------------
    print("\ncache promotion cleans up after itself, and rolls back on failure")
    leftovers = [n for n in os.listdir(data)
                 if "staging" in n or n.endswith(".previous") or n.endswith(".tmp")]
    check("a successful promotion leaves no staging or backup directory", leftovers, [])

    # Force the swap to fail and assert the PREVIOUS cache survives intact. The dangerous
    # window is after the old cache is moved aside and before the new one lands; without a
    # rollback the tree would be left with no cache at all.
    live = os.path.join(data, IP.CACHE_DIRNAME)
    before = sorted(os.listdir(live))
    real_replace = os.replace
    calls = []

    def flaky(a, b):
        calls.append(a)
        if len(calls) == 2:                       # let the old cache move aside, then fail
            raise OSError(32, "simulated: directory in use")
        return real_replace(a, b)

    os.replace = flaky
    try:
        IP.convert(PACK, data, quiet=True)
        check("a failed promotion raises CachePromotionError", "no exception", "an exception")
    except IP.CachePromotionError as exc:
        check("a failed promotion raises CachePromotionError", True, True)
        check("...and says the previous cache is untouched", "untouched" in str(exc), True)
    finally:
        os.replace = real_replace
    check("...and the previous cache really is intact", sorted(os.listdir(live)), before)
    check("...and no staging or backup directory is orphaned",
          [n for n in os.listdir(data)
           if "staging" in n or n.endswith(".previous") or n.endswith(".tmp")], [])
    check("...and it still validates", IP.validate_cache(data)[0], True)

    # -- --only refuses to invent a cache -----------------------------
    print("\n--only updates a cache, it never creates one")
    check("--only works when a complete cache exists",
          IP.convert(PACK, data, only="Testland", quiet=True)["schema"], IP.SCHEMA)
    shutil.rmtree(live)
    raises("--only refuses when there is no cache to update",
           lambda: IP.convert(PACK, data, only="Testland", quiet=True), "--only needs a complete")
    check("...and did not leave a partial cache behind", os.path.exists(live), False)
    IP.convert(PACK, data, quiet=True)            # restore for anything below

    # -- unseen colours are reported, not silently approximated -------
    print("\nan unknown pack colour is approximated AND counted")
    unseen = []
    approx = pack_colors.color_for((3, 5, 7), unseen)
    check("a colour absent from the table is reported", unseen, [(3, 5, 7)])
    check("...and still yields a usable hex", approx.startswith("#") and len(approx), 7)
finally:
    shutil.rmtree(tmp, ignore_errors=True)

# --------------------------------------------------------------------- pack identity
print("\npack-identity guard warns on the client's own maps/ root")
root_like = tempfile.mkdtemp(prefix="maps-")
try:
    maps = os.path.join(root_like, "maps")
    os.makedirs(maps)
    reasons = IP.looks_like_root_maps(maps)
    check("a directory named maps/ with no grid layers is flagged", len(reasons), 2)
    check("the real pack is not flagged for its name",
          [r for r in IP.looks_like_root_maps(PACK) if "named" in r], [])
finally:
    shutil.rmtree(root_like, ignore_errors=True)

# --------------------------------------------------------------------- layered resolution
# Section A: resolve_zone_source and root_layer are pure functions of the filesystem, so the
# whole cascade is assertable without converting anything. The fixture mimics the real layout
# - maps/<Pack>/ - because the derivation is POSITIONAL: root is --pack's parent when that
# parent is named `maps`. delta/eta/zeta/epsilon are deliberately outside every roster, so
# they can be pinned here while conversion (which walks only the roster) never sees them.
print("\nlayered resolution: root is derived from --pack's parent")
LAYERED = os.path.join(FX, "layered", "maps", "Layered")
LROOT = os.path.join(FX, "layered", "maps")

check("a pack under maps/ derives the root as its base layer",
      IP.root_layer(LAYERED), os.path.abspath(LROOT))
check("--pack pointed AT the root gets no base layer", IP.root_layer(LROOT), None)
# The assertion that guarantees existing behaviour is untouched: packfx/pack's parent is
# packfx, so derivation cannot fire there and every flat expectation above still holds.
check("the flat fixture pack derives nothing", IP.root_layer(PACK), None)
check("a trailing separator does not defeat the derivation",
      IP.root_layer(LAYERED + os.sep), os.path.abspath(LROOT))
check("a '.' component does not defeat it either",
      IP.root_layer(os.path.join(LAYERED, ".")), os.path.abspath(LROOT))
# Case-folded on purpose: the probe below is os.path.exists, which is case-insensitive on
# Windows, so 'Maps/Brewall' must layer exactly like 'maps/Brewall'.
check("the parent's name is matched case-folded",
      IP.root_layer(os.path.join(FX, "layered", "MAPS", "Layered")),
      os.path.abspath(os.path.join(FX, "layered", "MAPS")))

# All five cascade branches. Rules 3 and 4 - the orphan tail - are the branches the live
# `tutorial` measurement motivates, and eta/zeta exist for no other reason.
print("\nthe cascade: base beats orphan, pack beats root, never a mix")
ROOTA = os.path.abspath(LROOT)
for zone, want in (("alpha",   (LAYERED, "pack")),    # rule 1: both have a base, pack wins
                   ("beta",    (LAYERED, "pack")),    # rule 1: pack only
                   ("gamma",   (ROOTA, "root")),      # rule 2: THE FALLBACK
                   ("delta",   (ROOTA, "root")),      # rule 2: base beats pack orphan
                   ("eta",     (LAYERED, "pack")),    # rule 3: orphan tail, pack side
                   ("zeta",    (ROOTA, "root")),      # rule 4: orphan tail, root side
                   ("epsilon", (None, None))):        # rule 5: nowhere
    check("resolve %-8s -> %s" % (zone, want[1] or "nothing"),
          IP.resolve_zone_source(LAYERED, ROOTA, zone), want)

# With no base layer the cascade collapses to rule 3, which is today's rule verbatim.
check("with root None, resolution is exactly the pre-layering rule",
      IP.resolve_zone_source(PACK, None, "alpha"), (PACK, "pack"))
check("...and a zone the pack lacks resolves nowhere rather than falling back",
      IP.resolve_zone_source(PACK, None, "epsilon"), (None, None))

# looks_like_root_maps and root_layer probe the same tree for OPPOSITE mistakes: one warns
# that --pack IS the root, the other derives the root sitting above --pack. Complementary,
# not redundant - do not merge them.
print("\nlooks_like_root_maps and root_layer are complementary probes")
check("a pack under maps/ is not flagged for its name, and derives a base layer",
      ([r for r in IP.looks_like_root_maps(LAYERED) if "named" in r] == []
       and IP.root_layer(LAYERED) == ROOTA), True)
check("the root itself IS flagged for its name, and derives nothing",
      ([r for r in IP.looks_like_root_maps(LROOT) if "named" in r] != []
       and IP.root_layer(LROOT) is None), True)

# --------------------------------------------------------------------- layered conversion
# Section B converts the layered fixture for real. It reuses packfx/data, so the roster is
# still alpha/beta/gamma and no authored `off` had to be invented - what changes is only which
# DIRECTORY each zone comes from.
print("\nlayered conversion: the pack overwrites the root per zone, all or nothing")
ltmp = tempfile.mkdtemp(prefix="packfx-layered-")
try:
    ldata = os.path.join(ltmp, "data")
    shutil.copytree(os.path.join(FX, "data"), ldata)
    lman = IP.convert(LAYERED, ldata, quiet=True)
    lgen = os.path.join(ldata, IP.CACHE_DIRNAME, "continents", "Testland")

    def lload(*parts):
        with open(os.path.join(lgen, *parts), encoding="utf-8") as f:
            return json.load(f)

    # -- pass-B discovery --------------------------------------------
    with open(os.path.join(ldata, "world.json"), encoding="utf-8") as f:
        lworld = json.load(f)
    lentries = IP.discovery_index_entries(LAYERED, ROOTA, ldata, lworld)
    lindex = IP.mapgeom.zidx_from(lentries)
    lroster = ["alpha", "beta", "gamma"]
    detected, drejected = IP.detect_discoveries(LAYERED, ROOTA, lroster, lindex)
    check("detection accepts only partial key/from records, sorted",
          detected,
          {"Testland": [{"key": "ambi", "from": "root"},
                         {"key": "excluded", "from": "root"},
                         {"key": "theta", "from": "root"}]})
    by_key = {record["key"]: record for record in drejected}
    check("series members are rejected with their common stem",
          [(key, by_key[key]["reason"], by_key[key]["detail"])
           for key in ("sraa", "srab", "srac")],
          [("sraa", "series", "sra"), ("srab", "series", "sra"),
           ("srac", "series", "sra")])
    check("a derived-key candidate names its authored parent",
          by_key["alphab"], {"key": "alphab", "reason": "derived", "detail": "alpha"})
    check("baseless rejection precedes marker resolution",
          [(key, by_key[key]["reason"]) for key in ("eta", "zeta")],
          [("eta", "baseless"), ("zeta", "baseless")])
    check("the bare Beta fixture label is still rejected by the transition prefix gate",
          by_key["delta"]["reason"], "unresolved")

    ambiguous_index = dict(lindex)
    ambiguous_index[IP.mapgeom.znorm("Other")] = ("Elsewhere", "other")
    _accepted_amb, rejected_amb = IP.detect_discoveries(
        LAYERED, ROOTA, lroster + ["other"], ambiguous_index)
    check("resolved neighbours spanning continents are ambiguous",
          {r["key"]: r for r in rejected_amb}["ambi"]["reason"], "ambiguous")

    saved_exclude = IP.mapgeom.DISCOVERY_EXCLUDE
    try:
        IP.mapgeom.DISCOVERY_EXCLUDE = {"excluded"}
        _accepted_exc, rejected_exc = IP.detect_discoveries(
            LAYERED, ROOTA, lroster, lindex)
    finally:
        IP.mapgeom.DISCOVERY_EXCLUDE = saved_exclude
    check("the authored residue table emits its closed rejection record",
          {r["key"]: r for r in rejected_exc}["excluded"],
          {"key": "excluded", "reason": "excluded", "detail": "DISCOVERY_EXCLUDE"})
    all_reasons = {r["reason"] for r in drejected + rejected_amb + rejected_exc}
    check("fixtures exercise the complete rejection reason schema",
          all_reasons,
          {"ambiguous", "unresolved", "series", "derived", "excluded", "baseless"})

    empty_accepted, empty_rejected = IP.detect_discoveries(
        PACK, None, ["alpha", "beta", "gamma"], IP.mapgeom.zidx_from(ientries))
    check("a source with no unrostered maps has paired empty detection results",
          (empty_accepted, empty_rejected), ({}, []))

    check("the manifest records discovery mode per continent", lman["continents"]["Testland"]["discovery"], True)
    check("the manifest stores sorted partial discovered records",
          lman["continents"]["Testland"]["discovered"], detected["Testland"])
    check("the manifest stores structured top-level rejections",
          lman["discoveryRejected"], drejected)
    check("step 2 writes no accepted candidate geometry",
          [key for key in ("ambi", "excluded", "theta")
           if os.path.exists(os.path.join(lgen, "geometry", key + ".json"))], [])

    no_discovery = IP.convert(LAYERED, ldata, quiet=True, discover=False)
    check("discovery-off records false per refreshed continent",
          no_discovery["continents"]["Testland"]["discovery"], False)
    check("discovery-off writes neither accepted nor rejected catalog",
          ("discovered" in no_discovery["continents"]["Testland"],
           "discoveryRejected" in no_discovery), (False, False))
    lman = IP.convert(LAYERED, ldata, quiet=True)  # restore the discovery-on cache below

    # The anchor for the whole section: confirmed NON-empty, which is what makes the paired
    # empty-assertions on the flat pack at the end of this block mean anything.
    check("the manifest records the derived base layer", lman["root"], ROOTA)
    check("...and names the other licensing regime beside it",
          "Daybreak" in lman.get("rootNote", ""), True)
    tl = lman["continents"]["Testland"]
    check("gamma - the one zone the pack has not mapped - resolved to the root",
          tl["rootZones"], ["gamma"])
    check("no rostered zone resolved to a directory lacking a base file",
          tl["baselessZones"], [])

    # The no-mixing assertion in its cheapest form. Root alpha carries base + _1 + _2 while
    # the pack carries base + _1, so a per-layer merge would pull alpha_2.txt in here.
    check("sources are exactly the resolved files, and alpha_2.txt is NOT among them",
          sorted(tl["sources"]),
          ["alpha.txt", "alpha_1.txt", "beta.txt", "beta_1.txt",
           "gamma.txt", "gamma_1.txt"])
    check("every file records which layer it came from",
          {n: s["from"] for n, s in tl["sources"].items()},
          {"alpha.txt": "pack", "alpha_1.txt": "pack", "beta.txt": "pack",
           "beta_1.txt": "pack", "gamma.txt": "root", "gamma_1.txt": "root"})
    # All-or-nothing as a sweep rather than by naming files: every file of a rootZones zone is
    # "root" and no file of any other zone is, so a future fixture zone is covered too.
    check("all-or-nothing per zone: no zone draws from both layers",
          {(n.split(".")[0].split("_")[0], s["from"]) for n, s in tl["sources"].items()},
          {("alpha", "pack"), ("beta", "pack"), ("gamma", "root")})

    # The strongest single assertion here: a per-layer merge appends the root's extra layers,
    # so it would add a _2 grid seg AND the to_Root_Only label to this zone.
    la = lload("detail", "alpha.json")
    check("alpha comes from the pack alone - one base layer, no root _2 grid",
          la["seglayer"], [0])
    check("...and carries the pack's label, never the root's",
          [l[4] for l in la["labels"]], ["to_Beta"])
    check("...and the pack's geometry, not the root's 100-unit decoy",
          la["segs"], [[4, 4, 5, 7, 2]])
    check("the fallback really did produce continent geometry for gamma",
          lload("geometry", "gamma.json")["segs"], [[1, 1, 2, 2]])
    # An explicit literal, deliberately NOT "one entry longer than the flat run": layering
    # DROPS root alpha_2.txt (whose grid colour the flat fixture counts) at the same moment
    # gamma adds one, so the two cancel and a length relation could pass or fail for reasons
    # that have nothing to do with this feature.
    check("root-sourced colours participate in palette allocation",
          lload("palette.json"),
          ["#08ce08",     # 0  (0,204,0)     beta base    <- beta is FIRST in detailZones
           "#ffffff",     # 1  (255,255,255) beta _1
           "#ff4545",     # 2  (255,0,0)     alpha base and alpha _1
           "#4f94cd"])    # 3  (70,130,180)  gamma base   <- from the ROOT layer
    check("...and no root colour is unknown to the shipped table", lman["unseenColors"], [])
    check("the layered manifest records the schema", lman["schema"], IP.SCHEMA)

    # baselessZones is ASSERTED, not merely printed. Without this the only guard against the
    # live `tutorial` class - an orphan layer resolving to empty geometry that validate_cache
    # accepts because the file exists - is a stderr NOTE no test reads.
    lcpath = os.path.join(ldata, "continents", "Testland", "continent.json")
    with open(lcpath, encoding="utf-8") as f:
        lmeta = json.load(f)
    lmeta["zoneOrder"].append("eta")          # the pack has eta_1.txt and no eta.txt
    lmeta["zones"]["eta"] = {"name": "Eta", "color": "#5fb95f", "cx": 0, "cy": 0,
                             "off": [0.0, 0.0]}
    with open(lcpath, "w", encoding="utf-8") as f:
        json.dump(lmeta, f)
    eman = IP.convert(LAYERED, ldata, quiet=True)
    check("a zone resolved to a directory with no base file is recorded",
          eman["continents"]["Testland"]["baselessZones"], ["eta"])
    check("...and its continent geometry really is empty",
          lload("geometry", "eta.json")["segs"], [])

    # A roster entry absent from both layers is skipped and counted, not fatal.
    lmeta["zoneOrder"].remove("eta")
    lmeta["zones"].pop("eta")
    lmeta["zoneOrder"].append("epsilon")
    lmeta["zones"]["epsilon"] = {"name": "Epsilon", "color": "#5fb95f",
                                   "cx": 0, "cy": 0, "off": [0.0, 0.0]}
    with open(lcpath, "w", encoding="utf-8") as f:
        json.dump(lmeta, f)
    eman = IP.convert(LAYERED, ldata, quiet=True)
    check("a zone in neither layer is counted as skipped",
          eman["continents"]["Testland"]["skippedZones"], ["epsilon"])
    check("...and writes no geometry file",
          os.path.exists(os.path.join(ldata, "_generated", "continents", "Testland",
                                      "geometry", "epsilon.json")), False)
    skip_out, skip_err = io.StringIO(), io.StringIO()
    with redirect_stdout(skip_out), redirect_stderr(skip_err):
        fskip = IP.convert(PACK, ldata, quiet=False)
    check("the same skip contract holds without a base layer",
          fskip["continents"]["Testland"]["skippedZones"], ["epsilon"])
    check("the skip report names epsilon", "epsilon" in skip_out.getvalue(), True)
    check("the skip NOTE fires", "NOTE:" in skip_err.getvalue(), True)
    check("the supplement hint fires exactly once", skip_err.getvalue().count("HINT:"), 1)
    progress = next(line for line in skip_out.getvalue().splitlines() if "Testland" in line)
    check("the continent summary counts only generated zones and detail",
          progress.split()[:5], ["Testland", "3", "zones,", "3", "detail,"])

    cli_out, cli_err = io.StringIO(), io.StringIO()
    saved_argv = sys.argv[:]
    try:
        sys.argv = ["import_pack.py", "--pack", PACK, "--data", ldata]
        with redirect_stdout(cli_out), redirect_stderr(cli_err):
            IP.main()
    finally:
        sys.argv = saved_argv
    check("the CLI summary counts only generated zones",
          "Wrote 1 continents, 3 zones" in cli_out.getvalue(), True)

    check("a declared skip exempts only its generated files",
          IP.validate_cache(ldata), (True, "ok"))
    check("cache_skips reads a partial cache",
          IP.cache_skips(ldata), {"Testland": {"epsilon"}})
    with open(os.path.join(ldata, "continents", "Testland", "layout.json"),
              "w", encoding="utf-8") as f:
        json.dump({"connectors": [], "hubs": [], "zoneXf": {},
                   "links": [{"z1": "alpha", "z2": "beta", "locked": False},
                             {"z1": "alpha", "z2": "epsilon", "locked": True}]}, f)
    with open(os.path.join(ldata, "travel.json"), "w", encoding="utf-8") as f:
        json.dump({}, f)
    built_all = BUILD.build(ldata)[0]
    check("build filters only links touching a skipped zone",
          built_all["Testland"].get("links", []),
          [{"z1": "alpha", "z2": "beta", "locked": False}])
    raises("travel derivation refuses a partial cache",
           lambda: DTG.refuse_partial_cache(ldata), "Testland (1)")

    nocache = tempfile.mkdtemp(prefix="packfx-no-cache-")
    try:
        raises("travel derivation names a missing cache manifest",
               lambda: DTG.refuse_partial_cache(nocache), "map cache manifest is missing")
    finally:
        shutil.rmtree(nocache, ignore_errors=True)

    # Present files with no L or P record remain a broken pack, not a coverage gap.
    raises("a present but unusable map file remains fatal",
           lambda: IP.convert(EMPTY, ldata, quiet=True), "no usable map records")

    # Paired with the confirmed non-empty assertions at the top of this block, per the
    # false-pass trap README.md names: on their own these two would pass with the whole
    # feature deleted, and mean nothing.
    lmeta["zoneOrder"].remove("epsilon")
    lmeta["zones"].pop("epsilon")
    with open(lcpath, "w", encoding="utf-8") as f:
        json.dump(lmeta, f)
    full_out, full_err = io.StringIO(), io.StringIO()
    with redirect_stdout(full_out), redirect_stderr(full_err):
        fman = IP.convert(PACK, ldata, quiet=False)
    check("a zero-skip conversion prints no skip report", "skipped zone" in full_out.getvalue(), False)
    check("...and neither NOTE nor supplement HINT", "NOTE:" in full_err.getvalue() or
          "HINT:" in full_err.getvalue(), False)
    try:
        DTG.refuse_partial_cache(ldata)
        complete_guard_ok = True
    except SystemExit:
        complete_guard_ok = False
    check("travel derivation accepts a complete cache", complete_guard_ok, True)
    check("a pack outside maps/ derives no base layer at all", fman["root"], None)
    check("...and carries no rootNote to assert a second regime",
          "rootNote" in fman, False)
    check("...and resolves nothing to the root",
          fman["continents"]["Testland"]["rootZones"], [])

    # The summary helper needs world["order"], because the manifest is sort_keys=True and does
    # not store it - alphabetical continent keys cannot recover the authored order.
    check("root_layer_zones pairs continent with zone, in authored order",
          IP.root_layer_zones(lman, ["Testland"]), [("Testland", "gamma")])
    check("...and reports nothing for a flat conversion",
          IP.root_layer_zones(fman, ["Testland"]), [])
    # The summary is derived from the ZONE LIST, never from top-level `root`, and this pins
    # that. The reachable symptom: after a layered convert, an --only run whose --pack sits
    # outside maps/ nulls top-level `root` while the continents it did not touch keep their
    # rootZones - so a root-gated summary would report "nothing from the root layer" about a
    # cache that has some. Asserted against a hand-built manifest rather than a real --only
    # run because packfx/data has ONE continent, so --only there rewrites the only entry there
    # is and the mixed state cannot occur.
    check("a null top-level root does not hide an untouched continent's rootZones",
          IP.root_layer_zones(
              {"root": None,
               "continents": {"Later": {"rootZones": ["gamma"]}, "Refreshed": {"rootZones": []}}},
              ["Refreshed", "Later"]),
          [("Later", "gamma")])
finally:
    shutil.rmtree(ltmp, ignore_errors=True)

print("\nRESULT: " + ("FAIL (%d)" % len(fails) if fails else "PASS"))
sys.exit(1 if fails else 0)
