// Travel guide against the REAL artifact: actual routes over the authored graph, and the
// search index, which the fixture tier cannot reach (ZIDX is built from DETAIL and the
// fixtures ship DETAIL={}).
//
// Algorithm semantics live in travel.test.js instead, deliberately: on real data an alternate
// walk chain almost always exists, so a directedness or gating bug hides behind a path that
// happens to work anyway.
//
// Usage: node travel-full.test.js <artifact.html>
const { load } = require('./lib.js');

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
function info(t) { console.log('  info  ' + t); }
function section(t) { console.log('\n-- ' + t); }

const a = load(process.argv[2]);
if (a.errors.length) { console.log('FAIL load: ' + a.errors.join('; ')); process.exit(1); }
const ev = a.ev;

function plan(from, to, caps) {
  ev('for(const k in TCAPS)TCAPS[k]=false;'
    + (caps || []).map((c) => `TCAPS[${JSON.stringify(c)}]=true;`).join('')
    + 'TADJ=null;');
  return JSON.parse(ev(`JSON.stringify(tPlan(${JSON.stringify(from)},${JSON.stringify(to)}))`));
}
const hops = (r) => r.legs.map((l) => l.from + '>' + l.to);
const find = (q, n) => JSON.parse(
  ev(`JSON.stringify(tFind(${JSON.stringify(q)},${n || 9}).map(e=>e.kind+':'+e.key))`));

section('the roster the runtime built from the authored graph');
{
  const n = ev('Object.keys(TZONES).length');
  eq('77 routed zones, matching what verify.py travel reports', n, 77);
  eq('no node is missing a name', ev('Object.keys(TZONES).filter(k=>!TZONES[k].name).length'), 0);
  eq('no node fell back to its own key as a name',
    ev('Object.keys(TZONES).filter(k=>TZONES[k].name===k).length'), 0);
  info(ev('TSEARCH.length') + ' search entries ('
    + ev('Object.keys(TRAVEL.groups).length') + ' groups + ' + n + ' zones)');
}

section('every routed zone is findable by typing its own name');
{
  // The property that actually matters, and it does NOT depend on the zone having a detail
  // map: names come from ALL, so a routable zone shipped without a DETAIL entry is still
  // searchable. Asserting ZIDX coverage instead would enforce a coincidence the runtime no
  // longer relies on, and would fail the day a plane ships routable but undetailed.
  const missed = JSON.parse(ev(`JSON.stringify(Object.keys(TZONES).filter(function(k){
    return !tFind(TZONES[k].name,30).some(function(e){return e.kind==='zone'&&e.key===k;});}))`));
  eq('no routed zone is unsearchable', missed, []);
  const detailed = ev('Object.keys(TZONES).filter(k=>DETAIL[TZONES[k].cont]'
    + '&&DETAIL[TZONES[k].cont].zones[k]).length');
  info(detailed + '/' + ev('Object.keys(TZONES).length')
    + ' routed zones also have a detail map (reported, not enforced)');
}

section('search ranking: the group wins a bare city name, quarters stay reachable');
{
  eq('"neriak" offers the group first', find('neriak')[0], 'group:Neriak');
  ok('...with all three quarters behind it',
    ['neriaka', 'neriakb', 'neriakc'].every((k) => find('neriak').indexOf('zone:' + k) > 0),
    find('neriak'));
  eq('"neriak commons" reaches that quarter alone', find('neriak commons'), ['zone:neriakb']);
  eq('"freeport" offers the group first', find('freeport')[0], 'group:Freeport');
  eq('"west freeport" reaches the single zone', find('west freeport'), ['zone:freportw']);
  eq('"qeynos" offers the group first', find('qeynos')[0], 'group:Qeynos');
  // ZALIAS is consulted only by resolveZone's exact lookup; without folding its keys in as
  // search terms this returns nothing at all.
  eq('"North Ro" surfaces through ZALIAS', find('north ro'), ['zone:nro']);
  eq('"Butcherblock" surfaces through ZALIAS', find('butcherblock')[0], 'zone:butcher');
  eq('a nonsense query finds nothing', find('zzzz'), []);
  eq('an empty query finds nothing', find('   '), []);
}

section('real routes over the authored graph');
{
  const boat = plan(['qeynos'], ['erudnint']);
  ok('South Qeynos -> Erudin (inside) routes', !!boat, boat);
  if (boat) {
    ok('via the Erudin boat', boat.legs.some((l) => l.label === "Erudin ⇄ Erud's Crossing ⇄ South Qeynos"),
      boat.legs.map((l) => l.label));
    ok('touching the Erud\'s Crossing waypoint, which carries no hub at all',
      hops(boat).some((h) => h.indexOf('erudsxing') >= 0), hops(boat));
  }
  const fp = plan(['freportw'], ['butcher']);
  ok('West Freeport -> Butcherblock routes with no capability at all', !!fp, fp);
  if (fp) {
    ok('crossing via Ocean of Tears', hops(fp).some((h) => h.indexOf('oot') >= 0), hops(fp));
    ok('by boat', fp.legs.some((l) => l.kind === 'boat'), fp.legs.map((l) => l.kind));
  }
  const walk = plan(['qeynos2'], ['qeytoqrg']);
  ok('a walk-only Antonica pair returns a pure walk chain',
    walk && walk.legs.every((l) => l.kind === 'walk'), walk);
  eq('...and no route label rides a walk leg',
    walk ? walk.legs.map((l) => l.label) : null, ['']);
}

section('the planes: gated in, and the reagent note reaches the leg');
{
  eq('Plane of Fear is unreachable ungated', plan(['freportw'], ['fearplane']), null);
  const pof = plan(['freportw'], ['fearplane'], ['pof']);
  ok('...and reachable once Plane of Fear access is on', !!pof);
  if (pof) {
    const last = pof.legs[pof.legs.length - 1];
    eq('arriving through the Feerrott portal, a `line` from a specific origin',
      last.from + '>' + last.to, 'feerrott>fearplane');
    eq('by the portal route', last.label, 'Plane of Fear');
  }
  eq('Plane of Sky is unreachable without wizard ports', plan(['freportw'], ['airplane']), null);
  const sky = plan(['freportw'], ['airplane'], ['wizard']);
  ok('...and one hop away with them', sky && sky.legs.length === 1, sky);
  if (sky) {
    ok('the consumed component rides the arriving leg rather than gating the plan',
      /Cloudy Stone of Veeshan \(consumed\)/.test(sky.legs[0].note), sky.legs[0].note);
    ok('and Alter Plane is named', /Alter Plane/.test(sky.legs[0].note), sky.legs[0].note);
  }
}

section('`anywhere` is directed on real data too');
{
  // Not a substitute for the fixture assertion -- an alternate path exists here by design --
  // but the ASYMMETRY is still meaningful: porting in is one hop, getting back out is not.
  const into = plan(['freportw'], ['airplane'], ['wizard']);
  const outOf = plan(['airplane'], ['freportw'], ['wizard']);
  ok('both directions route', !!into && !!outOf);
  if (into && outOf) {
    ok('but leaving costs more than arriving (the edge is one-way)',
      outOf.total > into.total, { in: into.total, out: outOf.total });
    ok('leaving needs more than one leg', outOf.legs.length > 1, hops(outOf));
  }
}

