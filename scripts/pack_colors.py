"""Pack RGB -> display hex, the one part of the import that is a lookup rather than a rule.

The map packs draw in colours chosen for a light background: pure red, and a lot of near-black.
The original import lifted them for the viewer's dark canvas - pack (255,0,0) ships as #ff4545,
(0,0,0) as #afafaf. That importer is not in this repo (searched: docs/internal/, scripts/, the
client's own notes), so the transform is known only through its output.

It is NOT recoverable by fitting. Hue is preserved and dark colours are lifted, but any
"normalise then adjust" pipeline is refuted by a single pair: (0,50,0) and (0,64,0) both
normalise to (0,205,0) yet ship as (9,205,9) and (8,206,8). Whatever the original did, it is
not a function of the normalised colour alone.

So the mapping is a table, recovered from the committed palettes while they still existed:
every pack colour the 11 continents use, cross-checked across all of them with zero
ambiguity - no pack colour ever mapped to two different hexes. lift() approximates for a
colour the table has never seen, and import_pack.py counts those hits in the manifest so a
pack that needs many is visible rather than silent.

Code, like the rest of scripts/, and covered by the repo's LICENSE (PolyForm Noncommercial).
The keys are facts about the pack's files; the values are this project's rendering decision,
which is why this is code and not data/.
"""
import math

# Recovered from data/continents/*/continent.json before the palettes moved to the cache.
PACK_COLORS = {
    (  0,   0,   0): '#afafaf',
    (  0,   0, 127): '#6f6fe2',
    (  0,   0, 153): '#6f6fe2',
    (  0,   0, 240): '#6d6df6',
    (  0,   0, 255): '#6c6cff',
    (  0,  50,   0): '#09cd09',
    (  0,  64,   0): '#08ce08',
    (  0, 100,   0): '#09cd09',
    (  0, 102,   0): '#08ce08',
    (  0, 125,   0): '#08ce08',
    (  0, 127,   0): '#08ce08',
    (  0, 127, 127): '#00cdcd',
    (  0, 128,   0): '#08ce08',
    (  0, 128, 128): '#00cdcd',
    (  0, 204,   0): '#08ce08',
    (  0, 204, 204): '#00cdcd',
    (  0, 220,   0): '#00dc00',
    (  0, 240,   0): '#00f000',
    (  0, 240, 240): '#00f0f0',
    (  0, 255,   0): '#00ff00',
    ( 53,   0,  76): '#b14fdc',
    ( 60,  40,   0): '#cd8800',
    ( 63,  63,  63): '#cdcdcd',
    ( 64,  64,  64): '#cdcdcd',
    ( 65,  65,  65): '#cdcdcd',
    ( 70, 130, 180): '#4f94cd',
    (100,  50,   0): '#cd6a07',
    (102,   0, 204): '#9c5ade',
    (102, 255, 102): '#66ff66',
    (102, 255, 255): '#66ffff',
    (114, 114, 114): '#cdcdcd',
    (125,   0, 255): '#a54fff',
    (125, 125, 125): '#cdcdcd',
    (127,   0,   0): '#dd5353',
    (127,  64,   0): '#ce6a06',
    (127, 127,   0): '#cdcd00',
    (127, 127, 127): '#cdcdcd',
    (128,   0, 128): '#d83cd8',
    (128,  64,   0): '#ce6a07',
    (128, 128,   0): '#cdcd00',
    (128, 128, 128): '#cdcdcd',
    (139,  69,  19): '#cd661e',
    (150,   0, 150): '#d83cd8',
    (150,   0, 200): '#b74cdb',
    (150, 100,   0): '#cd8800',
    (150, 150, 150): '#cdcdcd',
    (155,   0, 155): '#d83cd8',
    (155, 155, 155): '#cdcdcd',
    (178, 102, 204): '#b266cd',
    (178, 102, 255): '#b266ff',
    (184, 134,  11): '#cd950c',
    (199,  21, 133): '#d747a2',
    (200,  65,   0): '#d46029',
    (204,   0, 204): '#d83cd8',
    (204,  51,   0): '#d75d34',
    (204, 102,   0): '#ce6a07',
    (205, 102, 255): '#cd66ff',
    (205, 133,  53): '#cd8535',
    (205, 133,  63): '#cd853f',
    (240,   0,   0): '#f44a4a',
    (240,   0, 255): '#f227ff',
    (240,  33,   0): '#f34e34',
    (240,  83,   0): '#f05808',
    (240, 127,   0): '#f07f00',
    (240, 127,  64): '#f07f40',
    (240, 240,   0): '#f0f000',
    (240, 240, 240): '#f0f0f0',
    (240, 255, 255): '#f0ffff',
    (246,   0,   0): '#f84848',
    (250, 210,   0): '#fad200',
    (255,   0,   0): '#ff4545',
    (255,  20, 147): '#ff33a1',
    (255, 102, 255): '#ff66ff',
    (255, 140,   0): '#ff8c00',
    (255, 165,   0): '#ffa500',
    (255, 168, 102): '#ffa866',
    (255, 210,   0): '#ffd200',
    (255, 210, 240): '#ffd2f0',
    (255, 246,   0): '#fff600',
    (255, 250, 250): '#fffafa',
    (255, 255,   0): '#ffff00',
    (255, 255,  50): '#ffff32',
    (255, 255, 255): '#ffffff',
}

