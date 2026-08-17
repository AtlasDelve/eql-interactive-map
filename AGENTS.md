# AGENTS.md

Project guidance for any coding agent working in this repository: what the project is, how to
build it, the data model, the verification rules, and the licensing boundary. Claude Code loads
this through an import in `CLAUDE.md`; other agent tools read it directly.

## What this is

An interactive drill-down map of Norrath for **EverQuest Legends** (universe → world → continent → zone detail). The deliverable is a single self-contained HTML file with **no runtime dependencies**, generated from a versioned data tree by a Python build script.

## Subsystem references — read the matching file before you edit or review

This file carries the invariants and the traps; the *reasoning* behind each — measured figures,
alternatives rejected, the derivation behind each constant — lives in one file per subsystem under
`docs/reference/`. **These are not background reading. Read the matching file before changing or
reviewing that code, or you will re-litigate a decision that already has a measurement attached to
it.** Where a row names two files, you need both.

| If you are touching… | Read first |
|---|---|
| `data/travel.json`; walk edges, transport routes (boats, ports, spires), route costs, `access`, `overrides`, adjacency, doorways; `scripts/derive_travel_graph.py` | [`travel-graph.md`](docs/reference/travel-graph.md) |
| the travel module in `src/template.html` — search, `tPlan`, the itinerary, `TROUTE`, `tRender`, route drawing at any level, `focus`/`zoneDimmed`, the zone legend | [`travel-runtime.md`](docs/reference/travel-runtime.md) |
| `META[c].xpac`, `XPAC_*`, `recomputeXpac`, `ALTITUDES`, the expansion picker, `META` field semantics | [`expansion-selection.md`](docs/reference/expansion-selection.md) |
| `EDIT`/`WEDIT`, `contData()`, `buildOverlay`, `applyContOverlay`/`applyWorldOverlay`, anchoring, the localStorage buffers | [`customization-overlay.md`](docs/reference/customization-overlay.md) |
| hubs, connectors, welds, `links`, `zoneXf` — editing them *or* reading them as evidence | [`customization-overlay.md`](docs/reference/customization-overlay.md) + [`travel-graph.md`](docs/reference/travel-graph.md) |
| `scripts/import_pack.py`, `scripts/pack_colors.py`, `data/_generated/`, pack provenance, `detectLinks`, the derived detail offset | [`pack-import.md`](docs/reference/pack-import.md) |
| `src/pack_convert.js` — the DOM-free browser twin of pack import and build composition | [pack-import.md](docs/reference/pack-import.md) + Build pipeline below |
| `src/builder.html` — the no-install builder page, directory/pack picker, browser file adapter, progress, report, download | [`builder.md`](docs/reference/builder.md) + [`licensing.md`](docs/reference/licensing.md) |
| `scripts/build_builder.py` — assembling the no-install builder and its embedded authored inputs | [`builder.md`](docs/reference/builder.md) + Build pipeline below |
| `scripts/build.py`, `strip_regions`, `inject()`, the edition markers, `exportStandaloneHTML`, adding an injected structure | Build pipeline and Two editions below; [`travel-runtime.md`](docs/reference/travel-runtime.md) for declaration placement |
| `data/world.json`, or adding a continent | Build pipeline below (`META`), then [`expansion-selection.md`](docs/reference/expansion-selection.md) + [`travel-graph.md`](docs/reference/travel-graph.md) + [`customization-overlay.md`](docs/reference/customization-overlay.md) |
| `tools/verify/**` | `tools/verify/README.md`, plus the reference file for whatever the test covers |
| `LICENSE`; `exportStandaloneHTML` or any new author-side HTML export | [`licensing.md`](docs/reference/licensing.md) |

A change spanning two rows is the normal case, not a sign you picked the wrong file.

**A commit-time hook mirrors this table** to name the matching files from what the working tree
changed (`.claude/hooks/check-agent-docs.js`; `src/template.html` routes by *symbol* there, because
its path alone spans three subsystems). The mirror is a convenience, not a second source of truth —
**add a row here and add its path or symbol to that file in the same commit**, or the new subsystem
routes to nothing and the omission is silent.

## Commands

```bash
python scripts/build.py                    # -> dist/eql-interactive-map.html        (user edition, DEFAULT)
python scripts/build.py --edition author    # -> dist/eql-interactive-map.author.html (full authoring build)
python scripts/build.py --out PATH          # write elsewhere, e.g. the game install dir
python scripts/build.py --data DIR          # build from a different data tree (default: the repo's data/)
python scripts/build.py --pack DIR          # remember a map-pack path in data/pack.local.json
```

