#!/usr/bin/env python3
"""Mutation-resistant checks for mapgeom's standalone numeric contract."""
import ast
import os
import subprocess
import sys


REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SCRIPTS = os.path.join(REPO, "scripts")
MAPGEOM_PATH = os.path.join(SCRIPTS, "mapgeom.py")
sys.path.insert(0, SCRIPTS)
import mapgeom  # noqa: E402


fails = []


def check(name, got, want):
    ok = got == want
    print("%-58s %s" % (name, "OK" if ok else "FAIL\n   got  %r\n   want %r" % (got, want)))
    if not ok:
        fails.append(name)


# This pinned input is a cross-language fixture, not a runtime search. CPython's hypot is the
# outlier: explicit sqrt produces SQRT_REPR in both CPython and JavaScript, while Python hypot
# produces HYPOT_REPR. Plan 3 still owes the live Python-vs-Node comparison.
DX = -22407.44944409043
DY = 14778.172561699554
HYPOT_REPR = "26841.910789897916"
SQRT_REPR = "26841.910789897913"

check("control: Python hypot has its pinned divergent value",
      repr(__import__("math").hypot(DX, DY)), HYPOT_REPR)
check("hazard: hypot and mapgeom.norm diverge",
      __import__("math").hypot(DX, DY) != mapgeom.norm(DX, DY), True)
check("mapgeom.norm returns the cross-language sqrt double",
      mapgeom.norm(DX, DY), float(SQRT_REPR))


# Fully specified production-path fixture. Its first leg is exactly (DX,DY), and its second leg
# is zero. The division by UNITS_PER_COST preserves the hypot/sqrt divergence by one output ULP.
ZONES = {
    "a": {"cx": 0.0, "cy": 0.0, "segs": []},
    "b": {"cx": 0.0, "cy": 0.0, "segs": []},
}
EXITS = {
    ("a", "b"): (22407.44944409043, -14778.172561699554),
    ("b", "a"): (0.0, 0.0),
}
COST_REPR = "107.36764315959165"
check("cost_between is bound to the explicit-sqrt contract",
      mapgeom.cost_between(ZONES, "a", "b", False, EXITS), float(COST_REPR))


with open(MAPGEOM_PATH, "r", encoding="utf-8") as f:
    tree = ast.parse(f.read(), filename=MAPGEOM_PATH)
imports = set()
for node in ast.walk(tree):
    if isinstance(node, ast.Import):
        imports.update(alias.name for alias in node.names)
    elif isinstance(node, ast.ImportFrom):
        imports.add(node.module or "")
check("mapgeom import set is exactly math and re", imports, {"math", "re"})


DISCOVERY_EXCLUDE = {
    "arcstone", "arginhiz", "barren", "bloodfalls", "breedinggrounds", "brellsrest",
    "broodlands", "commonlands", "corathus", "crystalshard", "delvea", "dragonscale",
    "eastwastesshard", "ethernere", "feerrott2", "freeportacademy", "freeportcityhall",
    "freeporthall", "freeportmilitia", "freeportsewers", "freeporttheater", "freeportwest",
    "gorowyn", "growthplane", "gunthak", "highpasshold", "jaggedpine", "kaelshard",
    "korshaext", "lopingplains", "mischiefplane", "mistythicket", "moors", "neriakd",
    "oceangreenhills", "oceanoftears", "scorchedwoods", "soldungc", "steamfontmts",
    "takishruins", "toxxulia", "xorbb",
}
check("discovery exclusion is exactly the owner's 42-key ruling",
      mapgeom.DISCOVERY_EXCLUDE, DISCOVERY_EXCLUDE)
check("commonlands is explicitly excluded by the residue ruling",
      "commonlands" in mapgeom.DISCOVERY_EXCLUDE, True)
check("the discovered zone colour is the pinned authored literal",
      mapgeom.DISCOVERED_ZONE_COLOR, "#8f78d4")
check("marker display-name derivation preserves identity and presentation",
      mapgeom.discovery_display_name("to_New_Sebilis_Expedition_(click)"),
      "New Sebilis Expedition")


probe = """import sys
assert 'import_pack' not in sys.modules
assert 'derive_travel_graph' not in sys.modules
sys.path.insert(0, %r)
import mapgeom
assert 'import_pack' not in sys.modules
assert 'derive_travel_graph' not in sys.modules
print(mapgeom.UNITS_PER_COST)
""" % SCRIPTS
p = subprocess.run([sys.executable, "-c", probe], text=True,
                   stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
check("standalone subprocess import exits successfully", p.returncode, 0)
check("standalone subprocess imports neither sibling", p.stdout.strip(), "250.0")


print()
print("RESULT: %s" % ("PASS" if not fails else "FAIL: %s" % fails))
sys.exit(1 if fails else 0)
