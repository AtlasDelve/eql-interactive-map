# Expansion selection

Authoritative for `META[c].xpac`, `XPAC_*`, `recomputeXpac`, `ALTITUDES`, the expansion picker,
and `META`'s field semantics generally.

Part of the `eql-interactive-map` reference set, pointed at from `AGENTS.md`'s routing table.
**`AGENTS.md` states the rules; this file carries the reasoning behind them** — the measured
figures, the alternatives tried and rejected, the derivations. Where the two disagree, that is a
bug to fix in place, not a precedence question.


**The field is `xpac`; everything a user reads says "Expansion". Both halves are deliberate.**
`xpac` is the terse, portable field name — nothing about it is EQ-specific, which is what
`atlasforge-engine` needs — while `xpacs.labels` makes display names per-atlas data and the HUD label
is spelled out. So do not "fix" either direction: not the identifiers to `expansion`, not the UI to
`xpac`. Two `era` spellings also survive on purpose and are not oversights. `data/world.json`'s two
`"not in EQL (classic era)"` universe notes are user-visible copy in the community's own idiom — and
editing them changes the injected `UNIVERSE` payload, which is a data change masquerading as a
rename. `tools/verify/README.md`'s substring-trap note says the zone key `lakerathe` contains `era`,
which is a true statement about why that key sweep is anchored; rewriting it to `xpac` makes it false.

**Expansions are cumulative and ordered.** A continent shows iff `rank(META[c].xpac) <= rank(selected)`,
which is the one rule that makes both "picking the first expansion hides three continents" and "picking
the last hides nothing" true. `data/world.json` → `xpacs.order` is the roster, oldest first.

**This filters existence, not clutter, and that is why it is worth the machinery.** The server runs
one expansion at a time, so without it the travel guide routes a player onto `boat-butcher-timorous`
— a boat to a zone that does not exist yet. That is a *wrong answer*. Versioned per-expansion geometry is a
separate and deliberately deferred thing.

**`ALTITUDES` is derived from `META[c].alt`, and the derivation must iterate `names`, never `META`.**
`names` follows the authored continent order; `META` is a raw passthrough whose own key order differs
(it lists Odus before Faydwer, the draw order is the reverse), so iterating it silently reorders the
globe draw and label passes. `datacmp` cannot see this at all — it extracts only the *injected*
structures — so the gate is a deep-equal assertion in `smoke.js` and `travel.test.js` against a
written-out literal. `fixture.py` writes its own `META` in a deliberately different order from `ALL`
for exactly this reason; emitting both in one order would make the fixture unable to tell the correct
derivation from the broken one.

**Expansion hiding is separate state from the user's `hidden` flag, and the two are checked side by side.**
`isGhost` is suppressed by "Show hidden"; folding expansion into it would let that toggle resurrect content
the server does not have. Every skip site tests both.

**Nothing expansion-related may read `EDIT`/`WEDIT`/`contData()`, and `XPAC_*` must never consult `TCAPS`.**
What exists is a fact about the game — the same invariant that keeps routing off zone centroids, one
layer up. A capability toggle making hub glyphs appear and disappear would conflate "you cannot use
this" with "this is not there yet".

**Expansion never enters the customization overlay.** `buildOverlay` round-trips to a shareable file, and a
shared layout must not carry the sharer's server progress. It rides its own localStorage key,
edition-suffixed like every other buffer, and `loadXpac()` validates the stored string against the
authored roster before it can reach a rank lookup. Assert that as a **key sweep over a non-empty
overlay** — the substring trap that makes the obvious check useless is in `tools/verify/README.md`.

**`recomputeXpac()` must run before the first draw.** The globe iterates `XPAC_CONT`, and an empty one
is every continent vanishing rather than a filter — a one-line ordering miss that reads as a
catastrophic bug. The four derived sets are `const` containers repopulated *in place*, both to keep
every holder's reference valid and to sidestep the temporal-dead-zone hazard the `TROUTE` note
describes.

**`pidx` is the published index, stamped where the content hint `ref` is captured.** Routes anchor
hubs as `"<Continent>:<index>"` into published `HUBS`, but the draw loop walks `contData().hubs`,
which becomes `EDIT[c].hubs` once edit-state exists — and deleting a hub splices that array. A
user-added item carries `pidx:null` at **every** creation site, or it inherits a published index and
hides the wrong glyph. The world-link lifecycle needs the same treatment at more points: splices,
creation, the snapshot, its reconstruction, and overlay adds.

