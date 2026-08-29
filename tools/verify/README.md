# Verification

Ad-hoc verification for the generated map. **Not** a build dependency and not run by
anything automatically — `scripts/build.py` still needs nothing but the Python standard
library.

```bash
python tools/verify/run.py                # everything available
python tools/verify/run.py --quick        # skip the 18 MB artifact loads
python tools/verify/run.py --no-browser   # skip the real-browser pass

cd tools/verify/js && npm install         # once, for layers 2-4
```

Layer 1 (Python) runs from a bare clone with no dependencies. The converter/lift parity gates and
real-artifact number round-trip need Node but only its built-ins, so they run whenever Node exists
even without `npm install`; `--quick` skips their real-pack/18 MB cases but not the fixture-scale
ones. The remaining layers 2–4 need `npm install` in `tools/verify/js`; without it they are skipped
with a notice rather than failing.

## The four layers

| | Layer | What it covers |
|---|---|---|
| 1 | Python | Marker-walker and declaration-locator mutation tests; `inject()` data escaping; credit formatting/escaping/substitution order; the pack importer against a synthetic pack; browser-builder embedding, closed inputs, cache-independence, refusals and script-data escaping; strip completeness; CLI artifact LF bytes; injected-data equivalence between editions; catalog differential, source-freshness and artifact travel-tail contracts; JS-canonical number spellings; ref-hint collision check. |
| 2 | jsdom, ~100 KB fixtures | Overlay build/apply/resolve, hide-restore, ghost alpha, author-edition guards, script-close escaping through the standalone export, browser-builder adapter/conversion identity modulo line endings (`assertSame` normalizes them); the browser-built artifact's LF bytes are asserted here, and the CLI artifact's independently in layer 1, so normalized parity establishes byte identity. Covers tokenization/report/download seams, travel-graph **semantics**, and world-link anchoring mechanics. Fast, and canonical data can be **mutated to simulate an update**. |
| 3 | Node + jsdom, real 18 MB artifact | JavaScript parse/stringify identity for all injected blobs after normalizing the intentional `<\/` script-safety escape (Node-only, no installed modules); smoke on both editions; travel search and real routes; the drawn route's state, lifecycle, per-level position sources, realm accounting and leg navigation; the untouched-overlay invariant across all 11 continents; view-vs-edit timing. |
| 4 | Real browser | The builder directory picker and conversion, `FileReader`, drag-and-drop, genuine downloads, the CSS cascade, and the rendered bitmap. |

Layer 4 uses `playwright-core` against an **already-installed** Chromium-family browser
via `executablePath`, which avoids the ~150 MB `playwright install` download. It searches
Brave, Chrome and Edge in the usual places; override with `EQL_BROWSER=/path/to/browser`.
No browser found means the step is skipped, not failed. It always launches a throwaway
profile, never yours.

## Why each layer exists — bugs caught, and gaps closed

Written down because each one is a mistake worth not repeating:

- **Map geometry parity is live across CPython and dependency-free Node.** `mapgeom.test.js`
  compares raw IEEE-754 bits for explicit-sqrt `norm` and untransformed `costBetween`, while
  `tpoint`/`tinv` compare at the injected half-even one-decimal boundary. It also covers all
  resolver tables, discovery classifiers, detail/exit recovery, the four doorway/fallback cost
  paths, exhaustive nearest-outline scanning, both `_cpts`/`_cpts_t` caches, and Python parity for
  degenerate `xf` shapes. Deliberate mutations proved the checks reject `Math.hypot` in either
  the helper or its production caller, plus `Math.round`, broken affine directions, last-wins
  resolution, unused aliases/overrides/exclusions, broadened filters,
  normalized display names, weakened offset/exit recovery, sampled nearest points and bypassed
  caches, including a colliding transformed-cache key, a removed transformed-point mapping, wrong
  missing-scale and rotation defaults, and reversed supplied rotation. The real-pack marker bridge
  separately injects an instrumented `MapGeom` resolver and requires tagged index and target
  consumption; its source grep is only a secondary signal. This closes the partial-resolver defect
  that could certify a verifier-local replica instead of the
  runtime resolution contract.