section('groups as endpoints');
{
  eq('"Freeport" resolves to its three zones',
    JSON.parse(ev("JSON.stringify(tNodes({kind:'group',key:'Freeport'}))")).sort(),
    ['freporte', 'freportn', 'freportw']);
  const g = plan(['butcher'], ['freporte', 'freportn', 'freportw']);
  ok('Butcherblock -> Freeport (group) routes', !!g, g);
  if (g) ok('terminating on a Freeport zone',
    ['freporte', 'freportn', 'freportw'].indexOf(g.legs[g.legs.length - 1].to) >= 0,
    hops(g));
}

section('calibration holds: no trip detours through a port to reach the zone next door');
{
  // The failure mode the cost pass exists to prevent. With a port cheaper than a typical
  // single walk edge, the planner tells a player standing at the Cazic-Thule exit to cast a
  // port to step into The Feerrott, and the 76 walk edges go decorative.
  //
  // These two are NOT bugs: each is a crossing long enough that a porting class really would
  // port. Declared by name rather than tolerated by a threshold, exactly as TRAVEL_AWAITING
  // is, so the list cannot rot -- a third fails, and one that stops needing the exemption
  // fails too.
  // Both are Karana-basin crossings of 33+ units, the widest walk edges on the map, and each
  // is exempt in ONE direction only: an arrival edge is one-way, so a pair can port in the
  // direction whose destination is a ring or spire stop and walk back.
  // This list has shrunk twice, and both times that was the calibration getting sharper rather
  // than slipping. Recosting the walk graph from the detail-map doorways dropped the North/South
  // Karana pair (real doorways price it 29.1 against the closest-approach 37.2, under the 30 a
  // port costs). Then pricing the in-zone walk to and from a hub dropped four more.
  //
  // The surviving pair is ASYMMETRIC, and that is now a modelled fact rather than a coincidence:
  // West Karana's wizard spire sits 8 097 units from its centroid, so arriving there costs
  // 30 + 32.4 = 62.4 against a 47.3 walk and porting loses, while arriving at North Karana's
  // costs 30 + 5.1 = 35.1 and it wins. An arrival edge is one-way, so the two directions are
  // genuinely allowed to differ.
  const EXPECTED_PORT = [
    'lakerathe>southkarana',      // 35.4 walk vs 30 + 18.6 access to South Karana's druid ring
    'qey2hh1>northkarana',        // 47.3 walk vs 30 + 5.1 access to North Karana's wizard spire
  ];
  const found = JSON.parse(ev(`JSON.stringify((function(){
    for(const k in TCAPS)TCAPS[k]=true; TADJ=null;
    const out=[];
    for(const w of TRAVEL.walk){
      for(const p of [[w.z[0],w.z[1]],[w.z[1],w.z[0]]]){
        const r=tPlan([p[0]],[p[1]]);
        if(r&&r.legs.some(l=>l.kind==='ring'||l.kind==='spire'))out.push(p[0]+'>'+p[1]);}}
    return out.sort();})())`));
  const unexpected = found.filter((k) => EXPECTED_PORT.indexOf(k) < 0);
  const stale = EXPECTED_PORT.filter((k) => found.indexOf(k) < 0);
  eq('no adjacent pair routes via a port beyond the declared long crossings', unexpected, []);
  eq('...and every declared exemption still needs to be declared', stale, []);
  info(found.length + ' of ' + (2 * ev('TRAVEL.walk.length'))
    + ' directed adjacent pairs port instead of walking');

  // The other half: a porting class must still prefer its own ring over a long boat.
  const druid = plan(['freportw'], ['butcher'], ['druid']);
  ok('a druid reaches Butcherblock by its ring, not by the Ocean of Tears boat',
    druid && druid.legs.length === 1 && druid.legs[0].kind === 'ring', druid);
  const ungated = plan(['freportw'], ['butcher']);
  ok('...while the boat is still what an ungated traveller gets',
    ungated && ungated.legs.some((l) => l.kind === 'boat'), ungated);
  ok('and the port is genuinely cheaper than that boat trip',
    druid.total < ungated.total, { port: druid.total, boat: ungated.total });
}

section('four adjudicated zone lines stay adjudicated');
{
  // Each was settled on two independent sources: the zone's OWN detail-map transition
  // labels (`to_`/`from_`, resolved through resolveZone), and a second community planner
  // queried on these specific pairs. All four are recorded in travel.json's `overrides`,
  // so --audit subtracts them; these assertions stop the graph drifting back.
  const direct = (a, b) => {
    const r = plan([a], [b], []);
    return !!r && r.legs.length === 1 && r.legs[0].kind === 'walk';
  };
  const hops = (a, b) => {
    const r = plan([a], [b], []);
    return r ? r.legs.map((l) => l.to) : null;
  };
  ok('Dagnor\'s Cauldron does not open onto Castle Mistmoore',
    !direct('cauldron', 'mistmoore'), hops('cauldron', 'mistmoore'));
  ok('...so Greater Faydark reaches the Cauldron through Butcherblock',
    (hops('gfaydark', 'cauldron') || []).indexOf('butcher') >= 0, hops('gfaydark', 'cauldron'));
  ok('Kedge Keep does not open onto the Estate of Unrest',
    !direct('kedge', 'unrest'), hops('kedge', 'unrest'));
  ok('...both reach each other through Dagnor\'s Cauldron',
    (hops('kedge', 'unrest') || []).indexOf('cauldron') >= 0, hops('kedge', 'unrest'));
  ok('Paineel does not open onto the Stonebrunt Mountains',
    !direct('paineel', 'stonebrunt'), hops('paineel', 'stonebrunt'));
  ok('...it reaches them through The Warrens',
    (hops('paineel', 'stonebrunt') || []).indexOf('warrens') >= 0, hops('paineel', 'stonebrunt'));
  ok('The Feerrott DOES open onto the Rathe Mountains',
    direct('feerrott', 'rathemtn'), hops('feerrott', 'rathemtn'));
  // and nothing was stranded by the three removals
  for (const z of ['mistmoore', 'kedge', 'unrest', 'stonebrunt']) {
    ok('nothing stranded: ' + z + ' is still reachable on foot from Freeport',
      !!plan(['freportw'], [z], []), z);
  }
}

