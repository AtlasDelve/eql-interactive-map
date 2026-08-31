#!/usr/bin/env python3
"""Unit tests for build.py: the marker walker (strip_regions / _walk_markers) and
the data escaping in inject()."""
import contextlib
import io
import inspect
import json
import os
import sys
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "scripts"))
import build  # noqa: E402
import verify as verify_tool  # noqa: E402

# Must satisfy every build.LOAD_CRITICAL declaration, or strip_regions() aborts on the
# payload-intact assertion before the marker behaviour under test is ever reached.
# TRAVEL and XPACS are both here for the same reason: each is in LOAD_CRITICAL *and* is
# unwrapped by any marker, on adjacent lines. META/DETAIL are absent only because they share
# the `const ALL=` line, which already covers them.
PAY = ("const ALL=1;const HUBS=2;const UNIVERSE=3;const WORLDLINKS=4;"
       "const TRAVEL=5;const XPACS=6;")
fails = []


def check(name, got, want):
    ok = got == want
    print("%-46s %s" % (name, "OK" if ok else "FAIL\n   got  %r\n   want %r" % (got, want)))
    if not ok:
        fails.append(name)


def json_field(text, key):
    try:
        return json.loads(text)[key]
    except (json.JSONDecodeError, KeyError, TypeError) as e:
        return "invalid injected JSON: %s" % e


def raises(name, text, edition, needle):
    try:
        build.strip_regions(text, edition)
    except SystemExit as e:
        ok = needle in str(e)
        print("%-46s %s" % (name, "OK" if ok else "FAIL (msg %r)" % str(e)))
        if not ok:
            fails.append(name)
        return
    print("%-46s FAIL (no SystemExit)" % name)
    fails.append(name)


def artifact_writer_uses_explicit_lf():
    """Pin the inline writer spelling, not its bytes.

    This is a source assertion because the artifact write is inline in build.main(), with no
    writer function a unit test can call. A behavioural assertion would require a full 18 MB build
    and break layer 1's bare-clone contract; the standing ``verify.py lf`` check covers that half.
    """
    source = inspect.getsource(build.main)
    return 'open(out, "w", encoding="utf-8", newline="")' in source


# --- basic strip / keep ---------------------------------------------------
check("artifact writer disables newline translation",
      artifact_writer_uses_explicit_lf(), True)

t = PAY + "/*__AUTHOR__*/AAA/*__END_AUTHOR__*//*__USER__*/UUU/*__END_USER__*/"
check("user keeps USER body, drops AUTHOR",
      build.strip_regions(t, "user"), PAY + "UUU")
check("author keeps AUTHOR body, drops USER",
      build.strip_regions(t, "author"), PAY + "AAA")

# --- markup syntax -------------------------------------------------------
t = PAY + "<!--__AUTHOR__--><b>A</b><!--__END_AUTHOR__--><i>keep</i>"
check("markup region stripped for user",
      build.strip_regions(t, "user"), PAY + "<i>keep</i>")
check("markup markers removed for author",
      build.strip_regions(t, "author"), PAY + "<b>A</b><i>keep</i>")

# --- multiple regions, and non-greediness (the file-body-swallow hazard) --
t = PAY + "/*__AUTHOR__*/A1/*__END_AUTHOR__*/KEEP/*__AUTHOR__*/A2/*__END_AUTHOR__*/"
check("two AUTHOR regions: middle KEEP survives",
      build.strip_regions(t, "user"), PAY + "KEEP")

# --- a region inside a JS template literal (delLinkBtn / hub rows) --------
t = PAY + "h+=`<span>x</span>/*__AUTHOR__*/<b>del</b>/*__END_AUTHOR__*/`;"
check("region inside template literal (user)",
      build.strip_regions(t, "user"), PAY + "h+=`<span>x</span>`;")

# --- data sentinels ------------------------------------------------------
t = "/*__DATA_ALL__*/" + PAY + "/*__END_ALL__*/"
check("data sentinels removed for user", build.strip_regions(t, "user"), PAY)
check("data sentinels kept for author", build.strip_regions(t, "author"), t)

# --- fail loud: unbalanced both directions -------------------------------
raises("open AUTHOR with no close -> SystemExit",
       PAY + "/*__AUTHOR__*/oops", "user", "no matching")
raises("close AUTHOR with no open -> SystemExit",
       PAY + "oops/*__END_AUTHOR__*/", "user", "no matching")
raises("open USER with no close -> SystemExit",
       PAY + "/*__USER__*/oops", "author", "no matching")