- **Both front ends' LF bytes are asserted independently.** `test_markers.py` requires the inline
  `build.main()` writer to disable newline translation explicitly, while `verify.py lf` scans the
  built CLI artifact's bytes. The builder jsdom test separately rejects CR in the page-composed
  artifact; together with its normalized parity comparison, the two behavioural checks establish
  platform-independent byte identity without turning a writer defect into a converter failure.
- **The geometry-free builder claim is a pair of narrower, falsifiable claims.**
  `test_builder.py` builds from the real authored tree and a copy with the generated cache absent,
  then requires byte identity; it separately parses `build_builder.py` to close the input list over
  the map template, converter, colour table, and authored files. Cache-independence by itself cannot
  disprove geometry smuggled in through an arbitrary fourth file, while the closed list is what
  rules that file out. The test builds every artifact in a temporary directory so layer 1 retains
  its bare-clone contract.
- **Builder script-data safety needs hostile authored text.** Production authored data and the
  colour table contain no less-than sign, so current-data assertions cannot distinguish escaping
  from no escaping. The hostile fixture puts `<!--` before a later `<script` with no intervening
  close, plus a mixed-case closing tag. Layer 1 proves every less-than sign became `\u003c` and the
  three payloads round-trip; layer 2 owns the tokenizer parse. A close-tag-only mutant is caught in
  both places.
- **The embedded template is scanned at template scope, not as an untouched whole document.**
  `cmd_strip` deliberately excises injected declarations before scanning forbidden tokens. The
  comment inside that span names standalone-export tokens required by its placement rules, so a
  whole-template scan reports a false failure and invites deleting the correct comment. The builder
  test captures `cmd_strip` output instead: the user template has only the unfilled credit and version tokens,
  while the author template is the negative control with many forbidden tokens.
- **The builder and emitted map notices are guarded at their two source surfaces.** The three
  approved notice lines are static in both `src/builder.html` and `src/template.html`; checking only
  a built builder would still pass if its embedded map copy drifted. Layer 1 compares the named
  source lines byte-for-byte, and a one-line notice mutation was confirmed to fail that assertion.
- **Builder byte identity must enter through the page's adapter and picker.** `builder.test.js`
  supplies File-like plain objects to `filesFromFileList()` and obtains `packDir`/`rootDir` from
  `packChoices()` in both the `maps/Layered` and renamed-parent cases. Hand-building `{keys, read}`
  or passing path literals would let either public seam disappear while the parity check stayed
  green. `assertSame` retains line-ending normalization so a future writer-side newline change
  cannot fail a converter test and be misread as a converter defect; the writer spelling is pinned
  separately in layer 1. The test-set `webkitRelativePath` is necessarily a jsdom fabrication; only
  the real-browser and manual layers can establish whether a browser populates it for directory
  selection.
- **The version parity guard perturbs the browser input, not the finished artifact.** The builder
  jsdom layer passes a mismatched version through the real `buildMap()`→`buildHTML()` seam and
  requires byte identity against the Python artifact to fail, while the ordinary flat and layered
  cases prove the committed version matches. Appending a byte to the final output would test only
  `assertSame`, leaving a disconnected version argument or an inert stamp green.
- **Builder progress semantics are pinned through the page's own handlers.** The adapter's direct
  `onRead` assertion proves it reports each resolved file, but a test-supplied callback that also
  updated the DOM made the progress check pass after the page stopped wiring `updateProgress`.
  The page-driven assertion run-length-collapses repeated layer-file messages and pins the exact
  zone, roster position, total, and completion sequence. Its root-only layered selection jumps
  from `(1/3)` to `(3/3)` with no `(2/3)`, proving skipped zones do not turn progress into a read
  count.
- **Travel-less maps retain hubs as geography.** The builder fixture enters its captured map's
  continent and requires the draw path to enumerate every published hub in `hubScreens`, then
  hit-tests one through `pickHub`. Inspecting only the expansion-derived hidden set would leave the
  consumer broken with a green test.
- **Travel-notice visibility is pinned at both artifact scales.** The builder fixture proves the
  hidden-notice predicate rejects a travel-less map, while real-artifact smoke requires that same
  notice to compute to `display: none` when authored travel data is present.
- **Escaping ran and tokenization succeeded are different claims.** Layer 1 proves no less-than
  sign survives the JSON payload lines. The builder jsdom layer parses the hostile page, counts the
  actual script elements, and requires a global set by the last block. Merely counting opening and
  closing tag text in the bytes balances even when the real closing tag was swallowed as script
  text. The close-only mutant must fail the parse-level assertion.