# The approximation. Only reached for a colour absent from the table above, which no pack
# shipping with this repo produces. Deliberately simple so the JS twin can transliterate it.
#
# Note the rounding: this is floor(x+0.5), i.e. JS Math.round, NOT the half-to-even round()
# that import_pack.py uses for coordinates. The two are genuinely different rules and the
# coordinate one is load-bearing - see import_pack.py's rounding note before "simplifying".
LIFT_MAX = 205.0        # scale a dark colour until its brightest channel reaches this
LIFT_LUMA = 124.3       # then wash it toward white until it is at least this luminous
BLACK = "#afafaf"       # pure black has no hue to preserve, so it is its own case


def _round_half_up(x):
    return int(math.floor(x + 0.5))


def lift(rgb):
    """Approximate the original importer's lift for an unseen colour. Returns '#rrggbb'."""
    r, g, b = float(rgb[0]), float(rgb[1]), float(rgb[2])
    mx = max(r, g, b)
    if mx <= 0.0:
        return BLACK
    if mx < LIFT_MAX:
        k = LIFT_MAX / mx
        r, g, b = r * k, g * k, b * k
    luma = 0.299 * r + 0.587 * g + 0.114 * b
    if luma < LIFT_LUMA:
        t = (LIFT_LUMA - luma) / (255.0 - luma)
        r = r + (255.0 - r) * t
        g = g + (255.0 - g) * t
        b = b + (255.0 - b) * t
    out = []
    for v in (r, g, b):
        v = _round_half_up(v)
        out.append(0 if v < 0 else (255 if v > 255 else v))
    return "#%02x%02x%02x" % (out[0], out[1], out[2])


def color_for(rgb, unseen=None):
    """Display hex for a pack RGB triple. Appends to `unseen` when the table misses."""
    hit = PACK_COLORS.get(tuple(rgb))
    if hit is not None:
        return hit
    if unseen is not None:
        unseen.append(tuple(rgb))
    return lift(rgb)


if __name__ == "__main__":
    import argparse
    import json
    import sys

    parser = argparse.ArgumentParser(description="Print the canonical pack colour table.")
    parser.add_argument("--json", action="store_true", help="write PACK_COLORS as JSON")
    args = parser.parse_args()
    if not args.json:
        parser.error("--json is required")

    # Tuple keys are encoded once at this boundary; the JavaScript twin consumes this table
    # as data rather than carrying a second hand-maintained copy.
    table = {",".join(str(v) for v in rgb): value for rgb, value in PACK_COLORS.items()}
    payload = json.dumps(table, ensure_ascii=False, separators=(",", ":")) + "\n"
    sys.stdout.buffer.write(payload.encode("utf-8"))
