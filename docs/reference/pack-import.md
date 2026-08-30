# The pack importer — `scripts/import_pack.py`

Authoritative for `scripts/import_pack.py`, `scripts/pack_colors.py`, the `data/_generated/`
cache, pack provenance, and anything derived from one pack's geometry.

Part of the `eql-interactive-map` reference set, pointed at from `AGENTS.md`'s routing table.
**`AGENTS.md` states the rules; this file carries the reasoning behind them** — the measured
figures, the alternatives tried and rejected, the derivations. Where the two disagree, that is a
bug to fix in place, not a precedence question.

Regenerates the traced geometry from a user-supplied map pack into the git-ignored
`data/_generated/`, so the repo need not carry data it does not own. It is **not** part of the
build and nothing reconverts automatically: an explicit re-run refreshes, and `build.py`
validates the manifest rather than repairing it. A silent auto-reconvert would be the same
"a cosmetic change moves data without anyone deciding it should" failure the travel graph's
authored-cost rule exists to prevent.

**Coordinates round with Python's `round()` — half-to-even — and this is load-bearing.**
Measured over all 118 non-stale zones: half-to-even reproduces the committed data **118/118**,
while `floor(x+0.5)` (JS `Math.round`) reproduces **23/118**. The pack has 16 938 exact `.5`
coordinates and detail y is negated, so the two rules disagree constantly and in both
directions. **`no-install-builder`'s JS twin therefore cannot use `Math.round`** — it needs an
explicit half-to-even helper, and the cross-language identical-output test is what will catch
it. Note the colour fallback in `pack_colors.py` deliberately uses the *other* rule; two
rounding rules in one converter is a trap, so both are commented where they sit.

**Injected JSON uses JavaScript's number dialect, even when its source file does not.** Python's
encoder preserves an integral float as `-1114.0`, while `JSON.stringify` emits `-1114`; worse,
Python parses those spellings as different types, so the order-sensitive `datacmp` sees them as a
real difference. The authored layer contains **382** `.0` floats (302 in `travel.json`, 80 across
ten `continent.json` files), computed detail bboxes add **409**, and one authored value is `-0.0`.
By contrast, browser-exported `layout.json` and `world.json` contain none, so canonicalising all
JSON through `build.py`'s one loader makes injection consistent with the editor's existing dialect
rather than creating a third one.

The loader returns an integer whenever a parsed float is integral, rejects Python's non-standard
`NaN`/infinity extensions, rejects nonzero fractional values below `1e-4`, and keeps every integer
within JavaScript's conservative safe range (`2^53 - 1`). The lower float guard is about notation:
Python switches to an exponent spelling before JavaScript does. The integer guard is about precision:
`9007199254740993` is preserved by Python but parses and re-emits as `9007199254740992` in
JavaScript. Some larger integers happen to round-trip exactly, but accepting a scattered subset is
a brittle contract and would not make arithmetic on them safe.

There are no rejected values in the tree today. Applying Python callbacks to generated geometry is
the cost of keeping the rule in one loader: one measured build made **4,932,196** integer-callback
calls and **1,460,652** float-callback calls, overwhelmingly over generated coordinates and preserved
`segz` that build composition does not consume. Nine alternating warm samples in one process,
against the same cache, measured the complete safe-number loader at **1.392 s** median
(1.334–1.415) and the exact float-only parent at **0.930 s** (0.913–0.955), a **+0.462 s**
increment. The largest injected integer is only **52,206**. The guard remains deliberate despite
that headroom: an ordinary Python build and the browser twin must reject the same unsafe input
domain, rather than relying on a later optional verification run to discover that they accepted
different inputs. A specialised geometry loader would avoid much of the cost but split one
invariant across two code paths, so the single loader remains the trade until measured authoring
latency justifies a different validator.

## The DOM-free JavaScript twin — transliteration traps

