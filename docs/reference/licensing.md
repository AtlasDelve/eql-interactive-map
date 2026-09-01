# Licensing and distribution — the reasoning

`AGENTS.md` → *Licensing boundary* states the rules. This file argues them: why the license is the one
it is, why the boundary sits where it sits, and why the distribution set is what it is. [`LICENSE`](../../LICENSE)
owns the operative scope of each regime and this file never restates it — where the two appear to
disagree, `LICENSE` wins and the drift is a bug to fix here.

## Source-available, not open source — and the distinction is checkable

The code is under **PolyForm Noncommercial License 1.0.0**, ratified 2026-07-28. That is
**source-available**, and calling it open source is not a loose synonym but a false claim a reader can
verify:

- NC's noncommercial term is a **field-of-use restriction**, which fails **OSD #6** ("No
  Discrimination Against Fields of Endeavor").
- It fails **FSF freedom 0** ("run the program for any purpose").
- It is **not OSI-approved.** It *is* SPDX-listed as `PolyForm-Noncommercial-1.0.0`, and an SPDX
  listing carries no approval — the list is an identifier registry, not a conformance body.

So the phrase everywhere is "source-available, noncommercial." This supersedes an earlier
"full OSS eventually" direction.

**The choice is locked, and the OSS counter-argument was put and answered rather than overlooked.**
Revisit only under specific pressure — a named contributor, channel or user requirement — not a
general re-examination. Do not propose MIT or another license unasked.

**Why locking the restrictive license before first publish was the recoverable order:** MIT → NC
cannot recall copies already released, while NC → MIT is trivial for the copyright holder. The
asymmetry is the whole argument, and it only worked while nothing had been published.

## The boundary moved for the repository, not for the output

Traced geometry is converted from a pack the user already has into a git-ignored cache under
`data/_generated/`; what is committed is the authored layer. So **the repository redistributes no
traces at all** — that is what the split buys.

**The built HTML still embeds them.** A distributed artifact therefore remains subject to its
geometry sources' terms no matter how clean the repository is. This is why `map-import` alone could
never make the project distributable and why the builder is the primary deliverable: `builder.html`
embeds no geometry, so it is the only artifact whose licensing follows the code license alone.

The builder page and each generated map state the approved PolyForm Required Notice, code/data
boundary, and fan-use/non-affiliation notice in visible chrome. Their exact placement and the guard
that keeps the two source copies aligned are documented in [`builder.md`](builder.md) → *Notice
placement and disclosure*; the notice communicates the boundary but does not grant redistribution
rights for embedded geometry.

## Three sources, three regimes

Depth in the game client's `maps/` tree decides which regime a file belongs to. The per-zone
resolution mechanics, the measured divergence between root and pack files, and the root-coverage
figures live in [`pack-import.md`](pack-import.md) — they are not repeated here.

| Source | Whose work | Consequence |
|---|---|---|
| A pack subdirectory (`maps/Brewall/`, `maps/Good's Maps/`) | that pack's authors | manually installed community data; the provenance this project claims |
| The `maps/` **root** | Daybreak | the files the game ships; a different regime entirely |
| The authored layer under `data/` | this project's decisions *about* Daybreak content | see below |

**The authored layer is the subtle one, and it is easy to overclaim.** Zone names, colours, centroids,
adjacencies and costs are this project's decisions, but what they *describe* is EverQuest content:
"EverQuest" and the zone and place names are Daybreak/Darkpaw trademarks and the game content is their
copyright. The correct statement is that the project **operates under fan-use tolerance** — not that
it holds no copyright in the names, and not that it holds one. Those are three different claims and
only the first is right.

**Client string tables and archives** (`dbstr_us.txt`, `eqstr_us.txt`, the `.eqg`/`.s3d` files) are
Daybreak-authored. Reading them to cross-check a name or an ID is fine; copying their contents into
`data/` changes what the committed layer *is*, which is why that is a decision to surface rather than
make.

## Why what ships is ruled rather than open

Ruled 2026-08-05, with the measurements in hand:

**`builder.html` ships on its own** and is the primary product. It embeds no geometry, so it is the
one artifact this project can hand out without passing on anyone else's work.

