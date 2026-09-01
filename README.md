# eql-interactive-map

Interactive drill-down map of Norrath for **EverQuest Legends** — universe → world → continent → zone views, with an in-browser editor for zone placement, connectors, and transport hubs. The map is a single self-contained HTML file with **no runtime dependencies**, produced either by the no-install browser builder or by the Python authoring tools.

## Build your map

The browser builder is the intended end-user path: open it, select the `maps` folder from your game
installation, choose a community pack or the game's own maps, and download a self-contained HTML
map. Nothing is installed, uploaded, or needed when you open the finished map later.

**[Download `builder.html`](https://github.com/AtlasDelve/eql-interactive-map/releases/latest/download/builder.html)**
— a single file that runs locally from `file://`. If you would rather not build one, the
[latest release](https://github.com/AtlasDelve/eql-interactive-map/releases/latest) also carries
prebuilt maps for Brewall's pack, Good's Maps, and the game's own maps.

A **hosted page** is planned; its location will be added here when it exists.

A community pack is recommended for complete coverage. Select the game's `maps` folder rather than
the pack subdirectory inside it: the builder then offers the available packs and can use the game's
own maps as a per-zone fallback. A root-only build is supported, but it is partial and the builder
names every rostered zone it could not supply.

Coverage is reported both ways, because it can fail in both directions. The inverse of a rostered
zone with no file is a **file the roster never listed** — and those are not ignored. A map in your
pack or in the `maps/` root that the authored roster does not name is **discovered** and attached
automatically: placed on its continent, named, and routable like any other zone, with
`data/_generated/manifest.json` recording which source each one came from. So a build is a superset
of what the roster knows, not a filter on it — which is how New Sebilis Expedition reaches every
build, including the packs that do not carry it.

## Python authoring workflow

**You need map files from your game installation; a community pack is recommended for complete
coverage.** This repo does not carry traced map geometry, so it is regenerated on your machine
instead of committed. Point the build at your pack once:

```bash
# first run: name the pack, e.g. the Brewall set installed under your game's maps/ folder
python scripts/build.py --pack "C:/path/to/EverQuest Legends/maps/Brewall"
```

That converts the pack into a git-ignored cache (`data/_generated/`, about five seconds) and
remembers the path in `data/pack.local.json`, so afterwards no flag is needed:

```bash
# regenerate the map
python scripts/build.py

# or write it straight into your game folder
python scripts/build.py --out "C:/path/to/EverQuest Legends/eql-interactive-map.html"

# the full authoring build, with the repo-export buttons
python scripts/build.py --edition author

# re-run the conversion yourself, e.g. after updating the pack
python scripts/import_pack.py
```

Prefer a **pack subdirectory** (`maps/Brewall`, `maps/Good's Maps`): it supplies the community
tracings and uses the game's `maps/` root as a fallback. Pointing `--pack` at `maps/` itself is also
supported and builds every zone that the game ships there; rostered zones with no file are skipped
and named in the conversion report instead of aborting the build. A community pack supplements
those gaps. The conversion warns when the path is the root, because that is usually a mistake rather
than a choice: the game's own files cover **89 of the 120 rostered zones and skip 32** — most of
Kunark (17 of its 26) and Velious (12 of 17), plus Runnyeye, the Hole and the Plane of Hate — and
you also lose the pack's tracings on every zone where both supply a file. Pointing at the pack
instead would have given you both.

Pointing at a subdirectory is also what gets you the root's maps *where you need them*. When
`--pack`'s parent is named `maps`, that root becomes a **base layer**: your pack supplies every
zone it has mapped, and any zone it has not falls back to the game's own file for that zone. It is
per zone and all-or-nothing — a zone never mixes the two sources — and the conversion summary says
how many **rostered** zones came from the root, with `data/_generated/manifest.json` recording which
files came from where. A discovered zone's source is not in that count: it is recorded separately as
`discovered[].from`, so a build whose only root-sourced map is a discovered one still reports "no
zones from the root layer".

The conversion is not automatic after the first run — update your pack and the cache keeps the
old traces until you re-run `import_pack.py`. That is deliberate: a build that silently
reconverted could change the map without anyone deciding it should.

Open the resulting `dist/eql-interactive-map.html` in any modern browser. Requires only Python 3
(standard library) to build.

### Two editions

`--edition` picks what the generated file contains. Both are built from the same `src/template.html`.

| | `user` (default) | `author` |
|---|---|---|
| Output | `dist/eql-interactive-map.html` | `dist/eql-interactive-map.author.html` |
| Rearrange the map | yes | yes |
| Add hubs / connectors | yes | yes |
| Hide published hubs / connectors | yes (restorable) | — (deletes instead) |
| Edit published hub text, delete welds | — | yes |
| Save layout to a file | yes | yes |
| Export `layout.json` / `world.json` / standalone HTML | — | yes |

The default is `user` so that forgetting the flag ships the safe artifact. Use `--edition author` for your own map work.

## How it works

The finished map embeds eight data structures (`ALL`, `META`, `DETAIL`, `HUBS`, `UNIVERSE`, `WORLDLINKS`, `TRAVEL`, `XPACS`). Rather than hand-editing an 18 MB HTML file, this repo keeps that data split into small, purpose-scoped files and reassembles them at build time:

```
src/template.html                     the viewer/editor code (placeholders for data)
scripts/build.py                      reassembles data + template -> dist/*.html
scripts/import_pack.py                converts a map pack -> data/_generated/
data/                                 COMMITTED: the authored layer, about 75 KB
  world.json                          global layout: continent placement + order, expansions, realms, world links
  travel.json                         global routing graph: walk edges, transport routes, costs
  continents/<Continent>/
    continent.json                    zone order, placed/unplaced, bbox, and per-zone
                                        name / colour / centroid / frame offset
    layout.json                       connectors, hubs, zone-links, zone transforms  <- edits live here
data/_generated/                      REGENERATED from your pack (git-ignored, ~28 MB)
  continents/<Continent>/
    palette.json                      the continent's colour palette
    geometry/<zone>.json              one file per zone: the outline, in continent coords
    detail/<zone>.json                one file per zone: the zoomed-in detail map
dist/                                 generated map (git-ignored)
```

### Why the split

- **The traced geometry is the map pack's work, not this project's**, so it is regenerated from your copy rather than redistributed here. See *Data & attribution*.
- **Updating your pack** re-traces every zone and leaves your hand-tuned connectors, hubs, and placement in `layout.json` untouched.
- **Everything the editor changes** (moving/scaling/rotating zones, connectors, hubs, physical zone-links) lives in the tiny per-continent `layout.json`, so every edit is a small, readable git diff instead of a multi-megabyte blob change.
- **Per-zone names, colours and centroids stay in `continent.json`**, not in the regenerated files. They are decisions, and freezing them means swapping map packs cannot quietly change a zone's name or move a travel route's cost.
- **Adding a zone** means adding it to `zoneOrder`/`placed` and giving it a `zones` entry. `python scripts/import_pack.py --print-authored <Continent>` prints the block, filling in the pack's own trace bounds so you can choose the zone's `off` (where it sits on the continent); the build refuses, naming the zone, until the entry is complete.

Zone moves are stored as an affine transform in `layout.json` → `zoneXf` and **applied at render time by the viewer** (not baked into the geometry), so the static outline files stay untouched and what you commit to `layout.json` is exactly what renders.

## Customizing your map

Every level has an Edit mode (toggle **✎ Edit** in the panel, top-left). Nothing you do can break the map — you can always get back to the shipped layout.

- **Universe** — drag the realms (Norrath, The Planes, …) to reposition them.
- **World** — drag continents around the globe, and add or move world-view connectors (the dashed routes).
- **Continent** — drag zones to move them, use the blue corner to scale and the green knob to rotate; drag transport hubs and connector ends; add your own hubs and connectors; and click a 🔒 padlock to lock physically-joined zones so they move together.

Items **you** add are marked with a dashed magenta ring, so they're easy to tell from the ones that shipped with the map.

### Hiding things instead of deleting them

A hub or connector that shipped with the map can be **hidden** rather than removed, so it's always recoverable. Select it and choose *Hide this hub* / *Hide this connector*. To get it back, use the **Hidden items** panel — either tick *Show hidden* (hidden items reappear dimmed; click one to restore it) or open the **N hidden** list and restore individually or all at once. Hubs and connectors you added yourself get a plain *Delete* instead.

Published hub text (type, letter, label, note) can't be edited. If a label is wrong, hide that hub and add your own in its place.

### Saving your work

- **Save version / Revert last / History** — a disposable buffer inside your browser, scoped per continent plus one for the world view. The newest version loads automatically next time you open the map, so your arrangement is simply there.
- **Export my layout** — writes `eql-map-customization.json`, covering every continent *and* the world view. **Import layout** reads it back; you can also just drop the file anywhere on the map.
- **Reset to published map** — discards everything saved in this browser for the current level.

### Your changes survive map updates

The customization file records only *what you changed*, so when a newer version of the map adds a zone, a hub, a connector or a world route, it shows up inside your arrangement instead of being wiped out — and your own moves stay put. This works both when you reopen the map normally and when you import a customization file saved against an older release.

A few things follow from that, worth knowing:

- If you add a hub by hand and a later release adds the same one, you'll see both. Delete yours — the magenta ring shows which it is.
- A new zone is placed by following whichever neighbour you moved, so it lands next to where it belongs rather than back at its original spot.
- If a release changes an item you'd customized or hidden, that one change can't be matched up any more and is dropped. The map tells you how many, and never guesses.

## Authoring (`--edition author`)

The author build adds the durable repo exports:

- **Export layout.json** (continent level) / **Export world.json** (universe/world level) — downloads the edited data file. Drop it into `data/` (per-continent `layout.json` into `data/continents/<Continent>/`; `world.json` at `data/world.json`) and rerun `python scripts/build.py`.
- **Export standalone HTML** — bakes the current edits (all levels) into a fresh single-file map with no toolchain required. Downloads as `eql-interactive-map.author.html`: it is an authoring convenience, not a distributable (see the note below).

Here the durable source of truth is the committed `layout.json` / `world.json`, and the localStorage buffer is disposable scratch space. Note that a standalone export from the author build bakes in the authoring surface, so distribute the `user` build instead.

## Data & attribution

The code in this repository (the build script, the pack importer and the map viewer/editor) is licensed under the [PolyForm Noncommercial License 1.0.0](LICENSE). That is a **source-available** license, not an open-source one: you may read, modify, build on and redistribute the code for any noncommercial purpose — personal use, hobby projects, study, and use by charities, schools, public research bodies and government institutions — but not for commercial advantage. It is a deliberate fit for what this is: an unofficial, non-commercial fan project.

Map **geometry is traced by community map packs** such as [Brewall's EverQuest maps](https://www.eqmaps.info/). **This repository does not redistribute it.** The traces are converted from a pack you supply and already have installed, into a git-ignored cache on your machine; what is committed here is the authored layer — zone placement, connectors, hubs, the travel graph, and each zone's name, colour and centroid.

The generated HTML *does* embed that geometry, so a community-pack build is subject to the pack's
terms and a root-sourced build embeds Daybreak-authored files. The code license covers neither.
This project offers prebuilt maps from several sources, each naming the source it was built from
and crediting its authors; that credit is an attribution, not a license. "EverQuest" and
related zone and place names are trademarks of **Daybreak Game Company LLC / Darkpaw Games**, and
EverQuest game content is their copyright. This is an unofficial, non-commercial fan project, not
affiliated with or endorsed by Daybreak, and it operates under fan-use tolerance rather than under
any license granted by Daybreak.
