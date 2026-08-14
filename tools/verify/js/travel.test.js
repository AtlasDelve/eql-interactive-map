// Travel-graph SEMANTICS, against the synthetic fixture rather than the real map.
//
// Every assertion here is one an 18 MB-artifact test could not make honestly: on real data
// some alternate walk chain almost always exists, so a directedness or gating bug is masked
// by a path that happens to work anyway. The fixture is shaped to remove those alternates --
// see the TRAVEL block in fixture.py for why zeta is isolated and why the route order matters.
//
// Search is NOT covered here: ZIDX is built from DETAIL and the fixture ships DETAIL={}, so
// the forward search index is empty by construction. travel-full.test.js covers it.
const path = require('path');
const { load } = require('./lib.js');

const FX = path.join(__dirname, '..', '_fx');
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

const a = load(path.join(FX, 'fx-base.user.html'));
if (a.errors.length) { console.log('FAIL load: ' + a.errors.join('; ')); process.exit(1); }
const ev = a.ev;

// caps: an array of capability ids to enable; everything else off.
function plan(from, to, caps) {
  ev('for(const k in TCAPS)TCAPS[k]=false;'
    + (caps || []).map((c) => `TCAPS[${JSON.stringify(c)}]=true;`).join('')
    + 'TADJ=null;');
  return JSON.parse(ev(`JSON.stringify(tPlan(${JSON.stringify(from)},${JSON.stringify(to)}))`));
}
const kinds = (r) => r.legs.map((l) => l.kind);
const hops = (r) => r.legs.map((l) => l.from + '>' + l.to);

section('ALTITUDES is derived from each continent\'s own META.alt');
{
  // fixture.py deliberately writes META in a different key order from ALL (Faydwer moved), for
  // the same reason data/ has that skew: the derivation must iterate `names`, and iterating META
  // would silently reorder the globe draw and label passes. Order is asserted, not just membership.
  eq('the realms, in the authored continent order',
    JSON.parse(ev('JSON.stringify(ALTITUDES)')), {
      Norrath: ['Antonica', 'Faydwer', 'Odus', 'Kunark', 'Velious',
        'Ocean of Tears', "Erud's Crossing", 'Timorous Deep'],
      'The Planes': ['Plane of Fear', 'Plane of Hate', 'Plane of Sky'],
    });
  ok('...and it really is not merely META\'s own key order',
    ev("JSON.stringify(Object.keys(META))") !== ev("JSON.stringify(Object.keys(ALL))"),
    [ev('JSON.stringify(Object.keys(META))'), ev('JSON.stringify(Object.keys(ALL))')]);
}

section('the graph the fixture actually built');
eq('nodes are the referenced zones only (no stub-continent "only")',
  JSON.parse(ev('JSON.stringify(Object.keys(TZONES).sort())')),
  ['alpha', 'beta', 'delta', 'fieldofbone', 'gamma', 'zeta']);
eq('names come from ALL, not DETAIL (which is empty here)',
  ev("tzName('zeta')"), 'Zeta Hollow');
eq('zeta really is isolated in the authored data',
  JSON.parse(ev('JSON.stringify(TRAVEL.walk.filter(w=>w.z.indexOf("zeta")>=0)'
    + '.concat(TRAVEL.routes.filter(r=>r.stops.indexOf("zeta")>=0)))')), []);

section('`anywhere` is directed: you can port IN from anywhere, never back OUT');
{
  const inbound = plan(['zeta'], ['beta'], ['wizard']);
  ok('zeta -> beta succeeds (a self-cast port is available from any zone)', !!inbound, inbound);
  if (inbound) {
    eq('and it is the one-hop port', hops(inbound), ['zeta>beta']);
    eq('by the wizard route', inbound.legs[0].label, 'Wizard ports');
  }
  eq('beta -> zeta fails: the arrival edge does not run backwards',
    plan(['beta'], ['zeta'], ['wizard']), null);
  // The formulation to avoid: two stops of ONE anywhere route are legitimately mutually
  // reachable, because the route adds u->stop for every u. Asserting otherwise asserts a
  // falsehood. Guard the real property instead -- nothing at all reaches zeta.
  eq('nothing reaches zeta even with every capability granted',
    plan(['alpha'], ['zeta'], ['druid', 'wizard']), null);
  eq('...nor from gamma', plan(['gamma'], ['zeta'], ['druid', 'wizard']), null);
}

