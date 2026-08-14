// World-link anchoring: endpoints bind to a landmass and follow it, the way continent-level
// connector ends bind to zones. The overlay half of the feature lives in hide-io.test.js; this
// suite is the mechanics -- resolution, sticking, stretching, freeing, and the isolation rules
// that keep the derivation from leaking where it must not.
//
// Fixture facts these assertions lean on (tools/verify/fixture.py):
//   Antonica pos [10,30], Faydwer [17,38], Kunark [31,30]; every globe box is 6x6.
//   worldLinks[0] = {a:[10,30] -> Antonica, b:[17,38] -> Faydwer}
//   worldLinks[1] = {a:[10,30] -> Antonica, b:[31,30] -> Kunark}
// So both `a` ends sit dead centre of Antonica's box and anchor to it, while the `b` ends anchor
// elsewhere -- which is what lets "sticking" and "stretching" be asserted without contradiction.
const path = require('path');
const { load } = require('./lib');

const FX = path.join(__dirname, '..', '_fx');
const fx = (v, ed) => path.join(FX, 'fx-' + v + '.' + (ed || 'user') + '.html');

let fails = 0, checks = 0;
function ok(name, cond, extra) {
  checks++;
  if (cond) { console.log('  OK   ' + name); return true; }
  fails++;
  console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : ''));
  return false;
}
function eq(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  return ok(name + (g === w ? '' : ' (got ' + g + ', want ' + w + ')'), g === w);
}
function section(t) { console.log('\n-- ' + t); }

// ---------------------------------------------------------------------------
section('anchors are derived at edit-state build, from published positions');
{
  const { ev, errors } = load(fx('base'));
  ev('enterWorld();setEdit(true)');
  ok('no errors', errors.length === 0, errors);
  eq('link 0 ends anchor to the two landmasses they touch',
    ev('[WEDIT.worldLinks[0].anchorA,WEDIT.worldLinks[0].anchorB]'), ['Antonica', 'Faydwer']);
  eq('link 1 reaches the expansion-gated one',
    ev('[WEDIT.worldLinks[1].anchorA,WEDIT.worldLinks[1].anchorB]'), ['Antonica', 'Kunark']);
  eq('the offset is stored in globe units from pos', ev('WEDIT.worldLinks[0].la'), [0, 0]);
  eq('and wlPt reproduces the published point', ev("wlPt(WEDIT.worldLinks[0],'a')"), [10, 30]);
  // Nothing is written into data/: the published structure is untouched by the derivation.
  eq('published WORLDLINKS carry no anchor fields',
    ev("WORLDLINKS.some(l=>'anchorA' in l)"), false);
  // A published entry carries no anchor fields, so wlPt is the identity on its raw coords --
  // which is what makes it safe on the uncustomized user edition, where WEDIT is null and
  // worldConns() hands back WORLDLINKS itself.
  eq('wlPt on a published link is its raw coordinate',
    ev("wlPt(WORLDLINKS[0],'a')"), [10, 30]);
}

// ---------------------------------------------------------------------------
section('sticking and stretching');
{
  const { ev } = load(fx('base'));
  ev('enterWorld();setEdit(true)');
  ev("WEDIT.meta['Antonica'].pos=[15,35]");        // delta +5,+5
  eq('an endpoint anchored to Antonica moved with it',
    ev("wlPt(WEDIT.worldLinks[0],'a')"), [15, 35]);
  eq('...on every link that touches it',
    ev("wlPt(WEDIT.worldLinks[1],'a')"), [15, 35]);
  // The line STRETCHES rather than translating: the far end is anchored to a landmass that did
  // not move, so it stays exactly where it was.
  eq('the far end, anchored elsewhere, did not move',
    ev("wlPt(WEDIT.worldLinks[0],'b')"), [17, 38]);
  eq('nor did the other link\'s far end',
    ev("wlPt(WEDIT.worldLinks[1],'b')"), [31, 30]);
  // The raw fallback is untouched while the end is anchored -- that is what keeps the content
  // hint matching published data, and what a later release's move still lands on.
  eq('the raw fallback was not rewritten', ev('WEDIT.worldLinks[0].a'), [10, 30]);
}