- **Missing authored travel data is a supported runtime state.** The builder fixture deliberately
  has no `travel.json`; its captured map must boot, expose the persistent unavailable notice through
  computed style, and refuse to open Travel. The same test substitutes a schema-complete empty graph
  to prove that presence, rather than route count, restores the normal button and panel. The browser
  layer repeats the absent-data half through a real CSS cascade.
- **Directory selection is a browser claim, not a jsdom claim.** The browser layer passes a real
  directory to the `webkitdirectory` input, records whether Chromium populated each File's
  `webkitRelativePath`, and uses that path through the page's build button when available; it never
  assigns the property itself. A browser that omits it takes the separately logged synthetic-adapter
  fallback, leaving real directory picking for the manual gate rather than fabricating a pass. The
  same section pins the visible Required Notice, partial-build report and genuine map download.

- **The colour table is data; only `lift()` is hand-twinned.** `lift.test.js` reads all 83
  canonical RGB keys from `pack_colors.py --json`, adds threshold boundaries and a fixed-seed
  sweep, and compares the JavaScript fallback with Python. Keeping the table out of JavaScript
  leaves one behavioural function—not 83 rendering decisions—as the drift surface.
- **Fixture-scale pack conversion compares the complete artifact.** `pack-convert.test.js` runs
  flat and layered packs, one-zone and all-zone skips, and a rejected sub-`1e-4` Z through both
  languages. The skip cases pin conditional `skipped`/`links`/`DETAIL`/`HUBS` presence and the
  retained zero-zone continent; the layered case alone pins mixed-source credit and its apostrophe
  escape. It normalizes CRLF to LF because Windows text-mode output is the only permitted wrapper
  difference; every placeholder, ordered payload, and script-close escape remains in the one exact
  comparison. Wrong half-to-even rounding and Windows-1252 fallback decoding are mutation-tested.
- **Real-pack parity owns scale and source freshness.** `pack-convert-full.test.js` covers authored
  continent/zone order and the thousands of exact-half coordinates that a three-zone fixture
  cannot. Once invoked, Brewall must match the remembered cache fingerprint and the root-only case
  must be available: either mismatch is a failure naming the remediation, never a comparison that
  disappears behind `SKIP`. Both cases report the number of source files compared. The root-only
  case builds in an isolated ignored data copy and pins all 32 skipped keys, all 89 surviving keys,
  the sole `newsebexp` catalog record, and the retained empty Plane of Hate. Before deleting that
  scratch tree it requires every marker-named catalog entry to resolve from its anchor label to the
  injected zone key, with a non-zero count; the one root-only artifact is discovery-on. The
  enclosing runner may still skip the whole optional layer when the machine-local pack
  configuration or Node is absent, or under `--quick`.
- **Browser-converter parity includes discovery on its only production path.** Fixture, Brewall,
  root-only and browser-builder comparisons all use the same discovery-bearing Python artifact.
  The fixture's two-manifest differential removes only `discovered` and `discoveredPalette` from a
  copied manifest, then proves the catalog is an append that preserves authored records and palette
  indices. The Brewall pass also compares JavaScript and Python `znorm` over every accepted/rejected
  discovery key and every transition-marker label actually read, so real pack spellings exercise
  the shared resolver boundary. `derivedtravel` separately proves the authored `TRAVEL.walk` prefix
  and exact non-empty catalog tail.
- **The derived-travel check reads the artifact, not the authored graph verifier.** `verify.py travel`
  stays bare-clone-safe and owns only `data/travel.json`. `derivedtravel` instead extracts the built
  `ALL` and `TRAVEL`, requires the authored walk array as an unchanged prefix, and compares the
  ordered tail directly with manifest records whose costs were already produced during conversion.
  It also rejects absent endpoints and authored-pair collisions. Requiring at least one tail edge is
  the control against a green check with the entire merge removed; the step is skipped under
  `--quick` because it needs the real artifact and generated cache.
- **Discovered-zone runtime behaviour uses a viewer fixture, not the converter fixture.**
  `discovered-runtime.test.js` consumes an ordinary injected zone whose display name resolves from
  a neighbour's detail marker and whose walk edge stands in for the catalog-derived edge. It checks
  the marker target, click navigation, exit lookup, travel search, and planned leg/cost. The
  real-pack bridge above separately proves that conversion reaches this runtime shape.