section('every routed zone can actually be reached from somewhere, at every expansion');
{
  // Mirrors verify.py travel's reachability report, but through the runtime pathfinder, so
  // an edge-assembly bug that the Python side cannot see shows up here.
  //
  // Swept per expansion over the IN-EXPANSION node set, not over TZONES. TZONES stays the complete authored
  // roster by design -- it is the naming and lookup table search needs -- so iterating it at an
  // early expansion would demand a route to a zone the server does not have yet. Freeport is the
  // origin at every expansion because it is in the first one.
  for (const e of ev('XPACS.order')) {
    ev(`setXpac(${JSON.stringify(e)})`);
    const bad = JSON.parse(ev(`JSON.stringify((function(){
      for(const k in TCAPS)TCAPS[k]=true; TADJ=null;
      const out=[];
      for(const k of Object.keys(TZONES).filter(xpacZoneOn)){ if(k==='freportw')continue;
        if(!tPlan(['freportw'],[k]))out.push(k); }
      return out;})())`));
    eq('nothing is stranded at ' + e + ' with every capability granted', bad, []);
    info(ev('Object.keys(TZONES).filter(xpacZoneOn).length') + ' of '
      + ev('Object.keys(TZONES).length') + ' authored zones exist at ' + e);
  }
  ev("setXpac(XPACS.default)");
}

section('exactly what vanishes at the first expansion, declared rather than counted');
{
  // Pinned as lists in the style of EXPECTED_PORT above, and every figure here was MEASURED off
  // data/ rather than taken from the spec -- which is how the world-link set came to be five
  // entries and not the four the spec claimed. Link 8's far endpoint lies at distance 0.000 from
  // Velious' globe box AND from Plane of Hate's, whose boxes overlap; it is realm-tagged Norrath
  // and so is only ever drawn on the Norrath globe, where Plane of Hate does not appear at all.
  // It is the Everfrost run to Velious, and it does go at the first expansion.
  const HIDDEN_CONT = ['Kunark', 'Timorous Deep', 'Velious'];
  const HIDDEN_ROUTE = ['boat-butcher-timorous'];
  const HIDDEN_WL = [4, 5, 6, 7, 8];
  const HIDDEN_IN_XPAC_HUB = ['Faydwer:4'];   // a hub in a continent that DOES exist at this expansion
  const GONE_ZONES = ['timorous'];           // ...of the authored travel roster

  ev("setXpac('classic')");
  eq('the continents that do not exist yet',
    JSON.parse(ev('JSON.stringify(names.filter(c=>!XPAC_CONT.has(c)).sort())')), HIDDEN_CONT);
  eq('the routes that go with them',
    JSON.parse(ev('JSON.stringify([...XPAC_ROUTE].sort())')), HIDDEN_ROUTE);
  eq('the world links, by published index',
    JSON.parse(ev('JSON.stringify([...XPAC_WL].sort((a,b)=>a-b))')), HIDDEN_WL);
  eq('the routed zones that go with them',
    JSON.parse(ev('JSON.stringify(Object.keys(TZONES).filter(k=>!xpacZoneOn(k)).sort())')), GONE_ZONES);
  // The case the whole feature is really about: a dock in a continent the player CAN reach,
  // serving only a boat to one they cannot. Separable only because the author drew Butcherblock's
  // two docks as two hubs.
  eq('the hubs hidden inside a continent that still exists',
    JSON.parse(ev(`JSON.stringify(Object.keys(XPAC_HUB).filter(c=>XPAC_CONT.has(c))
      .flatMap(c=>[...XPAC_HUB[c]].map(i=>c+':'+i)).sort())`)), HIDDEN_IN_XPAC_HUB);
  info(ev('Object.keys(XPAC_HUB).reduce((n,c)=>n+XPAC_HUB[c].size,0)') + ' hubs hidden in total, '
    + 'across ' + ev('Object.keys(XPAC_HUB).length') + ' continents');

  // The boat that motivated the feature still sails at the expansion it belongs to, and the classic
  // boat sharing that continent is untouched by any of it.
  ok('the Butcherblock boat to the expansion is gone at the first expansion',
    !plan(['butcher'], ['timorous'], []));
  ev("setXpac('kunark')");
  ok('...and sails at its own', !!plan(['butcher'], ['timorous'], []));
  ev("setXpac('classic')");
  const fp = plan(['freportw'], ['butcher'], []);
  ok('while the Freeport boat to Butcherblock is unaffected',
    fp && fp.legs.some((l) => l.kind === 'boat'), fp && hops(fp));
  eq('nothing hides at the last expansion',
    (ev(`setXpac(${JSON.stringify(ev('XPACS.order[XPACS.order.length-1]'))})`),
      JSON.parse(ev('JSON.stringify([names.filter(c=>!XPAC_CONT.has(c)).length,'
        + '[...XPAC_ROUTE].length,[...XPAC_WL].length,Object.keys(XPAC_HUB).length])'))),
    [0, 0, 0, 0]);
  ev("setXpac(XPACS.default)");
}

// ===================== phase 3: the route drawn on the map =====================
// Geometry lives here rather than in travel.test.js because the fixture's stub continents all
// reuse one zone key, so there is nothing there to place a route across.

// Plan through the PANEL, not tPlan, because TROUTE is built by tRender and the lifecycle is
// half the thing under test.
function panelPlan(fromKey, toKey, caps) {
  ev("for(const k in TCAPS)TCAPS[k]=false;"
    + (caps || []).map((c) => `TCAPS[${JSON.stringify(c)}]=true;`).join('') + 'TADJ=null;');
  ev('setTravel(true)');
  ev(`tPick('from',{kind:'zone',key:${JSON.stringify(fromKey)},name:tzName(${JSON.stringify(fromKey)})})`);
  ev(`tPick('to',{kind:'zone',key:${JSON.stringify(toKey)},name:tzName(${JSON.stringify(toKey)})})`);
  return JSON.parse(ev('JSON.stringify(TROUTE&&{legs:TROUTE.legs,on:Object.keys(TROUTE.on).sort(),'
    + 'pip:TROUTE.pip,sel:TROUTE.sel})'));
}

section('every routed continent belongs to a realm the world view can show');
{
  const orphans = JSON.parse(ev(`JSON.stringify((function(){const out={};
    for(const k in TZONES){const c=TZONES[k].cont; if(c&&!altOf(c))out[c]=1;}
    return Object.keys(out);})())`));
  eq('altOf resolves every routed zone\'s continent', orphans, []);
  eq('...Antonica in Norrath', ev("altOf('Antonica')"), 'Norrath');
  eq('...and Plane of Fear in The Planes', ev("altOf('Plane of Fear')"), 'The Planes');
}

section('the two route lookups: membership includes the start, pips do not');
{
  const r = panelPlan('qeynos', 'erudnint');
  ok('South Qeynos -> Erudin planned through the panel', !!r, r);
  eq('membership is the departure zone plus every arrival',
    r.on, ['erudnext', 'erudnint', 'erudsxing', 'qeynos']);
  eq('the departure zone counts as on the route', ev("tOnRoute('qeynos')"), true);
  eq('...and a zone the trip never touches does not', ev("tOnRoute('befallen')"), false);
  // The bug this shape exists to prevent: one map with -1 for the start makes "<0" mean both
  // "off the route" and "is the start", so the departure zone dims while the rest stays lit.
  eq('the departure zone has no pip number', ev("tPipOf('qeynos')"), -1);
  eq('pip numbers follow leg order', [ev("tPipOf('erudsxing')"), ev("tPipOf('erudnext')"),
    ev("tPipOf('erudnint')")], [0, 1, 2]);
  eq('dimming follows membership, not the pip map',
    [ev("zoneDimmed('qeynos')"), ev("zoneDimmed('befallen')")], [false, true]);
}

