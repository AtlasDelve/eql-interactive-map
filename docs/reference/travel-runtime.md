# The travel runtime and the route drawn on the map

Authoritative for the travel module in `src/template.html` — search, `tPlan`, the itinerary,
`TROUTE`, `tRender`, route drawing at every level, `focus`/`zoneDimmed`, and the zone legend.

Part of the `eql-interactive-map` reference set, pointed at from `AGENTS.md`'s routing table.
**`AGENTS.md` states the rules; this file carries the reasoning behind them** — the measured
figures, the alternatives tried and rejected, the derivations. Where the two disagree, that is a
bug to fix in place, not a precedence question.

## The travel runtime (search, pathfinder, itinerary)

The module sits between `buildLegend` and the `EDIT MODULE` banner, which puts it **outside** the
span `cmd_strip` excises — so unlike the `TRAVEL` declaration's comment block, everything written
there *is* scanned, and a comment paraphrasing the spec can fail `verify.py strip` on a FORBIDDEN
token. It also sits before `insp`/`toastEl`/`ANCHOR_THRESH` are declared: function calls hoist,
top-level `const` reads into the edit module do not.

**`routes[].hubs` indexes published `HUBS`, never `contData()`.** `contData` returns `EDIT[c].hubs`
once a continent has live edit-state, so reading the leg's reagent note through it makes the same
trip describe itself differently depending on where the viewer happened to browse — and the author
edition's hub delete splices that array, shifting every index below it. Same invariant as "cost
never reads centroids", one layer up. The note belongs to the stop you **arrive at**, so an `i→j`
leg carries hub `j`'s and the reverse leg carries hub `i`'s.

**A step therefore carries *both* of its hub anchors (`hubA`/`hubB`), because the two consumers
want opposite ends.** `note` is the arrival's, per the rule above. The glyph a continent view
should *ring* is the one you **board** at, which is the departure end — carrying only the arrival
left Antonica un-ringed on a boat out of South Qeynos, whose own dock is `Antonica:0`. An
`anywhere` port has no departure stop at all (you cast from where you stand), so its `hubA` is
`null` by construction rather than by omission.

**Build absence is static and removes legs, not routes.** `TZONES` retains every key referenced by
travel or a group, but an absent zone has `cont:null`; `inBuild` and each route's absent stop-index
set are computed once from that fact. `tBuild` drops an `anywhere` destination or a `line`/`clique`
pair only when that leg touches an absent stop. This is deliberately separate from `XPAC_ROUTE`,
whose dynamic whole-route hiding models an expansion endpoint that does not exist yet. Root-only is
the measured reason: removing Plane of Hate must not also remove the surviving Plane of Sky wizard
destination, while 12 of 74 walk edges honestly disappear because one endpoint is absent.
Tests must inspect `TADJ` for that walk-edge removal: `tPlan` independently excludes absent nodes,
so a failed trip would pass even if the edge-building guard had been deleted.

**A referenced hub is hidden when its own stop is absent as well as when expansion hides its
route.** Route hub arrays are positional beside `stops`, so the static absent-index set supplies the
answer without re-indexing published `HUBS`. An unreferenced hub cannot be assigned to a host zone
because `HUBS` stores no such key; it may therefore float if its physical zone alone is skipped.
Current data has no exposed case outside wholly absent Plane of Hate, whose entire hub set is
omitted by the build.

**Adjacency is a per-node edge *list*, not a neighbour-keyed map.** Two routes can reach the same
neighbour and a route can duplicate a walk edge; a last-wins map keeps a worse cost paired with the
*other* edge's step metadata, which returns a non-shortest path under an itinerary naming the wrong
route. Relaxing parallel edges independently keeps cost and step together by construction.

**Search results are keyed `{kind,key}` records, never display strings resolved again on
selection.** `znorm` strips parentheticals and `ZIDX`'s `put()` is first-wins, so — measured — all
three Neriak quarters normalise to `neriak`, both Felwithes to `felwithe`, both Kaladims to
`kaladim`; re-resolving a chosen label lands on whichever was indexed first. That collision set is
exactly the `groups` list, which is why a bare "Neriak" should offer the group. `ZIDX` and `ZALIAS`
are consulted only by `resolveZone`'s exact lookup, so their entries must be indexed as extra
search *terms* or aliases like "North Ro" never surface as suggestions. There is deliberately no
`the`-folded ranking tier: `znorm` already strips a leading `the` from query and term alike.

