#!/usr/bin/env python3
"""Assemble the no-install browser builder from code and the authored data layer.

The output embeds the user-edition map template, the authored composition inputs, the canonical
colour table, and the DOM-free converter. It never reads a map pack or generated geometry.
"""
import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import build                                                     # noqa: E402
import pack_colors                                               # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")
BUILDER_TEMPLATE = os.path.join(ROOT, "src", "builder.html")
MAP_TEMPLATE = os.path.join(ROOT, "src", "template.html")
CONVERTER = os.path.join(ROOT, "src", "pack_convert.js")
DEFAULT_OUT = os.path.join(ROOT, "dist", "builder.html")

# Keep this tuple aligned with the authored half of import_pack.validate_cache. The layer-1
# builder test pins the two sites in both directions without changing that function's error order.
AUTHORED_KEYS = ("name", "color", "cx", "cy", "off")

PAYLOAD_ANCHORS = {
    "converter": ("<script>\n", "\n</script>\n<script>\n"),
    "template": ("const TPL = ", ";\n"),
    "authored": ("const AUTHORED = ", ";\n"),
    "colors": ("const COLORS = ", ";\n"),
}


def check_converter_safe(source, path):
    """Refuse raw JavaScript whose text could alter the surrounding script element."""
    folded = source.lower()
    for token in ("</script", "<script", "<!--"):
        if token in folded:
            raise SystemExit("%s: converter contains unsafe script text %r" % (path, token))


def read_converter(path=CONVERTER):
    with open(path, "r", encoding="utf-8") as f:
        source = f.read()
    check_converter_safe(source, path)
    return source


def load_authored(data=DATA):
    """Load only committed author decisions, in authored continent order."""
    world = build.load(os.path.join(data, "world.json"))
    travel_path = os.path.join(data, "travel.json")
    travel = build.load(travel_path) if os.path.exists(travel_path) else {}
    continents = {}
    for cont in world["order"]:
        cdir = build.cont_dir(cont, data)
        meta = build.load(os.path.join(cdir, "continent.json"))
        layout = build.load(os.path.join(cdir, "layout.json"))
        zones = meta.get("zones") or {}
        for zone in meta["zoneOrder"]:
            authored = zones.get(zone)
            missing = [key for key in AUTHORED_KEYS
                       if not authored or authored.get(key) is None]
            if missing:
                raise SystemExit(
                    "continent.json for %s has no complete zones entry for %r "
                    "(missing %s). See: python scripts/import_pack.py "
                    "--print-authored %s" % (cont, zone, ", ".join(missing), cont))
        continents[cont] = {"meta": meta, "layout": layout}
    return {"world": world, "travel": travel, "continents": continents}


def color_table():
    return {",".join(str(value) for value in rgb): color
            for rgb, color in pack_colors.PACK_COLORS.items()}


def json_for_builder(value):
    """JSON for script data: escape every less-than sign before the HTML tokenizer sees it."""
    return json.dumps(value, separators=(",", ":")).replace("<", "\\u003c")


def extract_payload(html, name):
    """Return one embedded payload using the fixed source anchors shared with layer 1."""
    key = name.lower().replace("__builder_", "").strip("_")
    if key not in PAYLOAD_ANCHORS:
        raise SystemExit("unknown builder payload %r" % name)
    opener, closer = PAYLOAD_ANCHORS[key]
    start = html.find(opener)
    if start < 0:
        raise SystemExit("builder output missing %s payload anchor %r" % (key, opener))
    start += len(opener)
    end = html.find(closer, start)
    if end < 0:
        raise SystemExit("builder output missing %s payload closer %r" % (key, closer))
    return html[start:end]


def assemble(data=DATA, builder_template=BUILDER_TEMPLATE, map_template=MAP_TEMPLATE,
             converter_path=CONVERTER):
    with open(builder_template, "r", encoding="utf-8") as f:
        page = f.read()
    with open(map_template, "r", encoding="utf-8") as f:
        map_source = f.read()

    converter = read_converter(converter_path)
    template_payload = json_for_builder(build.strip_regions(map_source, "user"))
    authored_payload = json_for_builder(load_authored(data))
    colors_payload = json_for_builder(color_table())
    version = build.read_version()
    replacements = {
        "__BUILDER_CONVERTER__": converter,
        "__BUILDER_TEMPLATE__": template_payload,
        "__BUILDER_AUTHORED__": authored_payload,
        "__BUILDER_COLORS__": colors_payload,
        "__BUILDER_VERSION__": version,
    }
    html = build.replace_placeholders(page, replacements)
    return html, {
        "template": len(template_payload.encode("utf-8")),
        "authored": len(authored_payload.encode("utf-8")),
        "colors": len(colors_payload.encode("utf-8")),
        "converter": len(converter.encode("utf-8")),
    }


def main():
    parser = argparse.ArgumentParser(description="Assemble the no-install browser map builder.")
    parser.add_argument("--out", default=DEFAULT_OUT,
                        help="output HTML path (default: dist/builder.html)")
    parser.add_argument("--data", default=DATA,
                        help="authored data root to embed (default: the repo's data/)")
    args = parser.parse_args()

    html, sizes = assemble(data=os.path.abspath(args.data))
    out = os.path.abspath(args.out)
    os.makedirs(os.path.dirname(out), exist_ok=True)
    encoded = html.encode("utf-8")
    with open(out, "wb") as f:
        f.write(encoded)
    print("wrote %s (%.1f KB; template %d B, authored %d B, colors %d B, converter %d B)" %
          (out, len(encoded) / 1024, sizes["template"], sizes["authored"], sizes["colors"],
           sizes["converter"]))


if __name__ == "__main__":
    main()