// ---------------------------------------------------------------------------
section('a freed end stays put, and freeing after a move does not teleport it');
{
  const { ev } = load(fx('base'));
  ev('enterWorld();setEdit(true)');
  ev("toggleWlAnchor(0,'a')");
  eq('the end is free', ev('WEDIT.worldLinks[0].anchorA'), null);
  ev("WEDIT.meta['Antonica'].pos=[15,35]");
  eq('so moving its landmass leaves it behind', ev("wlPt(WEDIT.worldLinks[0],'a')"), [10, 30]);
  eq('while its still-anchored neighbour follows', ev("wlPt(WEDIT.worldLinks[1],'a')"), [15, 35]);
}
{
  const { ev } = load(fx('base'));
  ev('enterWorld();setEdit(true)');
  // Move FIRST, then free. toggleWlAnchor has to capture the resolved point into the raw
  // fallback before nulling the anchor; without that the end snaps back to [10,30].
  ev("WEDIT.meta['Antonica'].pos=[15,35]");
  ev("toggleWlAnchor(0,'a')");
  eq('freeing after a move leaves the endpoint where it was drawn',
    ev("wlPt(WEDIT.worldLinks[0],'a')"), [15, 35]);
  eq('and the raw fallback now holds that point', ev('WEDIT.worldLinks[0].a'), [15, 35]);
}

// ---------------------------------------------------------------------------
section('a bare click never re-anchors a deliberately freed end');
{
  const { ev } = load(fx('base'));
  ev('enterWorld();setEdit(true)');
  ev("toggleWlAnchor(0,'a')");
  // The freed end sits at [10,30], dead centre of Antonica's box, so an ungated re-anchor pass
  // would certainly re-bind it. Press and release on its own handle with no movement between.
  const hit = ev("(function(){const p=wlPt(WEDIT.worldLinks[0],'a');return globeToScreen(p[0],p[1]);})()");
  eq('the handle is pickable', ev('pickWConnEndpoint(' + hit[0] + ',' + hit[1] + ')'), { i: 0, which: 'a' });
  ev('worldMouseDown({clientX:' + hit[0] + ',clientY:' + hit[1] + '})');
  ev('worldMouseUp({clientX:' + hit[0] + ',clientY:' + hit[1] + '})');
  eq('the end is still free after the click', ev('WEDIT.worldLinks[0].anchorA'), null);

  // A real drag DOES re-anchor, so the gate is not simply disabling the feature.
  const away = ev('globeToScreen(10.2,30.2)');
  ev('worldMouseDown({clientX:' + hit[0] + ',clientY:' + hit[1] + '})');
  ev('worldMouseMove({clientX:' + away[0] + ',clientY:' + away[1] + '})');
  ev('worldMouseUp({clientX:' + away[0] + ',clientY:' + away[1] + '})');
  eq('dragging the end onto a landmass re-anchors it', ev('WEDIT.worldLinks[0].anchorA'), 'Antonica');
}

// ---------------------------------------------------------------------------
section('dragging a landmass leaves the overlay sparse');
{
  const { ev } = load(fx('base'));
  ev('enterWorld();setEdit(true)');
  // Drive the REAL handlers, not a pos assignment: assigning WEDIT.meta[c].pos directly bypasses
  // the cmove branch, so this test could never fail if someone later marked links touched there.
  // Pick a point inside Antonica that is not on a connector -- both links have an endpoint at its
  // centre, and worldMouseDown checks the connector pickers before it checks the landmass.
  const hit = ev(`(function(){const r=worldRects['Antonica'];
    for(let u=1;u<20;u++)for(let v=1;v<20;v++){
      const bx=r.x0+(r.x1-r.x0)*u/20, by=r.y0+(r.y1-r.y0)*v/20;
      const mx=bx*wv.k+wv.x, my=by*wv.k+wv.y;
      if(worldPick(mx,my)!=='Antonica')continue;
      if(pickWConnEndpoint(mx,my)||pickWConnBody(mx,my)!==null)continue;
      return [mx,my];}
    return null;})()`);
  ok('found a draggable point on Antonica', hit !== null);
  ev('worldMouseDown({clientX:' + hit[0] + ',clientY:' + hit[1] + '})');
  eq('the drag really is a continent move', ev('drag.mode'), 'cmove');
  ev('worldMouseMove({clientX:' + (hit[0] + 40) + ',clientY:' + (hit[1] + 25) + '})');
  ev('worldMouseUp({clientX:' + (hit[0] + 40) + ',clientY:' + (hit[1] + 25) + '})');
  ok('the landmass actually moved',
    ev("JSON.stringify(metaPos('Antonica'))!==JSON.stringify(META['Antonica'].pos)"),
    ev("[metaPos('Antonica'),META['Antonica'].pos]"));
  ok('its connectors followed',
    ev("Math.abs(wlPt(WEDIT.worldLinks[0],'a')[0]-metaPos('Antonica')[0])<1e-9"));

  // The whole functional argument for anchoring over "translate the endpoints during the drag":
  // no link field is written, so the overlay stays sparse and a later release's move to one of
  // those endpoints still takes effect inside this customization.
  const o = JSON.parse(ev('JSON.stringify(worldOverlay())'));
  eq('the overlay records the continent', Object.keys(o.contPos), ['Antonica']);
  eq('and no world connector at all', 'worldConns' in o, false);
  eq('nothing was marked touched', ev('WEDIT.worldLinks.some(l=>l.touched)'), false);
}