`--pack` **records** the path in `data/pack.local.json` and the build converts from it on first use —
`ensure_cache()` calls `import_pack.convert()`. Only `resolve_pack()` itself reads nothing, which is
what its docstring means; the command as a whole does.

Map-pack conversion, **not** part of the build (see
[`docs/reference/pack-import.md`](docs/reference/pack-import.md)):

```bash
python scripts/import_pack.py --pack DIR              # convert the whole pack into data/_generated/
                                                      # DIR's PARENT matters: named `maps`, it
                                                      # becomes a per-zone base layer (see below)
python scripts/import_pack.py --only Antonica         # refresh one continent in an existing cache
python scripts/import_pack.py --print-authored Odus   # print the continent.json "zones" block
```

No-install browser-builder assembly, also **not** part of the build:

```bash
python scripts/build_builder.py             # -> dist/builder.html
python scripts/build_builder.py --out PATH  # write elsewhere
python scripts/build_builder.py --data DIR  # embed a different authored tree
```

Travel-graph authoring tooling, also **not** part of the build:

```bash
python scripts/derive_travel_graph.py              # propose walk edges + route stubs, print the review report
python scripts/derive_travel_graph.py --out PATH   # also write the proposal JSON
python scripts/derive_travel_graph.py --audit      # diff the proposal against the authored data/travel.json
python scripts/derive_travel_graph.py --scope all  # include Kunark + Velious (default: the routed classic set)
```

Verification lives in `tools/verify/` and is **not** part of the build:

```bash
python tools/verify/run.py                # everything available
python tools/verify/run.py --quick        # skip the 18 MB artifact loads
python tools/verify/run.py --no-browser   # skip the real-browser pass
cd tools/verify/js && npm install         # once, for the jsdom + browser layers
```

`build.py` still needs **nothing but the Python 3 standard library**, and there is no linter and no CI. The only `package.json` in the repo is `tools/verify/js/package.json`, which the build never reads; the Python layer of `run.py` works from a bare clone with no `npm install`, and the jsdom/browser layers skip with a notice when dependencies are absent. `dist/`, `tools/verify/_out/` and `tools/verify/_fx/` are git-ignored; rebuild them rather than committing them.

`docs/internal/` is git-ignored personal planning — specs, implementation plans, session handoffs, reference snapshots. Write planning material there and do **not** try to commit it. `docs/reference/` is the committed per-subsystem reference set this file routes to (see the routing table above); `docs/` root is for public-facing documentation. **A plan goes to `docs/internal/<topic>-plan.md`, named for its topic** — a later session told to "execute the plan" is working in the repo, and a generated name it cannot guess is as good as no plan at all.

**Use `--edition author` for your own map-authoring work** — the default build has no repo-export buttons. The default is `user` on purpose: forgetting the flag at release ships the safe artifact, whereas forgetting it while authoring is obvious within seconds.

## Two editions, one template

`src/template.html` is a single source stripped down to one edition at build time. Regions are delimited by markers in both comment syntaxes, so a region can wrap JS or markup:

- `/*__AUTHOR__*/ … /*__END_AUTHOR__*/` and `<!--__AUTHOR__--> … <!--__END_AUTHOR__-->`
- `/*__USER__*/ … /*__END_USER__*/` and `<!--__USER__--> … <!--__END_USER__-->`

`strip_regions(text, edition)` deletes the other edition's regions and removes the retained edition's markers. It is **non-greedy** (each opener pairs with the *first* closer after it, so a mispaired marker can never swallow the file body) and **fails loud**: unbalanced markers in either direction raise `SystemExit`, and afterwards it asserts no marker token survived *and* that every `LOAD_CRITICAL` declaration (`build.py:71`) is still present. The user edition also strips the `/*__DATA_ALL__*/`-style data sentinels, which only `exportStandaloneHTML` needs.