section('capability gating');
eq('gated destination unreachable with the capability off',
  plan(['zeta'], ['beta'], []), null);
ok('...and reachable with it on', !!plan(['zeta'], ['beta'], ['wizard']));
ok('...also via the other gated route', !!plan(['zeta'], ['beta'], ['druid']));
{
  // gamma hangs off beta by a walk edge, so it is reachable only THROUGH the gated arrival
  const g = plan(['zeta'], ['gamma'], ['druid']);
  ok('a zone behind a gated arrival is reachable once the gate opens', !!g, g);
  if (g) eq('by port then walk', kinds(g), ['ring', 'walk']);
}

section('parallel edges keep the MINIMUM, with the matching step metadata');
{
  // two anywhere routes both arrive at beta: druid 1, wizard 3 (wizard is written LAST)
  const both = plan(['zeta'], ['beta'], ['druid', 'wizard']);
  ok('both routes enabled -> a route exists', !!both);
  if (both) {
    eq('cost is the cheaper arrival, not the last one assembled', both.total, 1);
    eq('and the step names the route that actually produced it', both.legs[0].label, 'Druid ports');
    eq('kind matches that same route', both.legs[0].kind, 'ring');
  }
  // two line routes both join alpha-delta: boat 10 (has a hub), ferry 12 (written LAST)
  const sea = plan(['alpha'], ['delta'], []);
  ok('parallel line routes -> a route exists', !!sea);
  if (sea) {
    eq('cost is the cheaper line route', sea.total, 10);
    eq('and the step names it', sea.legs[0].label, 'Alpha ⇄ Delta');
  }
}

section('reagent notes ride the arriving leg, and only that leg');
{
  const out = plan(['alpha'], ['delta'], []);
  eq('alpha -> delta arrives at the hub that carries the note',
    out.legs.map((l) => l.note), ['Ring of Delta\nMossy Shard (consumed)']);
  const back = plan(['delta'], ['alpha'], []);
  eq('delta -> alpha is the same route in reverse and carries NO note',
    back.legs.map((l) => l.note), ['']);
  eq('...and is still the same route', back.legs[0].label, 'Alpha ⇄ Delta');
  const walkOnly = plan(['alpha'], ['gamma'], []);
  eq('a pure walk chain carries no notes at all',
    walkOnly.legs.map((l) => l.note), ['', '']);
  // Read through published HUBS, never contData: build live edit-state for Faydwer and
  // mutate it. The itinerary must not change.
  ev("enterCont('Faydwer');setEdit(true);hubs[0].note='TAMPERED';setEdit(false)");
  eq('a live edit-state hub note does not leak into the itinerary',
    plan(['alpha'], ['delta'], []).legs[0].note, 'Ring of Delta\nMossy Shard (consumed)');
  ev("enterCont('Antonica')");
}

section('node SETS: a group resolves to several zones at both ends');
{
  eq('group -> zone keys', JSON.parse(ev("JSON.stringify(tNodes({kind:'group',key:'The Reaches'}))")),
    ['delta', 'zeta']);
  const g = plan(['alpha'], ['delta', 'zeta'], []);
  ok('a group destination succeeds when ANY member is reachable', !!g, g);
  if (g) eq('terminating on the reachable member', g.legs[g.legs.length - 1].to, 'delta');
  const s = plan(['delta', 'zeta'], ['gamma'], []);
  ok('a group origin succeeds when ANY member can start', !!s, s);
  if (s) eq('starting from the connected member', s.legs[0].from, 'delta');
  eq('start already inside the destination set -> zero legs',
    plan(['alpha'], ['alpha', 'beta'], []), { legs: [], total: 0 });
}