`src/pack_convert.js` receives bytes and authored objects through callbacks; it does not own a
filesystem, DOM API, cache, or copy of `PACK_COLORS`. The table crosses the language boundary as
comma-separated RGB keys, while `lift()` is the sole hand-translated colour function. Keeping the
table as an argument prevents a second rendering-decision source from drifting.

Python's `float()` grammar and JavaScript's numeric conversions disagree in both directions:
JavaScript accepts blank strings and base-prefixed integers that Python rejects, while Python
accepts embedded digit underscores and `inf`/`nan` spellings that `Number()` does not reproduce
uniformly. The twin validates the ASCII form first, removes only legal digit separators, and then
converts. It deliberately rejects Python's Unicode decimal digits: no pack uses them, and a loud
rejection is safer than silently accepting a different value.

Python's `int(float(v))` truncates toward zero, so its JavaScript twin is `Math.trunc`. `Math.floor`
is wrong for negative values, while `| 0` additionally narrows the result to a signed 32-bit
integer.

Python `splitlines()` recognizes bare CR, vertical tab, form feed, record separators `0x1c`–`0x1e`,
NEL, and Unicode line/paragraph separators in addition to LF; Python `strip()` also differs from
JavaScript `trim()` at `0x1c`–`0x1f`, NEL, and `U+FEFF`. The twin spells out both sets. This is
parser parity rather than robustness: a different split changes which record owns a field-count
failure.

`TextDecoder('latin1')` is the WHATWG Windows-1252 decoder, not Python's ISO-8859-1 fallback. The
twin maps fallback bytes directly to same-valued code points. Its UTF-8 decoder already consumes
one leading BOM, matching Python's explicit one-BOM strip; adding a second JavaScript strip would
wrongly remove a second BOM that Python preserves, while stripping the Latin-1 path would be wrong
for the opposite reason.

The browser path has no generated-cache round trip, so it re-applies the cache loader's number
domain explicitly: finite values only, no nonzero fraction below `1e-4`, and no magnitude beyond
JavaScript's safe integer range. It walks the eight composed structures and validates preserved
`segz` when produced, reporting the original value and its path; otherwise the twin could emit an
artifact the ordinary Python build refuses.

The map's eight data placeholders and separate credit/version placeholders are assembled in one
non-recursive pass over the original stripped template. Sequential replacement would let a pack
name or injected string containing a later placeholder spelling become active template syntax.
The browser twin also uses a function replacement so JavaScript cannot reinterpret replacement
tokens such as `$&`; exact parity would not reveal either error until an input happened to carry
one of those spellings.

**Discovery ordering is ordinal, never locale-sensitive.** Python's `sorted()` uses Unicode
code-point order; the browser twin uses JavaScript's deterministic UTF-16 code-unit order, which
agrees for the ASCII filename stems discovery can produce. `localeCompare` is wrong on this path
because it uses ICU collation under the end user's host-default locale and can therefore change
injected key, palette and travel-edge order. The two ordinal orders diverge only for non-BMP keys,
whose surrogate pairs sort before U+E000–U+FFFF in UTF-16; observing such a key is a stop-and-ask,
not permission to silently introduce a second comparator convention.

**A zone's `off` is a FLOAT pair and translation happens before rounding.** Only 14 of 118
offsets are integral. This is what `AGENTS.md` previously recorded as "exact-integer agreement
is only 20/120" between the detail and continent frames — that figure is *not* evidence of the
two files being rounded independently, it is the signature of a fractional offset, and it
disappears once the offset is stored as a float. Applying an integer offset to the
already-rounded detail value reproduces exactly those 20 zones and no more.