**Author-only:** the repo-export machinery (`buildLayoutObject`, `exportLayout`, `buildWorldObject`, `exportWorld`, `getPristine`, `spliceBetween`, `exportStandaloneHTML`, the `bExport`/`bExportHTML` buttons and bindings) and `deleteLink`. Note `downloadBlob` is **shared** — the customization export needs it — so markers there go per function, not around the block. A partial build refuses author `saveVersion`, `exportLayout` and `exportWorld`: a full snapshot would persist missing welds/transforms and an authored export would write that loss into the repo. User overlay saving/export remains available because it is sparse and carries skipped zones in `zoneKeys`. Two traps worth remembering: `getPristine()` is called from *retained* `setEdit()` code, so line must be marker-wrapped or the user edition throws on first Edit click; and `document.getElementById('bExport')` inside `configEditbar` needs a line-granularity marker because the rest of that function stays.

**Paired by edition** (same name, one definition per edition, so behaviour differs without branching at call sites): `canEditHubContent`, `canHide`, `delLinkBtn`, `lsKeyFor`/`worldLsKey`, `snapshot`/`applyState`, `worldSnapshot`/`worldApplyState`.

New UI added for the user edition feature-detects its own container instead (`refreshHiddenUI` returns early when `#hiddenBlock` is absent), which avoids a marker around every call site.

**The split is a product-surface rule, never a secrecy one — do not justify it by concealment.** A player has no repo to export into, so `layout.json`/`world.json` downloads and `deleteLink` can only mislead them, and the user edition is exactly what the builder emits. Concealment was the original rationale and it is spent, so **repo privacy is not a precondition for anything**.

## Build pipeline

`data/` tree + `src/template.html` → `scripts/build.py` → single-file HTML in `dist/`.

`build.py` reassembles eight data structures and injects their compact JSON into template placeholders `__ALL__`, `__META__`, `__DETAIL__`, `__HUBS__`, `__UNIVERSE__`, `__WORLDLINKS__`, `__TRAVEL__`, `__XPACS__`:

**Numbers reaching the injected data are JS-canonical:** integral floats are emitted as integers, non-finite extensions are rejected, and integers stay within JavaScript's conservative safe range; `verify.py jsnum` enforces the rule. `json.loads` returns an `int` for `-1114` but a `float` for `-1114.0`, so `datacmp` is sensitive to a mixed dialect and reports what looks like data corruption; the measurements and guards are in [`pack-import.md`](docs/reference/pack-import.md).

`__CRED__` and `__VERSION__` are separate non-data substitutions rather than serialized structures; the static notice and version stamp sit beside the credit, outside edition markers and data sentinels. The version comes only from the root `VERSION` file (`__BUILDER_VERSION__` stamps and feeds the browser builder), and `verify.py strip` forbids an unfilled map token. Credit, version and the eight data placeholders are assembled in **one non-recursive pass over the stripped template**: sequential replacement in either order lets a user-controlled pack name or an injected string be reinterpreted as another placeholder. `cred_text()`'s exact separators are also the cross-language contract for the browser builder.