section('walk edges are undirected and the chain is shortest');
{
  const f = plan(['alpha'], ['gamma'], []);
  eq('alpha -> gamma walks through beta', hops(f), ['alpha>beta', 'beta>gamma']);
  eq('summing the authored costs', f.total, 17.2);
  eq('and the reverse is symmetric', hops(plan(['gamma'], ['alpha'], [])),
    ['gamma>beta', 'beta>alpha']);
}

section('itinerary rendering (fixture names come from ALL, so this is assertable here)');
{
  ev("for(const k in TCAPS)TCAPS[k]=false;TADJ=null;"
    + "tPick('from',{kind:'zone',key:'alpha',name:'Alpha Fields'});"
    + "tPick('to',{kind:'zone',key:'delta',name:'Delta Coast'});");
  const txt = ev("document.getElementById('tvOut').textContent");
  ok('names the origin', /from Alpha Fields/.test(txt), txt);
  ok('one leg, counted by mode', /1 leg/.test(txt) && /1 boat/.test(txt), txt);
  ok('names the destination zone', /Delta Coast/.test(txt), txt);
  ok('names the route', /Alpha ⇄ Delta/.test(txt), txt);
  ok('renders the reagent note', /Mossy Shard \(consumed\)/.test(txt), txt);
  eq('user edition shows no per-leg cost',
    ev("document.querySelectorAll('#travel .leg .c').length"), 0);
  ok('no raw cost figure leaked into the text', !/\b10(\.0)?\b/.test(txt), txt);

  ev("tPick('to',{kind:'zone',key:'zeta',name:'Zeta Hollow'});");
  const none = ev("document.getElementById('tvOut').textContent");
  ok('an unreachable destination says so', /No route with the modes/.test(none), none);
  ok('and does not invent a capability that would not help',
    !/would find one/.test(none), none);

  ev("tPick('from',{kind:'zone',key:'zeta',name:'Zeta Hollow'});"
    + "tPick('to',{kind:'zone',key:'beta',name:'Beta Hills'});");
  const gated = ev("document.getElementById('tvOut').textContent");
  ok('a gated trip names the capabilities that each work ALONE, joined with "or"',
    /Enabling Druid ports or Wizard ports would find one/.test(gated), gated);
}

section('capability persistence');
{
  eq('user edition key', ev('travelLsKey()'), 'eql_travel_caps_u1');
  ev("for(const k in TCAPS)TCAPS[k]=false;tBuildCaps();"
    + "document.querySelector('#tvCaps .btn[data-cap=druid]').onclick()");
  eq('toggling writes through', JSON.parse(ev('localStorage.getItem(travelLsKey())')),
    { druid: true, wizard: false });
  ok('the button reflects the state',
    ev("document.querySelector('#tvCaps .btn[data-cap=druid]').classList.contains('on')"));

  // reload the same page against the SAME backing store
  const b = load(path.join(FX, 'fx-base.user.html'), { storage: a.store });
  ok('reload: no errors', b.errors.length === 0, b.errors);
  eq('reload: the choice survived', JSON.parse(b.ev('JSON.stringify(TCAPS)')),
    { druid: true, wizard: false });
  ok('reload: the button came back on',
    b.ev("document.querySelector('#tvCaps .btn[data-cap=druid]').classList.contains('on')"));

  // the author edition must not read the user edition's buffer, and vice versa
  const c = load(path.join(FX, 'fx-base.author.html'), { storage: a.store });
  eq('author edition key', c.ev('travelLsKey()'), 'eql_travel_caps_v1');
  eq('author edition does NOT inherit the user edition choice',
    JSON.parse(c.ev('JSON.stringify(TCAPS)')), { druid: false, wizard: false });
  ev("for(const k in TCAPS)TCAPS[k]=false;tBuildCaps();tSaveCaps();");
}