section('TROUTE lifecycle: every path through tRender clears it, and closing does too');
{
  const alive = () => ev('TROUTE!==null');
  panelPlan('qeynos', 'erudnint');
  eq('a planned trip is live', alive(), true);
  // 1. no destination selected
  ev("TSEL.to=null;tInput('to').value='';tRender()");
  eq('clearing the destination clears the route', alive(), false);
  // 2. already there
  panelPlan('qeynos', 'qeynos');
  eq('"you are already there" leaves nothing drawn', alive(), false);
  // 3. no route with the enabled modes
  panelPlan('freportw', 'fearplane');
  eq('an unreachable destination leaves nothing drawn', alive(), false);
  ok('...and still names what would open a way through',
    /Plane of Fear access/.test(ev("document.getElementById('tvOut').textContent")),
    ev("document.getElementById('tvOut').textContent"));
  // 4. closing the panel
  panelPlan('qeynos', 'erudnint');
  eq('re-planning brings it back', alive(), true);
  ev('setTravel(false)');
  eq('closing the panel takes the route (and so its dimming) with it', alive(), false);
  eq('...and nothing is left dimmed', ev("zoneDimmed('befallen')"), false);
}

section('clicking an itinerary leg navigates without hijacking focus');
{
  panelPlan('qeynos', 'erudnint');
  eq('the panel built one clickable row per leg', ev('TROWS.length'), 3);
  ev("enterCont('Antonica');focus=null");
  ev('TROWS[1].onclick()');
  eq('row 1 arrives in Erudin, so the view is on Odus', ev('cur'), 'Odus');
  eq('...at continent level', ev('level'), 'continent');
  eq('...with that leg selected', ev('TROUTE.sel'), 1);
  // The trap: focus wins over route dimming in zoneDimmed, so setting it here would drop every
  // zone but one to alpha 0.10 AND skip every other zone's label - the route would vanish into
  // a near-black map. Selection emphasis rides TROUTE.sel instead.
  eq('focus is left alone', ev('focus'), null);
  eq('...so route dimming still governs', ev("zoneDimmed('tox')"), true);
  eq('the selected row is the marked one',
    JSON.parse(ev("JSON.stringify(TROWS.map(r=>r.classList.contains('on')))")),
    [false, true, false]);
  // The legend row is a second entry point that DOES set focus, so the guard cannot live only in
  // tGoLeg: focus dimming would otherwise leave the route as a bright line on a near-black map.
  ev("focus='tox';draw()");
  eq('a focused zone suppresses the route rather than drawing it over the dimming',
    JSON.parse(ev(`JSON.stringify((function(){const d=contData('Odus');
      let n=0;const real=tStroke;tStroke=function(){n++;};
      try{drawRouteCont(d,'Odus');drawRoutePips(d);}finally{tStroke=real;}
      return n;})())`)), 0);
  ev("focus=null;draw()");
  ok('...and clearing focus brings it back',
    JSON.parse(ev(`JSON.stringify((function(){const d=contData('Odus');
      let n=0;const real=tStroke;tStroke=function(){n++;};
      try{drawRouteCont(d,'Odus');}finally{tStroke=real;}
      return n;})())`)) > 0, 'no segments drawn with focus clear');
  eq('and the arrival zone is centred', JSON.parse(ev(`JSON.stringify((function(){
    const c=zoneCentroid(contData('Odus').zones['erudnext']);
    return [Math.round(wx(c[0])-cv.width/2),Math.round(wy(c[1])-cv.height/2)];})())`)), [0, 0]);
}

section('position sources differ by level, and each matches the drawing under it');
{
  panelPlan('qeynos', 'qeynos2');
  ev("buildEditState('Antonica');bindES('Antonica');enterCont('Antonica')");
  const before = JSON.parse(ev("JSON.stringify(zoneCentroid(contData('Antonica').zones['qeynos']))"));
  const pub = JSON.parse(ev("JSON.stringify(zoneCentroid(ALL['Antonica'].zones['qeynos']))"));
  ev("EDIT['Antonica'].zones['qeynos'].xf.tx+=500");
  const after = JSON.parse(ev("JSON.stringify(zoneCentroid(contData('Antonica').zones['qeynos']))"));
  eq('a viewer moving a zone moves the continent-level route point', after[0] - before[0], 500);
  // The world globe draws PUBLISHED outlines by design (buildWorldCache reads ALL, not
  // contData), so a route drawn from customised zone positions would float off the shapes it
  // claims to follow. Same nudge, no movement.
  eq('...and leaves the world-level one where the published outline is',
    JSON.parse(ev("JSON.stringify(zoneCentroid(ALL['Antonica'].zones['qeynos']))")), pub);
  // Not a contradiction: areaPt reads metaPos, which DOES go through WEDIT, so a world route
  // follows a continent the viewer moved while correctly not following a zone inside it.
  ev('buildWorldEditState()');
  const g0 = JSON.parse(ev(`JSON.stringify((function(){const wm=worldMap();
    const c=zoneCentroid(ALL['Antonica'].zones['qeynos']);return areaPt('Antonica',c[0],c[1],wm);})())`));
  ev("WEDIT.meta['Antonica'].pos[0]+=3");
  const g1 = JSON.parse(ev(`JSON.stringify((function(){const wm=worldMap();
    const c=zoneCentroid(ALL['Antonica'].zones['qeynos']);return areaPt('Antonica',c[0],c[1],wm);})())`));
  ok('but a viewer moving the whole continent does move it', g1[0] > g0[0], { g0: g0, g1: g1 });
  ev('WEDIT=null;delete EDIT["Antonica"]');
}