// ---------------------------------------------------------------------------
section('expansion ownership stays in the published frame');
{
  const { ev } = load(fx('base'));
  ev('enterWorld();setEdit(true)');
  const before = ev('(recomputeXpac(),JSON.stringify([...XPAC_WL]))');
  eq('the link to the expansion-gated landmass is hidden at the first expansion', before, '[1]');
  // Kunark moved far enough that a live-frame ownership lookup would hand link 1's far end to a
  // first landmass instead, and the link would stop hiding. Expansion must not see WEDIT at all.
  ev("WEDIT.meta['Kunark'].pos=[90,90]");
  eq('moving a landmass in WEDIT cannot change what exists',
    ev('(recomputeXpac(),JSON.stringify([...XPAC_WL]))'), before);
}

// ---------------------------------------------------------------------------
section('legacy author snapshots: absent means derive, null means the user chose free');
{
  const { ev, errors } = load(fx('base', 'author'));
  ev('enterWorld();setEdit(true)');
  // A snapshot written before endpoints could anchor carries no anchor keys at all.
  ev(`worldApplyState({meta:{},worldLinks:[
    {a:[10,30],b:[17,38],alt:'Norrath',pidx:0},
    {a:[10,30],b:[31,30],alt:'Norrath',pidx:1}]})`);
  ok('no errors', errors.length === 0, errors);
  eq('an absent anchor field re-derives rather than restoring free',
    ev('[WEDIT.worldLinks[0].anchorA,WEDIT.worldLinks[0].anchorB]'), ['Antonica', 'Faydwer']);

  // A snapshot the current build wrote records null for an end the user deliberately freed.
  ev("toggleWlAnchor(0,'a')");
  const st = ev('JSON.stringify(worldSnapshot())');
  eq('the snapshot carries the four fields',
    JSON.parse(st).worldLinks[0].anchorA, null);
  ev('worldApplyState(' + st + ')');
  eq('an explicit null is preserved', ev('WEDIT.worldLinks[0].anchorA'), null);
  eq('while its anchored sibling comes back anchored', ev('WEDIT.worldLinks[0].anchorB'), 'Faydwer');

  // The content hint must survive that, and it cannot be recomputed from the restored a/b:
  // freeing an end writes the RESOLVED point there, so on a moved landmass the raw coords are no
  // longer the published ones and a recomputed hint would match nothing on a later import.
  ev('buildWorldEditState()');
  ev("WEDIT.meta['Antonica'].pos=[15,35]");
  ev("toggleWlAnchor(0,'a')");
  ev('worldApplyState(' + ev('JSON.stringify(worldSnapshot())') + ')');
  eq('the hint still matches published data after freeing on a moved landmass',
    ev('WEDIT.worldLinks[0].ref'), ev('wlRefOf(WORLDLINKS[0])'));
}