section('expansion filtering: what the server does not have yet is not routable');
{
  // The fixture is shaped so `fieldofbone` has NO alternate path -- one route in, and that
  // route's far end is the expansion-gated continent. On real data an alternate walk chain almost
  // always exists and would mask a broken gate.
  const xpac = (e) => ev(`setXpac(${JSON.stringify(e)})`);
  xpac('classic');
  eq('the gated continent is absent from the visible set',
    ev("XPAC_CONT.has('Kunark')"), false);
  eq('...while its own expansion admits it', (xpac('kunark'), ev("XPAC_CONT.has('Kunark')")), true);
  xpac('classic');

  eq('the route whose far end does not exist yet is out of expansion',
    JSON.parse(ev('JSON.stringify([...XPAC_ROUTE])')), ['boat-delta-fieldofbone']);
  ok('so the zone behind it is unreachable, with every capability granted',
    !plan(['alpha'], ['fieldofbone'], ['druid', 'wizard']));
  xpac('kunark');
  const reach = plan(['alpha'], ['fieldofbone']);
  ok('...and reachable at its own expansion, ungated', !!reach, reach);
  if (reach) eq('by the boat that was missing before', kinds(reach), ['boat', 'boat']);
  xpac('classic');

  // The route gate and tPlan's node restriction are two defences over one hole, so on this
  // fixture EITHER alone makes the trip fail and neither is tested by the trip failing. Assert
  // each against the thing it actually owns, and isolate the second by suspending the first.
  eq('tRouteOn withholds the out-of-expansion route from edge assembly',
    JSON.parse(ev("JSON.stringify(TRAVEL.routes.filter(tRouteOn).map(r=>r.id))"))
      .indexOf('boat-delta-fieldofbone'), -1);
  eq('...and hands it back at its own expansion',
    (xpac('kunark'), JSON.parse(ev("JSON.stringify(TRAVEL.routes.filter(tRouteOn).map(r=>r.id))")))
      .indexOf('boat-delta-fieldofbone') >= 0, true);
  xpac('classic');
  eq('tPlan refuses an out-of-expansion node even with the route gate suspended',
    ev(`(function(){const keep=[...XPAC_ROUTE];XPAC_ROUTE.clear();TADJ=null;
      const r=tPlan(['alpha'],['fieldofbone']);
      for(const k of keep)XPAC_ROUTE.add(k);TADJ=null;return r;})()`), null);

  // The hub rule: hidden because every route referencing it is, NOT because its continent is.
  eq('a hub serving only an out-of-expansion route hides, in an in-expansion continent',
    ev("xpacHubHidden('Faydwer',1)"), true);
  eq('...while the ring beside it, which no route gates, stays',
    ev("xpacHubHidden('Faydwer',0)"), false);
  eq('...and it comes back with its route',
    (xpac('kunark'), ev("xpacHubHidden('Faydwer',1)")), false);
  xpac('classic');
  // The >=1 guard: without it the vacuous "all zero referencing routes are gone" fires and the
  // first hub no route mentions disappears. Antonica:2 is exactly that hub.
  eq('a hub no route references at all is never expansion-hidden',
    ev("xpacHubHidden('Antonica',2)"), false);

  eq('a world link reaching an out-of-expansion continent hides',
    JSON.parse(ev('JSON.stringify([...XPAC_WL])')), [1]);
  eq('...and returns at its expansion', (xpac('kunark'), JSON.parse(ev('JSON.stringify([...XPAC_WL])'))), []);
  xpac('classic');

  // The walk gate. No authored walk edge crosses an expansion today in either tree, so this asserts
  // the gate is WIRED rather than that it currently removes anything. Read off TADJ, not off a
  // failed trip: tPlan's node restriction would refuse the destination either way, so a trip
  // test passes just as happily with the walk loop ungated.
  const walkEdge = () => ev(`(function(){TRAVEL.walk.push({z:['alpha','fieldofbone'],cost:1});
    TADJ=null;tBuild();
    const n=(TADJ['alpha']||[]).filter(e=>e.to==='fieldofbone').length;
    TRAVEL.walk.pop();TADJ=null;return n;})()`);
  eq('the walk loop consults the expansion, not only the route loop', walkEdge(), 0);
  eq('...and admits the same edge once that zone exists', (xpac('kunark'), walkEdge()), 1);
  xpac('classic');

  // Search keeps out-of-expansion entries and labels them; the endpoint check names the expansion rather
  // than falling through to "no route with the modes you have enabled" + the capability probe.
  ok('an out-of-expansion zone is still findable',
    JSON.parse(ev("JSON.stringify(tFind('field of bone',5).map(e=>e.key))")).indexOf('fieldofbone') >= 0);
  ev("setTravel(true);tPick('from',{kind:'zone',key:'alpha',name:'Alpha Fields'});"
    + "tPick('to',{kind:'zone',key:'fieldofbone',name:'Field of Bone'});");
  const msg = ev("document.getElementById('tvOut').textContent");
  ok('the panel names the expansion rather than blaming the modes', /Kunark content/.test(msg), msg);
  ok('...and does not offer a capability that would not help',
    !/Enabling/.test(msg) && !/modes you have enabled/.test(msg), msg);
  eq('nothing is drawn for a trip that cannot exist', ev('TROUTE===null'), true);
  ev("setTravel(false);tPick('from',null);tPick('to',null);");
}

