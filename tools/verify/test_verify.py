#!/usr/bin/env python3
"""Mutation-resistant unit tests for verify.py's declaration locators."""
import contextlib
import io
import os
import sys
import tempfile
import copy

import verify


fails = []


def check(name, got, want):
    ok = got == want
    print("%-60s %s" % (name, "OK" if ok else "FAIL\n   got  %r\n   want %r" % (got, want)))
    if not ok:
        fails.append(name)


def write_fixture(root, name, text):
    path = os.path.join(root, name)
    with open(path, "w", encoding="utf-8", newline="") as f:
        f.write(text)
    return path


DECLS = """const ALL={\"real\":true}, META={}, DETAIL={};
const HUBS={};
const UNIVERSE=[];
const WORLDLINKS=[];
const TRAVEL={};
const XPACS={};
"""


with tempfile.TemporaryDirectory() as td:
    extract_text = "// prose const ALL= mention\n" + DECLS
    extract_path = write_fixture(td, "extract.html", extract_text)
    first = extract_text.index("const ALL=") + len("const ALL=")
    check("control: first textual ALL occurrence is prose", extract_text[first] != "{", True)
    check("extract skips prose and returns the real ALL object",
          verify.extract(extract_path)["ALL"], {"real": True})

    strip_text = """// prose const ALL= mention
build.py;
const ALL={}, META={}, DETAIL={};
const HUBS={};
const UNIVERSE=[];
const WORLDLINKS=[];
const TRAVEL={};
const XPACS={};
downloadBlob; buildEditState; detectLinks;
"""
    prose_at = strip_text.index("const ALL=")
    planted_at = strip_text.index("build.py")
    real_at = strip_text.index("const ALL=", prose_at + len("const ALL="))
    check("control: planted token is in old over-excised region",
          prose_at < planted_at < real_at, True)
    strip_path = write_fixture(td, "strip.html", strip_text)
    output = io.StringIO()
    with contextlib.redirect_stdout(output):
        strip_rc = verify.cmd_strip(strip_path)
    check("cmd_strip rejects planted token after locating real ALL", strip_rc, 1)
    check("cmd_strip reports the planted token",
          "FORBIDDEN build.py" in output.getvalue(), True)

    placeholder_text = strip_text.replace(
        "const ALL={}, META={}, DETAIL={};",
        "const ALL=__ALL__, META=__META__, DETAIL=__DETAIL__;",
    ).replace("const WORLDLINKS=[];", "const WORLDLINKS=__WORLDLINKS__;")
    placeholder_path = write_fixture(td, "placeholder.html", placeholder_text)
    placeholder_output = io.StringIO()
    with contextlib.redirect_stdout(placeholder_output):
        placeholder_rc = verify.cmd_strip(placeholder_path)
    check("cmd_strip accepts unbuilt placeholder declaration openers", placeholder_rc, 1)
    check("placeholder scan still reports the planted token",
          "FORBIDDEN build.py" in placeholder_output.getvalue(), True)

    missing_path = write_fixture(td, "missing.html", "// prose const ALL= mention\n")
    try:
        verify.extract(missing_path)
    except (AssertionError, ValueError) as e:
        check("missing real declaration raises and names the prefix",
              "const ALL=" in str(e), True)
    else:
        check("missing real declaration raises and names the prefix", "no exception", "exception")


zone = {"name": "Alpha", "cx": 500, "cy": 500,
        "segs": [[0, 0, 1000, 0], [1000, 0, 1000, 1000],
                 [1000, 1000, 0, 1000], [0, 1000, 0, 0]]}
anchor_all = {"Antonica": {"zones": {"alpha": zone},
                            "connectors": [{"a": {"xy": [0, 500], "anchor": "alpha", "lx": 0, "ly": 500},
                                            "b": {"xy": [1000, 500], "anchor": "alpha", "lx": 1000, "ly": 500}}]}}
anchor_hubs = {"Antonica": [{"x": 500, "y": 0, "anchor": "alpha", "lx": 500, "ly": 0}]}
rosters = {"Antonica": {"alpha"}}
output = io.StringIO()
with contextlib.redirect_stdout(output):
    anchor_control = verify._check_anchors(anchor_all, anchor_hubs, rosters)
check("anchors control passes", anchor_control, 0)

mut_hubs = copy.deepcopy(anchor_hubs)
mut_hubs["Antonica"][0]["lx"] += 3000
output = io.StringIO()
with contextlib.redirect_stdout(output):
    hub_mutation = verify._check_anchors(anchor_all, mut_hubs, rosters)
check("hub lx mutation fails anchors", hub_mutation, 2)
check("hub mutation names the exact authored entry",
      "FAIL  anchor off host: Antonica hubs[0]" in output.getvalue(), True)

mut_all = copy.deepcopy(anchor_all)
mut_all["Antonica"]["connectors"][0]["a"]["lx"] += 3000
output = io.StringIO()
with contextlib.redirect_stdout(output):
    conn_mutation = verify._check_anchors(mut_all, anchor_hubs, rosters)
check("connector lx mutation fails anchors", conn_mutation, 2)
check("connector mutation names the exact authored end",
      "FAIL  anchor off host: Antonica connectors[0].a" in output.getvalue(), True)


print()
print("RESULT: %s" % ("PASS" if not fails else "FAIL: %s" % fails))
sys.exit(1 if fails else 0)