**Palette allocation iterates `detailZones`, never `zoneOrder`.** They differ — Odus lists
`erudnext, tox, erudnint, …` against `erudnext, erudnint, tox, …` — and both orders yield a
palette of the *same length*, so a `zoneOrder` traversal permutes the tail with no length error
to notice it by. Indices are embedded in every detail seg, so that is a wrong colour on every
seg using them. First-seen over `detailZones` × layers `base,_1,_2,_3` × **`L` and `P` records
alike**: a label's colour shares the seg namespace, which is why P lines participate. Colours for
authored labels that survive composition are appended afterward only when absent. Appending keeps
every traced index stable; limiting it to surviving labels keeps a richer pack from acquiring an
unused authored colour merely because it supplied the same label itself.

**Pack RGB → display hex is a table, not a rule, and cannot be fitted.** The original importer
lifted the pack's colours for a dark canvas — `(255,0,0)` ships as `#ff4545`, black as
`#afafaf` — and it is not in this repo. Hue is preserved and dark colours are lifted, but the
shape is refuted by one pair: `(0,50,0)` and `(0,64,0)` both normalise to `(0,205,0)` yet ship
as `(9,205,9)` and `(8,206,8)`, so no "normalise then adjust" pipeline can separate them. The
83-entry table in `scripts/pack_colors.py` was recovered from the committed palettes, verified
collision-free across all 11 continents. `lift()` approximates an unseen colour and the
manifest counts every such hit, so a pack needing many is visible rather than silent. **Do not
spend time re-deriving the transform** — that search is closed.

**A zone may author labels the pack does not carry, and Ocean of Tears is the only live case.**
`continent.json` → `zones[zk].labels` holds `[x, y, "#hex", size, text]` entries that
`compose_detail` appends to the traced ones. It exists because re-importing `oot` dropped
`to_East_Freeport` and `to_Butcherblock_Mountains`, and **those two were never pack content** —
in the pre-split committed file they sat *after* the `_2` attribution block, and the import
concatenates base/`_1`/`_2`/`_3` in that order, so nothing from the pack can follow the credits.
They also reused an existing palette slot where a real `240,0,0` label would have allocated its
own, and carried size 3 where every traced label in that zone is size 2. They had been
hand-written into a file the data model called "static imported source". So this is not an
exception to the licensing boundary: it moves authored data into the layer it always belonged
in, exactly as `name`/`color`/`cx`/`cy` were promoted. (The pack's *separate* `oceanoftears`
variant carries the same connection as one `&`-joined label, which is evidently the source.)

**Two rules keep it from becoming a hatch for putting regenerated content back under version
control.** An authored label may only supply what the pack **lacks**, and **the pack always wins
a collision** — the authored copy is skipped, never duplicated and never allowed to override.
And the colour is authored as a **hex resolved against the palette at compose time, never as an
index**: indices are assigned during conversion and shift when a pack changes, so a stored index
silently recolours. Conversion appends a surviving authored label's missing hex after every traced
colour, preserving all generated indices. A hex still missing at compose time is a hard error: it
means the cache and authored layer were not converted together, rather than inviting a guess.

**A collision is a counted notice and must not be an error, and the reason is `multi-map-pack`.**
Whether a pack ships a given label varies *by pack* — Brewall's `oot_1.txt` has no transition
markers while the pack's own `oceanoftears` variant carries that same connection — so failing
the build would punish whoever installed the richer pack. `convert()` records every collision in
`manifest.authoredLabelCollisions` with continent, zone and label text, so "the authored entry
may no longer be needed" is reported without being decided.

## Layered resolution — the `maps/` root as a base layer under the pack

`AGENTS.md` states the rule: `--pack`'s parent, when named `maps`, becomes a base layer the
chosen pack overwrites **per zone**. The reasoning:

**The authored roster is a candidate list, not a pack-coverage requirement.** `convert()` still
walks `continent.json` rather than discovering zones from the pack — names, placement and colour
remain authored decisions — but a rostered zone absent from both layers is skipped instead of
aborting the whole continent. Its key is recorded in that continent's `skippedZones`, while
`zones` remains the full authored roster: the former says what this pack could supply and the
latter says which authored roster the cache was built against. Keeping those claims separate is
what lets authored completeness remain pack-independent, and putting the skip list under the
continent is what lets it survive an `--only` seed.