- **A dangling *function* reference.** `getPristine()` is called from *retained* `setEdit()`
  code, so the user edition threw on the first Edit click. "Parses with no console errors at
  load" sails straight past this — hence layer 3 toggles Edit at universe, world **and**
  continent level.
- **Sparseness measured against the wrong baseline.** Antonica ships 46 non-identity
  `zoneXf` and 11 `links`; testing for identity instead of comparing against the published
  value would emit all of them as user overrides on first save. Caught by the
  untouched-overlay invariant in layer 3, which is also why that runs over *real* data.
- **Seeding every unmoved zone.** In a sparse overlay "no entry" means "untouched", which
  covers new *and* untouched zones. Caught by layer 2, because the fixture can add a zone to
  canonical data and re-apply a pre-update overlay.
- **The author's buffer poisoned by an import.** `importOverlay` ships in both editions;
  writing a sparse overlay into the author's full-snapshot buffer made the next Edit entry
  throw. Layer 2 (`author-guards`).
- **Published links silently stripped on export.** With welds detected lazily, exporting a
  continent never opened in Edit dropped its published `links`. Layer 2 (`author-guards`).
- **A marker drawn in a colour the glyph already used.** The user-added ring was `#6fe3ff`,
  exactly the spire body. Only the layer-4 pixel check could see it — a stubbed canvas
  cannot. That check now samples every published hub kind, so a future collision fails.
- **A flag hard-coded to the wrong value.** `drawWorldEditOverlay` passed `drawEndpoint` a
  literal `false` for `anchored`, so every world-link handle drew free-yellow whatever its
  state. Nothing but pixels can see that: the flag reaches no JS-observable property, and the
  free colour is the same yellow the connector line already uses — so layer 4 discriminates on
  the *green*, in both directions, rather than on the yellow being present.
- **The pack fixture is persistent and hand-written, and both halves are the point.** Half of
  what `packfx/` pins is about *bytes on disk* — a UTF-8 BOM, a Latin-1 label — which a
  generated fixture would round-trip away before the decoder ever saw them. The label includes
  byte `0x92`, distinguishing true Latin-1 (`U+0092`) from Windows-1252's printable apostrophe;
  it is deliberately not `0x85`, which Python treats as a line break. The expectations are
  written out as literals so a converter change that moves output has to move a number here too.
  Its highest-value assertion is that rounding is half-to-even: `Math.round` disagrees on 95 of
  118 real zones, so the JS twin in `no-install-builder` will fail this the day it is written,
  which is exactly when it should. Confirmed by mutation rather than by watching it go green —
  four deliberate breakages (JS rounding, `zoneOrder` palette order, bbox without labels,
  rounding before translating) were each caught by the assertion that owns them.
  The authored-label palette assertion pins the root-only regression: a source may omit both an
  authored label and its chosen colour, so conversion must append that colour after the traced
  palette without renumbering generated entries; the compose-time hard error alone only reports
  the mismatch after conversion has already produced an unusable cache.
- **The layered tree under `packfx/layered/` must mimic `maps/<Pack>/`, because the derivation is
  positional.** The base layer is `--pack`'s *parent* when that parent is named `maps`, so the
  fixture nests `maps/Layered/` inside `maps/`. `packfx/pack`'s parent is `packfx`, which is why
  every flat assertion in the file is untouched by layering — and `root_layer(PACK) is None` is
  asserted explicitly so that stays true rather than merely happening to be.
  **The load-bearing detail is that root `alpha` has MORE layers than the pack's** (base + `_1` +
  `_2` against base + `_1`), so a per-layer merge — the wrong design — **fails** here instead of
  passing: it would pull in `alpha_2.txt`, an extra grid seg, an extra palette entry and the
  root's `to_Root_Only` label. Confirmed by mutation, both branches of the cascade: dropping the
  base-first pass (the naive "any pack layer file wins") is caught by `delta`, which is the live
  `tutorial` case in miniature; making root win over pack is caught by ten assertions at once.
  `delta`/`eta`/`zeta`/`epsilon` sit deliberately outside every roster — `resolve_zone_source` is
  a pure function of the filesystem, so they pin cascade rules 2–5 while conversion, which walks
  only the roster, never sees them. Two traps if you edit it: the palette is pinned as an
  **explicit literal, never as "one longer than the flat run"** (layering drops root `alpha_2.txt`
  at the same moment `gamma` adds an entry, so the two cancel and a length relation could pass or
  fail for unrelated reasons); and every empty-assertion on the flat pack (`root is None`,
  `rootZones == []`) is **paired** with a confirmed non-empty layered counterpart, since alone
  they pass with the whole feature deleted.