**Which capability a blocked trip needs cannot be read off the all-enabled route** — that route
also uses whatever merely made it *cheaper*, so listing its capabilities with "or" claims any one
of them suffices. Probe the disabled capabilities one at a time; only those that work alone are
genuine alternatives.

**The travel panel lives inside `#hud`, beside the button that opens it; the top-right slot is the
zone legend's alone.** An earlier arrangement had the two share that slot and hide each other,
which is why `syncLegend()` exists — it is now just "legend iff `level==='continent'`", called by
all four `enterX` functions instead of each touching `legend.style`. Being in the HUD means the
panel needs no positioning, width or scroll handling of its own. The panel deliberately **survives
level changes** — a trip in progress must not be dismissed by navigating — and its `✈ Travel`
button is shown unconditionally rather than through `setHUD`'s `tools` flag, which
`enterUniverse`/`enterWorld` pass `false`.

**An absent `data/travel.json` is a supported map state, not a boot error.** Both builders inject
an empty object when the authored file is absent. The runtime keeps that injected value untouched
and reads through an inert graph for initialization, disables the Travel button, keeps its panel
closed, and shows a persistent HUD notice explaining that the map was built without travel data.
A present graph, including one whose arrays are intentionally empty, retains the normal Travel UI;
availability therefore follows the graph schema rather than whether any route happens to exist.

**The legend renders alphabetically, from a sorted copy — never by sorting `order()`.** That
function returns the zone *draw* order, which affects rendering and which `datacmp` compares
between editions. Clicking a row focuses the zone and centres the view on it via `zoneCentroid()`
at the current zoom; the y term is **added** when converting to view coords because the viewer
draws with a Y-flip (`wy = -y*k + view.y`).

## The route drawn on the map

Each level draws only what it can show honestly; the itinerary is the one continuous record.

**`TROUTE` is declared with the view state (`level`/`cur`/`view`), not in the travel module** —
`drawCont`/`drawWorld`/`drawZone` are all defined *above* that module, and while function
declarations hoist a top-level `let` does not, so a module-local binding puts every earlier draw in
its temporal dead zone. It holds **two** lookups: `on` is membership *including* the departure zone,
`pip` is the arrival leg index *excluding* it. One map with `-1` for the start would make `<0` mean
both "off the route" and "is the start", dimming the departure zone while everything downstream
stayed lit.

**`tRender` is the only writer, and the discipline is clear-at-top, assign-on-success, one
`draw()`.** It has four early returns (no selection, already there, no route, and the capability
probe inside that last one); any of them skipping the clear leaves the previous trip drawn under a
panel that no longer describes it. Closing the panel clears it too — dimming that outlives the panel
explaining it reads as a rendering fault.

**Positions come from a different source per level, and that is not an inconsistency.** Continent
level reads `contData()`, so a viewer's own rearrangement moves the drawn line with the map. World
level reads published `ALL`, because `buildWorldCache` draws published outlines by design and a line
from customised zone positions would float off the shapes it claims to follow. `areaPt` reads
`metaPos()`, which *does* go through `WEDIT`, so a world route follows a continent the viewer
**moved** while correctly not following a zone they moved inside it. Each half matches the drawing
beneath it. Neither feeds cost — this is drawing only.

**Route dimming and `focus` dimming are separate states and `focus` wins**, which is why clicking an
itinerary leg must *not* set `focus`: doing so drops every zone but one to alpha 0.10 *and* makes
`drawCont`'s label loop skip the route's own zone names, leaving an orange line on a near-black map.
Selection emphasis rides `TROUTE.sel`. `zoneDimmed()` is the single owner of the test so the outline
loop and the label loop cannot drift. **And because the legend row sets `focus` directly, the route
suppresses itself whenever `focus` is set** — that guard lives in `drawRouteCont`/`drawRoutePips`
rather than only at the one call site that was careful not to set it. Focus means "show me this one
zone"; honour it.

**A leg is drawn from whatever of it exists in this continent, never gated on both centroids
resolving.** The point sequence is departure centroid → its hub → the arrival hub → arrival centroid,
with whatever resolves here joined up. Gating on both centroids left a boat arriving from Ocean of
Tears drawing *nothing* in Faydwer: a ringed dock floating unconnected beside a route that appeared
to begin in the middle of Butcherblock, while `routes[].access` was charging for exactly that walk.
A hub can only resolve in the continent its own stop is in, so there is no way to join two points
that are not both genuinely on this map.

