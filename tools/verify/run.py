#!/usr/bin/env python3
"""Run the verification suites for the generated map.

    python tools/verify/run.py                # everything available
    python tools/verify/run.py --quick        # skip the 18 MB artifact loads (~10 s)
    python tools/verify/run.py --no-browser   # skip the real-browser pass
    python tools/verify/run.py --list         # show the steps without running them

Layers, cheapest first:

  1. Python      browser-builder assembly/input guards, marker-walker unit tests, strip
                 completeness, injected-data equivalence, ref-hint collision check.
  N. Node        dependency-free pack-converter/lift parity; fixture scale always runs when
                 Node exists, real-pack scale follows the 18 MB --quick gate.
  2. jsdom/small browser-builder end-to-end plus ~100 KB synthetic map fixtures, so canonical
                 data can be MUTATED to simulate shipping an update.
  3. jsdom/full  the real ~18 MB artifact: smoke on both editions, the untouched-overlay
                 invariant across all 11 continents, and view-vs-edit timing. The Node-only
                 JS number round-trip runs before the npm dependency gate.
  4. browser     an installed Chromium-family browser, for what jsdom cannot reach: the builder
                 directory picker, FileReader, drag-and-drop, real downloads, the CSS cascade,
                 and the rendered bitmap.

Layers 2-4 need `npm install` in tools/verify/js (jsdom, playwright-core). They are
skipped with a notice if node_modules is absent, so layer 1 always works from a bare
clone with only Python.
"""
import argparse
import functools
import http.server
import os
import shutil
import socket
import subprocess
import sys
import threading

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
JS = os.path.join(HERE, "js")
OUT = os.path.join(HERE, "_out")
FX = os.path.join(HERE, "_fx")
BUILD = os.path.join(REPO, "scripts", "build.py")
BUILD_BUILDER = os.path.join(REPO, "scripts", "build_builder.py")
PACKFX_DATA = os.path.join(HERE, "packfx", "data")

USER = os.path.join(OUT, "user.html")
USER_ND = os.path.join(OUT, "user-no-discover.html")
AUTHOR = os.path.join(OUT, "author.html")
BUILDER = os.path.join(OUT, "builder.html")
BUILDER_FX = os.path.join(OUT, "builder-fx.html")

results = []


