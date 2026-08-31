#!/usr/bin/env python3
"""
Build the Norrath interactive map from the data/ tree + src/template.html.

Reassembles the eight data structures the viewer expects
(ALL, META, DETAIL, HUBS, UNIVERSE, WORLDLINKS, TRAVEL, XPACS) from the split
per-zone / per-continent files, passes through any zone transforms (zoneXf)
recorded in layout.json - these are applied at render time by the viewer, not
baked here - injects them into the template, and writes the finished
single-file HTML.

TRAVEL is the one structure with no per-continent assembly: data/travel.json is
authored by hand and copied through verbatim.

One template, two editions (see --edition): marker-delimited regions in
src/template.html are stripped so the same source yields either the end-user
map (bounded customization, no repo-authoring surface) or the full author
build.

Usage:
    python scripts/build.py                    # -> dist/eql-interactive-map.html
    python scripts/build.py --edition author   # -> dist/eql-interactive-map.author.html
    python scripts/build.py --out PATH         # write somewhere else (e.g. your game dir)
    python scripts/build.py --data DIR         # read a different data tree
    python scripts/build.py --pack DIR         # remember a map-pack path (see resolve_pack)

No third-party dependencies (Python 3 standard library only).
"""
import argparse
import json
import math
import os
import re
import sys
from html import escape as html_escape

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import import_pack                                              # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")
TEMPLATE = os.path.join(ROOT, "src", "template.html")
VERSION_FILE = os.path.join(ROOT, "VERSION")

# Where --pack is remembered, relative to the data root. Matched by .gitignore's *.local.*
# at any depth, so a machine-specific path can never be committed.
PACK_CONFIG = "pack.local.json"
DEFAULT_OUT = {
    "user":   os.path.join(ROOT, "dist", "eql-interactive-map.html"),
    "author": os.path.join(ROOT, "dist", "eql-interactive-map.author.html"),
}

# Edition markers. Each kind is delimited in both comment syntaxes so a region
# can wrap JS or markup: /*__AUTHOR__*/ ... /*__END_AUTHOR__*/ and
# <!--__AUTHOR__--> ... <!--__END_AUTHOR__-->.
MARKER_STYLES = (("/*__%s__*/", "/*__END_%s__*/"),
                 ("<!--__%s__-->", "<!--__END_%s__-->"))
KINDS = ("AUTHOR", "USER")

# Sentinels bracketing the injected data blocks. exportStandaloneHTML() splices
# between them, so they must survive in the author edition; the user edition has
# no standalone export, so they are removed as dead weight.
DATA_SENTINELS = ("/*__DATA_ALL__*/", "/*__END_ALL__*/",
                  "/*__DATA_HUBS__*/", "/*__END_HUBS__*/",
                  "/*__DATA_WL__*/", "/*__END_WL__*/",
                  "/*__DATA_UNI__*/", "/*__END_UNI__*/")

# Declarations that must survive stripping in every edition. A mis-paired marker
# that swallowed the file body would still pass the "no marker token left" check,
# so assert the payload is intact too.
LOAD_CRITICAL = ("const ALL=", "const HUBS=", "const UNIVERSE=", "const WORLDLINKS=",
                 "const TRAVEL=", "const XPACS=")
JS_SAFE_INTEGER = (1 << 53) - 1


def _canon_int(s):
    """Reject integers whose exact value JavaScript cannot safely preserve."""
    v = int(s)
    if abs(v) > JS_SAFE_INTEGER:
        raise SystemExit("non-canonical JSON integer %s exceeds JS safe range" % s)
    return v


def _canon_float(s):
    """JS-canonical numbers: JSON is JavaScript here, so integral floats are ints."""
    v = float(s)
    if not math.isfinite(v):
        raise SystemExit("non-canonical JSON float %s is not finite" % s)
    if v and abs(v) < 1e-4:
        raise SystemExit("non-canonical JSON float %s is below 1e-4" % s)
    if v == int(v):
        if abs(v) > JS_SAFE_INTEGER:
            raise SystemExit(
                "non-canonical JSON float %s has integral value outside JS safe range" % s)
        return int(v)
    return v


