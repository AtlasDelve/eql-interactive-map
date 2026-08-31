#!/usr/bin/env python3
"""
Convert a community map pack (Brewall, Good's Maps, ...) into data/_generated/.

The repo does not carry the traced map geometry - it is derived from a pack the project does
not own (see AGENTS.md, licensing boundary). This script regenerates it from a pack path the
user supplies, into a git-ignored cache. What stays committed is the authored layer: placement,
connectors, hubs, travel, and the per-zone values a pack does not carry.

Usage:
    python scripts/import_pack.py --pack DIR            # convert everything
    python scripts/import_pack.py --pack DIR --only Odus
    python scripts/import_pack.py --pack DIR --print-authored Odus

Granularity is a whole continent minimum: the palette is continent-scoped and allocated in
first-seen order, so regenerating one zone could renumber indices every other detail file in
that continent already refers to.

No third-party dependencies (Python 3 standard library only). Written flat and data-driven on
purpose - the JS twin in `no-install-builder` should be a transliteration, not a redesign.
"""
import argparse
import hashlib
import json
import math
import os
import shutil
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import mapgeom                                                 # noqa: E402
import pack_colors                                              # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")
CACHE_DIRNAME = "_generated"
# 2: per-file `from` and per-continent rootZones/baselessZones (layered pack resolution).
# 3: per-continent skippedZones (partial authored-roster coverage).
# 4: per-continent discovery mode/catalog and structured top-level discovery rejections.
#
# The bump is not hygiene. validate_cache never reads `sources`, so a schema-1 cache would
# keep building perfectly well - what it would break is the provenance report: seeded into a
# schema-2 --only run, a schema-1 manifest contributes continents with no `from`/rootZones, so
# the summary would say "no zones from the root layer" while an untouched continent had one.
# That is a silent false negative on a claim that now carries licensing weight. --only calls
# validate_cache BEFORE seeding, so the stale manifest is rejected instead. The same applies
# to schema 2 seeded into a schema-3 --only run: untouched continents would have no
# skippedZones and the merged skip report would silently under-count them.
SCHEMA = 4

# A pack zone is up to four files. They are semantic layers, not floors: the base file is line
# geometry, _1 the POI/label layer (where the to_/from_ transition markers live), _2 a
# coordinate grid plus the pack's attribution text, _3 exists for exactly one zone.
LAYER_SUFFIXES = ("", "_1", "_2", "_3")


# --------------------------------------------------------------------------- rounding
# Coordinates are rounded with Python's round(), which is HALF-TO-EVEN. This is not a
# stylistic choice and must not be "simplified" to floor(x+0.5): measured over all 118
# non-stale zones, half-to-even reproduces the committed data 118/118 while floor(x+0.5)
# (i.e. JS Math.round) reproduces 23/118. The pack has 16938 exact .5 coordinates, so the
# two rules disagree constantly. A JS port needs an explicit half-to-even helper.
def _r(x):
    return round(x)


JS_SAFE_INTEGER = (1 << 53) - 1


def _canon_catalog_number(value):
    """Return a finite JavaScript-canonical number produced for the discovery catalog."""
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise SystemExit("non-canonical discovered catalog number %r is not finite" % value)
    if isinstance(value, float) and value.is_integer():
        value = int(value)
    if isinstance(value, int) and abs(value) > JS_SAFE_INTEGER:
        raise SystemExit("non-canonical discovered catalog integer %r exceeds JS safe range" % value)
    return value


def _normalise_cost(value):
    """Plan-1 half-to-even one-decimal cost, then the injected-data number dialect."""
    return _canon_catalog_number(_r(max(value, 0.1) * 10) / 10)


# --------------------------------------------------------------------------- pack reading
def read_text(path):
    """Pack files are ASCII in practice; fall back rather than fail on a stray byte."""
    with open(path, "rb") as f:
        raw = f.read()
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        text = raw.decode("latin-1")
    # Written as an escape, not a literal: a bare BOM here is invisible in an editor and
    # the next person to touch this line would delete it without seeing it.
    if text[:1] == "﻿":
        text = text[1:]
    return text


def parse_zone(srcdir, zone_key):
    """[(layer, kind, fields, filename, lineno)] over the zone's layers, in layer order.

    `srcdir` is ONE directory, and it is not necessarily the pack: resolve_zone_source picks
    it per zone, so a zone no pack has mapped is parsed from the client's maps/ root instead.
    Every layer comes from that one directory - sources are never mixed within a zone.

    A malformed L/P line is a hard error naming file and line. That is deliberate: the
    to_/from_ labels are the travel graph's primary source for adjacency, so a silently
    dropped record is exactly the failure this grammar exists to prevent. Unknown record
    types are ignored, but counted so the manifest can show them.
    """
    out, unknown = [], {}
    for layer, suffix in enumerate(LAYER_SUFFIXES):
        name = zone_key + suffix + ".txt"
        path = os.path.join(srcdir, name)
        if not os.path.exists(path):
            continue
        for lineno, line in enumerate(read_text(path).splitlines(), 1):
            line = line.strip()
            if not line:
                continue
            kind = line[0]
            if kind not in ("L", "P"):
                unknown[kind] = unknown.get(kind, 0) + 1
                continue
            # A label's text may itself contain commas - 1605 pack lines do, e.g.
            # "Locked_Door_(Quests,Unpickable)" - so split P at most 7 times and take the
            # rest verbatim. Splitting on every comma and rejoining would silently rewrite
            # any internal spacing.
            if kind == "L":
                fields = [p.strip() for p in line[1:].split(",")]
                need = 9
            else:
                fields = line[1:].split(",", 7)
                fields = [p.strip() for p in fields[:7]] + [f.strip() for f in fields[7:]]
                need = 8
            if len(fields) != need:
                raise SystemExit("%s:%d: malformed %s line (%d fields, need %d): %s"
                                 % (name, lineno, kind, len(fields), need, line))
            try:
                if kind == "L":
                    nums = [float(v) for v in fields[:6]]
                    rgb = tuple(int(float(v)) for v in fields[6:9])
                    rec = (nums, rgb)
                else:
                    nums = [float(v) for v in fields[:3]]
                    rgb = tuple(int(float(v)) for v in fields[3:6])
                    rec = (nums, rgb, int(float(fields[6])), fields[7])
            except ValueError as exc:
                raise SystemExit("%s:%d: malformed %s line (%s): %s"
                                 % (name, lineno, kind, exc, line))
            out.append((layer, kind, rec, name, lineno))
    return out, unknown


def zone_files(srcdir, zone_key):
    """The zone's existing layer files in ONE directory - the same `srcdir` parse_zone read,
    so the manifest's per-file record cannot describe a different source than the geometry."""
    return [os.path.join(srcdir, zone_key + s + ".txt") for s in LAYER_SUFFIXES
            if os.path.exists(os.path.join(srcdir, zone_key + s + ".txt"))]


# --------------------------------------------------------------------------- the transform
# The detail frame is the pack frame with y negated and x unchanged; z is discarded from both
# segments and labels. Continent geometry is the BASE LAYER ALONE, translated by the zone's
# authored `off` - and off is a FLOAT pair, applied before rounding. Only 14 of 118 offsets
# are integral, which is why an integer offset applied to the already-rounded detail value
# reproduces just 20 of 120 zones.
def detail_records(records):
    """(segs_xy, segz, seglayer, labels_xy, lablayer, raw_xy) in pack order."""
    segs, segz, seglayer, labels, lablayer = [], [], [], [], []
    raw_x, raw_y = [], []
    for layer, kind, rec, name, lineno in records:
        if kind == "L":
            n, rgb = rec
            segs.append([_r(n[0]), _r(-n[1]), _r(n[3]), _r(-n[4]), rgb])
            segz.append([n[2], n[5]])
            seglayer.append(layer)
            raw_x += [n[0], n[3]]
            raw_y += [-n[1], -n[4]]
        else:
            n, rgb, size, text = rec
            labels.append([_r(n[0]), _r(-n[1]), rgb, size, text])
            lablayer.append(layer)
            raw_x.append(n[0])
            raw_y.append(-n[1])
    return segs, segz, seglayer, labels, lablayer, (raw_x, raw_y)