**Missing and unusable are deliberately different states.** No source directory means a coverage
gap and takes the skip path. A chosen directory whose zone files contain no `L` or `P` record is a
broken pack and remains a hard error: falling through or treating it as absent would let a blank
pack file silently select another source, reintroducing the cross-source mixing that per-zone
all-or-nothing resolution makes unrepresentable.

**The measured root-only result is 89 surviving zones and 32 skips across five continents.** The
skips are Antonica `runnyeye`; Odus `hole`; Kunark 17 named keys; Velious 12 named keys; and Plane
of Hate `hateplane`. The 89 survivors are 88 authored root-supplied zones plus the discovered
`Antonica/newsebexp` append. Plane of Hate therefore remains in `ALL` with an empty `zones` object
and its one-key skip list, while `DETAIL` and `HUBS` omit it. The real-pack parity test pins the
complete per-continent skip and survivor arrays, not only these counts. Keeping every continent
preserves authored order and keeps the partial-build author interlock observable even when a whole
continent is missing.

**Composition filters only structures whose identity depends on a surviving zone.** Detail and
geometry skip the absent key. `HUBS` is never compacted because travel anchors address the
published array positionally; the entire set is omitted only when the continent has no surviving
zone. Links with a skipped endpoint are filtered because otherwise the sparse overlay records a
false user deletion (14 of Kunark's 19 links, against none of Antonica's 11, in the root-only
measurement). Connectors are coordinate pairs whose `ref` is only a hint, so assigning one to a
zone at build time would be forbidden re-derivation. `placed` and `unplaced` have no runtime or
export consumer and stay whole rather than creating a second roster claim.

**Why per-zone all-or-nothing rather than per-layer.** A merged zone is two different tracings of
the same room superimposed — the 69/120 divergence and `arena.txt`'s 3480-vs-503 `L` lines are the
measure of how different. The design makes mixing *unrepresentable* rather than tested-against:
resolution returns **one directory**, which `parse_zone` and `zone_files` both take, so there is
no code path that could interleave two sources. Measured cost of all-or-nothing: **0** zones under
Brewall, **4** under Good's Maps (`commons`, `highpass`, `innothule`, `kerraridge`, whose base
lives in the pack while only the root has a `_1` POI layer). Those four keep the pack's tracing
and forgo the root's labels — the correct trade, but it means "all-or-nothing loses nothing" is
true of Brewall specifically, not of packs in general.
The client's own map UI also has a pack selector, so choosing one directory's whole zone mirrors
the game's behaviour rather than inventing a stricter model only for this converter.

**Why root is derived, not a flag.** `<install>/maps/<Pack>` is the only layout the client
supports for a manually installed pack, so the parent directory already carries the answer; a
`--maps-root` flag would let the two disagree and `data/pack.local.json` would need a second
field. `--pack` pointed *at* the root therefore derives nothing (its parent is the install
directory), which is the decided behaviour rather than an oversight.

**Why the derivation is lexical — `abspath`, not `realpath`.** Layering follows the path the user
typed. Resolving junctions or symlinks would switch layering on or off for the same directory
reached under two aliases, so the same pack would import differently depending on which spelling
was used. The `normcase(parent) == normcase(a)` guard in `root_layer` cannot fire today — only a
filesystem root is its own parent and a root's basename is empty, which the `maps` test already
rejects — so it is there to keep a future loosening of that test from reintroducing a
self-resolving source. Note `maps/maps` is *not* the pathological case: it resolves to the root
above it, which is correct.