section('a vehicle costs the walk to it as well as the ride');
{
  // A dock, ring or spire sits somewhere IN its zone, not at the centroid, so boarding or leaving
  // one is real walking. It runs 1.1 to 32.4 cost units on current data.
  const acc = JSON.parse(ev(`JSON.stringify((function(){const o={};
    for(const r of TRAVEL.routes)o[r.id]=r.access||null; return o;})())`));
  eq('every route declares an access cost per stop',
    Object.keys(acc).filter((k) => !acc[k]
      || acc[k].length !== JSON.parse(ev(`JSON.stringify(TRAVEL.routes.find(r=>r.id===${
        JSON.stringify(k)}).stops.length)`))), []);
  // A `line` leg pays both ends; an `anywhere` port pays only the arrival, because it is self-cast
  // from wherever you stand -- which is the same fact that makes its hubA null.
  const boat = plan(['qeynos'], ['erudnint']);
  const legRide = ev("TRAVEL.routes.find(r=>r.id==='boat-erudin-qeynos').cost");
  const a = JSON.parse(ev("JSON.stringify(TRAVEL.routes.find(r=>r.id==='boat-erudin-qeynos').access)"));
  eq('the boat out of South Qeynos charges its dock walk at both ends',
    Math.round(boat.legs[0].cost * 10) / 10, Math.round((legRide + a[2] + a[1]) * 10) / 10);
  const sky = plan(['freportw'], ['airplane'], ['wizard']);
  const skyR = ev("TRAVEL.routes.find(r=>r.id==='wizard-planes').cost");
  const skyA = JSON.parse(ev("JSON.stringify(TRAVEL.routes.find(r=>r.id==='wizard-planes').access)"));
  eq('a self-cast port charges only the walk out of where it drops you',
    Math.round(sky.legs[0].cost * 10) / 10, Math.round((skyR + skyA[0]) * 10) / 10);
  // The bug this shape prevents: TARR relaxes on its own `cost` field, so an arrival built from
  // the bare route cost would price the walk out of the ring at zero while the itinerary showed it.
  ok('...and that really is dearer than the bare route cost (' + sky.legs[0].cost + ' > ' + skyR + ')',
    sky.legs[0].cost > skyR, { leg: sky.legs[0].cost, route: skyR });
  // Authored, not measured at runtime: a user can drag a hub in their own copy, and their
  // customisation must not reprice their routing -- the same invariant that keeps cost off zone
  // centroids. Checked by actually dragging one, not by reading the source for a hubPos call.
  const before = plan(['qeynos'], ['erudnint']).total;
  ev(`buildEditState('Antonica');
    EDIT['Antonica'].hubs[0].x+=9000; EDIT['Antonica'].hubs[0].y-=9000;`);
  const after = plan(['qeynos'], ['erudnint']).total;
  ev('delete EDIT["Antonica"]');
  eq('dragging the Qeynos dock 12 700 units does not change what the trip costs', after, before);
}

section('the detail frame reaches the continent frame by a derived pure translation');
{
  // The whole exit-point mechanism rests on this: a zone's zoomed-in DETAIL map and its
  // continent-frame geometry are the same traced outline under a pure translation. Derived from
  // one corresponding segment, then checked against every index-aligned segment the two lists
  // share. DETAIL carries extra segments the continent geometry dropped, hence the length
  // difference; the shared prefix must still agree.
  const hold = JSON.parse(ev(`JSON.stringify((function(){
    let zones=0,exact=0;const bad=[];
    for(const c in ALL){ if(!DETAIL[c])continue;
      for(const z in ALL[c].zones){ const d=DETAIL[c].zones[z]; if(!d)continue;
        const o=detailOffset(c,z); if(!o){bad.push(c+'/'+z+' no offset');continue;}
        zones++;
        const g=ALL[c].zones[z],n=Math.min(g.segs.length,d.segs.length);
        let agree=0;
        for(let i=0;i<n;i++){const a=g.segs[i],b=d.segs[i];
          if(Math.abs((a[0]-b[0])-o[0])<1.5&&Math.abs((a[1]-b[1])-o[1])<1.5)agree++;}
        if(agree/n>0.995)exact++; else bad.push(c+'/'+z+' '+Math.round(agree/n*100)+'%');}}
    return {zones:zones,exact:exact,bad:bad.slice(0,6)};})())`));
  eq('every zone shipping both files is a pure translation apart (' + hold.zones + ' zones)',
    [hold.exact, hold.bad], [hold.zones, []]);
  // Scale or rotation would break it, and a stale STORED offset would break silently -- which is
  // why it is derived. A zone re-imported with a different origin re-derives correctly.
  ok('there are zones to check at all', hold.zones > 100, hold);
  // One segment recovers a translation; it does not establish that there IS one. detailOffset
  // confirms against a second and gives up rather than inventing a placement.
  eq('a zone whose segments stop agreeing yields no offset at all',
    JSON.parse(ev(`JSON.stringify((function(){
      const d=DETAIL['Antonica'].zones['innothule'], keep=d.segs;
      const m=Math.floor(Math.min(ALL['Antonica'].zones['innothule'].segs.length,keep.length)/2);
      d.segs=keep.slice(); d.segs[m]=[keep[m][0]+9000,keep[m][1]-9000,keep[m][2],keep[m][3],keep[m][4]];
      delete DOFF['Antonica|innothule']; delete DEXIT['Antonica|innothule|sro'];
      const off=detailOffset('Antonica','innothule');
      const exit=zoneExitPoint('Antonica','innothule','sro');
      d.segs=keep; delete DOFF['Antonica|innothule']; delete DEXIT['Antonica|innothule|sro'];
      return [off,exit];})())`)), [null, null]);
  ok('...and the real offset is back once it agrees again',
    !!JSON.parse(ev("JSON.stringify(detailOffset('Antonica','innothule'))")),
    JSON.parse(ev("JSON.stringify(detailOffset('Antonica','innothule'))")));
}

section('exit points come from the zone\'s own transition labels, with a fallback chain');
{
  const cov = JSON.parse(ev(`JSON.stringify((function(){
    let both=0,one=0,none=0;const partial=[];
    for(const w of TRAVEL.walk){const A=TZONES[w.z[0]],B=TZONES[w.z[1]];
      if(!A||!B||!A.cont||!B.cont){none++;continue;}
      const a=zoneExitPoint(A.cont,w.z[0],w.z[1]), b=zoneExitPoint(B.cont,w.z[1],w.z[0]);
      if(a&&b)both++;
      else if(a||b){one++;partial.push(w.z[0]+'|'+w.z[1]);}
      else {none++;partial.push(w.z[0]+'|'+w.z[1]+' (neither)');}}
    return {both:both,one:one,none:none,partial:partial};})())`));
  eq('every walk edge has a named exit on at least one side', cov.none, 0);
  info(cov.both + ' of ' + ev('TRAVEL.walk.length') + ' edges name it from both sides; '
    + cov.one + ' from one (' + cov.partial.join(', ') + ')');
  // Reported, not pinned to 70: a re-imported detail map may legitimately add or drop a label.
  // What must not rot is `none` -- an edge with no named exit anywhere falls back to closest
  // approach, which is the thing this section exists to stop relying on.
  ok('and most name it from both', cov.both > cov.one * 4, cov);

  // The one-sided fallback, on a genuinely one-sided edge. guktop|innothule is the pair phase 1
  // ruled in on game knowledge against a detail label that puts the connection on LOWER Guk, so
  // Innothule names Upper Guk and Upper Guk does not name Innothule.
  eq('guktop|innothule really is one-sided',
    [!!JSON.parse(ev("JSON.stringify(zoneExitPoint('Antonica','guktop','innothule'))")),
      !!JSON.parse(ev("JSON.stringify(zoneExitPoint('Antonica','innothule','guktop'))"))],
    [false, true]);
  panelPlan('guktop', 'innothule');
  ev("enterCont('Antonica')");
  const pair = JSON.parse(ev(`JSON.stringify((function(){const d=contData('Antonica');
    const l=TROUTE.legs[0],w=tLegWaypoints(d,'Antonica',l);
    const e=zoneExitPoint('Antonica','innothule','guktop');
    const t=tPoint(d.zones['innothule'],e[0],e[1]);
    // Is guktop's end really the closest point of ITS outline to that doorway? Nothing may beat it.
    let best=1e18;const zo=d.zones['guktop'];
    for(const s of zo.segs)for(const p of [[s[0],s[1]],[s[2],s[3]]]){
      const q=tPoint(zo,p[0],p[1]);best=Math.min(best,Math.hypot(q[0]-t[0],q[1]-t[1]));}
    return {namedIsLabel:Math.round(Math.hypot(w[1][0]-t[0],w[1][1]-t[1])),
            unnamedOnOutline:Math.round(distToZone(zo,w[0][0],w[0][1])),
            chosen:Math.round(Math.hypot(w[0][0]-t[0],w[0][1]-t[1])),
            bestPossible:Math.round(best)};})())`));
  eq('the named side is exactly its label', pair.namedIsLabel, 0);
  eq('the unnamed side sits on its own outline', pair.unnamedOnOutline, 0);
  // Not a distance threshold -- the honest gap here is 2 411 units and a threshold would only
  // encode that. The property is that no point of Upper Guk's outline is nearer the doorway.
  eq('...and is the nearest point of that outline to the named doorway',
    pair.chosen, pair.bestPossible);
}