- **The `skip-zone` fixture keeps travel references after removing `gamma`.** Its two added
  three-/multi-stop routes distinguish leg filtering from deleting an entire route, and the test
  reads `TADJ` directly because `tPlan`'s node filter would otherwise mask a surviving bad walk
  edge. The fixture's published `beta|gamma` link is manual on purpose: the zones are geometrically
  distant, so calling it an automatic weld makes the author round-trip correctly report a deletion
  and turns the base fixture inconsistent. Layer 1 separately calls `build()` over a partial cache,
  because a viewer fixture with pre-filtered links cannot prove the build performed that filtering.
- **Two escapes with nothing testing them.** A hub label is free text, so a script-close
  sequence in one would end the `<script>` element it is baked into. `build.py`'s `inject()`
  and the client-side `esc()` in `exportStandaloneHTML` each already prevented that, and
  deleting either left the whole suite green. Layer 1 covers the Python side, the
  `script-label` fixture and `script-escape` cover both, and both were confirmed by
  removing each escape in turn and watching the suite go red — the client-side one fails as
  `Invalid or unexpected token` when the export is re-parsed, not at export time.
- **Python and JavaScript spell the same number differently.** Integral floats such as
  `-1114.0` survive Python's encoder but stringify as `-1114` in JavaScript; `datacmp` also treats
  the two as different because Python parses them into different numeric types. Integer tokens do
  not pass through `parse_float`, and Python also accepts `NaN`/infinity extensions that browser
  `JSON.parse` rejects, so the loader has explicit integer and constant callbacks too. Layer 1's
  `jsnum` rejects non-canonical spellings and unsafe integers without Node, while layer 3 performs
  the actual eight-blob
  `JSON.parse`/`JSON.stringify` text comparison after undoing `inject()`'s intentional `<\/`
  spelling. A synthetic script-close string exercises that normalization because current data has
  none. A Python negative control injects an unsafe integer into `HUBS` and requires `jsnum` to
  reject it at the exact field path, so the verifier's integer branch cannot disappear while the
  loader-only tests stay green. That Node-only comparison runs before the npm-module gate so a bare
  clone with Node keeps the sufficient backstop. `numcmp` is the before/after instrument that
  proves canonicalisation changed spelling only while preserving key order; its float coercion
  assumes both artifacts have already satisfied the safe-integer contract.
- **Placeholder values recursively interpreted as placeholders.** Running the unrestricted
  `__CRED__` replacement over a finished artifact let an injected string satisfy its guard and
  be rewritten; merely reversing the order let a pack name containing `__ALL__` trigger data
  injection into the credit, while sequential data replacements could rewrite `__META__` inside
  an earlier payload. Assembly now matches all ten map tokens against the original template in one
  pass and never scans inserted values. Layer 1 pins all three collision directions against the
  live `inject(..., credit=)` path, including HTML escaping and the fail-loud path, and checks
  longest-first matching for overlapping future placeholder names. Its JSON assertions report a
  named failure rather than crashing when a mutation corrupts a payload; `verify.py strip`
  separately rejects any unfilled credit or version placeholder.

**The travel split is not arbitrary: algorithm semantics belong in layer 2, never layer 3.**
On real data an alternate walk chain almost always exists, so a directedness or gating bug is
masked by a path that happens to work anyway — the assertion passes while the bug ships. The
fixture exists to remove those alternates: `zeta` has no walk edge and is no route's stop, so
`zeta → beta` succeeds only because an `anywhere` port reaches it and `beta → zeta` has no way
back. Layer 3 keeps what the fixture *cannot* express — search, which needs `ZIDX`, which is
built from `DETAIL`, which the fixtures ship empty.