- **`ALL[continent]`** = `{ zones, [skipped], [labels], bbox, connectors, [links], placed, unplaced }`. `zones[key]` = `{ name, segs, cx, cy, color, [xf] }`, where `segs` is an array of `[x1,y1,x2,y2]` line segments in continent-frame coords, `cx,cy` is the label centroid, and the optional `xf` = `{tx,ty,s,rot}` is the zone transform **applied at render time** by the viewer (see the data model below). `skipped` names authored-roster zones the chosen source could not supply; `links` (physical zone-link lock state) rides here too, only when non-empty.
- **`META[continent]`** = `{ pos, uc, vc, gscale, gw, gh, alt, xpac }` — places the continent on the globe/world view. Comes straight from `data/world.json` → `meta`. `pos` is editable (world-level editor) and is a free choice; the other four are **derivable from the stored bbox in one line each on 10 of the 11 continents** — `uc,vc` is the bbox centre, `gscale = gw / bboxWidth`, `gh = gw · bboxHeight / bboxWidth`, with `gw` chosen. So placing a brand-new continent on the globe needs only its bbox and a `gw`; what was marker-fit is how the *bbox* was obtained, not these numbers. **Odus is the lone exception, and it is stale rather than special** — the drift is invisible at globe scale, so anything that recomputes META from bbox will silently shift Odus; do that as a deliberate act, never as a side effect (figures and cause: `expansion-selection.md`). `alt` is the realm and `xpac` the expansion it arrives in; both are authored, and both are read by derivations rather than restated anywhere. **`META`'s own key order differs from the authored continent order** — it lists Odus before Faydwer while the draw order is the reverse — so any derivation over continents must iterate the authored order, never `META`.
- **`DETAIL[continent]`** = `{ palette, zones }` — the zoomed-in single-zone maps; `segs` here carry a palette index and label refs.
- **`HUBS[continent]`** = `[{ x, y, kind, label, letter?, note? }]` — transport hubs; `kind` ∈ `boat|spire|ring|portal|teleport`. `letter` (≤2 chars) is overlaid on the `portal` and `teleport` glyphs only (`hubHasLetter`); the optional multi-line `note` is hover-only. All five kinds are now in use, and `note` is too — the Plane of Hate and Plane of Sky `teleport` hubs carry the Alter Plane spell name and its consumed component.
- **`UNIVERSE`** = `[{ name, kind, cx, cy, r, active, [alt], [note] }]` — realm-selector entities; `cx,cy` are **viewport fractions** (editable at the universe level). From `data/world.json` → `universe`.
- **`WORLDLINKS`** = `[{ a:[gx,gy], b:[gx,gy], alt }]` — world-view connectors as **free 2-point lines in globe (0–100) coords**, realm-scoped by `alt` (editable at the world level). From `data/world.json` → `worldLinks`.
- **`TRAVEL`** = `{ version, groups, capabilities, overrides, walk, routes }` — the travel/routing graph, copied through **verbatim** from `data/travel.json`. The only structure with no per-continent assembly, and the only one nothing in the editor mutates. When the file is absent, the injected value is `{}`: the map still boots, but disables Travel and shows that travel data is unavailable. `overrides` is authoring metadata that **no runtime code reads** — it exists for `derive_travel_graph.py --audit` — and it ships anyway because the copy is verbatim. 283 bytes in an 18 MB artifact, so stripping it would buy nothing and would cost the one property that makes this structure easy to reason about.
- **`XPACS`** = `{ order, default, labels }` — the expansion roster, oldest first, copied through verbatim from `data/world.json` → `xpacs`. Read-only like `TRAVEL`, and its declaration sits on the adjacent line for the same two placement reasons. `labels` has exactly one consumer, the HUD picker; if that ever stops needing display names, delete the field rather than shipping one `verify.py` cannot know is dead. **The field is `xpac`, everything a user reads says "Expansion", and neither gets renamed to match the other; the two surviving `era` spellings are also deliberate** — reasons in `expansion-selection.md`.

**Adding an injected structure is not a one-line change**, because `inject()` takes them **positionally**. A ninth touches `tools/verify/test_markers.py`, `tools/verify/fixture.py` (in *three* places) and `verify.py` (in three more) — what breaks in each, and the index-sensitivity that makes a new placeholder go on the *end*, are in `tools/verify/README.md`.

**A declaration's *placement* in `src/template.html` can be constrained in two directions at once, so moving one is never a cosmetic edit.** `TRAVEL`'s must sit **inside** the span `cmd_strip` excises, so its payload is not scanned for FORBIDDEN tokens, *and* **outside** every `/*__DATA_*__*/` sentinel block, because `exportStandaloneHTML` rewrites the whole `__DATA_ALL__` block as `ALL`/`META`/`DETAIL` and would drop anything sharing that line. `XPACS` rides the adjacent line for the same two reasons. Argued in `travel-runtime.md`.

## Data model — the core mental model

**The tree has two halves, and the split is the licensing boundary made structural.** What is
committed is *authored* — decisions this project made. What is regenerated is *traced* — the map
pack's work, which this project does not own and therefore does not carry.

```
data/                              COMMITTED (the authored layer, ~58 KB)
  world.json                       GLOBAL layout (hand-edited): { meta, order, xpacs, universe, worldLinks }
  travel.json                      GLOBAL routing graph (hand-edited): { version, groups, capabilities, overrides, walk, routes }
  pack.local.json                  machine-specific pack path, git-ignored (*.local.*)
  continents/<Continent>/
    continent.json                 structure + per-zone authored values:
                                     zoneOrder, placed, unplaced, bbox, detailZones, [labels],
                                     zones{ <zone>: { name, color, cx, cy, off } }
    layout.json                    THE hand-edited file: connectors, hubs, links, zoneXf

data/_generated/                   REGENERATED from the pack, git-ignored, never committed
  manifest.json                    schema, pack path, base-layer (root) path, per-source-file
                                   size+sha256+`from` layer, zone roster, rootZones, skippedZones
  continents/<Continent>/
    palette.json                   the continent palette (traced colours first; surviving authored-label
                                   colours appended when absent; indices are assigned on import)
    geometry/<zone>.json           { segs, segz }
    detail/<zone>.json             { segs, segz, seglayer, labels, lablayer, bbox }
```