def geometry_records(records, off):
    """Base layer only, translated into the continent frame. Rounding happens after."""
    ox, oy = float(off[0]), float(off[1])
    segs, segz = [], []
    for layer, kind, rec, name, lineno in records:
        if layer != 0 or kind != "L":
            continue
        n = rec[0]
        segs.append([_r(n[0] + ox), _r(-n[1] + oy), _r(n[3] + ox), _r(-n[4] + oy)])
        segz.append([n[2], n[5]])
    return segs, segz


def bbox_of(raw_x, raw_y):
    """Unrounded min/max over every segment endpoint AND every label position.

    From the raw pack floats, not the rounded output - which is why committed bboxes carry
    values like -3481.6995. Reproduces 118/118; computing it from the rounded segs alone
    gives 45/118.
    """
    if not raw_x:
        return [0.0, 0.0, 0.0, 0.0]
    return [min(raw_x), min(raw_y), max(raw_x), max(raw_y)]


# --------------------------------------------------------------------------- offsets source
def authored_zones(meta):
    return meta.get("zones") or {}


def offset_for(cont, meta, zone_key):
    """A zone's authored `off`. There is no derived fallback, and that is deliberate.

    `off` places the zone, so a pack must not be able to supply it - the same rule that keeps
    cx/cy authored. It was bootstrapped once from the then-committed geometry; that geometry
    is gone, so nothing could derive it now even if we wanted to. For a NEW zone, run
    --print-authored to get the pack's own frame and pick a placement.
    """
    az = authored_zones(meta).get(zone_key)
    if not az or az.get("off") is None:
        raise SystemExit(
            "%s/%s: no authored `off` in continent.json -> zones.\n"
            "Every zone in zoneOrder needs one. For a new zone, see:\n"
            "    python scripts/import_pack.py --print-authored %s"
            % (cont, zone_key, cont))
    return list(az["off"])


# --------------------------------------------------------------------------- writing
def dump_compact(obj, path):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f, separators=(",", ":"), ensure_ascii=False)