Two shapes there worth keeping when the fixture is edited. The isolated zone lives on
**Faydwer** because the overlay, hide-io and author-guards suites hard-code Antonica's zone and
hub counts. And in each pair of parallel routes the **cheap** one is written first, so a
neighbour-keyed last-wins map keeps the wrong cost and the wrong step metadata — put it last and
the test passes by luck.

All four travel invariants were confirmed by mutation, not by watching them go green: baking
`anywhere` in as an undirected clique makes `beta → zeta` reachable, a last-wins edge map returns
Slow Ferry at 12 instead of the boat at 10 and loses the note with it, and reading the hub note
through `contData()` leaks a `TAMPERED` edit-state value into the itinerary.

**The drawn route needs both jsdom and the browser, and each catches what the other cannot.**
Layer 3 owns everything structural — that closing the panel clears `TROUTE`, that each of
`tRender`'s four early returns clears it, that a leg click leaves `focus` alone, that a nudged zone
moves the continent-level point and not the world-level one. None of that needs pixels. Layer 4 owns
the two things a stubbed canvas cannot answer: that the line reaches the bitmap at all (measured as
delta-from-a-no-route-baseline at a leg midpoint, against a control point off-route), and that its
hue is not one the map already draws. **That second check has to run with the route off.** Measured
with it on, North Ro is a wizard spire and a trip ending there puts the line and its pip inside the
glyph's own annulus, so 29px of genuine route came back as a spire false positive — the test would
have been "fixed" by loosening the threshold that was doing the work.

**Route dimming is sampled on the target zone's own outline, clear of both the route and adjacent
discovered geometry.** A 40-pixel square around North Ro's centroid also included `newsebexp`, whose
off-route outline legitimately changes when the route turns on; that contaminated the on-route
control with evidence that dimming worked. The browser test now chooses the outline midpoint with
the greatest clearance and keeps the original `> 1.5` delta ratio. Disabling dimming makes that
check fail, so relocation did not turn the control inert.

**Searchability is asserted; `ZIDX` coverage is only reported.** Every currently routed zone happens
to have a detail map, and it is tempting to lock that down — but the runtime takes zone names from
`ALL`, not `DETAIL`, so a routable zone shipped without a detail map is still searchable and the
coincidence is not load-bearing. Enforcing it would invent a constraint the code does not have
and fail the first time a plane ships routable but undetailed. The property that matters, and
what layer 3 actually asserts, is that **every routed zone is findable by typing its own name**.

## Measurement traps

- **Whole-file byte-identity is not the invariant.** Refactoring retained code legitimately
  changes the file. The invariant is the *injected data*, which is what `datacmp` compares.
- **Mean luminance cannot measure the dimmed ghost.** `hubHalo` paints a *dark* backing
  disc, so dimming the glyph dims its halo too and brighter map lines show through — a ghost
  can measure *brighter* than the solid glyph. Measure mean absolute per-pixel delta against
  a no-hub baseline instead.
- **Asserting a derived set is not asserting anything.** A test that checks what some
  lookup *contains* passes with every consumer of it deleted — the data is right and the map
  still draws the thing. Aim at what the consumer produces (`hubScreens`, the pick result,
  `TADJ`, real pixels). Measured: a sweep over ten deliberate breakages caught three, and all
  seven misses were set-level assertions over consumer-level bugs.
- **Two guards over one hole test as one.** When either of two independent checks is enough
  to make the observable behaviour correct, an observable-level test passes with either one
  deleted. Assert each against what it alone owns, and isolate the second by suspending the
  first in the page rather than by trusting the trip to fail for the right reason.
- **A sparseness test must drive the real handlers.** "Dragging a continent leaves the overlay's
  `worldConns` empty" is a claim about the `cmove` branch and the mouse-up block. Assigning
  `WEDIT.meta[c].pos` directly bypasses both, so the test can never fail — it would stay green if
  someone later marked every attached link `touched`. Go in through `worldMouseDown`/`Move`/`Up` on
  a real continent hit, and assert the continent actually moved as part of it. (In the fixture,
  both world links have an endpoint at Antonica's centre and the connector pickers run first, so
  search the rect for a point that is genuinely a landmass hit.)
- **Never assert absence as a substring of a serialized blob.** Two ways it lies, and both
  bit this repo: the zone key `lakerathe` contains the string `era`, so back when the expansion
  field was spelled that way a real overlay reported a false positive; and an *empty* overlay
  reports a false pass, proving nothing. Sweep the keys, anchor the pattern, and assert on a
  structure you have first confirmed is non-empty. The field is `xpac` now and no zone key
  contains it — but keep the anchor, because the next field name may not be so lucky.