**Lines and numbered pips are two passes with two call sites, on z-order grounds found by looking at
the render.** Zone labels are centred on the same centroid a pip sits on and draw after the lines, so
a single pass buried every intermediate stop's number under a zone name. Pips go last, above the hub
glyphs too. The world view draws only the two endpoints and the selected stop — pips are a fixed
screen size, and at globe scale a seven-zone chain inside one continent stacks seven 18px discs into
a blob.

**A walk leg is drawn centroid → the doorway each zone *names* → centroid, and the primary source is
the zone's own detail map.** `to_X`/`from_X` labels mark where an exit physically is, and
`zoneExitPoint` places them on the continent map. Coverage on current data: **72 of 74** walk edges
name it from both sides, 2 from one (`guktop|innothule`, `hole|paineel`), **0 from neither**. A
transport leg has no shared outline at all, so it routes through whichever of its hubs is in this
continent instead.

**Geometric closest approach (`nearestOutlinePair`) is the fallback, and it is only a valid proxy for
a zone line where the outlines actually touch.** Where a stitch void separates them it returns
whichever flanks happen to face each other, which is a fact about relative box placement and not
about the game: South Ro sits ~16 000 units east of Innothule, so it picked Innothule's *east* flank
beside the Guk and Grobb city entrances — 3 096 units from the northern entrance Innothule itself
names, and the bug that prompted this. With a label on only one side, the unnamed end becomes the
point of that outline nearest the named doorway (`nearestOutlinePointTo`), so it stays anchored to a
real exit; with neither, it falls back to closest approach, which nothing on current data reaches.

**Do not sanity-check an exit label against its zone's outline.** The median label sits 49 units from
an outline segment, but **dungeon exits are legitimately far from any line** — Rivervale's Kithicor
exit is 3 488 units from the nearest segment because it stands in the middle of an open room. A
threshold would reject the correct answer on exactly the zones whose geometry is hardest to reason
about.

**`transitionTargets(z,label)` is the single owner of "which zones is this label a doorway to".**
`enterZone` builds its clickable `zlinks` from it and the travel guide asks it where a leg leaves;
a second copy drifts on precisely the awkward cases, the `&` two-target split and `LINK_OVERRIDE`.
Forgetting `LINK_OVERRIDE` is not hypothetical — it makes `commons|kithicor` look one-sided when
Kithicor does name the Commonlands through the override.

**The drawn line and the stored walk cost measure the same path again.** They diverged briefly, when
the drawing moved to the named doorway while authored cost still came from closest approach;
`--recost` closed it. Authored edges remain guarded by the cross-language cost sweep. An unrostered
discovered edge instead carries the conversion-time catalog cost that `build.py` appends unchanged,
and the real-artifact travel test asserts that exact cost on a planned leg. In either class, anything
that changes doorway selection has to move drawing and the cost-producing path together.

**`walk[].at` is still not that point, and must not be substituted for it.** It holds the *drawn
connector's* endpoints, resolved only to within `ANCHOR_THRESH` of a zone — on `innothule|sro` they
sit 16 553 apart, further than the centroids themselves, and **neither lands on its own outline**
(478 and 298 units off). As a single waypoint its midpoint deviates from the centroid line by >15% of
leg length on **31 of 72** edges and falls *outside* the leg entirely on **7**, worst
`gukbottom|guktop` at 1.9× the leg length, because Upper and Lower Guk overlap in the drawing. It
also cannot reach the zone-detail view at all, being continent-frame while `DETAIL` is a different
frame with no recorded offset; zone-level exit emphasis comes from `zlinks` instead, which
`enterZone` has already resolved to `{cont,key}`. A gap-gated "doorway tick" was considered and is
not viable either: 47 of 72 pairs sit under 120 units but 18 are ≥1000, so it would show on two
thirds of legs and vanish on the rest. `at` stays in the data as the record of the resolved zone
line, with no consumer.

**A zone's detail map and its continent geometry are a PURE TRANSLATION apart, and the runtime
derives that offset rather than storing it.** One corresponding segment recovers it; measured across
all **120** zones shipping both files, the offset taken from seg 0 holds for >99.5% of index-aligned
segments to within 1.5 units, every zone. `DETAIL` carries extra segments the continent geometry
dropped, which is why the lists differ in length but not in order — and the *reason* the order holds
is the import's concatenation, not anything the format guarantees: geometry is the pack's base file
while detail is that base followed by the pack's annotation and grid layers, so detail's first *N*
segs simply are geometry's (the full ordered stream is verified in [`../../AGENTS.md`](../../AGENTS.md) →
Licensing boundary, with the counts in [`pack-import.md`](pack-import.md)).
Confirmed directly, 120/120 zones within ±1 unit per coordinate. **Exact-integer agreement is only
20/120, and the reason is a fractional offset, not independent rounding** — the two frames are a
*float* translation apart (only 14 of 118 are integral) and the original import rounded after
translating, so an integer offset lands within a unit and rarely on it. That distinction matters
to anything re-deriving the offset: fit it as a float and the residual disappears entirely, which
is what the importer does. Derived, not stored, because a
stored offset goes stale silently when a zone is re-imported — and because the measured table in
`docs/internal/loc-to-map-offsets.json` is git-ignored reference, not shipped data.