section('the authored walk costs are the doorways the RUNTIME resolves, not a second opinion');
{
  // The one check that keeps two languages in step. derive_travel_graph.py --recost writes these
  // costs using its own copy of znorm/ZIDX/ZALIAS/LINK_OVERRIDE; this recomputes them from the
  // template's, and a divergence in either table shows up here as a cost mismatch rather than as
  // a route that is quietly wrong. Nothing else compares the two implementations.
  //
  // Untransformed on purpose: cost must never read a zone's live transform, or an author nudging
  // a zone for looks would reprice the map. So this mirrors the script's transformed=False path -
  // stored cx/cy and local doorway coords, no tPoint anywhere.
  const cmp = JSON.parse(ev(`JSON.stringify((function(){
    const UNITS=250, out=[];
    const local=(c,z,t)=>zoneExitPoint(c,z,t);
    for(const w of TRAVEL.walk){
      const A=TZONES[w.z[0]],B=TZONES[w.z[1]];
      if(!A||!B||A.cont!==B.cont){out.push([w.z.join('|'),'cross-continent',null]);continue;}
      const c=A.cont, za=ALL[c].zones[w.z[0]], zb=ALL[c].zones[w.z[1]];
      // Untransformed nearest-endpoint, inlined rather than calling nearestOutlinePointTo:
      // that one transforms through tPoint by design, since the DRAWING must follow a viewer's
      // moved zone, and cost must not. Mixing the two frames here is what made this check
      // disagree with the script by 0.3 on the one edge that needs it.
      const nearTo=(z,X,Y)=>{let md=1e18,bp=[z.cx,z.cy];
        for(const s of z.segs)for(const p of [[s[0],s[1]],[s[2],s[3]]]){
          const d=(p[0]-X)*(p[0]-X)+(p[1]-Y)*(p[1]-Y);if(d<md){md=d;bp=p;}}
        return bp;};
      let a=local(c,w.z[0],w.z[1]), b=local(c,w.z[1],w.z[0]);
      if(a&&!b)b=nearTo(zb,a[0],a[1]);
      else if(b&&!a)a=nearTo(za,b[0],b[1]);
      else if(!a&&!b){const p=nearestOutlinePair(za,zb,200);a=p.p1;b=p.p2;}
      const reach=Math.hypot(za.cx-a[0],za.cy-a[1])+Math.hypot(b[0]-zb.cx,b[1]-zb.cy);
      const mine=Math.round(Math.max(reach/UNITS,0.1)*10)/10;
      if(Math.abs(mine-w.cost)>0.05)out.push([w.z.join('|'),w.cost,mine]);}
    return out;})())`));
  eq('every authored cost reproduces from the runtime\'s own label resolution', cmp, []);
  // 0.05 is float noise on a value both sides round to one decimal, i.e. they must agree exactly.
  // It was briefly 0.15 to absorb the script sampling 200 outline points where the viewer scans
  // them all -- that gap was closed in the script instead, because a tolerance wide enough to hide
  // a sampling difference is wide enough to hide a small table divergence.
  info('checked all ' + ev('TRAVEL.walk.length') + ' authored walk costs against the runtime');
}

section('a walk leg is drawn through the shared zone line, not across the middle');
{
  // The same measurement the cost uses - the outlines' closest approach - so the drawn line and
  // the price finally describe one journey. Deliberately NOT the edge's stored `at`.
  // On a pair whose outlines actually meet, the two waypoints collapse onto one doorway.
  panelPlan('kithicor', 'highpass');
  ev("enterCont('Antonica')");
  const door = JSON.parse(ev(`JSON.stringify((function(){const d=contData('Antonica');
    return tLegWaypoints(d,'Antonica',TROUTE.legs[0]);})())`));
  const doorGap = Math.round(Math.hypot(door[0][0] - door[1][0], door[0][1] - door[1][1]));
  ok('where the outlines meet, the two waypoints are one doorway (' + doorGap + ' units apart)',
    door.length === 2 && doorGap < 200, { pts: door, gap: doorGap });

  // innothule|sro is the hard case, and the distinction is WHICH points, not how close. Its
  // outlines genuinely never come near touching - the 13 800-unit stitch void the cost pass
  // documented - so the honest doorway is still a long jump. What separates it from the stored
  // `at` is that these two points sit ON their own outlines and `at`'s endpoints do not: `at`
  // holds the drawn connector's, resolved only to within ANCHOR_THRESH of a zone, and on this
  // pair they land 16 553 apart, further than the centroids themselves.
  panelPlan('innothule', 'sro');
  ev("enterCont('Antonica')");
  const w = JSON.parse(ev(`JSON.stringify((function(){const d=contData('Antonica');
    return tLegWaypoints(d,'Antonica',TROUTE.legs[0]);})())`));
  eq('the leg carries two waypoints, one per outline', w.length, 2);
  const gaps = JSON.parse(ev(`JSON.stringify((function(){const d=contData('Antonica');
    const w=tLegWaypoints(d,'Antonica',TROUTE.legs[0]);
    const e=TRAVEL.walk.find(x=>x.z.indexOf('innothule')>=0&&x.z.indexOf('sro')>=0);
    const R=v=>Math.round(v);
    return {ours:R(Math.hypot(w[0][0]-w[1][0],w[0][1]-w[1][1])),
            at:R(Math.hypot(e.at[0][0]-e.at[1][0],e.at[0][1]-e.at[1][1])),
            onOutline:[R(distToZone(d.zones['innothule'],w[0][0],w[0][1])),
                       R(distToZone(d.zones['sro'],w[1][0],w[1][1]))],
            atOnOutline:[R(distToZone(d.zones['innothule'],e.at[0][0],e.at[0][1])),
                         R(distToZone(d.zones['sro'],e.at[1][0],e.at[1][1]))]};})())`));
  ok('...where neither of `at`\'s endpoints does (' + gaps.atOnOutline.join(' / ') + ' units off)',
    gaps.atOnOutline[0] > 0 && gaps.atOnOutline[1] > 0, gaps);

  // The waypoint IS the label, not merely near it. Deliberately not a gap comparison against
  // `at`: with a real doorway on each side this crossing spans the stitch void diagonally
  // (16 546 units against `at`'s 16 553), so "shorter than `at`" would pass by 7 units and
  // assert nothing. What distinguishes them is provenance, checked here and above.
  const isLabel = JSON.parse(ev(`JSON.stringify((function(){const d=contData('Antonica');
    const w=tLegWaypoints(d,'Antonica',TROUTE.legs[0]);
    const e=zoneExitPoint('Antonica','innothule','sro');
    const t=tPoint(d.zones['innothule'],e[0],e[1]);
    return Math.round(Math.hypot(w[0][0]-t[0],w[0][1]-t[1]));})())`));
  eq('the waypoint is exactly the zone\'s own to_South_Desert_of_Ro label', isLabel, 0);

  // The crossing must be the exit the ZONE ITSELF names, not merely the nearest bit of outline.
  // South Ro lies ~16 000 units east of Innothule with a stitch void between, so the outlines'
  // closest approach lands on Innothule's east flank -- beside the Guk and Grobb city entrances --
  // while `to_South_Desert_of_Ro` in Innothule's own detail map sits at the top of the zone.
  // Closest approach is only a valid proxy for a zone line where the outlines actually touch.
  const north = JSON.parse(ev(`JSON.stringify((function(){const d=contData('Antonica');
    const w=tLegWaypoints(d,'Antonica',TROUTE.legs[0]);
    const zo=d.zones['innothule'];let y0=1e18,y1=-1e18;
    for(const s of zo.segs){y0=Math.min(y0,s[1],s[3]);y1=Math.max(y1,s[1],s[3]);}
    return Math.round((w[0][1]-y0)/(y1-y0)*100);})())`));
  ok('the Innothule end is its NORTHERN entrance, not a city one (' + north + '% up the zone)',
    north > 85, north);
  // Geometry read through contData, like the rest of the continent-level drawing.
  ev("buildEditState('Antonica');bindES('Antonica')");
  const moved = JSON.parse(ev(`JSON.stringify((function(){
    EDIT['Antonica'].zones['innothule'].xf.tx+=400;
    const d=contData('Antonica');
    return tLegWaypoints(d,'Antonica',TROUTE.legs[0])[0];})())`));
  eq('a viewer moving the zone moves its doorway with it', Math.round(moved[0] - w[0][0]), 400);
  ev('delete EDIT["Antonica"]');
}