## Notes

- The page is a classic script, so its top-level `let`/`const` (`level`, `cur`, `EDIT`,
  `sel`, `editMode`, `zones`, `hubs`) are global **lexical** bindings and never appear on
  `window`. Reach them through `window.eval` — that is what `ev()` in `js/lib.js` is for.
- Fixture continent names must stay real: `buildWorldCache` dereferences `ALL[name]` for
  every continent in the realm, so each name must exist in both `ALL` and `META`.
  (`ALTITUDES` itself is no longer a literal — it derives from `META[c].alt`.)
- `fixture.py` writes `META` in a deliberately **different key order** from `ALL`, mirroring
  the skew in real `data/`. The `ALTITUDES` derivation must iterate `names`, and emitting both
  in one order here would leave the fixture unable to tell that from iterating `META`.
- Compare rendered positions with a tolerance, not float identity: an anchored item
  round-trips through `lx`/`ly` at 1e-4, and scale plus rotation amplifies that.
- `_out/` and `_fx/` are generated and git-ignored.

## Verifying a risky refactor — the `datacmp` procedure and its two traps

`AGENTS.md` states the invariant (the *injected data*, not whole-file byte-identity) and that
`datacmp` cannot span a rename. The procedure lives here.

For a risky refactor, capture a build *before* your change and `datacmp` against it. Build that
reference from the **working tree**: a committed `dist/` may be stale.

**`datacmp` cannot span a change to a structure's own declaration name or a `META` key.** `extract()`
grabs fixed openers and `cmd_datacmp` walks a fixed key tuple, so pointed at an artifact built before
such a rename it raises on the opener — which reads as data corruption and is not. Compare with a
throwaway script using a **name map**, normalising the old side. Two traps inside that:

- Rename a `META[c]` key by **rebuilding the dict in original key order**. `d[new]=d.pop(old)` moves
  the key to the end and `datacmp` compares order-sensitively, so a correct rename then reports DIFF
  on every continent.
- **Delete `dist/` first.** A stale artifact makes the comparison pass while proving nothing.

## Why `verify.py travel`'s reachability output is shaped the way it is

`AGENTS.md` states the authoring obligation (the two declared allowlists, and that a
`TRAVEL_AWAITING` entry gets deleted as its route is authored). The report's shape is decided here.

**Deliberately not enforced: "every routed multi-zone continent's walk graph is one component."** It
holds on today's data, but as a rule it would force a fictional walk edge the first time a zone is
legitimately transport-only. Reachability is reported as a component list instead.

**That report computes components twice** — once over ungated routes, once with every capability
granted — because a zone reachable only through a gated route is correct behaviour, not a gap.
Collapsing the two made Plane of Fear (reachable only via its gated portal) print beside the planes
that have no route at all, so the expected case read as broken. A single-zone component is now
labelled *gated-only* or *unreachable by any route*, and only the latter raises a warning.

## Adding a ninth injected structure — what breaks, and where

`AGENTS.md` states that this is not a one-line change and names the files. The specifics:

`inject()` takes the structures **positionally**, so a ninth breaks `tools/verify/test_markers.py`
and `tools/verify/fixture.py` — the latter in *three* places, since `variant()` unpacks and returns
its own tuple separately from `base_data()`.

- `test_markers.py`'s synthetic `PAY` payload must satisfy **every** `LOAD_CRITICAL` entry, or
  `strip_regions` aborts before the marker behaviour under test is reached.
- Its `TPL` placeholder list is **index-sensitive** — one assertion reads line 4 as the `HUBS`
  payload — so a new placeholder goes on the **end**.
- `verify.py` enumerates the structures in five places: the `grab()` calls, the `cmd_datacmp` key
  tuple, the `cmd_numcmp` key tuple, the `cmd_jsnum` key tuple, and `REQUIRED`. The Node
  `jsnum.test.js` specs are a sixth extraction site. (`extract()` is a hand scanner because it must
  find balanced JSON boundaries through nested values and escaped strings; opener-qualified lookup
  also skips prose mentions. There is no regex tuple of declarations to update, though a review once
  cited one as live.)