def _reject_constant(s):
    """Python accepts these extensions, but JSON.parse and the browser twin do not."""
    raise SystemExit("non-canonical JSON constant %s is not valid JSON" % s)


def load(path):
    with open(path, "r", encoding="utf-8") as f:
        try:
            return json.load(f, parse_int=_canon_int, parse_float=_canon_float,
                             parse_constant=_reject_constant)
        except SystemExit as e:
            raise SystemExit("%s: %s" % (path, e)) from None


def load_manifest(data):
    """Read manifest metadata without applying the injected-data number dialect.

    Catalog ``off`` values are audit metadata and may legitimately be smaller than the lower
    bound enforced for numbers that reach JavaScript.  Geometry, detail, and palette files keep
    using ``load()`` above; widening this reader would disarm their canonical-number guard.
    """
    path = os.path.join(data, import_pack.CACHE_DIRNAME, "manifest.json")
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def read_version(path=VERSION_FILE):
    """Read the one-line, raw-substitution-safe release version."""
    with open(path, "r", encoding="ascii") as f:
        version = f.read().strip()
    if not version:
        raise SystemExit("%s: version is empty" % path)
    if not re.fullmatch(r"[0-9A-Za-z][0-9A-Za-z.+-]*", version):
        raise SystemExit("%s: version must use only ASCII letters, digits, dot, plus, or hyphen" % path)
    return version


def cred_text(data):
    """Describe the selected pack and any zones supplied by the game's own maps."""
    manifest = load_manifest(data)
    pack_name = os.path.basename(os.path.normpath(manifest["pack"]))
    root_count = sum(len(c.get("rootZones", []))
                     for c in manifest.get("continents", {}).values())
    root_count += sum(
        1 for entry in manifest.get("continents", {}).values()
        for record in entry.get("discovered", []) if record.get("from") == "root")
    # Canonical format for the browser twin, including separators:
    #   root: EQL · selected maps folder
    #   pack: EQL · <name> map data[ · N zone(s) from the game's own maps]
    if pack_name.casefold() == "maps":
        text = "EQL · selected maps folder"
    else:
        text = "EQL · %s map data" % pack_name
    if root_count:
        text += " · %d zone%s from the game's own maps" % (
            root_count, "" if root_count == 1 else "s")
    return text


def replace_placeholders(template, replacements):
    """Replace only placeholders present in template, never text inserted by a value."""
    for ph in replacements:
        if ph not in template:
            raise SystemExit("template missing placeholder " + ph)
    # Longest first keeps a future __ALL__EXTRA__ distinct from its __ALL__ prefix.
    placeholders = sorted(replacements, key=len, reverse=True)
    pattern = re.compile("|".join(re.escape(ph) for ph in placeholders))
    return pattern.sub(lambda match: replacements[match.group(0)], template)


def cont_dir(cont, data=None):
    return os.path.join(data or DATA, "continents",
                        cont.replace(" ", "_").replace("'", ""))


def resolve_pack(data, pack=None):
    """Resolve the map-pack directory: an explicit --pack wins and is remembered.

    Returns the path, or None when neither a flag nor a remembered path is available.
    Nothing here reads the pack - the converter does. Persisting the path is the whole
    job, so that a first build with --pack leaves later ones needing no flag.
    """
    cfg = os.path.join(data, PACK_CONFIG)
    if pack:
        pack = os.path.abspath(os.path.expanduser(pack))
        if not os.path.isdir(pack):
            raise SystemExit("--pack: not a directory: " + pack)
        with open(cfg, "w", encoding="utf-8") as f:
            json.dump({"pack": pack}, f, indent=2)
            f.write("\n")
        return pack
    if os.path.exists(cfg):
        # A remembered path is checked too, not just the flag. It goes stale on its own -
        # the game gets reinstalled, a drive letter changes, the checkout moves machines -
        # and without this the failure is a raw FileNotFoundError from inside the pack
        # scanner, which reads as a converter bug rather than a path to fix.
        remembered = load(cfg).get("pack") or None
        if remembered and not os.path.isdir(remembered):
            raise SystemExit(
                "the remembered map pack is gone: %s\n"
                "It was recorded in %s. Point the build at the pack again:\n"
                "    python scripts/build.py --pack <path to the pack>\n"
                "or delete that file to start over." % (remembered, cfg))
        return remembered
    return None