**That table's `nektulos: None` is now stale rather than informative.** It recorded a *different*
derivation — our geometry index-aligned against the upstream community map file — which failed for
Nektulos Forest only because the committed outline had been imported from Brewall's superseded
`nektulos_original.txt` (450 segments) while the table aligned against the current
`nektulos.txt` (2 931). The re-import resolved that: the zone now traces the current pack file at
`off = (-1178.65, 4167.05)`, so every zone aligns against the pack and nothing about it is special.
The table is git-ignored reference and is not regenerated; treat it as a snapshot, not a source.

**One segment recovers the offset; a second is checked before it is trusted.** One pair is enough to
*recover* a translation and not enough to *know* it is one, and a re-import that reordered or dropped
a segment would yield a plausible offset that silently misplaced every exit in the zone. Knowing
*why* the alignment holds makes that guard more clearly load-bearing, not less: it rests on one
import's layer-concatenation order, which a re-import is exactly the thing that can change. So
`detailOffset` confirms against a well-separated second segment and returns `null` on disagreement,
which drops that zone to the closest-approach fallback rather than drawing somewhere invented. The
offset cache needs no invalidation because `ALL`/`DETAIL` are `const` and `segs` are never rewritten
(`zoneXf` is applied at render, never baked); the cached point is *local*, so `tPoint` still picks up
a viewer's live transform.

**Cost of the geometry, measured in a real browser**, on the ten-leg Freeport→Qeynos overland run,
warming both paths and interleaving the runs: **8.0 ms per continent draw with the route against
6.9 ms without**. What buys that is the **cached label lookup**, not `ROUTE_SAMPLE`: the labels cover
every edge, so the `O(n*m)` scan almost never runs at all, and the 200-sample cap only bounds a
fallback that current data never reaches. (The cap earned its keep when closest approach *was* the
primary path.) The world view skips the waypoints entirely — at globe scale Antonica's 57 118
continent units land inside about 20 globe units, so a doorway is sub-pixel.

**One chevron per leg, on its longest segment.** Per-segment chevrons crowd the doorway, where two
of the three segments are a few pixels long.

**Zone-level emphasis silently no-ops on some legs and that is correct.** The detail-map cross-check
corroborated 73 of 76 edges, `znorm` folds the Neriak quarters together, and a transport leg has no
transition label at all. The fallback is text in the HUD `desc`, with three branches — continues,
ends here, nothing — computed at `enterZone` time, so re-planning while already standing in a zone
does not rewrite it.

**The route colour is `#ff5a00`, and the constraint is the *teleport glyph*, not the palette.**
Green was never available (`#5fb95f` is the commonest zone outline, `#00ff00`/`#08ce08` are heavy in
detail palettes), but the near miss is `#ff9d3a`: its anti-aliased edges fade toward a dark halo and
a black letter stroke, landing at `(255t, 157t, 58t)`, so the separating predicate
`r>210 && g<115 && b<60` holds **by construction** — `r>210` forces `t>0.82`, which forces `g>129`.
At the lighter `#ff8a1f` (g=138) those edge pixels leak in and the browser layer's discriminating
test has to be loosened until it stops discriminating. Do not lighten it back.

**A realm's world view is scoped by `alt`, so a Norrath→plane trip is drawn per realm and the gap is
declared, not papered over.** `tRealmNote` counts the legs this realm cannot draw and offers the
flip; `#tvRealm` lives *outside* `#tvOut` (which `tRender` clears wholesale) so `syncRealmRow` can
refresh it from `enterWorld` without re-planning and losing the selected leg. The crossing leg counts
from **both** sides — neither realm holds both its ends — so a 7-leg trip to Plane of Fear reports 1
from Norrath and 7 from The Planes. No dual-realm navigation state was added.

**A pixel test that measures a glyph's hue must draw the route *off*.** Measured with it on, North Ro
is a wizard spire and a trip ending there puts the line and its pip inside the glyph's own annulus —
29px of genuine route came back as a spire false positive.