section('the derived sets reach the draw, pick and navigation paths');
{
  // Holding the right answer in XPAC_HUB/XPAC_WL is half the job; the assertions above would all
  // pass with every consumer of those sets deleted. These check the consumers.
  const xpac = (e) => ev(`setXpac(${JSON.stringify(e)})`);
  xpac('classic');

  // hubScreens is the one skip that covers render, hover AND click, so an expansion-hidden hub must
  // not appear in it at all.
  const glyphs = () => { ev("enterCont('Faydwer');draw()"); return JSON.parse(
    ev('JSON.stringify(hubScreens.map(s=>s.h.label))')); };
  eq('the hidden dock is not drawn, hoverable or clickable', glyphs(), ['Delta Ring']);
  eq('...and both glyphs are there at its expansion', (xpac('kunark'), glyphs()),
    ['Delta Ring', 'Delta Far Docks']);
  xpac('classic');

  // pidx, not the live array position. Deleting the hub ABOVE it shifts every index below, so a
  // bare index would start hiding the wrong glyph -- here, the ring that should have stayed.
  ev("enterCont('Faydwer');buildEditState('Faydwer');EDIT['Faydwer'].hubs.splice(0,1);draw()");
  eq('after the hub above it is deleted, the expansion hiding still lands on the same glyph',
    JSON.parse(ev('JSON.stringify(hubScreens.map(s=>s.h.label))')), []);
  ev("EDIT['Faydwer'].hubs.unshift({x:100,y:100,kind:'boat',label:'Inserted',letter:'',note:'',"
    + "anchor:null,lx:null,ly:null,ref:'boat|Inserted',pidx:null,touched:true,hidden:false,userAdded:true});draw()");
  eq('...and an inserted user hub neither hides itself nor unhides the published one',
    JSON.parse(ev('JSON.stringify(hubScreens.map(s=>s.h.label))')), ['Inserted']);
  ev("delete EDIT['Faydwer'];enterCont('Faydwer')");

  // World links: the pick paths read the same predicate the draw loop does.
  ev('enterWorld()');
  const pickEnd = (i, which) => ev(`(function(){const c=worldConns()[${i}];
    const P=globeToScreen(c.${which}[0],c.${which}[1]);
    const r=pickWConnEndpoint(P[0],P[1]);return r?r.i:-1;})()`);
  eq('an expansion-hidden world link is not pickable', pickEnd(1, 'b'), -1);
  eq('...while the one beside it still is', pickEnd(0, 'b'), 0);
  eq('...and it comes back at its expansion', (xpac('kunark'), pickEnd(1, 'b')), 1);
  xpac('classic');

  // World links get the same pidx treatment as hubs, and they need it just as much: BOTH editions
  // can splice this array (the keyboard Delete handler and the inspector's Delete button are
  // unmarked), and afterwards the live index of every link below the deleted one is off by one. On
  // real data that puts Antonica<->Timorous Deep back on the classic globe.
  ev('enterWorld();setEdit(true)');
  // What the draw and pick loops would keep, labelled by published index -- 'added' for a link
  // with no published identity, so a user link shows up here rather than being filtered away.
  const visible = () => JSON.parse(ev(`JSON.stringify(worldConns()
    .map((c,i)=>((c.alt&&c.alt!==alt)||isGhost(c)||xpacWlHidden(c,i))
      ? null : (pubWlIdx(c,i)==null?'added':pubWlIdx(c,i)))
    .filter(x=>x!==null))`));
  eq('before any delete, only the in-expansion link is drawn', visible(), [0]);
  ev('worldConns().splice(0,1)');
  eq('after the link above it is deleted, the hidden one is still hidden', visible(), []);
  // Added through the REAL creation path, and after the splice on purpose: that lands it at live
  // index 1, which is the published index of the expansion-hidden link. A user item without pidx:null
  // falls back to its live position and inherits exactly that hiding.
  ev("setTool('conn');worldMouseDown({clientX:120,clientY:120});"
    + 'worldMouseDown({clientX:160,clientY:150});');
  eq('a user-added link goes on the end', ev('worldConns().length'), 2);
  eq('...and is drawn without inheriting a published index', visible(), ['added']);
  ev('setEdit(false);WEDIT=null;worldCache=null;enterWorld()');

  // A selection made while an item existed is NOT retracted by the draw loop skipping it: the
  // edit overlay keeps ringing hubs[sel.id] and the inspector keeps offering Delete. The case
  // that matters is a hub in a continent that STAYS -- switching out of a continent that vanishes
  // routes through enterWorld/suspendEdit, which clears sel for unrelated reasons, so a test that
  // only covers that one passes with the clear in setXpac deleted.
  xpac('kunark');
  ev("enterCont('Faydwer');setEdit(true);sel={type:'hub',id:1};refreshInspector()");
  eq('a hub in an in-expansion continent can be selected while it exists', ev('sel&&sel.id'), 1);
  ok('...and the inspector offers to act on it',
    /Transport hub/.test(ev("document.getElementById('inspBody').innerHTML")));
  xpac('classic');
  eq('...the continent is still the one we are standing in', ev('cur'), 'Faydwer');
  eq('...but the selection of the now-nonexistent hub is dropped', ev('sel'), null);
  ok('...and the inspector no longer offers to delete it',
    !/Transport hub/.test(ev("document.getElementById('inspBody').innerHTML")),
    ev("document.getElementById('inspBody').innerHTML").slice(0, 120));
  ev('setEdit(false)');

  // The entry-point guard, which the globe pick does not cover: the zone-detail transition
  // click calls enterZone(cont,key) straight from a label.
  ev('enterWorld()');
  ev("enterCont('Kunark')");
  eq('entering an out-of-expansion continent is refused', ev('level'), 'world');
  eq('...and it is allowed at its expansion', (xpac('kunark'), ev("enterCont('Kunark')"), ev('cur')), 'Kunark');
  xpac('classic');
  eq('...and switching back out from inside it retreats to the globe', ev('level'), 'world');
  ev('enterUniverse()');
}

