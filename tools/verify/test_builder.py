#!/usr/bin/env python3
"""Python-only guards for the no-install builder.

Cache-independence plus the source-level closed input list prove that the builder does not depend on
the generated cache and that its declared inputs contain no traced geometry. They do not prove the
unfalsifiable broader claim that encoded geometry could not be smuggled in from some hypothetical
fourth input; closing the input list is what rules that input out. Every artifact inspected here is
built inside a temporary directory so this layer works from a bare clone.
"""
import argparse
import ast
import contextlib
import inspect
import io
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SCRIPTS = os.path.join(REPO, "scripts")
sys.path.insert(0, SCRIPTS)
sys.path.insert(0, os.path.join(REPO, "tools", "verify"))

import build                                                      # noqa: E402
import build_builder as builder                                   # noqa: E402
import import_pack                                                # noqa: E402
import verify as verify_tool                                      # noqa: E402

FX_DATA = os.path.join(REPO, "tools", "verify", "packfx", "data")
BUILDER_SCRIPT = os.path.join(REPO, "scripts", "build_builder.py")
fails = []


def check(name, got, want=True):
    ok = got == want
    print("%-58s %s" % (name, "OK" if ok else "FAIL\n   got  %r\n   want %r" % (got, want)))
    if not ok:
        fails.append(name)


def write_json(path, value):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(value, f, indent=1, ensure_ascii=False)
        f.write("\n")


def run_builder(data, out):
    return subprocess.run(
        [sys.executable, BUILDER_SCRIPT, "--data", data, "--out", out],
        cwd=REPO, text=True, encoding="utf-8", capture_output=True, check=False)


def make_hostile_data(destination):
    """Copy packfx authored data and add ordered script-token and placeholder attacks."""
    shutil.copytree(FX_DATA, destination)
    cdir = os.path.join(destination, "continents", "Testland")
    meta_path = os.path.join(cdir, "continent.json")
    layout_path = os.path.join(cdir, "layout.json")
    meta = json.load(open(meta_path, encoding="utf-8"))
    layout = json.load(open(layout_path, encoding="utf-8"))
    # Emission order is load-bearing: enter escaped state first, then double-escaped state,
    # with no '-->' between. The mixed-case close is a separate refusal/escaping case.
    meta["name"] = "Hostile <!-- continent"
    meta["zones"]["alpha"]["name"] = "Later <script zone"
    meta["zones"]["beta"]["name"] = "Literal __BUILDER_TEMPLATE__ value"
    layout["hubs"][0]["label"] = "Mixed </ScRiPt> hub"
    write_json(meta_path, meta)
    write_json(layout_path, layout)
    return destination


def close_only_json(value):
    return json.dumps(value, separators=(",", ":")).replace("</", "<\\/")


def replacement_values(data, encoder):
    map_source = open(builder.MAP_TEMPLATE, encoding="utf-8").read()
    return {
        "__BUILDER_CONVERTER__": builder.read_converter(),
        "__BUILDER_TEMPLATE__": encoder(build.strip_regions(map_source, "user")),
        "__BUILDER_AUTHORED__": encoder(builder.load_authored(data)),
        "__BUILDER_COLORS__": encoder(builder.color_table()),
        "__BUILDER_VERSION__": build.read_version(),
    }


def assemble_mutant(data, encoder=close_only_json, sequential=False):
    page = open(builder.BUILDER_TEMPLATE, encoding="utf-8").read()
    replacements = replacement_values(data, encoder)
    if not sequential:
        return build.replace_placeholders(page, replacements)
    # Deliberately wrong: an authored placeholder spelling is rescanned by a later replace.
    order = ("__BUILDER_CONVERTER__", "__BUILDER_AUTHORED__",
             "__BUILDER_TEMPLATE__", "__BUILDER_COLORS__", "__BUILDER_VERSION__")
    for placeholder in order:
        page = page.replace(placeholder, replacements[placeholder])
    return page


