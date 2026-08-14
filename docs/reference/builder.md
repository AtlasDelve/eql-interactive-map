# The no-install browser builder

Authoritative for `src/builder.html`, `scripts/build_builder.py`, and the verification layers that
assemble and exercise the browser builder. `AGENTS.md` states the short rules; this file records the
reasoning behind them. Where the two disagree, that is a bug to fix in place.

## Two front ends, one converter

The command-line importer can inspect a pack's parent directory. The browser cannot: a directory
selection exposes only the selected directory and its descendants. The page therefore asks for the
game's `maps/` folder and presents the pack directories inside it. Selecting `maps/Brewall`
directly would hide the `maps/` base layer from the browser even though the command-line
`--pack maps/Brewall` invocation can derive it.

This asymmetry is why the DOM-free converter takes `packDir` and `rootDir` separately. The page
reproduces `root_layer()` exactly: a subdirectory choice receives the selected folder as its base
only when that folder is named `maps`, case-insensitively. A root-only choice never receives itself
as a fallback. The plausible broader rule—treat every selected parent as a base—would make a folder
named `EQmaps` behave differently in the browser and the command line.

The converter remains independent of browser APIs. The page owns the `FileList` adapter, pack
picker, progress, report, and download; coordinate parsing and composition stay in
`src/pack_convert.js`.

## Progress comes from reads

`convert()` needs no progress callback. It already awaits the page-owned reader once for each
resolved layer file, in authored continent and roster order. The reader reports before resolving a
read, which gives the event loop an opportunity to repaint without coupling the converter to the
DOM. Progress uses the roster position rather than a read count because an absent zone produces no
read; jumps over skipped zones are accurate while a count would finish short.

## Reports do not alter artifact parity

The converter's report is outside the generated map and may be presented for people. In particular,
unseen RGB keys arrive in lexicographic order because the converter preserves Python artifact
semantics elsewhere; the page sorts their three numeric components for display. Skip lists,
root-folder warnings, and parser errors are likewise page chrome and never inputs to `buildHTML()`.

## Notice placement and disclosure

The builder page and every map it emits carry the same three approved notice lines in visible
chrome. The map-side copy is static template text beside the credit, outside edition markers and
data sentinels, so both Python editions and the browser-emitted user edition retain it without a
placeholder or a pack-provenance read. A source-line sync guard keeps that copy byte-equal to the
builder page's notice. The notice states that map data is outside the code terms and that the
project is an unofficial non-commercial fan project without trying to restate either regime.

Shipping the builder discloses the composition, rounding, and conditional-inclusion pipeline in
readable JavaScript. It does not disclose the author editing surface because the embedded template
has already been stripped to the user edition. This is a product-surface property, not a secrecy or
repository-visibility rule.

## Assembly and the closed input set

`build_builder.py` reads the builder page, strips the map template to the user edition, loads the
authored tree with `build.load()`, generates the colour table from `PACK_COLORS`, inlines the
converter, and reads the root `VERSION` file through `build.read_version()`. Those are the complete
inputs. It does not inspect the generated cache, a remembered pack path, or a map-pack directory,
so deleting the cache cannot change its bytes.

`VERSION` is one non-empty ASCII line in the raw-substitution-safe set of letters, digits, dot,
plus and hyphen. The shared reader strips the file once and rejects anything outside that contract.
The assembler substitutes the value into visible builder chrome and a quoted
`__BUILDER_VERSION__` JavaScript literal; that same `BUILDER_VERSION` crosses the
`buildMap()`→`buildHTML()` seam to replace the map template's visible `__VERSION__` token. Reading
Git state was rejected because a downloaded builder has no repository and identical committed
inputs must produce identical bytes in both front ends.

Authored completeness is checked before the page ships. Every rostered zone needs `name`, `color`,
`cx`, `cy`, and `off`. This duplicates five key names from `validate_cache` deliberately: extracting
a shared validator would interleave cache and authored checks differently and change which failure
the ordinary build reports first. Verification parses the other site's tuple and pins both
directions of drift instead.

## Script-data escaping and raw converter text

The template, authored object, and colour table are JSON payloads embedded in a script element.
Every less-than sign in those JSON texts becomes `\u003c`. Escaping only `</` prevents a direct
closing tag but does not prevent the HTML tokenizer's `<!--` and `<script` state transitions. The
stronger rule is unconditionally safe JSON and round-trips without a custom inverse.

The stripped template contains seven astral-plane characters, so its JavaScript UTF-16 length is
seven greater than its Unicode code-point count. Cross-language length comparisons are therefore
invalid; compare the text in one language. The authored object is 41,981 code points as compact
Unicode JSON and 42,241 bytes in the emitted ASCII-only literal; the 83-entry colour table is 1,813
bytes; and the raw converter is 18,197 characters or 18,200 UTF-8 bytes. Summary sizes describe the
bytes actually embedded.

The converter is different: applying the JSON rewrite to raw JavaScript would corrupt its literal
`.replace(/</g, ...)` regular expression. It is therefore embedded byte-for-byte after a
case-insensitive refusal for `</script`, `<script`, and `<!--`. The refusal makes the raw embedding
safe without maintaining a rewritten second copy.

All five builder placeholders are replaced against the original page in one non-recursive pass.
Inserted values may contain placeholder spellings and must remain inert. The names have no prefix
overlap, preserving the longest-first matching contract used by the shared substitution helper.

## Why this is a builder page and a JavaScript twin

Embedding Python through Pyodide was rejected. Its roughly 10 MB WebAssembly runtime would need a
network fetch, so the page would no longer work as a self-contained file with no runtime
dependencies. Translating the converter into DOM-free JavaScript keeps the builder usable from
`file://`; exact output parity, rather than a shared runtime, is what keeps the two implementations
aligned.

A live-reading map page was rejected with the other end-user flows that require machine-specific
capabilities: repo-clone-plus-Python is an authoring workflow, and `showDirectoryPicker()` is
Chromium-only. The builder instead uses `<input webkitdirectory>`, which works from `file://`, reads
the selected files once, and emits the same self-contained map the command-line build produces.
The result remains usable after the source folder is no longer available.

The input is large enough that selection is part of the architecture. The supported maps tree is
340 MB on disk across 4,093 text files, while roster-and-layer filtering reads 361 files / 25.9 MB
for Brewall. Reading the entire selection first would multiply the browser's I/O for data the
converter will never inspect. The assembled builder itself is 257,425 bytes. Of that closed input,
the authored payload is 41,981 Unicode code points and 42,241 emitted bytes; the two units are kept
separate because compact Unicode JSON and the ASCII-only embedded literal are not byte-equivalent.

## Why byte identity is the parity gate

The JavaScript twin must reproduce both conversion and composition. Byte-identical generated maps
make one comparison cover half-to-even rounding, palette indices, object order, conditional fields,
escaping, credit formatting, and the final template substitution. A field-by-field checklist would
have to predict every way the implementations could drift, and would miss the next unlisted one.

That strength has an ongoing cost: every change to the generated payload or its composition must be
made in both the Python and JavaScript front ends and then re-verified for byte identity. The twin is
therefore deliberately small and DOM-free; browser presentation can change independently, but the
artifact-producing path cannot.