def sha256_of(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def looks_like_root_maps(pack):
    """Warn when --pack IS the client's own maps/ root rather than a pack subdirectory of it.

    Files in the maps/ ROOT are the maps Daybreak ships; 69 of the 120 zones this repo carries
    have a same-named root file with DIFFERENT content (arena.txt: 3480 L lines official
    against Brewall's 503), so importing from there swaps both the geometry and the provenance
    claim on most zones at once.

    Layering makes that MORE clearly a mistake, not less. The supported way to reach a root
    file is now as a base layer UNDER a pack - per zone, all-or-nothing, and recorded (see
    root_layer). Pointing --pack at the root instead takes every zone from Daybreak's files
    and leaves no layer to fall back to, since root_layer looks at --pack's PARENT.

    Warn, never refuse - a user may have installed a pack directly into the root, and guessing
    wrong for them is worse than a warning.
    """
    reasons = []
    if os.path.basename(os.path.normpath(pack)).lower() == "maps":
        reasons.append("directory is named 'maps'")
    grids = len([n for n in os.listdir(pack) if n.endswith("_2.txt")])
    if grids < 50:
        reasons.append("only %d *_2.txt grid layers (a pack has hundreds)" % grids)
    return reasons


def root_layer(pack):
    """The client's maps/ ROOT as a base layer under `pack`, or None when there is none.

    DERIVED, not configured: the root is --pack's parent when that parent is named `maps`,
    which is exactly the shape of a community pack installed into the client's map directory
    (<install>/maps/Brewall). Anywhere else there is no base layer at all and behaviour is
    byte-identical to a single-directory import - including --pack pointed straight AT the
    root, whose parent is the install dir, so pointing there still gives no fallback.

    Lexical on purpose - abspath, NOT realpath. Layering follows the path the user typed.
    Resolving junctions and symlinks would switch layering on or off for the same directory
    reached under two different aliases, so the same pack would import differently depending
    on which one was used. Do not "fix" this to realpath.

    Complementary to looks_like_root_maps(), which probes the same tree for the opposite
    mistake - --pack BEING the root rather than sitting under it. Two probes, one tree, and
    they answer different questions; do not merge them.
    """
    a = os.path.abspath(pack)
    parent = os.path.dirname(a)
    if os.path.basename(parent).lower() != "maps":
        return None
    # Belt and braces against a path that is its own parent, which would make a zone resolve
    # to its own directory and turn the fallback into a silent no-op that looks like it
    # worked. Only a filesystem root is its own parent, and a root's basename is empty, so
    # the test above already excludes one - this cannot fire today. It is here so that
    # loosening that test later cannot reintroduce the self-resolving case unnoticed.
    if os.path.normcase(parent) == os.path.normcase(a):
        return None
    return parent


def resolve_zone_source(pack, root, zone_key):
    """(srcdir, "pack"|"root") for the ONE directory this zone's layers come from, or
    (None, None) when neither layer has any. NEVER returns a mix.

    Base-first, then pack-first:

        1. base <zone>.txt in pack -> pack        3. any layer file in pack -> pack
        2. base <zone>.txt in root -> root        4. any layer file in root -> root
                                                  5. neither -> (None, None)

    Rules 1/2 are "the pack overwrites the root, per zone". All-or-nothing per zone rather
    than per layer, because a merged zone is two different tracings of the same room
    superimposed. Rules 3/4 are the orphan tail: a directory holding _N annotation layers but
    no base <zone>.txt at all.

    Base beats orphan because an orphan has not MAPPED the zone - continent geometry is the
    base layer alone, so resolving to one yields an empty geometry file that validate_cache
    accepts (the file exists) and that renders as nothing. Measured, and the figures depend on
    CASE-FOLDING, which is the semantics that matters here because the probe is
    os.path.exists - case-insensitive on Windows: Brewall holds 12 orphan zones, Good's Maps
    22, the maps/ root 0. Case-sensitive set arithmetic over-counts Brewall by 10, so anyone
    re-measuring pack coverage must fold. Exactly ONE orphan shadows a root base file under
    either folding - Brewall's `tutorial`, which carries tutorial_1.txt and no tutorial.txt
    while the root has tutorial.txt - and that single instance is the entire reason the
    ordering is base-first rather than "any pack file wins".

    Rule 3 is today's rule verbatim, so with `root` None every input resolves exactly as it
    did before layering existed.
    """
    def has(srcdir, suffixes):
        return srcdir and any(
            os.path.exists(os.path.join(srcdir, zone_key + s + ".txt")) for s in suffixes)

    for suffixes in (("",), LAYER_SUFFIXES):          # base only, then any layer
        for srcdir, tag in ((pack, "pack"), (root, "root")):
            if has(srcdir, suffixes):
                return srcdir, tag
    return None, None


def root_layer_zones(manifest, order):
    """[(continent, zone)] for every authored or discovered root-layer zone.

    `order` is a required parameter rather than a convenience: the manifest is written with
    sort_keys=True and does not store world["order"], so its continent keys come back
    alphabetically and the manifest alone cannot recover the authored order. Callers pass
    world["order"]. Within a continent, authored rootZones stay in roster order and discovered
    entries follow in their catalog's sorted candidate-key order.

    Read from the MERGED manifest, so this covers the whole cache rather than one --only run's
    continents.
    """
    conts = manifest.get("continents", {})
    out = []
    for cont in order:
        entry = conts.get(cont) or {}
        out.extend((cont, zk) for zk in entry.get("rootZones", []))
        out.extend((cont, record["key"]) for record in entry.get("discovered", [])
                   if record.get("from") == "root")
    return out


def cache_skips(data=None):
    """{continent: set(zone_keys)} from the validated cache manifest."""
    data = data or DATA
    with open(os.path.join(data, CACHE_DIRNAME, "manifest.json"),
              "r", encoding="utf-8") as f:
        man = json.load(f)
    return {cont: set(entry.get("skippedZones", []))
            for cont, entry in man.get("continents", {}).items()}


def cache_discoveries(data=None):
    """Per-continent discovery catalogs and palette tails from the plain manifest dialect."""
    data = data or DATA
    with open(os.path.join(data, CACHE_DIRNAME, "manifest.json"),
              "r", encoding="utf-8") as f:
        man = json.load(f)
    return {
        cont: {"zones": entry.get("discovered", []),
               "palette": entry.get("discoveredPalette", [])}
        for cont, entry in man.get("continents", {}).items()
        if entry.get("discovered")
    }


class CachePromotionError(Exception):
    """The staged cache could not replace the live one. Typed so callers can tell this apart
    from a conversion failure: the conversion succeeded, only the swap did not."""


def promote(tmp_root, out_root):
    """Swap a fully-written staging directory into place, rolling back if the swap fails.

    The dangerous window is between moving the old cache aside and moving the new one in: on
    Windows a directory held open by another process (an editor, an antivirus scan, a second
    build) makes the second rename fail, and without a rollback the tree is left with NO
    cache at all - the previous good one having already been renamed away. So the old cache
    is put back before raising, and the guarantee is that a failed promotion leaves the
    previous cache exactly as it was.
    """
    old_root = out_root + ".previous"
    if os.path.exists(old_root):
        shutil.rmtree(old_root, ignore_errors=True)
    moved = False
    try:
        if os.path.exists(out_root):
            os.replace(out_root, old_root)           # atomic where the OS can manage it
            moved = True
        os.replace(tmp_root, out_root)
    except OSError as exc:
        if moved and not os.path.exists(out_root):
            try:
                os.replace(old_root, out_root)       # put the working cache back
            except OSError:
                raise CachePromotionError(
                    "could not install the new cache AND could not restore the old one. The "
                    "previous cache is at %s - rename it back to %s by hand. (%s)"
                    % (old_root, out_root, exc))
        shutil.rmtree(tmp_root, ignore_errors=True)
        raise CachePromotionError(
            "could not replace %s (%s). The previous cache is untouched; close anything "
            "holding that directory open and re-run." % (out_root, exc))
    shutil.rmtree(old_root, ignore_errors=True)


# --------------------------------------------------------------------------- conversion
def discovery_index_entries(pack, root, data, world):
    """Authored ``(continent, key, name)`` entries in the viewer's DETAIL order.

    Resolution is existence-only here: a rostered detail zone participates only when the
    selected source can actually supply it.  That mirrors the viewer's ZIDX, which is built
    from DETAIL rather than from the complete authored roster.  The full authored order is
    always scanned, even for ``--only``, because this is one global first-wins index.
    """
    entries = []
    for cont in world["order"]:
        cdir = os.path.join(data, "continents", cont.replace(" ", "_").replace("'", ""))
        with open(os.path.join(cdir, "continent.json"), "r", encoding="utf-8") as f:
            meta = json.load(f)
        roster = list(meta["zoneOrder"])
        for zk in meta.get("detailZones", []):
            if zk not in roster:
                roster.append(zk)
        resolved = set()
        for zk in roster:
            srcdir, _src = resolve_zone_source(pack, root, zk)
            if srcdir is not None:
                resolved.add(zk)
        zones = authored_zones(meta)
        for zk in meta.get("detailZones", []):
            if zk in resolved:
                entries.append((cont, zk, zones[zk]["name"]))
    return entries


def discovery_base_keys(pack, root):
    """Sorted, case-folded zone keys represented by any layer in either directory."""
    keys = set()
    suffixes = tuple(s.casefold() for s in LAYER_SUFFIXES if s)
    for srcdir in (pack, root):
        if not srcdir:
            continue
        for name in os.listdir(srcdir):
            stem, ext = os.path.splitext(name)
            folded = stem.casefold()
            if ext.casefold() != ".txt":
                continue
            for suffix in suffixes:
                if folded.endswith(suffix):
                    folded = folded[:-len(suffix)]
                    break
            keys.add(folded)
    return sorted(keys)


def detect_discoveries(pack, root, roster, zone_index, include_targets=False):
    """Return ({continent: partial records}, structured rejections) for unrostered maps."""
    roster = {key.casefold() for key in roster}
    key_continent = {key: cont for cont, key in zone_index.values()}
    candidates, rejected = [], []

    def reject(key, reason, detail):
        rejected.append({"key": key, "reason": reason, "detail": detail})

    for key in discovery_base_keys(pack, root):
        if key in roster:
            continue
        srcdir, source = resolve_zone_source(pack, root, key)
        if srcdir is None:
            continue
        # The orphan tail resolves annotation-only zones.  Reject it before parsing so a
        # markerless orphan is always baseless, never incidentally unresolved.
        if not os.path.exists(os.path.join(srcdir, key + ".txt")):
            reject(key, "baseless", source)
            continue
        records, _unknown = parse_zone(srcdir, key)
        targets = set()
        for layer, kind, record, _name, _lineno in records:
            if layer == 1 and kind == "P":
                targets.update(mapgeom.transition_targets(zone_index, key, record[3]))
        targets = sorted(target for target in targets if target in key_continent)
        continents = sorted({key_continent[target] for target in targets})
        if not targets:
            reject(key, "unresolved", "no resolved outward transition")
            continue
        if len(continents) != 1:
            reject(key, "ambiguous", ", ".join(continents))
            continue
        candidates.append({"key": key, "from": source, "continent": continents[0],
                           "targets": targets})

    # A series qualifies only when every member has exactly one neighbour and it is the same
    # neighbour for the whole stem.  Multi-neighbour members deliberately fall through.
    groups = {}
    for candidate in candidates:
        stem = mapgeom.discovery_series_stem(candidate["key"])
        if stem:
            groups.setdefault(stem, []).append(candidate)
    series_keys = set()
    for stem, members in groups.items():
        if (len(members) >= 3 and all(len(m["targets"]) == 1 for m in members) and
                len({m["targets"][0] for m in members}) == 1):
            for member in members:
                series_keys.add(member["key"])
                reject(member["key"], "series", stem)

    accepted = {}
    for candidate in candidates:
        key = candidate["key"]
        if key in series_keys:
            continue
        parent = mapgeom.discovery_derived_parent(key, roster)
        if parent is not None:
            reject(key, "derived", parent)
            continue
        if key in mapgeom.DISCOVERY_EXCLUDE:
            reject(key, "excluded", "DISCOVERY_EXCLUDE")
            continue
        record = {"key": key, "from": candidate["from"]}
        if include_targets:
            # Conversion needs the already-resolved neighbours for placement.  Keep them
            # private: the durable catalog receives sorted `edges` in step 4 instead.
            record["_targets"] = candidate["targets"]
        accepted.setdefault(candidate["continent"], []).append(record)

    for records in accepted.values():
        records.sort(key=lambda record: record["key"])
    rejected.sort(key=lambda record: record["key"])
    return accepted, rejected


def _source_identity(sources):
    """(count, sha256) over sorted (filename, content-sha256) pairs."""
    pairs = sorted((name, entry["sha256"]) for name, entry in sources.items())
    h = hashlib.sha256()
    for name, digest in pairs:
        h.update(("%s %s\n" % (name, digest)).encode("utf-8"))
    return len(pairs), h.hexdigest()


def _candidate_doorway(records, zone_index, key, target):
    """First layer-1 transition point from candidate ``key`` to ``target``."""
    for layer, kind, record, _name, _lineno in records:
        if layer != 1 or kind != "P":
            continue
        nums, _rgb, _size, label = record
        if target in mapgeom.transition_targets(zone_index, key, label):
            return (_r(nums[0]), _r(-nums[1]))
    raise AssertionError("discovery target %s -> %s lost its source marker" % (key, target))


def _reciprocal_marker(records, zone_index, anchor):
    """The one unresolved transition in an anchor's selected _1 layer, if unique."""
    unresolved = []
    for layer, kind, record, _name, _lineno in records:
        if layer != 1 or kind != "P":
            continue
        nums, _rgb, _size, label = record
        if not label.casefold().startswith(("to_", "from_")):
            continue
        if not mapgeom.transition_targets(zone_index, anchor, label):
            unresolved.append((_r(nums[0]), _r(-nums[1]), label))
    return unresolved[0] if len(unresolved) == 1 else None


def _written_centroid(segs, key):
    """Endpoint mean in written segment order, rounded to the authored integer dialect."""
    if not segs:
        raise SystemExit("discovered zone %r has no base-layer line geometry" % key)
    sx = sy = 0
    count = 0
    for seg in segs:
        sx += seg[0]
        sx += seg[2]
        sy += seg[1]
        sy += seg[3]
        count += 2
    return _r(sx / count), _r(sy / count)


def _read_compact(path):
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def assemble_discoveries(cont, candidates, pack, root, parsed, meta, zone_index,
                         cout, palette, unseen_all):
    """Write discovered cache files and return (catalog, sources, palette tail).

    The shared palette.json is already final when this runs and is never modified.  New display
    colours are indexed against an in-memory extension recorded as discoveredPalette.
    """
    catalog = []
    discovered_sources = {}
    discovered_palette = []
    palette_index = {color: i for i, color in enumerate(palette)}
    azones = authored_zones(meta)
    targets_by_key = {}

    zones = {}
    for key in meta["zoneOrder"]:
        if key not in parsed:
            continue
        geometry = _read_compact(os.path.join(cout, "geometry", key + ".json"))
        zones[key] = compose_zone(azones[key], geometry, None)

    for partial in sorted(candidates, key=lambda record: record["key"]):
        key = partial["key"]
        targets = sorted(partial["_targets"])
        targets_by_key[key] = targets
        anchor = targets[0]
        srcdir, source = resolve_zone_source(pack, root, key)
        if srcdir is None or source != partial["from"]:
            raise AssertionError("discovered source changed during conversion for %s" % key)
        records, _unknown = parse_zone(srcdir, key)
        candidate_doorway = _candidate_doorway(records, zone_index, key, anchor)
        reciprocal = _reciprocal_marker(parsed[anchor], zone_index, anchor)

        if reciprocal is not None:
            off = [azones[anchor]["off"][0] + reciprocal[0] - candidate_doorway[0],
                   azones[anchor]["off"][1] + reciprocal[1] - candidate_doorway[1]]
            name = mapgeom.discovery_display_name(reciprocal[2])
            if mapgeom.znorm(name) != mapgeom.znorm(reciprocal[2]):
                raise AssertionError("discovered display name changed marker identity for %s" % key)
            # This is an argument made executable, not a reachable collision guard: had the
            # marker resolved to authored content, detection would not have left it unresolved.
            if mapgeom.resolve_zone(zone_index, name) is not None:
                raise AssertionError("discovered marker name collides with authored content: %s" % name)
            name_from = "marker"
        else:
            point = mapgeom.nearest_outline_point(
                zones[anchor], zones[anchor]["cx"], zones[anchor]["cy"], transformed=False)
            # Arbitrary by design: without a reciprocal marker the selected source says which
            # zone connects, but not where on its outline the doorway belongs.
            off = [point[0] - candidate_doorway[0], point[1] - candidate_doorway[1]]
            name = key
            name_from = "key"

        geometry_segs, geometry_z = geometry_records(records, off)
        cx, cy = (_canon_catalog_number(value)
                  for value in _written_centroid(geometry_segs, key))
        dump_compact({"segs": geometry_segs, "segz": geometry_z},
                     os.path.join(cout, "geometry", key + ".json"))
        zone = compose_zone({"name": name, "color": mapgeom.DISCOVERED_ZONE_COLOR,
                             "cx": cx, "cy": cy}, {"segs": geometry_segs}, None)
        zones[key] = zone

        segs, segz, seglayer, labels, lablayer, raw = detail_records(records)
        # Tail order is the written detail order: every segment first, then every label, each
        # array retaining base/_1/_2/_3 source order.  Existing colours reuse their old index.
        for item, slot in [(seg, 4) for seg in segs] + [(label, 2) for label in labels]:
            color = pack_colors.color_for(item[slot], unseen_all)
            if color not in palette_index:
                palette_index[color] = len(palette) + len(discovered_palette)
                discovered_palette.append(color)
            item[slot] = palette_index[color]
        dump_compact({"segs": segs, "segz": segz, "seglayer": seglayer,
                      "labels": labels, "lablayer": lablayer,
                      "bbox": bbox_of(raw[0], raw[1])},
                     os.path.join(cout, "detail", key + ".json"))

        for path in zone_files(srcdir, key):
            discovered_sources[os.path.basename(path)] = {
                "bytes": os.path.getsize(path), "sha256": sha256_of(path), "from": source}

        catalog.append({"key": key, "name": name, "nameFrom": name_from,
                        "color": mapgeom.DISCOVERED_ZONE_COLOR, "cx": cx, "cy": cy,
                        "off": off, "anchor": anchor, "from": source})

    by_name = {}
    for record in catalog:
        by_name.setdefault(mapgeom.znorm(record["name"]), []).append(record)
    for collision in (records for records in by_name.values() if len(records) > 1):
        key_norms = [mapgeom.znorm(record["key"]) for record in collision]
        if len(set(key_norms)) != len(key_norms):
            raise SystemExit("discovered zone keys still collide after name fallback: %s"
                             % ", ".join(record["key"] for record in collision))
        for record in collision:
            record["name"] = record["key"]
            record["nameFrom"] = "key"

    # Costs are the final part of candidate assembly.  At this point every candidate's cache
    # files and composed zone record exist, and name-collision fallback has fixed the same index
    # identity the runtime will see.
    edge_index = dict(zone_index)
    discovered_index = mapgeom.zidx_from(
        [(cont, record["key"], record["name"]) for record in catalog])
    for normalized, target in discovered_index.items():
        edge_index.setdefault(normalized, target)
    extended_palette = palette + discovered_palette
    for record in catalog:
        key = record["key"]
        candidate_cache = _read_compact(os.path.join(cout, "detail", key + ".json"))
        candidate_detail = compose_detail(record, candidate_cache, extended_palette)
        candidate_exits = mapgeom.exit_points_from(key, zones[key], candidate_detail, edge_index)
        edges = []
        for neighbour in targets_by_key[key]:
            neighbour_cache = _read_compact(
                os.path.join(cout, "detail", neighbour + ".json"))
            neighbour_detail = compose_detail(
                azones[neighbour], neighbour_cache, extended_palette)
            neighbour_exits = mapgeom.exit_points_from(
                neighbour, zones[neighbour], neighbour_detail, edge_index)
            exits = dict(candidate_exits)
            exits.update(neighbour_exits)
            candidate_named = (key, neighbour) in exits
            neighbour_named = (neighbour, key) in exits
            if candidate_named and neighbour_named:
                named = "both"
            elif candidate_named:
                named = "candidate"
            elif neighbour_named:
                named = "neighbour"
            else:
                raise AssertionError("accepted discovery edge lost both doorway markers: %s/%s"
                                     % (key, neighbour))
            raw_cost = mapgeom.cost_between(
                zones, key, neighbour, transformed=False, exits=exits)
            edges.append({"z": neighbour, "cost": _normalise_cost(raw_cost), "named": named})
        record["edges"] = edges

    return catalog, discovered_sources, discovered_palette


def convert(pack, data=None, only=None, quiet=False):
    data = data or DATA
    with open(os.path.join(data, "world.json"), "r", encoding="utf-8") as f:
        world = json.load(f)
    order = [c for c in world["order"] if only is None or c == only]
    if only is not None:
        if not order:
            raise SystemExit("--only: no such continent in world.json order: " + only)
        # Refuse unless there is already a complete, valid cache to merge into. Otherwise a
        # single-continent run produces a cache that LOOKS usable - manifest present, right
        # schema - and then fails validation on the next build, or worse gets built against
        # with ten continents missing. --only is for refreshing one continent, never for
        # creating a cache.
        ok, why = validate_cache(data, world)
        if not ok:
            raise SystemExit(
                "--only needs a complete cache to update, and there isn't one: %s\n"
                "Convert everything first:  python scripts/import_pack.py" % why)

    # Always recorded in the manifest; printed unless the caller asked for quiet. The only
    # quiet caller is the test fixture, whose 3-zone pack trips the grid-count heuristic by
    # construction - it asserts against looks_like_root_maps() directly instead.
    warnings = looks_like_root_maps(pack)
    if not quiet:
        for w in warnings:
            sys.stderr.write("WARNING: --pack may be the client's own maps/ root, not a "
                             "community pack (%s). Root maps are Daybreak-authored and differ "
                             "from the pack on most zones. To use root files only for the "
                             "zones no pack has mapped, point --pack at the pack "
                             "subdirectory: the root is then picked up as a base layer "
                             "underneath it.\n" % w)
    # The other half of the same tree. root_layer looks UPWARDS from --pack, so a pack
    # installed as <install>/maps/<Pack> gets the client's own maps/ as a per-zone base layer
    # and anything else gets none - in which case every line below behaves exactly as it did
    # before layering existed.
    root = root_layer(pack)

    # Pass A -- index. Build the same global, first-wins name index the viewer gets from
    # DETAIL. Map-file contents are deliberately not read in this pass.
    index_entries = discovery_index_entries(pack, root, data, world)
    zone_index = mapgeom.zidx_from(index_entries)

    # Pass B -- detect globally. --only scopes which catalog entry is replaced, never the
    # first-wins index or the classification that assigned a candidate to a continent.
    roster_keys = []
    for cont in world["order"]:
        cdir = os.path.join(data, "continents", cont.replace(" ", "_").replace("'", ""))
        with open(os.path.join(cdir, "continent.json"), "r", encoding="utf-8") as f:
            meta = json.load(f)
        roster_keys.extend(meta["zoneOrder"])
        roster_keys.extend(meta.get("detailZones", []))
    accepted, rejected = detect_discoveries(
        pack, root, roster_keys, zone_index, include_targets=True)

    out_root = os.path.join(data, CACHE_DIRNAME)
    # A unique staging directory beside the target, not a fixed `.tmp` sibling: two runs in
    # the same tree would otherwise stage into the same path and corrupt each other, and a
    # crashed run would leave a stale one the next run silently adopts. Beside the target
    # rather than in the system temp so the promotion below is a rename, not a copy across
    # filesystems.
    parent = os.path.dirname(os.path.abspath(out_root)) or "."
    os.makedirs(parent, exist_ok=True)
    tmp_root = tempfile.mkdtemp(prefix=CACHE_DIRNAME + ".staging-", dir=parent)
    # A partial --only run must not lose the continents it is not touching.
    if only is not None and os.path.exists(out_root):
        shutil.rmtree(tmp_root)                      # copytree needs a non-existent target
        shutil.copytree(out_root, tmp_root)
    os.makedirs(tmp_root, exist_ok=True)

    manifest = {
        "schema": SCHEMA,
        "pack": os.path.abspath(pack),
        "packNote": "Community map pack; its traced geometry is not covered by the code license. See AGENTS.md.",
        # Load-bearing, not decoration: without it an empty rootZones list is ambiguous
        # between "no base layer existed" and "one existed and nothing needed it".
        "root": root,
        "warnings": warnings,
        "continents": {},
        "unknownRecords": {},
        "unseenColors": [],
    }
    manifest["discoveryRejected"] = rejected
    manifest["discoveryRejectedNote"] = (
        "Run-scoped like unknownRecords; an --only conversion may under-report the merged cache.")
    manifest["discoveredSourcesNote"] = (
        "Discovered inputs are separate from sources so sourceCount/sourceFingerprint keep "
        "describing the authored roster files. Their own count and fingerprint are checked "
        "independently across both the Python and browser conversion paths.")
    if root:
        manifest["rootNote"] = (
            "Base layer: the client's own maps/ root, used per zone where no pack file exists. "
            "Daybreak-authored - a DIFFERENT regime from the pack. sources[].from names which "
            "of the two layers each file came from. See AGENTS.md.")
    if only is not None and os.path.exists(os.path.join(out_root, "manifest.json")):
        with open(os.path.join(out_root, "manifest.json"), "r", encoding="utf-8") as f:
            manifest["continents"] = json.load(f).get("continents", {})

    unseen_all, collisions, baseless_all = [], [], []
    for cont in order:
        cdir = os.path.join(data, "continents", cont.replace(" ", "_").replace("'", ""))
        with open(os.path.join(cdir, "continent.json"), "r", encoding="utf-8") as f:
            meta = json.load(f)

        parsed, sources = {}, {}
        root_zones, baseless, skipped = [], [], []
        roster = list(meta["zoneOrder"])
        for zk in meta.get("detailZones", []):
            if zk not in roster:
                roster.append(zk)
        for zk in roster:
            # ONE directory per zone, chosen before a byte is read. That is what makes a zone
            # assembled from two sources unrepresentable rather than merely untested - a
            # per-layer preference would superimpose two tracings of the same room.
            srcdir, src = resolve_zone_source(pack, root, zk)
            if srcdir is None:
                skipped.append(zk)
                continue
            recs, unknown = parse_zone(srcdir, zk)
            if not recs:
                # Files present, not one L or P line among them. Deliberately NOT a
                # fall-through to the other layer: a blank or comment-only file is a broken
                # pack rather than a coverage gap, and falling through would reintroduce
                # cross-source mixing through the back door.
                raise SystemExit(
                    "no usable map records for zone %r (continent %s): the %s layer has %s "
                    "but not one L or P line. Looked in %s"
                    % (zk, cont, src,
                       ", ".join(os.path.basename(p) for p in zone_files(srcdir, zk)),
                       srcdir))
            parsed[zk] = recs
            if src == "root":
                root_zones.append(zk)
            if not os.path.exists(os.path.join(srcdir, zk + ".txt")):
                # Cascade rules 3/4 only: the resolved directory annotates this zone but never
                # mapped it, so its continent geometry - the base layer alone - comes out
                # empty, and validate_cache accepts that because the file exists. Recorded
                # per-continent so a test can assert it rather than a human noticing a NOTE.
                baseless.append(zk)
            for k, n in unknown.items():
                manifest["unknownRecords"][k] = manifest["unknownRecords"].get(k, 0) + n
            for p in zone_files(srcdir, zk):
                # `from` names the LAYER, not the licensing regime. "pack" means "the directory
                # --pack named", which is a community pack in every supported invocation but is
                # the client's own root if a user points --pack straight at maps/. Only the
                # "root" layer is KNOWN to be Daybreak-authored; read the pack layer's regime
                # from `pack` plus `warnings`. See docs/reference/pack-import.md.
                sources[os.path.basename(p)] = {"bytes": os.path.getsize(p),
                                                "sha256": sha256_of(p),
                                                "from": src}

        # Palette: first-seen over detailZones x layers x L and P records, in file order.
        # detailZones, NOT zoneOrder - they differ on Odus, both give a 37-entry palette,
        # and only detailZones puts the right colour at each index. A zoneOrder traversal
        # permutes the tail with no length error to notice it by.
        pal_index, pal_rgb = {}, []
        for zk in meta.get("detailZones", []):
            if zk not in parsed:
                continue
            for layer, kind, rec, name, lineno in parsed[zk]:
                rgb = rec[1]
                if rgb not in pal_index:
                    pal_index[rgb] = len(pal_rgb)
                    pal_rgb.append(rgb)
        unseen = []
        palette = [pack_colors.color_for(rgb, unseen) for rgb in pal_rgb]
        unseen_all += unseen

        # Pack-derived colours keep their first-seen indices. An authored label that survives
        # (because the chosen source does not carry the same text) may need a display colour the
        # source never used; append it after the traced palette so composition stays lossless
        # without renumbering any generated segment or label.
        for zk in meta.get("detailZones", []):
            if zk not in parsed:
                continue
            traced = {lab[4] for lab in detail_records(parsed[zk])[3]}
            for lab in ((meta.get("zones") or {}).get(zk, {}).get("labels") or []):
                if lab[4] not in traced and lab[2] not in palette:
                    palette.append(lab[2])

        cout = os.path.join(tmp_root, "continents", cont.replace(" ", "_").replace("'", ""))
        os.makedirs(os.path.join(cout, "geometry"), exist_ok=True)
        os.makedirs(os.path.join(cout, "detail"), exist_ok=True)
        dump_compact(palette, os.path.join(cout, "palette.json"))

        for zk in meta["zoneOrder"]:
            if zk not in parsed:
                continue
            recs = parsed[zk]
            segs, segz = geometry_records(recs, offset_for(cont, meta, zk))
            dump_compact({"segs": segs, "segz": segz},
                         os.path.join(cout, "geometry", zk + ".json"))

        for zk in meta.get("detailZones", []):
            if zk not in parsed:
                continue
            segs, segz, seglayer, labels, lablayer, raw = detail_records(parsed[zk])
            for s in segs:
                s[4] = pal_index[s[4]]
            for l in labels:
                l[2] = pal_index[l[2]]
            dump_compact({"segs": segs, "segz": segz, "seglayer": seglayer,
                          "labels": labels, "lablayer": lablayer,
                          "bbox": bbox_of(raw[0], raw[1])},
                         os.path.join(cout, "detail", zk + ".json"))
            # An authored label this pack turns out to supply itself. compose_detail drops the
            # authored copy (pack wins); recording it here is what stops that being silent, and
            # is the signal that the authored entry may no longer be needed. Whether it IS
            # needed depends on the pack, so this reports rather than prescribes.
            traced = {l[4] for l in labels}
            for lab in ((meta.get("zones") or {}).get(zk, {}).get("labels") or []):
                if lab[4] in traced:
                    collisions.append("%s/%s: %s" % (cont, zk, lab[4]))

        discovered, discovered_sources, discovered_palette = [], {}, []
        if accepted.get(cont):
            discovered, discovered_sources, discovered_palette = assemble_discoveries(
                cont, accepted[cont], pack, root, parsed, meta, zone_index,
                cout, palette, unseen_all)

        # Anything that must survive an --only run lives HERE, under continents[cont], because
        # the --only seed copies only `continents`. That is why from/rootZones/baselessZones
        # are per-continent rather than top-level: the per-run unknownRecords already
        # under-reports on such a run, and a provenance record that did the same would report
        # "nothing from the root layer" about a cache that has some.
        manifest["continents"][cont] = {
            "zones": roster,
            "paletteSize": len(palette),
            "discovery": True,
            "rootZones": root_zones,
            "baselessZones": baseless,
            "skippedZones": skipped,
            "sources": sources,
        }
        manifest["continents"][cont]["discovered"] = discovered
        if discovered:
            manifest["continents"][cont]["discoveredPalette"] = discovered_palette
            manifest["continents"][cont]["discoveredSources"] = discovered_sources
            dcount, dfingerprint = _source_identity(discovered_sources)
            manifest["continents"][cont]["discoveredSourceCount"] = dcount
            manifest["continents"][cont]["discoveredSourceFingerprint"] = dfingerprint
        baseless_all += ["%s/%s" % (cont, zk) for zk in baseless]
        if not quiet:
            detail_written = sum(zk in parsed for zk in meta.get("detailZones", []))
            print("  %-16s %2d zones, %2d detail, palette %d"
                  % (cont, len(parsed), detail_written,
                     len(palette)))

    skipped_run = [(cont, list(manifest["continents"][cont].get("skippedZones", [])))
                   for cont in order
                   if manifest["continents"][cont].get("skippedZones")]
    skipped_all = ["%s/%s" % (cont, zk) for cont, zones in skipped_run for zk in zones]

    if not quiet:
        # Gated on the ZONE LIST, never on top-level manifest["root"], and getting that
        # backwards creates a false negative --only can reach: an --only run whose --pack sits
        # outside maps/ sets root to null while untouched continents still carry rootZones, so
        # a root-gated summary would report "nothing from the root layer" about a cache that
        # has some. Printed from convert() rather than main() because build.py's ensure_cache()
        # calls convert() directly, and a user's first build must see this.
        rz = root_layer_zones(manifest, world["order"])
        if rz:
            print("  %d zone%s from the root layer: %s"
                  % (len(rz), "" if len(rz) == 1 else "s",
                     ", ".join("%s (%s)" % (zk, cont) for cont, zk in rz)))
        elif root:
            print("  no zones from the root layer (base layer: %s)" % root)
        for cont, zones in skipped_run:
            print("  %d skipped zone%s in %s: %s"
                  % (len(zones), "" if len(zones) == 1 else "s", cont,
                     ", ".join(zones)))

    manifest["unseenColors"] = sorted(set(unseen_all))
    manifest["authoredLabelCollisions"] = sorted(set(collisions))
    # Identify the pack by WHAT IT CONTAINS, not by where it lives. The same path can hold a
    # different revision and the same pack can sit at different paths, so the path is a hint
    # for a human and the digest is the identity. Over sorted (filename, sha256) pairs, so it
    # is stable across filesystems and reproducible from the manifest alone.
    #
    # sources[].from is DELIBERATELY excluded, and this is not an oversight to tidy up:
    # identical bytes from two directories produce identical geometry, so every geometric
    # claim printed beside this digest holds either way. The provenance record is
    # sources[].from itself, and the pair (sourceFingerprint, rootZones) already answers
    # "same content, different provenance".
    srcs = sorted((n, s["sha256"]) for c in manifest["continents"].values()
                  for n, s in c["sources"].items())
    h = hashlib.sha256()
    for n, s in srcs:
        h.update(("%s %s\n" % (n, s)).encode("utf-8"))
    manifest["sourceCount"] = len(srcs)
    manifest["sourceFingerprint"] = h.hexdigest()
    if manifest["unseenColors"]:
        sys.stderr.write("NOTE: %d pack colour(s) not in scripts/pack_colors.py; approximated "
                         "by lift(). See the manifest.\n" % len(manifest["unseenColors"]))
    if collisions:
        sys.stderr.write("NOTE: this pack supplies %d label(s) that continent.json also "
                         "authors; the pack's copy wins and the authored one is unused: %s\n"
                         % (len(collisions), ", ".join(collisions)))
    if baseless_all:
        sys.stderr.write("NOTE: %d zone(s) resolved to a directory that annotates them but "
                         "carries no base <zone>.txt, so their continent geometry is empty and "
                         "they will render as nothing: %s\n"
                         % (len(baseless_all), ", ".join(baseless_all)))
    if skipped_all:
        sys.stderr.write("NOTE: %d rostered zone(s) had no map file in either layer and were "
                         "skipped: %s\n" % (len(skipped_all), ", ".join(skipped_all)))
        if root is None:
            sys.stderr.write(
                "HINT: A community map pack installed under the game's maps/ directory can "
                "supply the missing zones. Point --pack at its subdirectory to use the "
                "client's maps/ root underneath it. Packs: https://www.eqmaps.info/\n")
        else:
            sys.stderr.write(
                "HINT: These zones are in neither the community pack nor the client's maps/ "
                "root; a different or additional community map pack may supply them.\n")
    with open(os.path.join(tmp_root, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=1, sort_keys=True)
        f.write("\n")

    promote(tmp_root, out_root)
    return manifest


def validate_cache(data=None, world=None):
    """True when the cache is present, current-schema, and its roster matches the authored one.

    Staleness against the PACK is deliberately not detected - an explicit re-run refreshes, and
    the manifest hashes let a future --audit report drift. A build that silently reconverted
    would be the "a cosmetic change moves data without anyone deciding it should" failure this
    repo rules against everywhere else.
    """
    data = data or DATA
    mpath = os.path.join(data, CACHE_DIRNAME, "manifest.json")
    if not os.path.exists(mpath):
        return False, "no cache at " + os.path.join(data, CACHE_DIRNAME)
    try:
        with open(mpath, "r", encoding="utf-8") as f:
            man = json.load(f)
    except ValueError as exc:
        return False, "unreadable manifest: %s" % exc
    if man.get("schema") != SCHEMA:
        return False, "cache schema %r, expected %r" % (man.get("schema"), SCHEMA)
    if world is None:
        with open(os.path.join(data, "world.json"), "r", encoding="utf-8") as f:
            world = json.load(f)
    metas = {}
    authored_keys = set()
    for cont in world["order"]:
        cdir = os.path.join(data, "continents", cont.replace(" ", "_").replace("'", ""))
        with open(os.path.join(cdir, "continent.json"), "r", encoding="utf-8") as f:
            metas[cont] = json.load(f)
        authored_keys.update(zk.casefold() for zk in metas[cont]["zoneOrder"])
        authored_keys.update(zk.casefold() for zk in metas[cont].get("detailZones", []))
    for cont in world["order"]:
        entry = man.get("continents", {}).get(cont)
        if entry is None:
            return False, "cache has no continent %r" % cont
        if entry.get("discovery") is not True:
            return False, "cache discovery catalog for %r is absent or disabled" % cont
        meta = metas[cont]
        want = list(meta["zoneOrder"])
        for zk in meta.get("detailZones", []):
            if zk not in want:
                want.append(zk)
        if entry.get("zones") != want:
            return False, "cache zone roster for %r does not match continent.json" % cont
        raw_skipped = entry.get("skippedZones", [])
        if not isinstance(raw_skipped, list) or not all(
                isinstance(zk, str) for zk in raw_skipped):
            return False, "cache skippedZones for %r is not a list of strings" % cont
        if len(set(raw_skipped)) != len(raw_skipped):
            return False, "cache skippedZones for %r contains duplicates" % cont
        outside = [zk for zk in raw_skipped if zk not in want]
        if outside:
            return False, ("cache skippedZones for %r names zones outside the authored roster: %s"
                           % (cont, ", ".join(outside)))
        skipped = set(raw_skipped)
        # A matching roster is not enough: a zone with no usable offset is listed in the
        # roster and yet has no geometry written for it. Without this check the miss
        # surfaces later as a FileNotFoundError from inside build()'s composition loop,
        # instead of the one message that says which command fixes it.
        gdir = os.path.join(data, CACHE_DIRNAME, "continents",
                            cont.replace(" ", "_").replace("'", ""))
        azones = authored_zones(meta)
        for zk in meta["zoneOrder"]:
            # The authored half, checked here for the same reason as the cached half: adding a
            # zone means touching zoneOrder, placed AND zones, and missing the last one would
            # otherwise surface as a bare KeyError from inside build()'s composition loop.
            az = azones.get(zk)
            missing = [k for k in ("name", "color", "cx", "cy", "off")
                       if not az or az.get(k) is None]
            if missing:
                return False, ("continent.json for %s has no complete zones entry for %r "
                               "(missing %s). See: python scripts/import_pack.py "
                               "--print-authored %s" % (cont, zk, ", ".join(missing), cont))
            if (zk not in skipped and
                    not os.path.exists(os.path.join(gdir, "geometry", zk + ".json"))):
                return False, "cache is missing geometry for %s/%s" % (cont, zk)
        for zk in meta.get("detailZones", []):
            if (zk not in skipped and
                    not os.path.exists(os.path.join(gdir, "detail", zk + ".json"))):
                return False, "cache is missing detail for %s/%s" % (cont, zk)

        discovered = entry.get("discovered", [])
        if not isinstance(discovered, list):
            return False, "cache discovered catalog for %r is not a list" % cont
        keys = []
        names = []
        required = {"key": str, "name": str, "nameFrom": str, "color": str,
                    "cx": int, "cy": int, "off": list, "anchor": str,
                    "from": str, "edges": list}
        for record in discovered:
            if not isinstance(record, dict):
                return False, "cache discovered record for %r is not an object" % cont
            for field, kind in required.items():
                value = record.get(field)
                if (not isinstance(value, kind) or
                        (kind is int and isinstance(value, bool))):
                    return False, ("cache discovered record for %r has missing or invalid %s"
                                   % (cont, field))
            key = record["key"]
            if key != key.casefold():
                return False, "cache discovered key %r is not case-folded" % key
            if key.casefold() in authored_keys:
                return False, "cache discovered key %r collides with the authored roster" % key
            keys.append(key)
            names.append(mapgeom.znorm(record["name"]))
            for kind in ("geometry", "detail"):
                if not os.path.exists(os.path.join(gdir, kind, key + ".json")):
                    return False, "cache is missing discovered %s for %s/%s" % (kind, cont, key)
            if record["nameFrom"] not in ("marker", "key"):
                return False, "cache discovered nameFrom for %r is invalid" % key
            if record["from"] not in ("pack", "root"):
                return False, "cache discovered source for %r is invalid" % key
            if (len(record["off"]) != 2 or
                    any(isinstance(v, bool) or not isinstance(v, (int, float)) or
                        not math.isfinite(v) for v in record["off"])):
                return False, "cache discovered off for %r is not a finite pair" % key
            if any(abs(record[field]) > JS_SAFE_INTEGER for field in ("cx", "cy")):
                return False, "cache discovered centroid for %r exceeds JS safe range" % key
            edges = record["edges"]
            if not edges:
                return False, "cache discovered edges for %r is empty" % key
            edge_keys = []
            allowed = set(want)
            allowed.update(r.get("key") for r in discovered if isinstance(r, dict))
            for edge in edges:
                if not isinstance(edge, dict) or not isinstance(edge.get("z"), str):
                    return False, "cache discovered edge for %r has missing or invalid fields" % key
                neighbour = edge["z"]
                edge_keys.append(neighbour)
                if neighbour not in allowed:
                    return False, ("cache discovered edge for %r leaves continent %r"
                                   % (key, cont))
                if edge.get("named") not in ("both", "candidate", "neighbour"):
                    return False, "cache discovered edge named value for %r is invalid" % key
                cost = edge.get("cost")
                if (isinstance(cost, bool) or not isinstance(cost, (int, float)) or
                        not math.isfinite(cost) or cost <= 0):
                    return False, "cache discovered edge cost for %r is not finite and positive" % key
                if ((isinstance(cost, float) and
                     (cost.is_integer() or (0 < abs(cost) < 1e-4))) or
                        (isinstance(cost, int) and abs(cost) > JS_SAFE_INTEGER)):
                    return False, "cache discovered edge cost for %r is not JS-canonical" % key
            if len(set(edge_keys)) != len(edge_keys):
                return False, "cache discovered edges for %r contain duplicate zones" % key
            if record["anchor"] not in edge_keys:
                return False, "cache discovered anchor for %r is not among its edges" % key
        if len(set(keys)) != len(keys):
            return False, "cache discovered catalog for %r contains duplicate keys" % cont
        if len(set(names)) != len(names):
            return False, "cache discovered catalog for %r contains duplicate normalized names" % cont
    return True, "ok"


# --------------------------------------------------------------------------- composition
# The authored half and the cached half are joined here, in ONE place, because the key order
# of what comes out is load-bearing - verify.py datacmp compares order-sensitively, so a
# correct-but-reordered composition reports DIFF on every continent and reads as corruption.
# build.py and derive_travel_graph.py both call these rather than keeping their own copy.
def compose_zone(az, cache_geom, xf=None):
    """The legacy ALL[cont].zones[zk] record: authored identity + regenerated trace."""
    z = {"name": az["name"], "segs": cache_geom["segs"],
         "cx": az["cx"], "cy": az["cy"], "color": az["color"]}
    if xf is not None:
        z["xf"] = xf              # appended last, as the pre-split files had it
    return z


def compose_detail(az, cache_detail, palette):
    """The legacy DETAIL[cont].zones[zk] record.

    Composes the LEGACY KEYS ONLY - the cache also carries segz/seglayer/lablayer, which the
    viewer has no use for and which must never reach the injected data.

    `az["labels"]` is the escape hatch for a label that is authored rather than traced, and it
    exists for one measured reason: Ocean of Tears' two `to_` markers were hand-written into
    the old committed detail file, not imported. The proof is ordering - they sat AFTER the
    `_2` attribution block, and the import concatenates base/_1/_2/_3 in that order, so nothing
    from the pack can follow the credits. They also reused an existing palette slot and carried
    size 3 where every imported label in that zone is size 2. So this is not pack data being
    smuggled back under version control; it is authored data being moved to the layer it always
    belonged in, the same argument that promoted name/color/cx/cy.

    The colour is authored as a HEX, never as a palette index: indices are assigned during
    conversion and shift when a pack changes, so a stored index silently recolours. A hex the
    palette does not contain is a hard error rather than a guess.
    """
    labels = list(cache_detail["labels"])
    traced = {l[4] for l in cache_detail["labels"]}
    for lab in (az.get("labels") or []):
        x, y, color, size, text = lab
        # The narrowing that keeps this from becoming a general "put generated content back
        # under version control" hatch: an authored label may only supply what the pack does
        # not carry, and THE PACK ALWAYS WINS on a collision.
        #
        # Skipped, not an error, and that is a multi-pack requirement rather than leniency:
        # whether a pack supplies a given label varies BY PACK. Ocean of Tears is the live
        # case - Brewall's oot_1.txt has no transition markers so the label is authored, while
        # the pack's own `oceanoftears` variant does carry that connection. Erroring would turn
        # a richer pack into a build failure for whoever installed it. convert() records every
        # collision in the manifest with a counted notice, so this is reported, never silent.
        if text in traced:
            continue
        if color not in palette:
            raise SystemExit(
                "authored label %r on zone %r wants colour %s, which this pack's palette does "
                "not contain. Pick one of the palette's colours, or drop the label."
                % (text, az.get("name"), color))
        labels.append([x, y, palette.index(color), size, text])
    return {"name": az["name"], "segs": cache_detail["segs"],
            "labels": labels, "bbox": cache_detail["bbox"]}


# --------------------------------------------------------------------------- authoring aid
def print_authored(pack, data, cont):
    """Print the continent.json `zones` block, filling gaps with pack-derived candidates.

    The converter never *writes* authored values - it proposes, a human disposes. Existing
    zones echo what is already authored; a zone in zoneOrder with no `zones` entry gets the
    numbers needed to author one, in the PACK's own frame:

        trace   the endpoint mean and bbox of the trace, before any offset
        off     null, because placement is a decision and not derivable. Choose it, then
                cx/cy is trace-mean + off.

    This is the only supported route for adding a zone: the offset used to be recoverable
    from the committed geometry, but that geometry is no longer in the tree.
    """
    cdir = os.path.join(data, "continents", cont.replace(" ", "_").replace("'", ""))
    with open(os.path.join(cdir, "continent.json"), "r", encoding="utf-8") as f:
        meta = json.load(f)
    authored = authored_zones(meta)
    root = root_layer(pack)
    out, todo = {}, []
    for zk in meta["zoneOrder"]:
        az = authored.get(zk)
        if az and az.get("off") is not None:
            out[zk] = az
            continue
        todo.append(zk)
        # The same per-zone resolution convert() uses, and this is what keeps layering from
        # breaking the repo's documented add-a-zone path. The zones that reach here are exactly
        # the ones being authored, which is exactly where a root-only zone shows up first - and
        # parsing those from the PACK yields no base records at all, so the trace mean below
        # would divide by zero and say nothing about why.
        srcdir, _src = resolve_zone_source(pack, root, zk)
        if srcdir is None:
            raise SystemExit(
                "%s/%s: no map files in either layer, so there is no trace to propose a "
                "placement from. Neither the pack nor the base layer has %s."
                % (cont, zk, zk + ".txt"))
        recs, _ = parse_zone(srcdir, zk)
        base = [rec[0] for layer, kind, rec, n, ln in recs if layer == 0 and kind == "L"]
        xs = [n[0] for n in base] + [n[3] for n in base]
        ys = [-n[1] for n in base] + [-n[4] for n in base]
        out[zk] = {
            "name": zk, "color": "#5fb95f",
            "trace": {"mean": [_r(sum(xs) / len(xs)), _r(sum(ys) / len(ys))],
                      "bbox": [min(xs), min(ys), max(xs), max(ys)]},
            "off": None,
        }
    print(json.dumps({"zones": out}, indent=2))
    if todo:
        sys.stderr.write(
            "\n%d zone(s) need authoring: %s\n"
            "Pick an `off` for each, set cx/cy = trace.mean + off, give it a name and colour,\n"
            "then delete the `trace` block - it is guidance, not a field build.py reads.\n"
            % (len(todo), ", ".join(todo)))


def main():
    ap = argparse.ArgumentParser(description="Convert a map pack into data/_generated/.")
    ap.add_argument("--pack", default=None, help="map-pack directory")
    ap.add_argument("--data", default=None, help="data root (default: the repo's data/)")
    ap.add_argument("--only", default=None,
                    help="convert one continent (whole-continent minimum: the palette is "
                         "continent-scoped and index assignment is first-seen)")
    ap.add_argument("--print-authored", default=None, metavar="CONTINENT",
                    help="print the continent.json 'zones' block instead of converting")
    args = ap.parse_args()

    data = os.path.abspath(os.path.expanduser(args.data)) if args.data else DATA
    pack = args.pack
    if not pack:
        cfg = os.path.join(data, "pack.local.json")
        if os.path.exists(cfg):
            with open(cfg, "r", encoding="utf-8") as f:
                pack = json.load(f).get("pack")
    if not pack:
        raise SystemExit(
            "no map pack. Pass --pack DIR, or run 'python scripts/build.py --pack DIR' once to\n"
            "remember it in data/pack.local.json. A community pack subdirectory, such as\n"
            "<install>/maps/Brewall, supplies broad coverage and uses the client's maps/ root as\n"
            "a fallback. The maps/ root itself is also supported for the zones it contains.")
    if not os.path.isdir(pack):
        raise SystemExit("--pack: not a directory: " + pack)

    if args.print_authored:
        print_authored(pack, data, args.print_authored)
        return

    print("Converting %s -> %s" % (pack, os.path.join(data, CACHE_DIRNAME)))
    manifest = convert(pack, data, args.only)
    nz = sum(len(c["zones"]) - len(c.get("skippedZones", []))
             for c in manifest["continents"].values())
    print("Wrote %d continents, %d zones" % (len(manifest["continents"]), nz))


if __name__ == "__main__":
    main()