**The cascade's derivation is one measured instance.** Orphan zones — a directory with `_N` layer
files and no base `<zone>.txt` — number **12** in Brewall, **22** in Good's Maps, **0** in the
root. **Those figures are case-FOLDED, and the folding is the point**: the resolver's probe is
`os.path.exists`, which is case-insensitive on Windows. Case-sensitive set arithmetic gives 22 and
23, over-counting Brewall by 10, so anyone re-measuring pack coverage must fold — and a pack's
effective coverage is therefore filesystem-dependent, which nothing else in this repo is. Exactly
**one** orphan shadows a root base file under either folding: Brewall's `tutorial`, which carries
`tutorial_1.txt` and no `tutorial.txt` while the root has `tutorial.txt`. A naive "any pack layer
file wins" resolves it to the POI layer, yields **empty geometry** (continent geometry is the base
layer alone), and passes `validate_cache` because the file exists — a zone that renders as
nothing. That single instance is the whole reason the cascade is base-first, and why
`baselessZones` is recorded per continent and asserted rather than merely printed. A possible
follow-up, not done here: `validate_cache` could reject a geometry file with zero segs.

**Why the `SCHEMA` bump is not hygiene.** `validate_cache` never reads `sources`, so a schema-1
cache would keep building fine. What the bump makes unrepresentable is a schema-1 manifest seeded
into a schema-2 `--only` run: it would contribute continents with no `from`/`rootZones`, so the
summary would report "no zones from the root layer" while an untouched continent had one — a
silent false negative on a claim that now carries licensing weight. `--only` calls
`validate_cache` *before* seeding, so the stale manifest is rejected with `cache schema 1,
expected 2` instead.

The 2→3 bump closes the same hole for partial coverage. A schema-2 continent has no
`skippedZones`; seeding it unchanged into a schema-3 `--only` run would make the merged manifest
under-count gaps on every untouched continent. Schema 3 also validates the field before treating
it as authoritative — list of strings, unique, and within the authored roster — because an invalid
skip declaration otherwise turns a healthy generated file into content the builder silently drops.
File absence alone never grants the exemption: only declared membership does, so an undeclared
cache hole remains corruption rather than becoming a skip.

**Anything that must survive `--only` lives under `manifest["continents"][cont]`.** The `--only`
seed copies only `continents`; the counter-example is `unknownRecords`, which is top-level and
therefore already under-reports on such a run. That is why `from`, `rootZones` and
`baselessZones` are per-continent. The root-layer summary is gated on the **zone list**, never on
top-level `root`, for the same reason: an `--only` run whose `--pack` sits outside `maps/` nulls
top-level `root` while untouched continents still carry `rootZones`.

The skip notice has the opposite scope on purpose: it lists only the continents converted by this
run, and its supplement hint is chosen from this run's resolved `root`. A merged manifest can carry
skips from an untouched continent converted under different layering; combining those old skips
with the current run's top-level `root` would confidently give the wrong remediation. Restricting
both the list and hint to the current `order` makes their provenance agree by construction.

**`looks_like_root_maps` warns about a mistake, not about a licensing regime — word it from
usability, never from provenance.** Its durable costs are that the root supplies **88 of the 120
rostered zones** — only 9 of Kunark and 5 of Velious — and that the pack's tracings are lost on the
**69 zones where both directories hold a same-named file**, when pointing `--pack` at the pack would
have yielded both layers. Its own message ends by saying so. "Root geometry is Daybreak-authored
rather than community-pack" describes a root build accurately but is **not** a reason to warn, since
a root-sourced prebuilt is a deliberate deliverable; it also invites the licensing-signal reading the
next paragraph rejects.