section('expansion choice persists, per edition');
{
  const s = load(path.join(FX, 'fx-base.user.html'));
  eq('first run takes the authored default', s.ev('xpac'), 'classic');
  s.ev("setXpac('kunark')");
  const r = load(path.join(FX, 'fx-base.user.html'), { storage: s.store });
  eq('reload: the choice survived', r.ev('xpac'), 'kunark');
  ok('reload: the picker came back on the stored expansion',
    r.ev("document.querySelector('#xpacPick .k.on').dataset.xpac") === 'kunark');
  // Keys are suffixed per edition for the same reason every other buffer is.
  const au = load(path.join(FX, 'fx-base.author.html'), { storage: s.store });
  eq('author edition key', au.ev('xpacLsKey()'), 'eql_map_xpac_v1');
  eq('user edition key', r.ev('xpacLsKey()'), 'eql_map_xpac_u1');
  eq('so the author edition does not inherit it', au.ev('xpac'), 'classic');
  // A stored value that is not on the authored roster must never reach a rank lookup.
  const bad = load(path.join(FX, 'fx-base.user.html'),
    { storage: { eql_map_xpac_u1: 'luclin' } });
  eq('a stale stored expansion falls back to the default', bad.ev('xpac'), 'classic');
  ok('and it loaded without error', bad.errors.length === 0, bad.errors);
}

