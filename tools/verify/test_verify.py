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
    anchor_control = verify._check_anchors(anchor_all, anchor_hubs, rosters, "brewall", {})
check("anchors control passes", anchor_control, 0)

mut_hubs = copy.deepcopy(anchor_hubs)
mut_hubs["Antonica"][0]["lx"] += 3000
output = io.StringIO()
with contextlib.redirect_stdout(output):
    hub_mutation = verify._check_anchors(anchor_all, mut_hubs, rosters, "brewall", {})
check("hub lx mutation fails anchors", hub_mutation, 2)
check("hub mutation names the exact authored entry",
      "FAIL  anchor off host: Antonica hubs[0]" in output.getvalue(), True)

mut_all = copy.deepcopy(anchor_all)
mut_all["Antonica"]["connectors"][0]["a"]["lx"] += 3000
output = io.StringIO()
with contextlib.redirect_stdout(output):
    conn_mutation = verify._check_anchors(mut_all, anchor_hubs, rosters, "brewall", {})
check("connector lx mutation fails anchors", conn_mutation, 2)
check("connector mutation names the exact authored end",
      "FAIL  anchor off host: Antonica connectors[0].a" in output.getvalue(), True)


hub_exception = {
    "default": {
        "Antonica hubs[0]": {"host": "alpha", "local": [3500.0, 0.0],
                              "dist": 2500.0, "inside_aabb": False},
    },
}


def run_anchor_case(all_data, hubs, pack_key, exceptions):
    output = io.StringIO()
    with contextlib.redirect_stdout(output):
        result = verify._check_anchors(all_data, hubs, rosters, pack_key, exceptions)
    return result, output.getvalue()


exception_match, text = run_anchor_case(anchor_all, mut_hubs, "default", hub_exception)
check("anchor exception matches the exact diagnosed point", exception_match, 0)
check("matching anchor exception prints its named EXCEPT line",
      "EXCEPT anchor off host (root trace gap): Antonica hubs[0]" in text, True)
check("matching anchor exception prints no FAIL line", "FAIL" not in text, True)

stale_distance = copy.deepcopy(hub_exception)
stale_distance["default"]["Antonica hubs[0]"]["dist"] += 1
result, text = run_anchor_case(anchor_all, mut_hubs, "default", stale_distance)
check("changed exception distance is stale", result != 0, True)
check("changed exception distance names stale entry",
      "FAIL  anchor exception stale: Antonica hubs[0]" in text, True)
check("changed exception distance prints no EXCEPT line", "EXCEPT" not in text, True)

result, text = run_anchor_case(anchor_all, mut_hubs, "brewall", hub_exception)
check("exception for another calibration is inert", result != 0, True)
check("inert exception leaves the ordinary bound failure",
      "FAIL  anchor off host: Antonica hubs[0]" in text, True)
check("inert exception prints no EXCEPT line", "EXCEPT" not in text, True)

result, text = run_anchor_case(anchor_all, anchor_hubs, "default", hub_exception)
check("exception is rejected when ordinary checks pass", result != 0, True)
check("ordinary point names unnecessary exception",
      "FAIL  anchor exception unnecessary: Antonica hubs[0]" in text, True)
check("unnecessary exception prints no EXCEPT line", "EXCEPT" not in text, True)

unused_exception = copy.deepcopy(hub_exception)
unused_exception["default"] = {"Antonica hubs[7]": unused_exception["default"].pop("Antonica hubs[0]")}
result, text = run_anchor_case(anchor_all, anchor_hubs, "default", unused_exception)
check("exception for an absent entry fails", result != 0, True)
check("absent entry names unused exception",
      "FAIL  anchor exception unused: Antonica hubs[7]" in text, True)
check("unused exception prints no EXCEPT line", "EXCEPT" not in text, True)

equidistant_hubs = copy.deepcopy(anchor_hubs)
equidistant_hubs["Antonica"][0]["lx"] = 500
equidistant_hubs["Antonica"][0]["ly"] = 3500
result, text = run_anchor_case(anchor_all, equidistant_hubs, "default", hub_exception)
check("equidistant point does not inherit exception", result != 0, True)
check("equidistant point names stale exception",
      "FAIL  anchor exception stale: Antonica hubs[0]" in text, True)
check("equidistant point prints no EXCEPT line", "EXCEPT" not in text, True)

wrong_host = copy.deepcopy(hub_exception)
wrong_host["default"]["Antonica hubs[0]"]["host"] = "beta"
result, text = run_anchor_case(anchor_all, mut_hubs, "default", wrong_host)
check("changed pinned host is stale", result != 0, True)
check("changed pinned host names stale exception",
      "FAIL  anchor exception stale: Antonica hubs[0]" in text, True)
check("changed pinned host prints no EXCEPT line", "EXCEPT" not in text, True)

wrong_aabb = copy.deepcopy(hub_exception)
wrong_aabb["default"]["Antonica hubs[0]"]["inside_aabb"] = True
result, text = run_anchor_case(anchor_all, mut_hubs, "default", wrong_aabb)
check("changed pinned AABB result is stale", result != 0, True)
check("changed pinned AABB result names stale exception",
      "FAIL  anchor exception stale: Antonica hubs[0]" in text, True)
check("changed pinned AABB result prints no EXCEPT line", "EXCEPT" not in text, True)

skipped_all = copy.deepcopy(anchor_all)
skipped_all["Antonica"]["skipped"] = ["alpha"]
result, text = run_anchor_case(skipped_all, mut_hubs, "default", hub_exception)
check("skipped host leaves exception unused", result != 0, True)
check("skipped host names unused exception",
      "FAIL  anchor exception unused: Antonica hubs[0]" in text, True)
check("skipped host prints no EXCEPT line", "EXCEPT" not in text, True)

check("recognized default receives the exception table",
      verify.anchor_exceptions_for("default", None) is verify.ANCHOR_EXCEPTIONS, True)
check("unrecognized default receives no exceptions",
      verify.anchor_exceptions_for("default", "unrecognized map directory") == {}, True)
check("Brewall receives no exceptions",
      verify.anchor_exceptions_for("brewall", None) == {}, True)


print()
print("RESULT: %s" % ("PASS" if not fails else "FAIL: %s" % fails))
sys.exit(1 if fails else 0)