**A world-link endpoint is matched to a continent's globe box, and the match is realm-scoped.**
Velious' box and Plane of Hate's *overlap*, and one authored endpoint sits at distance 0.000 from
both; the link is `alt`-tagged and only ever drawn on that realm's globe, so the other realm's boxes
are not candidates. Get this wrong and world link 8 — the Everfrost run to Velious — is judged by a
first-expansion continent and never hides. Nearest-box-*with-tolerance*, not strict containment: one
endpoint misses its box by 0.033. Justified for links alone because `WORLDLINKS` have no routing
role, so the worst case is a decorative line drawn or not. `META.gw`/`gh` have no other runtime
consumer.

**A route is hidden when any *in-build* stop is out of expansion, and the straddle is the point, not a smell.**
Butcherblock is first-expansion and Timorous Deep is not; the boat between them should vanish with its far
end. So "no route may span two expansions" is the wrong invariant — it fails the one route the feature was
built for. The real hazard is bluntness on a longer route: hiding a three-stop line whose last stop is
a later expansion drops a leg that was fine, and one later stop added to a druid-ring route would
take every already-existing destination with it. `verify.py travel` therefore fails when hiding a
route would remove a connection **both of whose ends exist at that expansion**. Nothing authored trips it.
An absent pack zone is not an expansion claim: it is ignored by this whole-route rule, and the
travel builder removes only legs whose endpoint is absent. Keeping static build absence outside
`XPAC_ROUTE` is what lets a surviving stop on a multi-stop transport remain usable.

**The out-of-expansion endpoint check runs *before* `tPlan`, not after.** Once `tPlan` restricts its node
set an out-of-expansion destination just returns `null`, which lands in the "no route with the modes you
have enabled" branch and then runs the capability probe — toggling every capability, finding nothing,
and answering a question the user did not ask. Do not extend that probe to suggest expansions either: it
asks what you would need to *have*, and expansion is a global setting.

**Search deliberately keeps both out-of-expansion and absent referenced zones.** A query is a
direct question, and silence is indistinguishable from a broken search. `TZONES` is the naming and
lookup table for every travel/group key; a surviving zone gets its published display name, while an
absent one has only its key and is labelled "not in this build" rather than "later". Static build
presence and the dynamic in-expansion node set therefore live separately. Any test wanting an
expansion-scoped count must read the filtered set, not `TZONES`.

**A group resolves to its in-expansion members**, and one with none left is rejected as an out-of-expansion
destination rather than as an empty trip. Latent today; every authored group is wholly first-expansion.

**Expansion filtering applies in the author edition's edit mode too.** It is a viewing feature, not an
authoring capability: an author working on a later expansion switches expansion exactly as they switch
realm. An exemption would make the author's globe and the player's disagree. The consequence is that
any sweep over all continents — `untouched.test.js` is the live one — must select the last expansion first.

**`tRouteOn`'s expansion check and `tPlan`'s node restriction are two gates over one hole**, so an
out-of-expansion trip fails with either one deleted and a trip-level assertion tests neither. Assert each
against what it owns — `TRAVEL.routes.filter(tRouteOn)`, and `tPlan` run with `XPAC_ROUTE` temporarily
cleared — and read the walk gate off `TADJ`. This and the "derived sets pass with their consumers
deleted" trap are general enough that `tools/verify/README.md` carries them too.

**`scripts/derive_travel_graph.py` still carries its own `CLASSIC` continent list** — a duplicated
fact now that `META[c].xpac` is authored, and the same argument that killed the `ALTITUDES` literal.
Not part of the build, so it did not gate this work.

## `META` derivation and the Odus drift — measured

`AGENTS.md` states the rule: Odus' `META` is stale rather than special, so anything recomputing
`META` from `bbox` silently shifts it. The figures, so nobody re-measures them:

Odus' `META` implies a **14 129 × 13 027** extent centred at **`(-480.5, -2894.5)`**, while its
`continent.json` stores **14 529 × 12 268** centred at **`(-480.5, -3474.0)`**. Odus was the POC
continent and its bbox moved afterwards without the globe fit being redone. The drift is invisible at
globe scale, which is exactly why a recompute would go unnoticed.

This sits in this file rather than its own because `META`'s field semantics are argued here —
`ALTITUDES` deriving from `alt`, the key-order hazard, and `gw`/`gh` as the world-link box bounds.