section('a leg that leaves the continent still draws the half that is here');
{
  // The reported bug: drawRouteCont gated the whole leg on both centroids resolving, so a boat
  // arriving from Ocean of Tears drew nothing in Faydwer -- a ringed dock floating unconnected
  // beside a route that appeared to begin in the middle of Butcherblock. That in-zone walk is
  // priced in routes[].access, so it has to be visible.
  //
  // Counted off tStroke rather than inferred from tLegWaypoints, because the bug was in the
  // ASSEMBLY of the point sequence, not in the waypoints it assembles.
  const seg = (from, to, caps, cont) => {
    ev("for(const k in TCAPS)TCAPS[k]=false;"
      + (caps || []).map((c) => `TCAPS[${JSON.stringify(c)}]=true;`).join('') + 'TADJ=null;');
    ev('setTravel(true)');
    ev(`tPick('from',{kind:'zone',key:${JSON.stringify(from)},name:tzName(${JSON.stringify(from)})})`);
    ev(`tPick('to',{kind:'zone',key:${JSON.stringify(to)},name:tzName(${JSON.stringify(to)})})`);
    ev(`enterCont(${JSON.stringify(cont)})`);
    return JSON.parse(ev(`JSON.stringify((function(){
      const d=contData(${JSON.stringify(cont)}),drawn=[],real=tStroke;
      tStroke=function(A,B){drawn.push([A,B]);};
      try{drawRouteCont(d,${JSON.stringify(cont)});}finally{tStroke=real;}
      const l=TROUTE.legs[TROUTE.legs.length-1];
      const hub=tHubScreen(l.hubB,${JSON.stringify(cont)});
      const c=zoneCentroid(d.zones[l.to]);
      return {segments:drawn.length,
              fromResolves:!!tContScr(d,l.from),
              hubEnd:hub?[Math.round(hub[0]),Math.round(hub[1])]:null,
              centroidEnd:[Math.round(c[0]),Math.round(c[1])],
              ends:drawn.map(s=>[[Math.round(iwx(s[0][0])),Math.round(iwy(s[0][1]))],
                                 [Math.round(iwx(s[1][0])),Math.round(iwy(s[1][1]))]])};})())`));
  };
  // hub -> centroid, checked as an unordered pair so this does not also pin the draw direction.
  const joins = (r) => r.segments === 1
    && JSON.stringify(r.ends[0]) === JSON.stringify([r.hubEnd, r.centroidEnd]);
  const boat = seg('freportw', 'butcher', [], 'Faydwer');
  eq('the boat\'s departure zone is not in Faydwer at all', boat.fromResolves, false);
  ok('...yet its arrival half is drawn, dock to centroid', joins(boat), boat);
  // Same for an `anywhere` port cast from another continent: no departure hub by construction,
  // so the only geometry here is spire -> centroid.
  const port = seg('butcher', 'southkarana', ['wizard'], 'Antonica');
  ok('a port cast from another continent draws its arrival walk too, spire to centroid',
    joins(port), port);
}

section('a transport leg is drawn through its hubs, which is where its exit really is');
{
  panelPlan('qeynos', 'erudnint');
  ev("enterCont('Antonica')");
  const boat = JSON.parse(ev(`JSON.stringify((function(){const d=contData('Antonica');
    return tLegWaypoints(d,'Antonica',TROUTE.legs[0]);})())`));
  const dock = JSON.parse(ev("JSON.stringify(tHubScreen('Antonica:0','Antonica'))"));
  // A boat's exit is not a zone line at all - there is no shared outline with Erud's Crossing.
  eq('the boat out of Qeynos routes through its dock', boat, [dock]);
  // ...and a stop whose hub is in another continent contributes nothing here rather than
  // throwing or dragging the line off to a foreign coordinate.
  eq('the Erudin end contributes no waypoint in Antonica',
    JSON.parse(ev(`JSON.stringify((function(){const d=contData('Antonica');
      return tLegWaypoints(d,'Antonica',TROUTE.legs[1]);})())`)), []);
  eq('...and an off-continent walk leg contributes none either',
    JSON.parse(ev(`JSON.stringify((function(){const d=contData('Antonica');
      return tLegWaypoints(d,'Antonica',TROUTE.legs[2]);})())`)), []);
}