def is_identity(xf):
    """True when a zoneXf entry is absent or a no-op (nothing to render-transform)."""
    return not xf or (xf.get("tx", 0) == 0 and xf.get("ty", 0) == 0
                      and xf.get("s", 1) == 1 and xf.get("rot", 0) == 0)


def _walk_markers(text, kind, drop_body):
    """Resolve one marker kind: delete each region's body (drop_body) or just its markers.

    Non-greedy by construction - each opener pairs with the FIRST closer after it,
    so a greedy match can never swallow the file body. Unbalanced markers in
    either direction raise SystemExit, matching the missing-placeholder posture.
    """
    for open_fmt, close_fmt in MARKER_STYLES:
        o, c = open_fmt % kind, close_fmt % kind
        out, i = [], 0
        while True:
            a, b = text.find(o, i), text.find(c, i)
            if a < 0 and b < 0:
                out.append(text[i:])
                break
            if b >= 0 and (a < 0 or b < a):
                raise SystemExit("template: %s with no matching %s" % (c, o))
            b = text.find(c, a + len(o))
            if b < 0:
                raise SystemExit("template: %s with no matching %s" % (o, c))
            out.append(text[i:a])
            if not drop_body:
                out.append(text[a + len(o):b])
            i = b + len(c)
        text = "".join(out)
    return text


def strip_regions(text, edition):
    """Reduce the two-edition template to one edition, then assert the result is sane."""
    keep = "USER" if edition == "user" else "AUTHOR"
    for kind in KINDS:
        text = _walk_markers(text, kind, drop_body=(kind != keep))
    if edition == "user":
        for tok in DATA_SENTINELS:
            text = text.replace(tok, "")
    for kind in KINDS:
        for fmt in ("__%s__", "__END_%s__"):
            tok = fmt % kind
            if tok in text:
                raise SystemExit("template: %s survived stripping for edition %s"
                                 % (tok, edition))
    for need in LOAD_CRITICAL:
        if need not in text:
            raise SystemExit("template: %r was stripped away - check marker pairing "
                             "for edition %s" % (need, edition))
    return text


def ensure_cache(data, pack):
    """Convert when the cache is absent or invalid; otherwise leave it alone.

    Deliberately not staleness-aware: an out-of-date cache against an updated pack is NOT
    detected, because a build that silently reconverted would let a pack change move the
    injected data with nobody deciding it should. Re-run scripts/import_pack.py to refresh.
    """
    ok, why = import_pack.validate_cache(data)
    if ok:
        return
    if not pack:
        raise SystemExit(
            "cannot build: %s\n\n"
            "The traced map geometry is regenerated from a community map pack rather than\n"
            "committed, so a fresh clone needs one. Point the build at yours once:\n\n"
            "    python scripts/build.py --pack <path to the pack>\n\n"
            "and it is remembered in %s. A community pack subdirectory, such as\n"
            "<install>/maps/Brewall, supplies broad coverage and uses the client's maps/ root\n"
            "as a fallback. The maps/ root itself is also supported for the zones it contains.\n"
            "See README.md." % (why, os.path.join(data, PACK_CONFIG)))
    print("converting map pack (%s)" % why)
    import_pack.convert(pack, data)
    ok, why = import_pack.validate_cache(data)
    if not ok:
        raise SystemExit("conversion did not produce a usable cache: %s\n"
                         "Re-run: python scripts/import_pack.py --pack %s" % (why, pack))