raises("unbalanced markup marker -> SystemExit",
       PAY + "<!--__AUTHOR__-->oops", "user", "no matching")

# --- fail loud: payload swallowed ---------------------------------------
raises("region swallowing const ALL= -> SystemExit",
       "/*__AUTHOR__*/" + PAY + "/*__END_AUTHOR__*/", "user", "stripped away")

# --- fail loud: stray bare token survives (caught by the post-strip assert,
#     not the walker - a bare token matches neither comment syntax) ---------
raises("stray bare __END_USER__ token -> SystemExit",
       PAY + "x __END_USER__ y", "user", "survived stripping")

# --- fail loud: accidentally nested same-kind regions --------------------
raises("nested same-kind AUTHOR regions -> SystemExit",
       PAY + "/*__AUTHOR__*/a/*__AUTHOR__*/b/*__END_AUTHOR__*/c/*__END_AUTHOR__*/",
       "user", "no matching")

# --- inject(): data must never terminate the <script> block it lands in ---
# build.py rewrites "</" as "<\/" before injecting. A hub label is the realistic
# carrier, since labels are free text the author types. Without the rewrite the
# built page's script element ends early and the rest of the map is parsed as
# markup. Deleting that one replace() used to leave the whole suite green.
LBL = "Docks </script><b>x</b>"
HUBS = {"Antonica": [{"x": 0, "y": 0, "kind": "boat", "label": LBL}]}
# inject() requires every placeholder to be present, so feed it all eight. One per line:
# json.dumps never emits a raw newline, so line 4 is exactly the HUBS payload even
# though the label itself contains spaces. A new placeholder therefore goes on the END,
# or that index silently starts reading a different structure.
TPL = ("__ALL__\n__META__\n__DETAIL__\n__HUBS__\n__UNIVERSE__\n__WORLDLINKS__\n"
       "__TRAVEL__\n__XPACS__\n__VERSION__")
VERSION = build.read_version()
out = build.inject(TPL, {}, {}, {}, HUBS, [], [], {}, {}, version=VERSION)
check("no raw '</' survives inject()", "</" in out, False)
check("escaped payload still parses to the original label",
      json.loads(out.split("\n")[3])["Antonica"][0]["label"], LBL)
check("version substitutes as raw constrained text", out.split("\n")[-1], VERSION)

# --- credit: format, escaping, missing-placeholder guard, and one-pass assembly ---
def fixture_credit(pack, root_counts, discovered=None):
    with tempfile.TemporaryDirectory() as data:
        generated = os.path.join(data, build.import_pack.CACHE_DIRNAME)
        os.makedirs(generated)
        manifest = {"pack": pack, "continents": {
            "C%d" % i: {"rootZones": ["z%d" % j for j in range(n)]}
            for i, n in enumerate(root_counts)}}
        if discovered:
            manifest["continents"].setdefault("C0", {"rootZones": []})["discovered"] = discovered
        with open(os.path.join(generated, "manifest.json"), "w", encoding="utf-8") as f:
            json.dump(manifest, f)
        return build.cred_text(data)


check("credit names a community pack exactly",
      fixture_credit(os.path.join("game", "maps", "Brewall"), []),
      "EQL · Brewall map data")
check("credit does not infer provenance from maps dirname",
      fixture_credit(os.path.join("game", "maps"), []),
      "EQL · selected maps folder")
check("credit singular root-zone clause",
      fixture_credit(os.path.join("game", "maps", "Layered"), [1]),
      "EQL · Layered map data · 1 zone from the game's own maps")
check("credit plural root-zone clause",
      fixture_credit(os.path.join("game", "maps", "Layered"), [1, 2]),
      "EQL · Layered map data · 3 zones from the game's own maps")
check("credit counts root-sourced discoveries in the manifest",
      fixture_credit(os.path.join("game", "maps", "Layered"), [],
                     [{"key": "new", "from": "root"}, {"key": "packnew", "from": "pack"}]),
      "EQL · Layered map data · 1 zone from the game's own maps")
escaped_credit = build.inject(
    "<div>__CRED__</div>\n" + TPL, {}, {}, {}, {}, [], [], {}, {},
    credit="x</div>&\"'", version=VERSION)
check("live credit injection escapes HTML",
      escaped_credit.split("\n")[0], "<div>x&lt;/div&gt;&amp;&quot;&#x27;</div>")
try:
    build.inject(TPL, {}, {}, {}, {}, [], [], {}, {}, credit="credit", version=VERSION)