// ---------------------------------------------------------------------------
section('a user-added world link anchors on creation and keeps it through the overlay');
{
  const { ev } = load(fx('base'));
  ev('enterWorld();setEdit(true)');
  // Through the conn tool's own two clicks, not by pushing an object onto the array.
  ev("tool='conn';(function(){const A=globeToScreen(10,30),B=globeToScreen(17,38);"
    + 'worldMouseDown({clientX:A[0],clientY:A[1]});worldMouseDown({clientX:B[0],clientY:B[1]});})()');
  eq('the link was created', ev('WEDIT.worldLinks.length'), 3);
  eq('and both ends auto-anchored on creation',
    ev('[WEDIT.worldLinks[2].anchorA,WEDIT.worldLinks[2].anchorB]'), ['Antonica', 'Faydwer']);
  // worldConnsAdded builds a fresh link object and reads it back through wlEndIn, a path the
  // published/touched entries above never exercise.
  const o = ev('JSON.stringify(worldOverlay())');
  ev('buildWorldEditState()');
  ev('applyWorldOverlay(' + JSON.stringify(JSON.parse(o)) + ')');
  eq('the anchors survived the round trip',
    ev('[WEDIT.worldLinks[2].anchorA,WEDIT.worldLinks[2].anchorB]'), ['Antonica', 'Faydwer']);
  ev("WEDIT.meta['Antonica'].pos=[15,35]");
  eq('so a re-imported user-added link follows its landmass too',
    ev("wlPt(WEDIT.worldLinks[2],'a')"), [15, 35]);
}

// ---------------------------------------------------------------------------
// The requirement was that world links behave the SAME as zone-to-zone connectors, and on both
// of these the continent side was the one that was wrong. Asserted here, beside their world
// twins, because shipping one fixed and one broken is the failure being guarded against.
section('the same two rules one level down, on continent connectors');
{
  const { ev } = load(fx('base'));
  ev("enterCont('Antonica');setEdit(true);sel=null");
  // conns[1].a sits on beta's right edge. Chosen over conns[0] because the alpha|beta weld
  // padlock is picked before connector endpoints and sits right on conns[0].a.
  eq('the end is anchored to beta', ev('conns[1].anchorA'), 'beta');
  ev("EDIT['Antonica'].zones.beta.xf.tx=900");
  eq('moving the zone moves the end', ev("ep(conns[1],'a')"), [2950, 500]);
  ev("toggleAnchor(1,'a')");
  eq('freeing it after the move does not teleport it back', ev("ep(conns[1],'a')"), [2950, 500]);
  eq('because the raw fallback was refreshed', ev('conns[1].a'), [2950, 500]);

  // The freed end sits exactly on beta's outline, so an ungated re-anchor would certainly
  // re-bind it on a bare click.
  const hit = ev("(function(){const P=ep(conns[1],'a');return [wx(P[0]),wy(P[1])];})()");
  eq('its handle is pickable', ev('JSON.stringify(pickConnEndpoint(' + hit[0] + ',' + hit[1] + '))'),
    JSON.stringify({ i: 1, which: 'a' }));
  ev('editMouseDown({clientX:' + hit[0] + ',clientY:' + hit[1] + '})');
  ev('editMouseUp({clientX:' + hit[0] + ',clientY:' + hit[1] + '})');
  eq('a bare click leaves it free', ev('conns[1].anchorA'), null);
  ev('editMouseDown({clientX:' + hit[0] + ',clientY:' + hit[1] + '})');
  ev('editMouseMove({clientX:' + (hit[0] + 3) + ',clientY:' + (hit[1] + 3) + '})');
  ev('editMouseUp({clientX:' + (hit[0] + 3) + ',clientY:' + (hit[1] + 3) + '})');
  eq('but a real drag re-anchors it', ev('conns[1].anchorA'), 'beta');
}

// ---------------------------------------------------------------------------
section('exports resolve anchors, so an unedited map round-trips unchanged');
{
  const { ev, downloads } = load(fx('base', 'author'));
  ev('enterWorld();setEdit(true)');
  eq('the durable export matches published data exactly',
    ev('JSON.stringify(buildWorldObject().worldLinks)'), ev('JSON.stringify(WORLDLINKS)'));

  ev('exportStandaloneHTML()');
  ok('a standalone file was produced', downloads.length === 1, downloads.length);
  (async () => {
    const text = await downloads[0].text();
    const m = /\/\*__DATA_WL__\*\/const WORLDLINKS=(.*?);\/\*__END_WL__\*\//.exec(text);
    ok('the standalone export carries a world-link block', !!m);
    eq('...identical to published data', m && JSON.parse(m[1]), JSON.parse(ev('JSON.stringify(WORLDLINKS)')));

    console.log('\n' + checks + ' checks, ' + fails + ' failed');
    console.log('RESULT: ' + (fails ? 'FAIL' : 'PASS'));
    process.exit(fails ? 1 : 0);
  })();
}