`build()` composes the records the viewer expects from the two halves — a zone is
`{name, segs, cx, cy, color}` with `name/cx/cy/color` authored and `segs` cached. **Compose a
fresh dict with the legacy keys only**: the cache also carries `segz`/`seglayer`/`lablayer`,
which nothing at build time reads and which must never reach the injected data. Key order is
load-bearing, because `datacmp` compares order-sensitively.

Rules that matter when editing:

- **The hand-edited files are `continent.json` and `layout.json` (per continent) and `world.json` (global — continent placement on the globe, realm positions, world connectors).** The traces under `data/_generated/` are regenerated output: edit one and the next import discards it. The editor exports the authored files: **Export layout.json** at the continent level, **Export world.json** at the universe/world levels.
- **`zones[].off` is the detail-frame → continent-frame translation, and it is authored precisely so a pack cannot move a zone.** A float pair — most are fractional — applied before rounding. It was converter-computed once, against the committed geometry, and is frozen now; the converter consumes it and never writes it. Same argument as `cx`/`cy`: regenerating placement per pack would let pack choice move a travel cost. **Do not confuse it with the offset the *runtime* derives**: the viewer recovers each zone's detail-frame → continent-frame translation at render time and deliberately stores nothing, because a stored one goes stale silently on re-import. Both are float translations, which is what makes them easy to conflate — `off` is authored and frozen, that one is derived and disposable (`travel-runtime.md`).
- **A fresh clone cannot build without a map pack, and that is the point.** `build.py` validates the cache and converts on first use; with no pack it exits naming `--pack`, `data/pack.local.json`, and where packs come from. It deliberately does **not** detect staleness against an updated pack — an explicit `scripts/import_pack.py` run refreshes. A build that silently reconverted would let a pack change move the injected data with nobody deciding it should.