def build(data=None):
    data = data or DATA
    world = load(os.path.join(data, "world.json"))
    META = world["meta"]
    order = world["order"]
    UNIVERSE = world.get("universe", [])       # realm selector entities (positions editable)
    WORLDLINKS = world.get("worldLinks", [])   # world-view free connectors, in globe coords
    # Expansion order, labels and the first-run default. Game facts, so they are authored rather
    # than hardcoded in the template; nothing at runtime mutates them.
    XPACS = world.get("xpacs", {})

    # The authored graph is the stable prefix.  Catalog edges already carry their conversion-time
    # costs; build only appends those records and never derives geometry or cost here.
    travel_path = os.path.join(data, "travel.json")
    TRAVEL = load(travel_path) if os.path.exists(travel_path) else {}

    ALL, DETAIL, HUBS = {}, {}, {}
    skips = import_pack.cache_skips(data)
    discoveries = import_pack.cache_discoveries(data)
    for cont in order:
        base = cont_dir(cont, data)
        gen = cont_dir(cont, os.path.join(data, import_pack.CACHE_DIRNAME))
        meta = load(os.path.join(base, "continent.json"))
        layout = load(os.path.join(base, "layout.json"))
        xfs = layout.get("zoneXf", {}) or {}

        # Each zone record is composed from the authored layer (name/colour/centroid, which
        # are frozen so a pack swap cannot move a travel cost) plus the regenerated trace.
        # import_pack owns the composition so this and derive_travel_graph cannot drift.
        azones = meta.get("zones") or {}
        zones = {}
        skipped = skips.get(cont, set())
        for zk in meta["zoneOrder"]:
            if zk in skipped:
                continue
            xf = xfs.get(zk)          # passed through; viewer applies it at render time
            zones[zk] = import_pack.compose_zone(
                azones[zk], load(os.path.join(gen, "geometry", zk + ".json")),
                None if is_identity(xf) else xf)
        catalog = discoveries.get(cont, {"zones": [], "palette": []})
        for record in catalog["zones"]:
            az = {field: record[field] for field in ("name", "color", "cx", "cy")}
            zones[record["key"]] = import_pack.compose_zone(
                az, load(os.path.join(gen, "geometry", record["key"] + ".json")), None)

        # bbox is always the stored continent bbox; the viewer computes a live
        # fit-bbox from transformed segs when a continent has any non-identity xf.
        entry = {"zones": zones}
        skipped_ordered = [zk for zk in meta["zoneOrder"] if zk in skipped]
        if skipped_ordered:
            entry["skipped"] = skipped_ordered
        if meta.get("labels") is not None:      # continent-level extra labels (oceans, planes)
            entry["labels"] = meta["labels"]
        entry["bbox"] = meta["bbox"]
        entry["connectors"] = layout.get("connectors", [])
        links = [link for link in layout.get("links", [])
                 if link["z1"] not in skipped and link["z2"] not in skipped]
        if links:                               # round-trip lock state; omitted when empty
            entry["links"] = links
        entry["placed"] = meta.get("placed", [])
        entry["unplaced"] = meta.get("unplaced", [])
        ALL[cont] = entry

        # The palette is pack-derived (indices are assigned during conversion), so it lives in
        # the cache rather than the authored layer.
        palette = load(os.path.join(gen, "palette.json")) + catalog["palette"]
        dz = {}
        for zk in meta.get("detailZones", []):
            if zk in skipped:
                continue
            dz[zk] = import_pack.compose_detail(
                azones[zk], load(os.path.join(gen, "detail", zk + ".json")), palette)
        for record in catalog["zones"]:
            az = {field: record[field] for field in ("name", "color", "cx", "cy")}
            dz[record["key"]] = import_pack.compose_detail(
                az, load(os.path.join(gen, "detail", record["key"] + ".json")), palette)
        if palette or dz:
            DETAIL[cont] = {"palette": palette, "zones": dz}

        hubs = layout.get("hubs", [])
        if hubs and zones:
            HUBS[cont] = hubs

    if TRAVEL:
        # Copy before appending so the loaded authored graph remains a distinct value.  A user
        # overlay cannot affect these costs; reconverting against another pack can move only this
        # catalog-derived tail.
        TRAVEL = dict(TRAVEL)
        authored_pairs = {
            tuple(sorted(edge["z"])) for edge in TRAVEL.get("walk", [])
        }
        derived = []
        records = sorted(
            (record for catalog in discoveries.values() for record in catalog["zones"]),
            key=lambda record: record["key"])
        for record in records:
            for edge in sorted(record["edges"], key=lambda edge: edge["z"]):
                pair = tuple(sorted((record["key"], edge["z"])))
                # Fence 1 makes this unreachable today.  Keep it as an assertion so a future
                # discovery-rule change cannot silently duplicate an authored edge.
                assert pair not in authored_pairs, (
                    "discovered walk edge duplicates authored pair: %s|%s" % pair)
                derived.append({"z": [record["key"], edge["z"]], "cost": edge["cost"]})
        TRAVEL["walk"] = list(TRAVEL.get("walk", [])) + derived

    return ALL, META, DETAIL, HUBS, UNIVERSE, WORLDLINKS, TRAVEL, XPACS