section('partial builds remove legs, not surviving routes');
{
  const s = load(path.join(FX, 'fx-skip-zone.user.html'));
  ok('partial fixture loads', s.errors.length === 0, s.errors);
  const e = s.ev;
  e('TADJ=null;TARR=null;tBuild()');
  ok('an anywhere route keeps its surviving beta destination',
    e("TARR.some(x=>x.to==='beta'&&x.step.label==='Beta/Gamma spires')"));
  ok('an anywhere route does not retain its absent destination',
    !e("TARR.some(x=>x.to==='gamma')"));
  eq('the node filter cannot traverse an absent middle stop', e("tPlan(['beta'],['zeta'])"), null);
  ok('the live beta control remains routable from zeta',
    e("tPlan(['zeta'],['beta'])!==null"));
  ok('the walk edge touching gamma is absent from adjacency',
    !e("(TADJ.beta||[]).some(x=>x.to==='gamma')"));
  eq('gamma own hub is hidden', e("xpacHubHidden('Antonica',2)"), true);
  eq('beta own hub remains visible', e("xpacHubHidden('Antonica',1)"), false);
  e("enterCont('Antonica');draw()");
  eq('the draw/pick list omits only the absent-stop hub',
    JSON.parse(e('JSON.stringify(hubScreens.map(s=>s.h.label))')),
    ['Alpha Docks', 'Beta Spires']);
  e("tPick('from',{kind:'zone',key:'beta',name:'Beta Hills'});"
    + "tPick('to',{kind:'zone',key:'gamma',name:'gamma'});");
  const msg = e("document.getElementById('tvOut').textContent");
  ok('the panel names build absence', /not in this build.*map pack/.test(msg), msg);
  ok('the missing-zone panel does not call it later', !/later/.test(msg), msg);
  e("document.getElementById('tvTo').value='gamma';tSuggest('to')");
  const sug = e("document.getElementById('tvToSug').textContent");
  ok('the search suggestion names build absence too', /not in this build/.test(sug), sug);
  ok('the missing-zone suggestion does not call it later', !/later/.test(sug), sug);
}

section('author edition shows the numbers the user edition withholds');
{
  const c = load(path.join(FX, 'fx-base.author.html'));
  ok('author: no load errors', c.errors.length === 0, c.errors);
  c.ev("tPick('from',{kind:'zone',key:'alpha',name:'Alpha Fields'});"
    + "tPick('to',{kind:'zone',key:'gamma',name:'Gamma Wastes'});");
  eq('one cost cell per leg',
    c.ev("document.querySelectorAll('#travel .leg .c').length"), 2);
  eq('the per-leg figures are the authored costs',
    JSON.parse(c.ev("JSON.stringify([...document.querySelectorAll('#travel .leg .c')].map(e=>e.textContent))")),
    ['4.2', '13.0']);
  ok('and a total',
    /total 17\.2/.test(c.ev("document.getElementById('tvOut').textContent")),
    c.ev("document.getElementById('tvOut').textContent"));
}

console.log('\n' + checks + ' checks, ' + fails + ' failed');
console.log('RESULT: ' + (fails ? 'FAIL' : 'PASS'));
process.exit(fails ? 1 : 0);