except SystemExit as e:
    check("missing credit placeholder fails loud", str(e),
          "template missing placeholder __CRED__")
else:
    check("missing credit placeholder fails loud", "no error", "SystemExit")

# All ten replacements inspect the original template once. Neither a data placeholder in
# user-controlled credit nor later placeholders in an earlier payload may be interpreted.
collision_out = build.inject(
    "<div>__CRED__</div>\n" + TPL,
    {"credit": "__CRED__", "later": "__META__"}, {"sentinel": 1}, {}, {}, [], [], {}, {},
    credit="pack __ALL__", version=VERSION)
collision_lines = collision_out.split("\n")
check("credit data-placeholder spelling stays text",
      collision_lines[0], "<div>pack __ALL__</div>")
check("credit placeholder in payload stays data",
      json_field(collision_lines[1], "credit"), "__CRED__")
check("later placeholder in earlier payload stays data",
      json_field(collision_lines[1], "later"), "__META__")
check("longest overlapping placeholder wins",
      build.replace_placeholders(
          "__ALL__EXTRA__", {"__ALL__": "short", "__ALL__EXTRA__": "long"}),
      "long")

try:
    build.inject(TPL.replace("__VERSION__", ""), {}, {}, {}, {}, [], [], {}, {},
                 version=VERSION)
except SystemExit as e:
    check("missing version placeholder fails loud", str(e),
          "template missing placeholder __VERSION__")
else:
    check("missing version placeholder fails loud", "no error", "SystemExit")

with tempfile.TemporaryDirectory() as td:
    unsafe_version = os.path.join(td, "VERSION")
    with open(unsafe_version, "w", encoding="ascii") as f:
        f.write('0.1.0";alert(1)//\n')
    try:
        build.read_version(unsafe_version)
    except SystemExit as e:
        check("unsafe raw-substitution version fails loud",
              "ASCII letters, digits, dot, plus, or hyphen" in str(e), True)
    else:
        check("unsafe raw-substitution version fails loud", "no error", "SystemExit")

# --- numeric loader: the Python reader must emit only values JS preserves safely ---
check("largest JS-safe integer is accepted",
      build._canon_int(str(build.JS_SAFE_INTEGER)), build.JS_SAFE_INTEGER)
for name, fn, value, needle in (
        ("oversized integer fails loud", build._canon_int,
         str(build.JS_SAFE_INTEGER + 1), "exceeds JS safe range"),
        ("integral float outside safe range fails loud", build._canon_float,
         str(build.JS_SAFE_INTEGER + 1) + ".0",
         "float %d.0 has integral value outside JS safe range"
         % (build.JS_SAFE_INTEGER + 1)),
        ("overflowing exponent fails loud", build._canon_float, "1e999", "not finite"),
        ("Python-only NaN constant fails loud", build._reject_constant, "NaN", "not valid JSON")):
    try:
        fn(value)
    except SystemExit as e:
        check(name, needle in str(e), True)
    else:
        check(name, "no error", "SystemExit")

with tempfile.TemporaryDirectory() as td:
    bad_json = os.path.join(td, "unsafe.json")
    with open(bad_json, "w", encoding="utf-8") as f:
        f.write('{"n":%d}' % (build.JS_SAFE_INTEGER + 1))
    try:
        build.load(bad_json)
    except SystemExit as e:
        check("numeric load error names its source file", bad_json in str(e), True)
    else:
        check("numeric load error names its source file", "no error", "SystemExit")

with tempfile.TemporaryDirectory() as td:
    with open(build.TEMPLATE, "r", encoding="utf-8") as f:
        unsafe_tpl = build.strip_regions(f.read(), "user")
    unsafe_html = build.inject(
        unsafe_tpl, {}, {}, {}, {"Antonica": [{"x": build.JS_SAFE_INTEGER + 2}]},
        [], [], {}, {}, credit="EQL · fixture map data", version=VERSION)
    unsafe_artifact = os.path.join(td, "unsafe.html")
    with open(unsafe_artifact, "w", encoding="utf-8") as f:
        f.write(unsafe_html)
    output = io.StringIO()
    with contextlib.redirect_stdout(output):
        unsafe_result = verify_tool.cmd_jsnum(unsafe_artifact)
    check("jsnum rejects oversized integer branch", unsafe_result, 1)
    check("jsnum names oversized integer location",
          "HUBS.Antonica[0].x" in output.getvalue(), True)

print()
print("RESULT: %s" % ("PASS" if not fails else "FAIL: %s" % fails))
sys.exit(1 if fails else 0)