def step(name, argv, cwd=None, optional=False):
    """Run one step, stream nothing, keep the last RESULT line."""
    print("\n" + "=" * 72)
    print("  " + name)
    print("=" * 72)
    p = subprocess.run(argv, cwd=cwd or HERE, text=True,
                       stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    print(p.stdout.rstrip())
    skipped = "SKIP:" in p.stdout
    ok = p.returncode == 0
    results.append((name, "SKIP" if (skipped and ok) else ("PASS" if ok else "FAIL")))
    if not ok and not optional:
        return False
    return True


def build(edition, out, discover=True):
    argv = [sys.executable, BUILD, "--edition", edition, "--out", out]
    if not discover:
        # Plan 3 removes this parity-only --no-discover once the browser converter consumes catalogs.
        argv.append("--no-discover")
    subprocess.run(argv,
                   check=True, stdout=subprocess.DEVNULL)


def build_builder(out, data=None):
    argv = [sys.executable, BUILD_BUILDER, "--out", out]
    if data is not None:
        argv.extend(["--data", data])
    subprocess.run(argv, check=True, stdout=subprocess.DEVNULL)


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def serve(directory, port):
    """Serve `directory` on 127.0.0.1:port in a daemon thread.

    The browser pass needs http:// rather than file://: Chromium treats file:// as an
    opaque origin where localStorage is unreliable, and the whole point is to exercise
    the localStorage buffer.
    """
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=directory)
    handler.log_message = lambda *a, **k: None
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", port), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--quick", action="store_true", help="skip the 18 MB artifact suites")
    ap.add_argument("--no-browser", action="store_true", help="skip the real-browser pass")
    ap.add_argument("--list", action="store_true", help="list the steps and exit")
    args = ap.parse_args()

    have_node = shutil.which("node") is not None
    have_mods = os.path.isdir(os.path.join(JS, "node_modules"))

    if args.list:
        print("1 python     test_builder, test_markers, test_import_pack, test_verify, test_mapgeom,")
        print("               strip, lf,")
        print("               datacmp(user,author), discoveryappend, jsnum x2, hints, discoveryfresh, travel")
        print("1/artifact     derivedtravel  [--quick skips]")
        print("N node/small pack-convert fixture parity, lift parity  [no npm install needed]")
        print("N node/full  pack-convert real-pack parity, jsnum")
        print("               [--quick skips; no npm install needed]")
        print("2 jsdom/small builder, overlay, hide-io, ghost-alpha, author-guards, script-escape,")
        print("               travel, world-anchor")
        print("3 jsdom/full  smoke x2, travel-full, untouched, perf"
              + ("  [--quick skips]" if True else ""))
        print("4 browser     browser.test.js" + ("  [--no-browser skips]" if True else ""))
        return 0

    os.makedirs(OUT, exist_ok=True)
    print("building both editions and both browser builders into " + os.path.relpath(OUT, REPO))
    build("user", USER)
    build("author", AUTHOR)
    build("user", USER_ND, discover=False)
    build_builder(BUILDER)
    build_builder(BUILDER_FX, PACKFX_DATA)

    # ---- 1. Python -------------------------------------------------------
    step("browser-builder assembly and closed-input guards",
         [sys.executable, "test_builder.py"])
    step("build.py unit tests (markers, data escaping)",
         [sys.executable, "test_markers.py"])
    step("import_pack.py against the synthetic pack fixture",
         [sys.executable, "test_import_pack.py"])
    step("verify.py robustness unit tests", [sys.executable, "test_verify.py"])
    step("mapgeom standalone numeric contract", [sys.executable, "test_mapgeom.py"])
    step("strip completeness (user edition)", [sys.executable, "verify.py", "strip", USER])
    step("platform-independent LF artifact", [sys.executable, "verify.py", "lf", USER])
    # No committed baseline: the two editions must inject byte-identical data as each
    # other. For a risky refactor, also capture a build BEFORE the change and datacmp
    # against that.
    step("injected data identical across editions",
         [sys.executable, "verify.py", "datacmp", USER, AUTHOR])
    step("discovery-on is the manifest-declared non-empty append",
         [sys.executable, "verify.py", "discoveryappend", USER_ND, USER])
    step("JS-canonical numbers (user edition)",
         [sys.executable, "verify.py", "jsnum", USER])
    step("JS-canonical numbers (author edition)",
         [sys.executable, "verify.py", "jsnum", AUTHOR])
    step("ref-hint collision check over data/", [sys.executable, "verify.py", "hints"])
    step("discovered input freshness", [sys.executable, "verify.py", "discoveryfresh"])
    step("travel graph integrity over data/", [sys.executable, "verify.py", "travel"])
    if args.quick:
        results.append(("catalog-derived travel edges in the artifact", "SKIP"))
    else:
        step("catalog-derived travel edges in the artifact",
             [sys.executable, "verify.py", "derivedtravel", USER])

    # Dependency-free twin gates run before the npm-module gate. Fixture scale is cheap and
    # always runs when Node exists; real-pack scale follows the other 18 MB --quick gates.
    if have_node:
        step("pack converter twin: fixture-scale agreement",
             ["node", "pack-convert.test.js", sys.executable], cwd=JS)
        step("lift() twin agrees with pack_colors.lift",
             ["node", "lift.test.js", sys.executable], cwd=JS)
    else:
        results.append(("pack converter twin: fixture-scale agreement", "SKIP"))
        results.append(("lift() twin agrees with pack_colors.lift", "SKIP"))

    if args.quick:
        results.append(("pack converter twin: real pack agreement", "SKIP"))
    elif have_node:
        step("pack converter twin: real pack agreement",
             ["node", "pack-convert-full.test.js", sys.executable, USER_ND], cwd=JS)
    else:
        results.append(("pack converter twin: real pack agreement", "SKIP"))

    if args.quick:
        results.append(("JS number round-trip over 18 MB artifacts", "SKIP"))
    elif have_node:
        step("injected blobs round-trip through JavaScript numbers",
             ["node", "jsnum.test.js", USER, AUTHOR], cwd=JS)
    else:
        print("\nSKIPPING the JavaScript number round-trip: node not found")
        results.append(("JS number round-trip over 18 MB artifacts", "SKIP"))

    if not (have_node and have_mods):
        why = "node not found" if not have_node else \
              "tools/verify/js/node_modules missing - run: npm install (in tools/verify/js)"
        print("\nSKIPPING the jsdom and browser layers: " + why)
        results.append(("jsdom + browser layers", "SKIP"))
        return summary()

    # ---- 2. jsdom, synthetic fixtures ------------------------------------
    subprocess.run([sys.executable, "fixture.py", FX], check=True, cwd=HERE,
                   stdout=subprocess.DEVNULL)
    step("jsdom fixtures: builder.test.js",
         ["node", "builder.test.js", sys.executable], cwd=JS)
    for f in ("overlay.test.js", "hide-io.test.js", "ghost-alpha.test.js",
              "author-guards.test.js", "script-escape.test.js", "travel.test.js",
              "world-anchor.test.js"):
        step("jsdom fixtures: " + f, ["node", f], cwd=JS)

    # ---- 3. jsdom, the real artifact -------------------------------------
    if args.quick:
        results.append(("18 MB artifact suites", "SKIP"))
    else:
        step("jsdom smoke: user edition", ["node", "smoke.js", USER, "expect-user"], cwd=JS)
        step("jsdom smoke: author edition", ["node", "smoke.js", AUTHOR, "expect-author"], cwd=JS)
        step("travel guide over the real graph (routes, search)",
             ["node", "travel-full.test.js", USER], cwd=JS)
        step("untouched map yields an empty overlay (all continents)",
             ["node", "untouched.test.js", USER], cwd=JS)
        step("continent view stays cheap (deferred weld detection)",
             ["node", "perf.test.js", USER], cwd=JS)

    # ---- 4. real browser -------------------------------------------------
    if args.no_browser:
        results.append(("real-browser pass", "SKIP"))
    else:
        port = free_port()
        srv = serve(OUT, port)
        try:
            step("real browser: file picker, drag-drop, downloads, pixels",
                 ["node", "browser.test.js", "http://127.0.0.1:%d" % port], cwd=JS)
        finally:
            srv.shutdown()

    return summary()


def summary():
    print("\n" + "=" * 72)
    print("  SUMMARY")
    print("=" * 72)
    width = max(len(n) for n, _ in results)
    for name, verdict in results:
        print("  %-*s  %s" % (width, name, verdict))
    bad = [n for n, v in results if v == "FAIL"]
    print("\n%d step(s), %d failed" % (len(results), len(bad)))
    print("RESULT: " + ("FAIL" if bad else "PASS"))
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