def inject(template, ALL, META, DETAIL, HUBS, UNIVERSE, WORLDLINKS, TRAVEL, XPACS,
           *, credit=None, version=None):
    def j(o):
        # escape "</" so any string value (e.g. a hub label/note containing "</script>")
        # cannot break out of the <script> block it is injected into.
        return json.dumps(o, separators=(",", ":"), ensure_ascii=False).replace("</", "<\\/")
    replacements = {
        ph: j(obj)
        for ph, obj in (("__ALL__", ALL), ("__META__", META),
                        ("__DETAIL__", DETAIL), ("__HUBS__", HUBS),
                        ("__UNIVERSE__", UNIVERSE), ("__WORLDLINKS__", WORLDLINKS),
                        ("__TRAVEL__", TRAVEL), ("__XPACS__", XPACS))
    }
    if credit is not None:
        replacements["__CRED__"] = html_escape(credit)
    if version is not None:
        replacements["__VERSION__"] = version
    return replace_placeholders(template, replacements)


def main():
    ap = argparse.ArgumentParser(description="Build the Norrath interactive map.")
    # Default is 'user' so forgetting the flag at release ships the safe artifact;
    # forgetting it while authoring is obvious within seconds (no Export button).
    ap.add_argument("--edition", choices=("user", "author"), default="user",
                    help="user (default): end-user map, bounded customization. "
                         "author: full authoring build.")
    ap.add_argument("--out", default=None,
                    help="output HTML path (default: dist/eql-interactive-map.html, "
                         "or dist/eql-interactive-map.author.html for --edition author)")
    ap.add_argument("--data", default=None,
                    help="data root to build from (default: the repo's data/)")
    ap.add_argument("--pack", default=None,
                    help="map-pack directory (e.g. <game install>/maps/Brewall). Remembered "
                         "in <data>/" + PACK_CONFIG + ", so later builds need no flag.")
    args = ap.parse_args()
    out = args.out or DEFAULT_OUT[args.edition]
    data_root = os.path.abspath(os.path.expanduser(args.data)) if args.data else DATA
    if not os.path.isdir(data_root):
        raise SystemExit("--data: not a directory: " + data_root)
    ensure_cache(data_root, resolve_pack(data_root, args.pack))

    with open(TEMPLATE, "r", encoding="utf-8") as f:
        template = f.read()

    template = strip_regions(template, args.edition)     # strip before injecting
    data = build(data_root)
    html = inject(template, *data, credit=cred_text(data_root),
                  version=read_version())

    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    with open(out, "w", encoding="utf-8", newline="") as f:
        f.write(html)

    ALL, HUBS, TRAVEL = data[0], data[3], data[6]
    kb = len(html) / 1024
    print("Built %s [%s edition] (%.0f KB) - %d continents, %d hub sets, "
          "%d walk edges, %d routes"
          % (out, args.edition, kb, len(ALL), len(HUBS),
             len(TRAVEL.get("walk", [])), len(TRAVEL.get("routes", []))))


if __name__ == "__main__":
    main()