**Three prebuilt maps also ship** — one from the client's `maps/` root, one from Brewall, one from
Good's Maps — each naming its source and crediting that source's authors.

**The reasoning behind offering prebuilts at all:** a prebuilt saves the user one gesture they can
already perform themselves, from files already on their disk. Shipping the builder while refusing
every geometry-bearing prebuilt would have mooted the question rather than answered it, since the
user's own build is identical to the one withheld.

**Attribution is not a license, and that was stated before the ruling rather than discovered after
it.** Neither pack grants redistribution rights and neither does Daybreak; disclaiming ownership is
correct practice and changes nothing about permission.

**Checked 2026-08-05: `maps/Brewall` and `maps/Good's Maps` held `.txt` files and nothing else** — no
license, readme or terms file. **Read that as a measurement of two directories on one date, not as a
standing property of map packs.** A pack author may add terms at any time, and a pack nobody here has
examined may already carry them, so the durable rule is to check the pack in hand rather than to rely
on this figure. Absent any statement, the default is all rights reserved, and any permission would
have to come from the pack's own authors — **and the two packs do not point at the same place.**
Measured 2026-08-31 over the installed packs: Brewall's `_2` layer carries `http://www.eqmaps.info`
(alongside `Return_of_the_Exiled_(www.roteguild.org)`), so eqmaps.info is Brewall's contact point
and Brewall's alone. **Good's Maps names no site at all** — across 2 190 files and 1.79 M lines it
contains zero URLs, and its only attribution is the author string `Map_by_Goodurden` (with
`Map_updated_by_Goodurden`, `Labels:__Goodurden` and a `<RoI>` variant). So for Good's Maps there is
no published contact point in the pack, which is a harder position than Brewall's, not an easier one. **The ruling is a risk decision taken deliberately** — recorded as such
so a later session does not mistake it for an oversight and reopen it.

**One measurement worth keeping, because it prevents a wrong inference:** Brewall's
`Original_Map: EverQuest_Default` credit on 59 of 94 attributed zones does **not** mean its geometry
carries Daybreak's copyright — 0 of those 59 match the root files' line counts, at a median divergence
of 2.44×, which reads as retracing rather than copying.

**A root-sourced build is a deliberate deliverable, not an accident to catch.** Its geometry is
entirely Daybreak-authored, and it is partial by construction. That is why the rule in `AGENTS.md` is
to check `manifest.json` against what a release note claims, rather than to forbid the build.
**Read `discovered[].from` for that, not `rootZones`.** `rootZones` counts authored rostered zones
that fell back to the root, so it reads `0` for the Good's and Brewall builds even though each takes
one zone (`newsebexp`) from the client's own files — a check gated on it would call a mixed-source
artifact single-source, which is the failure the rule exists to prevent.

## `.author.html` — why the suffix is load-bearing

`.gitignore` protects author artifacts two ways, and **neither pattern matches a file named like the
user distributable**: `/dist/` is path-anchored, and `*.author.html` exists specifically to catch a
build written elsewhere in the repo (its own comment says so).

So an author-edition export named `eql-interactive-map.html` defeats both guards at once, and an
author-surface file becomes indistinguishable from a shippable one by name, by extension, or by any
repo guard. **Both failure modes are silent**: handing the authoring surface to players who cannot use
it, and committing it. `browser.test.js` pins the download name, so the rule is enforced rather than
remembered — and any new author-side HTML export inherits it, because the guards are pattern-based
and will not notice a new filename.

## `pack_colors.py` is code, and the reason is in which half is a fact

Its **keys** are facts about the pack's files — which colour appears in whose tracings. Its **values**
are hex colours this project chose for rendering. A fact about someone else's data does not make the
file theirs; the rendering decision is ours, so the file carries the code license like any other
script.

## The edition split is not a licensing rule

It reads like one because concealment used to be its justification, and it is not. The rule and its
current rationale live in `AGENTS.md` → *Two editions, one template*. Nothing about the split turns on
licensing, and **repo privacy is not a precondition for anything** — the project publishes its source.