Two ways that export silently no-ops, both of which look like a broken build rather than a misplaced file. **Hubs, connectors, welds and `zoneXf` exist only in the per-continent export** — `buildWorldObject` returns `{meta, order, universe, worldLinks}` and nothing else, so exporting `world.json` to capture a hub edit produces a file byte-identical to the committed one. Hub edits need **Export layout.json** from inside that continent, one continent at a time. And **the download is named `<Continent>.layout.json`, not `layout.json`** (so repeated exports don't collide in Downloads) while the toast names the save *target*; saving under the download name drops an inert file next to the real one, which `build.py` never reads.
- **Zone moves are stored as an affine transform**, not by rewriting geometry. `layout.json` → `zoneXf[zoneKey] = {tx, ty, s, rot}` is **passed through by `build.py`** into `ALL[cont].zones[key].xf` and **applied at render time by the viewer** (`tPoint`, rotate/scale about the zone centroid) — it is *not* baked into `segs`. Geometry files never change when a zone is repositioned, and **what you commit to `layout.json` is exactly what renders** (no bake/un-bake indirection). Export from the editor is therefore a trivial `xf` dump.
- **Directory name transform** (`cont_dir()` in build.py): spaces → `_`, apostrophes stripped. `Erud's Crossing` → `Eruds_Crossing`.
- **Coordinate frame:** `segs` are in continent-frame units. The viewer applies a Y-flip: `wx = x*k + view.x`, `wy = -y*k + view.y`.
- **The import keeps every source line but the *injected* data drops each line's Z.** A pack `L` line is `x1,y1,z1,x2,y2,z2,r,g,b`; `ALL`/`DETAIL` `segs` are `[x1,y1,x2,y2]` with detail putting a palette index in slot 4. **Z is no longer lost** — `data/_generated/` keeps it as `segz` alongside every seg, which is what unblocks the `level-filter` and `3d-zones` roadmap items from the *data* side. What they still need is a consumer: nothing at build time reads `segz`, so surfacing it means a new injected structure, and that is not a one-line change (see the `inject()` note above). Stacking is real and worst in the dungeons the roadmap names, and deriving per-segment level ids means connected-component labelling over the segment graph rather than a threshold. The per-zone measurements, the discriminator, and the two instruments that look right and are not are in `pack-import.md` — do not re-measure them.
- **`links[].deleted` is an editor rigid-group signal, not a statement that two zones don't connect.** Do not subtract deletes blindly when deriving adjacency — on current data that shatters Antonica into 4 components and strands three zones. The working rule, and the one authored pair it still gets wrong, are in `travel-graph.md`.

### Principles the whole tree obeys

Six rules recur across every subsystem. Each is argued in the reference file named beside it; what
follows is the rule, and the vocabulary it needs.

1. **Authored vs traced is the spine, and it is also the licensing boundary.** A value that encodes a
   *decision* — a name, a colour, a centroid, a zone `off`, an adjacency, a cost — is authored,
   committed and hand-edited. A value *traced* from the map pack is regenerated into git-ignored
   `data/_generated/` and never committed. **Do not hand-edit anything under `data/_generated/`**: the
   next import discards it, silently.
2. **Never derive at build time what a cosmetic change could then silently move.** Adjacency and cost
   *are* derivable from committed geometry, and are authored anyway: deriving them would let an author
   nudge a zone for looks and change a travel route with nothing to flag it — `datacmp` cannot catch
   it, because the injected data legitimately changed. → `travel-graph.md`
3. **Facts read published data; only drawing reads live edit state.** *Published* is the injected
   `ALL`/`META`/`DETAIL`/`HUBS`/`TRAVEL` built from `data/`. *Live edit state* is `EDIT[cont]` and
   `WEDIT` — the viewer's own in-session customisation, which `contData()` returns **in place of**
   published data once it exists. So routing, expansion filtering and anything asking "what exists"
   must read published, or a user's cosmetic change silently alters their own routing or hides content
   the server does have. The live instances: `routes[].hubs` indexes published `HUBS`; `pidx` is
   always a published index; `wlBoxDist` takes a position as an argument so the two frames cannot mix;
   nothing expansion-related may read `EDIT`/`WEDIT`/`contData()`. → `expansion-selection.md`,
   `customization-overlay.md`, `travel-runtime.md`
4. **Report, never reconcile.** `derive_travel_graph.py --audit` reports drift and must never write;
   `--recost` writes and stays explicitly invoked. Nothing that silently reconciles authored data
   against regenerated data may become a build step. → `travel-graph.md`
5. **A sparse overlay compares against published, never against identity or a default.** The user
   edition serialises only what the user *touched*, which is what lets a later release's new content
   appear inside an existing customization — and `zoneXf` is non-identity on shipped data, so an
   identity test would re-emit every authored transform as a user override. → `customization-overlay.md`
6. **A constant with a measurement behind it is re-measured, not reasoned about.** `ANCHOR_THRESH`,
   `LINK_THRESH`, `WL_ANCHOR_THRESH`, `NEARMISS_GAP`, `UNITS_PER_COST` and the seconds-per-cost-unit
   anchor each carry their value *and* their derivation in their own reference file, several in units
   that do not compare across frames. `META.gscale` is the cautionary case: a cosmetic globe-fit
   factor, **not** a physical scale, and it must never be used to normalise distance.

### Conditional inclusion in `build()` — easy to break

- `labels` exists on **only some** continents (oceans, planes); it is copied through only when present. Do not drop it.
- `skipped` is emitted immediately after `zones` only when non-empty. Every authored continent stays in `ALL`, including one whose `zones` is empty; `DETAIL[cont]` and `HUBS[cont]` are emitted **only when non-empty**, and hubs are never re-indexed around a skipped zone.
- A zone's `xf` is attached **only when non-identity**; `ALL[cont].links` is emitted **only when non-empty**. **Both are populated in practice** — Antonica ships 46 non-identity `zoneXf` entries and 11 `links`, Kunark 26 and 19. So any code that treats "identity" as a proxy for "the author didn't set this" is wrong — see the sparseness rule in `customization-overlay.md`.
- In a partial build, `links` touching skipped zones are removed before injection; `connectors`, `placed` and `unplaced` remain the authored records unchanged.
- `bbox` in `ALL` is **always the stored `continent.json` bbox** — `build.py` never recomputes it (nothing is baked). The **viewer** computes a live fit-bbox (`contBbox`) from `xf`-transformed segs when a continent has any non-identity `zoneXf`; otherwise it uses the stored bbox.

## Verification

Run `python tools/verify/run.py` before claiming a change to `src/template.html` or
`scripts/build.py` is done. **`tools/verify/README.md` explains what each layer covers, which
bug each one caught, and the two measurement traps** — read it rather than inventing a check. That
README, not this file, owns *what each layer covers and which bug it caught*; keep new material of
that kind there.

Three things about the harness that bite while you are writing ordinary code, not tests:

- **Comments in `src/template.html` outside the span `cmd_strip` excises *are* scanned for FORBIDDEN tokens**, so a comment that paraphrases the spec can fail `verify.py strip`. It reads as a spurious failure and is not — the travel module in particular sits outside that span (`travel-runtime.md`).
- **The zone-name resolution tables — `znorm`/`ZIDX`/`ZALIAS`/`LINK_OVERRIDE`, which turn a label into a zone key — exist twice, once in Python and once in the template, and `travel-full.test.js` is the only thing stopping them drifting.** It recomputes every authored cost from the *template's* resolution and demands exact agreement, so a table that falls out of step surfaces as a cost mismatch rather than a quietly wrong route. Change one copy, change both (`travel-graph.md`).
- **Any sweep over all continents must select the last expansion first**, because expansion filtering applies in the author edition's edit mode too. `untouched.test.js` is the live case (`expansion-selection.md`).

`verify.py travel` checks the authored graph over `data/`. It enforces what is enforceable — schema sanity, and a **bidirectional** roster (a zone dropped from `zoneOrder` leaves dangling references, the same class of failure as a zone added) — and *reports* what depends on game knowledge. Two declared allowlists carry that split, and both exist so a gap is explicit rather than silent: `TRAVEL_UNROUTED` (Kunark, Velious — in the map, deliberately not routed) and `TRAVEL_AWAITING` (zones inside a routed continent with no route yet, because the transport leg isn't recoverable from `data/`). Delete a `TRAVEL_AWAITING` entry as its route gets authored — the check fails if a listed zone *becomes* routed, so the declaration can't rot.

Deliberately **not** enforced: "every routed multi-zone continent's walk graph is one component" — as a rule it would force a fictional walk edge the first time a zone is legitimately transport-only. Reachability is reported as a component list instead, computed twice so a gated-only zone is not mistaken for an unreachable one; why, in `tools/verify/README.md`.

Rules it can't enforce for you:

- **Whole-file byte-identity is not the invariant.** Refactoring retained code legitimately
  changes the built file. The invariant is the *injected data*, which `verify.py datacmp`
  compares (both editions must agree, including continent and zone draw order — order affects
  rendering). **And `datacmp` cannot span a change to a structure's own declaration name or a
  `META` key** — pointed at an artifact built before such a rename it raises on the opener, which
  reads as data corruption and is not. The before/after procedure and the two traps inside the
  rename workaround are in `tools/verify/README.md`.
- **Assertions on JS properties don't model the CSS cascade.** A `display:none` stylesheet
  rule silently wins when code clears an inline style, so check visibility with
  `getComputedStyle` or a real browser — never by asserting a property was set.
- **A stubbed canvas cannot verify appearance.** Anything about how something *looks* —
  dimming, a marker colour — needs the browser layer reading real pixels. A marker drawn in a
  colour the glyph already used passes every other layer.

## Keeping these instructions current

**Before every commit, re-read this file, then `CLAUDE.md`, then every `docs/reference/` file for a
subsystem you touched** — plural, because a change spanning two is the normal case. Ask one
question: did this change teach something a future reader cannot recover from the code, **or
falsify something those files already claim?** Update the file in the *same* commit when the answer
is yes — the second limb is the one that gets missed, since a change can invalidate a measured figure
without teaching anything new. No tooling can make either call for you — judging what is worth
recording is not a regex's job.

**Which file it goes in is decided by kind, not by convenience.** This file is what every session
loads before it knows what it is doing, so it stays small enough to be worth loading. There are
three destinations and they do not overlap:

- **`AGENTS.md`** — an invariant the code depends on but never states; a trap that looks like a bug
  and is not, or the reverse; a rule about *where* something goes that the tree alone does not make
  obvious; one routing line per subsystem. Nothing here should run longer than a couple of sentences.
- **`docs/reference/<subsystem>.md`** — the reasoning record: an alternative that was tried or
  considered and rejected, and why; a measured figure that would otherwise have to be re-measured; the
  derivation behind a constant; the argument for an invariant this file merely states.
- **`tools/verify/README.md`** — what each verification layer covers, which bug each one caught, and
  how to measure without falling into the two measurement traps.

**If a new fact wants a paragraph, it belongs in a reference file with at most a pointer here** — the
routing table already names the file, so there is always somewhere else for it to go. That is what
keeps this file from growing back to the 92 000 characters that forced the split.

**Where this file and a reference file disagree, that is a bug to fix in place — not a precedence
question.** This file states the rule; the reference file argues it. Neither may contradict the other.

**What belongs in none of them: these files are instructions, not a changelog.** No what-changed entries, no
dates, no version history, and no restating what the code plainly says — if a reader can get it
by reading the code, leave it in the code. When a fact here stops being true, **correct it in
place** rather than appending a newer note beside the stale one. The note about `zoneXf` being
identity everywhere is what that failure looks like: it survived as a contradiction until
someone hit it.

## Licensing boundary — constrains what you may do

**Two regimes that must stay distinct in any redistribution:** the **code** is under the **PolyForm Noncommercial License 1.0.0**; the **map data** under `data/` is not. **`LICENSE` owns the exact scope of each — read it there rather than restating it here.** So apply no code license, header or notice under `data/`, propose no publishing or monetizing of the map data, and **surface this boundary rather than deciding it yourself**. An unofficial non-commercial fan project. → `licensing.md`

**Never call this project open source.** PolyForm NC is **source-available**; the phrase is "source-available, noncommercial". Ratified and locked — do not propose MIT or any other license unasked. → `licensing.md`

**The repo redistributes no traces, but the built HTML embeds them** — the boundary moved for the repository, not for the output, so a distributed artifact stays subject to its geometry sources' terms. → `licensing.md`

**What this project distributes is ruled rather than open:** the builder, which embeds no geometry, plus three prebuilts — the client's `maps/` root, Brewall, Good's Maps — each naming its source and crediting that source's authors. **Attribution is not a license.** A built map's provenance must match its release note: check `manifest.json` (`rootZones`, `sources[].from`) before shipping one. **Still not yours to decide:** distributing anything beyond those artifacts, or restating the terms. → `licensing.md`

**Depth in the client's `maps/` tree decides the regime** — a pack subdirectory (`maps/Brewall/`, `maps/Good's Maps/`) is manually installed community data, the `maps/` **root** is what Daybreak ships — and **a zone resolves to exactly one directory, never a mix**, which `manifest.json` records. A root-sourced build is a deliberate deliverable and **partial by construction**, so its release note must say so. Figures: [`pack-import.md`](docs/reference/pack-import.md). → `licensing.md`

`dbstr_us.txt`, `eqstr_us.txt` and the `.eqg`/`.s3d` archives are Daybreak-authored too — read them to cross-check a name or ID, but **copying their contents into `data/` is a licensing decision to surface, not make**. (The install path is machine-specific and deliberately not recorded in this file.)

`scripts/pack_colors.py` is **code** and carries the code license — its hex values are this project's rendering decision, while its keys are merely facts about the pack's files. → `licensing.md`
**A pack zone is up to four files, and they are semantic layers rather than floors — which matters the moment anything is re-imported.** `<zone>.txt` is line geometry; `<zone>_1.txt` is the POI/label layer, and the `to_`/`from_` transition markers the travel graph treats as its primary source live *there*; `<zone>_2.txt` is a coordinate grid plus the pack's attribution text (`Original_Map:`, `Revised_Map:`, `eqmaps.info`); `_3` exists for exactly one zone. `geometry/*.json` is the **base file alone** and `detail/*.json` is **base+`_1`+`_2`+`_3` concatenated in that order**, verified segment-by-segment and guarded by `tools/verify/test_import_pack.py` (counts in `pack-import.md`). Two consequences: the grid and the credits ride inside `detail` with nothing marking them as non-map content, so "just the outlines" is not separable after import; and the `_1`/`_2`/`_3` suffixes are **not** vertical levels, whatever their names suggest. **A zone's whole layer set comes from exactly one directory** — resolution picks the source per zone, never per layer, so a zone is never assembled from a pack base plus a root `_1`.


**`exportStandaloneHTML` must download as `eql-interactive-map.author.html`, and the suffix is load-bearing rather than cosmetic.** Neither `.gitignore` guard — `/dist/` (path-anchored) or `*.author.html` — matches a download named like the user distributable, so such a file becomes indistinguishable from a shippable one and can be handed to players or committed to the repo, both silently. `browser.test.js` pins the name, so this is enforced rather than remembered; any new author-side HTML export inherits the rule. → `licensing.md`