**`from` names the LAYER, not the licensing regime.** `"pack"` means "the directory `--pack`
named". That is a community pack in every supported invocation, but a user who points `--pack`
straight at `maps/` gets every Daybreak file tagged `"pack"` — nothing is wrong with the tag, yet
`packNote` asserts that directory *is* a community pack and that assertion goes false. Only the
`root` layer is *known* to be Daybreak-authored; read the pack layer's regime from `pack` plus
`warnings`. **Rejected:** gating `packNote` on `looks_like_root_maps` having fired. That heuristic
keys on a directory name and a `*_2.txt` count (it fires hard on the real root — **2** grid files
against Brewall's **577**), so gating a licensing string on it makes the regime statement
probabilistic, which is worse than a note that is occasionally over-broad.

**The build credit follows the same evidence boundary.** A selected directory whose basename is
`maps` is described neutrally as the selected maps folder; the name alone cannot establish who
authored its contents, for the same reason `looks_like_root_maps` only warns. A non-empty
per-continent `rootZones` list is stronger evidence: it records zones resolved through the derived
base layer, so the mixed-source clause may name how many came from the game's own maps. The exact
credit format is canonical because the browser converter must reproduce the Python artifact byte
for byte.

**`from` is excluded from `sourceFingerprint` deliberately.** Identical bytes from two
directories produce identical geometry, so every geometric claim printed beside the digest holds
either way; the provenance record is `sources[].from`, and the pair
(`sourceFingerprint`, `rootZones`) already answers "same content, different provenance".

**Two consequences of a root-sourced zone, neither a fault.** Palette allocation is first-seen
over `detailZones`, so a root-sourced authored zone early in that list **renumbers the tail** —
exactly why the whole-continent minimum exists. And root `newsebexp` uses 7 distinct RGB values,
**2 absent from `pack_colors.PACK_COLORS`** — `(160,120,60)` → `#cd9a4d` and `(85,184,20)` →
`#5fcd16` — so its discovered palette tail makes `unseenColors` non-empty. That is the report
path working without changing existing authored palette indices.

## The discovered-zone catalog

Unrostered base files are detected across the same pack/root cascade, but acceptance still requires
authored game knowledge: the fixed exclusion table rejects ruled residue, while a candidate must
carry a layer-1 transition to an authored zone in exactly one continent. Discovery never changes a
`zoneOrder`; it writes generated `geometry/<key>.json` and `detail/<key>.json` plus an ordered
`manifest.continents[continent].discovered` record. Each record carries the resolved source layer,
display-name provenance, placement and centroid, and its conversion-time walk edges with stored
costs. Sorted candidate key then sorted neighbour key is the append order used by `ALL`, `DETAIL`
and injected `TRAVEL`.

Placement has two explicit paths. If the selected anchor layer has one unresolved reciprocal marker,
the two rounded doorway points solve an exact translation and supply the display name. Otherwise the
candidate key is the name and its named doorway is placed at the nearest point on the anchor outline.
That fallback is deliberately arbitrary but legible (`nameFrom: "key"` and per-edge `named`); guessing
a reciprocal from a different layer would break the one-directory source model. Both placement and
walk cost are traced facts about the selected inputs, so reconversion against another pack may move
them. A user overlay cannot: it exists only at runtime, while the catalog was already written.

**Discovered provenance is a second digest namespace.** `discoveredSources` uses the same
`{bytes, sha256, from}` records as `sources`, with its own count and fingerprint. Keeping it separate
preserves `sources` as the authored-roster inputs. The Node adapter hashes captured bytes for each
namespace independently and compares both to the Python manifest; `verify.py discoveryfresh`
recomputes the discovered digest from disk. Production browser conversion is one in-memory pass and
returns only its ephemeral catalog/source report—it computes no hashes, writes no manifest, and
injects no report-only state. Manifest `rootZones` remains authored-only; credit and
`root_layer_zones()` additionally count root-sourced discovered records.

**Discovered colours never enter `palette.json`.** The shared palette and its `paletteSize` remain
the authored-roster conversion result. New colours form `discoveredPalette` in sorted candidate-key
order and first-seen written-detail order within each candidate. Their detail indices begin at
`paletteSize`; the build always composes and injects `palette.json + discoveredPalette`. A
two-manifest differential strips only the catalog and tail from a copied fixture manifest to prove
the authored palette and records remain byte-identical. This allocation point keeps existing indices
stable and makes a permuted tail observable through literal-order tests rather than only range
checks.

## Anything geometry-derived is a fact about ONE pack, and must say which

The rule generalises past labels, and `multi-map-pack` is what makes it bite: the packs share a
coordinate frame but differ in *coverage* (L-line ratio 0.22–1.55, bbox delta up to 4 289 units
on `overthere`), so weld detection, proposals and doorways all differ by pack.

**Identify a pack by content, never by path.** The same path can hold a different revision and
the same pack can sit at different paths, so `manifest.sourceFingerprint` is a sha256 over
sorted `(filename, sha256)` pairs and the path is only a human hint. `--audit` prints both.

**And `overrides` rulings are pack-conditional, so the audit reports rather than prescribes.** A
ruling exists because *some* pack's geometry could not derive an edge; this proposal agreeing is
not evidence that every supported pack's does. Advice to "drop this entry" would ping-pong
between packs — it says review the ruling across supported packs instead. The blast radius stays
small only because `--audit` never writes and is not a build step; authored edges and costs are
untouched, so pack choice can never move routing. Per-entry pack/reason metadata is the natural
growth when `multi-map-pack` is actually built.

**Do not hand-edit anything under `data/_generated/`** — it is regenerated, so the edit
evaporates on the next import. Authored labels are the supported route.

The cache is **lossless where the committed data was not**: it keeps `segz` (Z) and `seglayer`
(the layer role), both discarded by the original import and both blocking a roadmap item
(`level-filter`, `3d-zones`). Nothing at build time reads them; they exist so the next consumer
needs no second re-import. That is why it is 28 MB against the 17.6 MB it replaces — irrelevant,
since it is git-ignored.

## What the preserved Z actually shows — measured, do not re-measure

`AGENTS.md` states only that the cache keeps `segz` and that nothing at build time reads it. The
measurements behind the `level-filter` / `3d-zones` roadmap items live here.

Stacking is real and worst in the dungeons the roadmap names. Measure it per cell (rasterise a zone's
XY at 50×50, count distinct Z clusters within each cell at a 15-unit gap): Velketor's is **74% of
cells carrying 2+ levels at a 78-unit median spread**, then Blackburrow 56%/37, Highkeep 56%/26,
Hole 45%/16, Sebilis 40%/8. **Median spread is the discriminator, not the percentage** — Qeynos
reaches 24% of cells at a 1.0-unit spread, which is one surface with a wall on it, not two floors.

Two instruments that look right and are not: *footprint overlap between the two Z-halves* cannot
separate a continuous surface at varying height from superimposed floor plans, and ranks dungeons
**below** outdoor zones, i.e. exactly backwards; and *global Z banding* finds one band in every
dungeon, because connecting passages make Z continuous across the whole range. Deriving per-segment
level ids therefore means connected-component labelling over the segment graph, not a threshold.

## Provenance, measured

`AGENTS.md`'s licensing boundary carries the *rules* about which regime a pack file belongs to. The
evidence behind them:

- The 1:1 correspondence between a pack file's `L` lines and `segs` — in order, under a per-zone
  translation plus the Y-flip — was **checked on 16 zones across 12 continents**.
- `<zone>.txt` is line geometry: **117 of the 120 carry no `P` line at all**, and the three that do
  (`highkeep`, `runnyeye`, `unrest`) carry five or six. **All 120 zones carry at least one layer
  file in the pack layer** — a claim about the pack specifically, not about resolution, which can
  now also reach the root — and `_3` exists for exactly one zone.
- That `geometry/*.json` is the base file alone and `detail/*.json` is base+`_1`+`_2`+`_3`
  concatenated in that order was **not** inferred from totals — it was checked segment-by-segment
  against the concatenated source stream, and since the re-import it holds **120/120 exactly, byte
  for byte**. `tools/verify/test_import_pack.py` guards it. The superseded 119/120 and 118/120
  figures were the two stale zones (`nektulos`, `oot`) and are gone.