def write_hostile_pair(destination):
    os.makedirs(destination, exist_ok=True)
    data = make_hostile_data(os.path.join(destination, "data"))
    good, _ = builder.assemble(data=data)
    bad = assemble_mutant(data, close_only_json)
    good_path = os.path.join(destination, "builder-hostile.html")
    bad_path = os.path.join(destination, "builder-hostile-close-only.html")
    for path, text in ((good_path, good), (bad_path, bad)):
        with open(path, "w", encoding="utf-8", newline="") as f:
            f.write(text)
    return good_path, bad_path


def strip_output(text, path):
    with open(path, "w", encoding="utf-8", newline="") as f:
        f.write(text)
    output = io.StringIO()
    with contextlib.redirect_stdout(output):
        result = verify_tool.cmd_strip(path)
    return result, output.getvalue()


def main():
    with tempfile.TemporaryDirectory() as td:
        real_out = os.path.join(td, "builder.html")
        real_run = run_builder(os.path.join(REPO, "data"), real_out)
        check("builder command exits zero", real_run.returncode, 0)
        check("builder command creates its requested output", os.path.exists(real_out))
        real_bytes = open(real_out, "rb").read()
        real_html = real_bytes.decode("utf-8")
        check("builder stays below 400 KB", len(real_bytes) < 400 * 1024)
        check("builder stays below the 300 KB stop threshold", len(real_bytes) < 300 * 1024)
        check("summary names output path", os.path.abspath(real_out) in real_run.stdout)
        check("summary names a size", bool(re.search(r"\(\d+\.\d KB; template \d+ B", real_run.stdout)))
        version = build.read_version()
        check("builder visible chrome states the root version",
              '<div>Version %s</div>' % version in real_html)
        check("assembled builder has no unfilled version token",
              "__BUILDER_VERSION__" not in real_html)

        no_cache = os.path.join(td, "data-no-cache")
        shutil.copytree(os.path.join(REPO, "data"), no_cache,
                        ignore=shutil.ignore_patterns("_generated"))
        no_cache_out = os.path.join(td, "builder-no-cache.html")
        no_cache_run = run_builder(no_cache, no_cache_out)
        check("no-cache builder exits zero", no_cache_run.returncode, 0)
        no_cache_bytes = open(no_cache_out, "rb").read() if os.path.exists(no_cache_out) else b""
        check("no-cache and real-tree builders are byte-identical", no_cache_bytes, real_bytes)

        # The no-cache negative control: one generated-cache read fails before assembly.
        try:
            build.load(os.path.join(no_cache, "_generated", "manifest.json"))
        except (FileNotFoundError, SystemExit) as exc:
            cache_mutant_message = str(exc)
            cache_mutant_failed = True
        else:
            cache_mutant_message = ""
            cache_mutant_failed = False
        check("direct missing-cache read fails on the no-cache tree", cache_mutant_failed)
        check("direct missing-cache read names generated manifest",
              "manifest.json" in cache_mutant_message)

        source = open(BUILDER_SCRIPT, encoding="utf-8").read()
        tree = ast.parse(source)
        imported = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                imported.update(alias.name for alias in node.names)
            elif isinstance(node, ast.ImportFrom) and node.module:
                imported.add(node.module)
        check("source has no generated-cache path token", "_generated" not in source)
        check("source has no cache-directory constant", "CACHE_DIRNAME" not in source)
        check("source does not import importer for I/O", "import_pack" not in imported)
        check("source does not call cache or pack resolvers",
              "ensure_cache" not in source and "resolve_pack" not in source)

        no_segs = lambda text: '"segs"' not in text
        check("built builder has no quoted segs key", no_segs(real_html))
        check("control: segs predicate rejects synthetic geometry",
              no_segs('{"segs":[[1,2,3,4]]}'), False)
        config = os.path.join(REPO, "data", "pack.local.json")
        pack_path = (json.load(open(config, encoding="utf-8"))["pack"]
                     if os.path.exists(config) else r"C:\machine\maps\Pack")
        excludes_path = lambda text, path: path not in text
        check("built builder omits remembered machine path", excludes_path(real_html, pack_path))
        check("control: path predicate rejects the path itself",
              excludes_path(pack_path, pack_path), False)

        source_template = open(builder.MAP_TEMPLATE, encoding="utf-8").read()
        builder_source = open(builder.BUILDER_TEMPLATE, encoding="utf-8").read()
        notice_needles = ("Required Notice:", "Code terms:", "Map data is not covered")
        builder_notice = [line for line in builder_source.splitlines()
                          if any(needle in line for needle in notice_needles)]
        map_notice = [line for line in source_template.splitlines()
                      if any(needle in line for needle in notice_needles)]
        check("builder and map carry the same three notice lines",
              map_notice, builder_notice)
        embedded_template = json.loads(builder.extract_payload(real_html, "template"))
        user_template = build.strip_regions(source_template, "user")
        author_template = build.strip_regions(source_template, "author")
        check("embedded template equals current user edition", embedded_template, user_template)
        check("control: author edition differs from embedded template",
              embedded_template == author_template, False)

        user_rc, user_scan = strip_output(user_template, os.path.join(td, "user-template.html"))
        user_forbidden = [line for line in user_scan.splitlines() if line.startswith("FORBIDDEN")]
        user_missing = [line for line in user_scan.splitlines() if line.startswith("MISSING")]
        user_forbidden_tokens = {
            match.group(1): int(match.group(2))
            for line in user_forbidden
            if (match := re.match(r"FORBIDDEN\s+(\S+)\s+x(\d+)$", line))
        }
        check("user template scan returns the expected failures", user_rc, 1)
        check("user template scan has the exact unfilled-token set",
              user_forbidden_tokens, {"__CRED__": 1, "__VERSION__": 1})
        check("user template scan has zero missing declarations", user_missing, [])
        author_rc, author_scan = strip_output(author_template, os.path.join(td, "author-template.html"))
        author_forbidden = [line for line in author_scan.splitlines() if line.startswith("FORBIDDEN")]
        check("control: author scan has many forbidden tokens", author_rc == 1 and len(author_forbidden) > 1)
        check("control: author scan sees standalone export", "exportStandaloneHTML" in author_scan)

        hostile_root = os.path.join(td, "hostile")
        good_hostile, bad_hostile = write_hostile_pair(hostile_root)
        hostile_html = open(good_hostile, encoding="utf-8").read()
        hostile_authored = builder.load_authored(os.path.join(hostile_root, "data"))
        for name, expected in (("template", user_template), ("authored", hostile_authored),
                               ("colors", builder.color_table())):
            payload = builder.extract_payload(hostile_html, name)
            check("hostile %s payload has no bare less-than" % name, "<" not in payload)
            check("hostile %s payload round-trips" % name, json.loads(payload), expected)
        close_only_html = open(bad_hostile, encoding="utf-8").read()
        check("control: close-only escaping leaves a bare less-than",
              "<" in builder.extract_payload(close_only_html, "authored"))

        check("one-pass assembly preserves authored placeholder spelling",
              hostile_authored["continents"]["Testland"]["meta"]["zones"]["beta"]["name"],
              "Literal __BUILDER_TEMPLATE__ value")
        sequential = assemble_mutant(os.path.join(hostile_root, "data"),
                                     builder.json_for_builder, sequential=True)
        check("control: sequential replacement consumes authored placeholder",
              "Literal __BUILDER_TEMPLATE__ value" in sequential, False)
        check("control: sequential replacement changes output", sequential == hostile_html, False)

        embedded_colors = json.loads(builder.extract_payload(real_html, "colors"))
        colors_run = subprocess.run(
            [sys.executable, os.path.join(REPO, "scripts", "pack_colors.py"), "--json"],
            cwd=REPO, capture_output=True, text=True, encoding="utf-8", check=False)
        cli_colors = json.loads(colors_run.stdout)
        check("embedded colour table equals pack_colors.py --json", embedded_colors, cli_colors)
        dropped = dict(embedded_colors); dropped.pop(next(iter(dropped)))
        check("control: dropping one embedded colour differs", dropped == cli_colors, False)

        converter = open(builder.CONVERTER, encoding="utf-8").read()
        embedded_converter = builder.extract_payload(real_html, "converter")
        check("embedded converter is byte-identical source text", embedded_converter, converter)
        check("embedded converter retains raw less-than regex", ".replace(/</g," in embedded_converter)
        rewritten_converter = converter.replace("</", "<\\/")
        check("control: converter rewrite changes bytes", rewritten_converter == converter, False)
        check("control: converter rewrite corrupts raw regex",
              ".replace(/</g," in rewritten_converter, False)

        attacks = ("</script", "</ScRiPt", "<script", "<!--")
        for index, attack in enumerate(attacks):
            path = os.path.join(td, "unsafe-converter-%d.js" % index)
            with open(path, "w", encoding="utf-8") as f:
                f.write("safe();" + attack + "unsafe();")
            try:
                builder.read_converter(path)
            except SystemExit as exc:
                check("converter refusal %r names its file" % attack, path in str(exc))
            else:
                check("converter refusal %r names its file" % attack, False)
        lowercase_only_refused = ["</script" in attack for attack in attacks]
        check("lowercase-close-only expression misses mixed attacks",
              all(lowercase_only_refused), False)

        missing_data = os.path.join(td, "missing-off")
        shutil.copytree(FX_DATA, missing_data)
        missing_meta_path = os.path.join(missing_data, "continents", "Testland", "continent.json")
        missing_meta = json.load(open(missing_meta_path, encoding="utf-8"))
        del missing_meta["zones"]["alpha"]["off"]
        write_json(missing_meta_path, missing_meta)
        missing_run = run_builder(missing_data, os.path.join(td, "missing.html"))
        missing_text = missing_run.stdout + missing_run.stderr
        check("missing authored off is refused", missing_run.returncode != 0)
        check("missing authored message names continent, zone, key",
              all(token in missing_text for token in ("Testland", "alpha", "off")))

        validate_source = inspect.getsource(import_pack.validate_cache)
        match = re.search(r'missing = \[k for k in (\([^\n]+\))\s*\n\s*if not az', validate_source)
        check("validate_cache authored-key tuple is parseable", match is not None)
        canonical_keys = ast.literal_eval(match.group(1)) if match else ()
        check("AUTHORED_KEYS equals validate_cache tuple", builder.AUTHORED_KEYS, canonical_keys)
        check("control: removing builder-side key fails pin",
              builder.AUTHORED_KEYS[:-1] == canonical_keys, False)
        check("control: removing importer-side key fails pin",
              builder.AUTHORED_KEYS == canonical_keys[:-1], False)

        tiny_data = os.path.join(td, "tiny-number")
        shutil.copytree(FX_DATA, tiny_data)
        tiny_meta_path = os.path.join(tiny_data, "continents", "Testland", "continent.json")
        tiny_meta = json.load(open(tiny_meta_path, encoding="utf-8"))
        tiny_meta["zones"]["alpha"]["cx"] = 0.00001
        write_json(tiny_meta_path, tiny_meta)
        tiny_run = run_builder(tiny_data, os.path.join(td, "tiny.html"))
        tiny_text = tiny_run.stdout + tiny_run.stderr
        check("sub-1e-4 authored number is refused", tiny_run.returncode != 0)
        check("numeric refusal explains lower bound", "below 1e-4" in tiny_text)
        raw_tiny = json.load(open(tiny_meta_path, encoding="utf-8"))
        check("plain json.load accepts the rejected tiny number",
              raw_tiny["zones"]["alpha"]["cx"], 0.00001)

        check("builder contains exact Required Notice",
              "Required Notice: Copyright (c) 2026 AtlasDelve" in real_html)
        check("builder contains PolyForm URL",
              "https://polyformproject.org/licenses/noncommercial/1.0.0" in real_html)

    print()
    print("RESULT: %s" % ("PASS" if not fails else "FAIL: %s" % fails))
    return 1 if fails else 0


if __name__ == "__main__":
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--write-hostile", default=None)
    args, rest = parser.parse_known_args()
    if rest:
        parser.error("unexpected arguments: %s" % " ".join(rest))
    if args.write_hostile:
        print("\n".join(write_hostile_pair(os.path.abspath(args.write_hostile))))
        sys.exit(0)
    sys.exit(main())