section('a cross-realm trip draws what this realm holds and declares the rest');
{
  const r = panelPlan('freportw', 'fearplane', ['pof']);
  ok('Freeport -> Plane of Fear routes with the portal enabled', !!r, r);
  ev("alt='Norrath'");
  const note = JSON.parse(ev('JSON.stringify(tRealmNote())'));
  eq('exactly the portal leg is outside Norrath', note && note.n, 1);
  eq('...and it points at the realm that holds it', note && note.realm, 'The Planes');
  ev('syncRealmRow()');
  ok('the panel offers the flip',
    /1 leg continues in The Planes/.test(ev("document.getElementById('tvRealm').textContent")),
    ev("document.getElementById('tvRealm').textContent"));
  // The row must not go on describing the realm you just left.
  ev("document.getElementById('tvRealm').onclick()");
  eq('taking the flip switches realm', ev('alt'), 'The Planes');
  eq('...and lands in that world view', ev('level'), 'world');
  const back = JSON.parse(ev('JSON.stringify(tRealmNote())'));
  eq('now it is the Norrath legs that are elsewhere', back && back.realm, 'Norrath');
  // All seven, not six: the crossing leg itself is undrawable from BOTH sides, since neither
  // realm holds both of its ends. Counting it once per realm is the honest answer - it is
  // exactly the leg neither world view can draw.
  eq('...all seven of them, the crossing leg included', back && back.n, 7);
  ev("alt='Norrath';enterWorld()");
}

section('hub rings resolve by content hint, not by a bare index');
{
  panelPlan('qeynos', 'erudnint');
  const legs = JSON.parse(ev('JSON.stringify(TROUTE.legs.map(l=>[l.hubA,l.hubB]))'));
  // `note` belongs to the stop you ARRIVE at; the glyph a continent should ring is the dock you
  // BOARD at. Carrying only the arrival anchor left Antonica un-ringed on a boat out of South
  // Qeynos, whose own dock is Antonica:0.
  eq('the boat out of Qeynos carries its departure dock', legs[0][0], 'Antonica:0');
  eq('...and the Erud\'s Crossing waypoint has no hub to arrive at', legs[0][1], null);
  eq('the next hop arrives at the Erudin dock', legs[1][1], 'Odus:0');
  ok('a dock in another continent does not ring this one',
    ev("tHubScreen('Odus:0','Antonica')") === null, ev("tHubScreen('Odus:0','Antonica')"));
  const published = JSON.parse(ev("JSON.stringify(tHubScreen('Odus:2','Odus'))"));
  ok('an unedited continent indexes straight through published HUBS', !!published, published);
  // The author edition's hub delete splices EDIT[c].hubs, so every index below the removed one
  // shifts. A bare index would ring a neighbouring glyph; resolveRef re-finds it by hint.
  ev("buildEditState('Odus')");
  ev("EDIT['Odus'].hubs.splice(0,1)");
  eq('after a hub above it is deleted, the ring still lands on the same glyph',
    JSON.parse(ev("JSON.stringify(tHubScreen('Odus:2','Odus'))")), published);
  ev('delete EDIT["Odus"]');

  // Expansion hiding is anchored the same way, and this is the assertion that catches a broken pidx:
  // Faydwer:4 is the Timorous dock, hidden at the first expansion, and Butcherblock's OTHER dock is
  // Faydwer:3 -- directly above it, so a bare live index starts hiding the wrong one the moment
  // anything is spliced out.
  ev("setXpac('classic');enterCont('Faydwer');draw()");
  const shown = () => JSON.parse(ev('JSON.stringify(hubScreens.map(s=>s.i))'));
  const pub4 = ev("JSON.stringify(HUBS['Faydwer'][4].label)");
  const pub3 = ev("JSON.stringify(HUBS['Faydwer'][3].label)");
  const drawn = () => JSON.parse(ev('JSON.stringify(hubScreens.map(s=>JSON.stringify(s.h.label)))'));
  ok('published: the expansion-hidden dock is not drawn', drawn().indexOf(pub4) < 0, [pub4, drawn()]);
  ok('...while the dock beside it is', drawn().indexOf(pub3) >= 0, [pub3, drawn()]);
  ev("buildEditState('Faydwer');EDIT['Faydwer'].hubs.splice(0,1);enterCont('Faydwer');draw()");
  ok('after a delete above them, the hidden one is still the hidden one',
    drawn().indexOf(pub4) < 0 && drawn().indexOf(pub3) >= 0, drawn());
  ev("EDIT['Faydwer'].hubs.unshift({x:0,y:0,kind:'boat',label:'Mine',letter:'',note:'',"
    + "anchor:null,lx:null,ly:null,ref:'boat|Mine',pidx:null,touched:true,hidden:false,userAdded:true});"
    + "enterCont('Faydwer');draw()");
  ok('and after an insert above them, still so',
    drawn().indexOf(pub4) < 0 && drawn().indexOf(pub3) >= 0, drawn());
  ok('...with the inserted hub itself drawn, never inheriting a published index',
    drawn().indexOf('"Mine"') >= 0, drawn());
  ev("delete EDIT['Faydwer'];enterWorld()");
  void shown;
}

section('zone-level exit emphasis comes from the detail map\'s own transition labels');
{
  // NOT from walk[].at: that is in continent-frame coords and the detail view is a different
  // frame with no recorded offset, so it cannot be projected here at all.
  panelPlan('freportw', 'oasis');
  eq('the trip runs West Freeport -> East Freeport -> North Ro -> Oasis',
    JSON.parse(ev('JSON.stringify(TROUTE.legs.map(l=>l.to))')), ['freporte', 'nro', 'oasis']);
  ev("enterZone('Antonica','nro')");
  eq('North Ro knows which way the trip leaves', ev("tNextFrom('nro')"), 'oasis');
  // Asserted on a leg whose label DOES resolve, not as coverage over all legs: a community map
  // may simply never have drawn one, and a boat leg has no transition label at all.
  ok('the Oasis exit is among the zone links drawn here',
    JSON.parse(ev('JSON.stringify(zlinks.map(z=>z.key))')).indexOf('oasis') >= 0,
    JSON.parse(ev('JSON.stringify(zlinks.map(z=>z.key))')));
  ok('and the HUD says where the trip goes next',
    /route continues → Oasis of Marr/.test(ev("document.getElementById('desc').textContent")),
    ev("document.getElementById('desc').textContent"));
  ev("enterZone('Antonica','oasis')");
  eq('the final zone has nothing departing it', ev("tNextFrom('oasis')"), null);
  ok('...so it reads as an arrival rather than going silent',
    /journey ends here/.test(ev("document.getElementById('desc').textContent")),
    ev("document.getElementById('desc').textContent"));
  ev("enterZone('Antonica','befallen')");
  ok('an off-route zone says nothing about the trip',
    !/route continues|journey ends/.test(ev("document.getElementById('desc').textContent")),
    ev("document.getElementById('desc').textContent"));
}

section('drawing the route at every level raises nothing');
{
  panelPlan('freportw', 'butcher');
  const n = a.errors.length;
  ev("enterWorld();enterCont('Antonica');enterCont('Faydwer');enterZone('Faydwer','butcher');enterUniverse()");
  eq('no console error across the whole cascade with a route live', a.errors.length, n);
}

console.log('\n' + checks + ' checks, ' + fails + ' failed');
console.log('RESULT: ' + (fails ? 'FAIL' : 'PASS'));
process.exit(fails ? 1 : 0);
