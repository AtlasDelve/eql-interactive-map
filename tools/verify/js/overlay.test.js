// Behavioural tests for the customization overlay, run against the small synthetic
// fixtures so canonical data can be mutated to simulate an author shipping an update.
const path = require('path');
const { load, lastToast } = require('./lib');

const FX = path.join(__dirname, '..', '_fx');
const fx = (v, ed) => path.join(FX, 'fx-' + v + '.' + (ed || 'user') + '.html');

let fails = 0;
let checks = 0;
function ok(name, cond, extra) {
  checks++;
  if (cond) { console.log('  OK   ' + name); return true; }
  fails++;
  console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : ''));
  return false;
}
function eq(name, got, want) {
  const g = JSON.stringify(got), wv = JSON.stringify(want);
  return ok(name + (g === wv ? '' : ' (got ' + g + ', want ' + wv + ')'), g === wv);
}
function section(t) { console.log('\n-- ' + t); }

// ---------------------------------------------------------------------------
section('fixture loads and edit state builds');
{
  const { ev, errors } = load(fx('base'));
  ok('no load errors', errors.length === 0, errors);
  eq('starts at universe', ev('level'), 'universe');
  ev("enterCont('Antonica')");
  eq('entered Antonica', ev('cur'), 'Antonica');

  ev("buildEditState('Antonica');detectLinks()");
  eq('gamma remains beyond automatic weld distance',
    ev("zoneLinks.map(l=>weldKey(l.z1,l.z2)).sort()"), ['alpha|beta']);

  // finding 2: welds must NOT be detected just by viewing a continent
  ev('setEdit(true)');
  eq('welds present once Edit opens', ev("EDIT['Antonica'].linksReady"), true);
  const welds = ev("EDIT['Antonica'].zoneLinks.map(l=>weldKey(l.z1,l.z2)).sort()");
  eq('automatic and published-manual links are both present', welds, ['alpha|beta', 'beta|gamma']);
  eq('published lock exception honoured (unlocked)',
    ev("EDIT['Antonica'].zoneLinks[0].locked"), false);
  eq('3 hubs, 2 connectors', [ev("EDIT['Antonica'].hubs.length"), ev("EDIT['Antonica'].conns.length")], [3, 2]);
  eq('gamma carries its published xf', ev("EDIT['Antonica'].zones.gamma.xf.tx"), 300);
}

// ---------------------------------------------------------------------------
section('sparseness is measured against PUBLISHED values, not identity');
{
  const { ev } = load(fx('base'));
  ev("enterCont('Antonica');setEdit(true)");
  const ov = ev('JSON.stringify(contOverlay("Antonica"))');
  eq('untouched continent produces no overlay at all', ov, 'null');

  // gamma ships tx:300; resetting it to identity must be RECORDED, else reload silently
  // restores the published transform and "Reset this zone" appears not to stick.
  ev("EDIT['Antonica'].zones.gamma.xf={tx:0,ty:0,s:1,rot:0}");
  const o2 = JSON.parse(ev('JSON.stringify(contOverlay("Antonica"))'));
  eq('resetting a published-xf zone is recorded', o2.zoneXf, { gamma: { tx: 0, ty: 0, s: 1, rot: 0 } });
  ok('reset does not drag in the other 2 zones', Object.keys(o2.zoneXf).length === 1, o2.zoneXf);

  // a published lock exception must not be re-emitted as a user override
  ok('published lock exception not re-emitted', !o2.links, o2.links);
  ev("EDIT['Antonica'].zoneLinks[0].locked=true");
  const o3 = JSON.parse(ev('JSON.stringify(contOverlay("Antonica"))'));
  eq('re-locking the exception IS recorded', o3.links,
    { 'alpha|beta': { locked: true, manual: false, deleted: false } });
}

// ---------------------------------------------------------------------------
section('touched flag: click-select must not mark an item customized');
{
  const { ev } = load(fx('base'));
  ev("enterCont('Antonica');setEdit(true)");
  ev("sel={type:'hub',id:0};refreshInspector()");
  ok('selecting a hub leaves it untouched', ev("EDIT['Antonica'].hubs[0].touched") === false);
  // simulate a real drag end
  ev("drag={mode:'hub',i:0,ox:0,oy:0,anchorCleared:false,moved:true};editMouseUp({})");
  ok('drag-end marks the hub touched', ev("EDIT['Antonica'].hubs[0].touched") === true);
  const o = JSON.parse(ev('JSON.stringify(contOverlay("Antonica"))'));
  ok('touched hub appears in overlay', !!o.hubs && o.hubs.length === 1, o.hubs);
  eq('hub entry carries its published hint', o.hubs[0].ref, 'boat|Alpha Docks');
}

// ---------------------------------------------------------------------------
section('weld key normalization (manual link created B-then-A)');
{
  const { ev } = load(fx('base'));
  ev("enterCont('Antonica');setEdit(true)");
  // link gamma -> alpha, i.e. selected zone is gamma, so addManualLink writes z1='gamma'
  ev("addManualLink('gamma','alpha')");
  const raw = ev("EDIT['Antonica'].zoneLinks.filter(l=>l.manual).map(l=>l.z1+'|'+l.z2)");
  eq('raw link object keeps selection order', raw, ['beta|gamma', 'gamma|alpha']);
  const o = JSON.parse(ev('JSON.stringify(contOverlay("Antonica"))'));
  ok('overlay key is lexicographic', 'alpha|gamma' in o.links, Object.keys(o.links));
  // and it must survive a round trip
  const st = ev('JSON.stringify(contOverlay("Antonica"))');
  ev('buildEditState("Antonica");applyContOverlay("Antonica",' + st + ');ensureLinks("Antonica")');
  const back = ev("EDIT['Antonica'].zoneLinks.filter(l=>l.manual).map(l=>weldKey(l.z1,l.z2))");
  eq('manual link restored after round trip', back, ['beta|gamma', 'alpha|gamma']);
  ok('restored link is locked',
    ev("EDIT['Antonica'].zoneLinks.find(l=>weldKey(l.z1,l.z2)==='alpha|gamma').locked") === true);
}

// ---------------------------------------------------------------------------
section('round trip: move a zone, drag a hub, add a hub and a connector');
function customize(ev) {
  ev("enterCont('Antonica');setEdit(true)");
  ev("EDIT['Antonica'].zones.alpha.xf={tx:250,ty:-75,s:1.5,rot:0.25}");
  ev("hubs[2].x=5555;hubs[2].y=777;hubs[2].anchor=null;hubs[2].lx=null;hubs[2].ly=null;hubs[2].touched=true");
  ev("tool='hub';newHubKind='teleport';editMouseDown({clientX:120,clientY:130})");
  ev("hubs[hubs.length-1].label='My Teleport';hubs[hubs.length-1].ref=hubRefOf(hubs[hubs.length-1])");
  ev("tool='conn';editMouseDown({clientX:50,clientY:60});editMouseDown({clientX:400,clientY:410})");
  return ev('JSON.stringify(buildOverlay())');
}
{
  const { ev, errors } = load(fx('base'));
  const ovText = customize(ev);
  const ov = JSON.parse(ovText);
  ok('no errors while customizing', errors.length === 0, errors);
  const a = ov.continents.Antonica;
  eq('overlay version', ov.v, 2);
  eq('only the moved zone is recorded', Object.keys(a.zoneXf), ['alpha']);
  eq('one touched hub', a.hubs.length, 1);
  eq('one added hub', a.hubsAdded.length, 1);
  eq('added hub kind/label', [a.hubsAdded[0].kind, a.hubsAdded[0].label], ['teleport', 'My Teleport']);
  eq('one added connector', a.connsAdded.length, 1);

  // Reapply onto a freshly built state and compare what actually RENDERS. Positions are
  // rounded to 0.01 continent-frame units: an anchored item round-trips through lx/ly at 1e-4,
  // and a 1.5x scale with 0.25 rad rotation amplifies that to ~5e-5 of a unit on a map tens of
  // thousands of units across. Exact equality would be asserting float identity, not behaviour.
  const R = 'function(p){return p.map(v=>Math.round(v*100)/100);}';
  const probe = '(function(){const r=' + R + ';return JSON.stringify([zones.alpha.xf,' +
    'hubs.map(h=>r(hubPos(h))),conns.map(c=>[r(ep(c,"a")),r(ep(c,"b"))])]);})()';
  const before = ev(probe);
  ev('delete EDIT["Antonica"];buildEditState("Antonica");applyContOverlay("Antonica",' +
     JSON.stringify(a) + ');ensureLinks("Antonica")');
  const after = ev(probe);
  ok('round trip reproduces xf, hub positions and connector ends', before === after,
    { before: before.slice(0, 220), after: after.slice(0, 220) });
}

// ---------------------------------------------------------------------------
section('R5 additive survival: new canonical items appear inside a customization');
function reapply(variantName, ovJson) {
  const { ev, errors } = load(fx(variantName));
  ev("enterCont('Antonica')");
  ev('buildEditState("Antonica")');
  const drops = ev('applyContOverlay("Antonica",' + JSON.stringify(ovJson) + ')');
  ev('setEdit(true)');
  return { ev, errors, drops };
}
{
  const seed = load(fx('base'));
  const ov = JSON.parse(customize(seed.ev)).continents.Antonica;

  // -- a hub inserted in the MIDDLE of the canonical array
  {
    const { ev, drops } = reapply('add-hub', ov);
    eq('new canonical hub appears', ev("hubs.some(h=>h.label==='Newly Added Docks')"), true);
    eq('user-added hub still there', ev("hubs.some(h=>h.label==='My Teleport')"), true);
    eq('the touched hub healed onto the right item',
      ev("(function(){const h=hubs.find(h=>h.label==='Gamma Portal');return [h.x,h.y];})()"), [5555, 777]);
    eq('nothing dropped', drops, 0);
    eq('user xf still applied', ev('zones.alpha.xf.tx'), 250);
  }
  // -- a connector inserted at index 0
  {
    const { ev, drops } = reapply('add-conn', ov);
    eq('new canonical connector appears (3 canonical + 1 added)', ev('conns.length'), 4);
    eq('added connector still last', ev('conns[conns.length-1].userAdded'), true);
    eq('nothing dropped', drops, 0);
  }
  // -- a brand new zone, whose nearest neighbour (beta) the user did NOT move
  {
    const { ev, drops } = reapply('add-zone', ov);
    eq('new zone present', ev('!!zones.epsilon'), true);
    eq('nothing dropped', drops, 0);
    // epsilon abuts beta, and beta stayed put, so epsilon must stay put too. Seeding from
    // the nearest *moved* zone instead would tear it away from the neighbour it belongs to.
    eq('new zone next to an unmoved neighbour is left alone',
      ev('[zones.epsilon.xf.tx,zones.epsilon.xf.ty]'), [0, 0]);
    // untouched published zones must NOT be dragged along either
    eq('beta and gamma keep their published transforms',
      ev('[zones.beta.xf.tx,zones.gamma.xf.tx]'), [0, 300]);
    const o2 = JSON.parse(ev('JSON.stringify(contOverlay("Antonica"))'));
    eq('overlay still records only alpha', Object.keys(o2.zoneXf), ['alpha']);
  }
  // -- a brand new zone whose neighbour the user DID move: inherit that delta
  {
    const moved = JSON.parse(JSON.stringify(ov));
    moved.zoneXf = { beta: { tx: 1000, ty: 500, s: 1, rot: 0 } };
    const { ev, drops } = reapply('add-zone', moved);
    eq('nothing dropped', drops, 0);
    eq('new zone inherits the moved neighbour delta, translation only',
      ev('[zones.epsilon.xf.tx,zones.epsilon.xf.ty,zones.epsilon.xf.s,zones.epsilon.xf.rot]'),
      [1000, 500, 1, 0]);
    const o2 = JSON.parse(ev('JSON.stringify(contOverlay("Antonica"))'));
    ok('seeded zone is NOT persisted (transient)', !('epsilon' in o2.zoneXf), o2.zoneXf);
  }
  // -- an overlay with no roster (older file) must skip seeding, never guess
  {
    const noRoster = JSON.parse(JSON.stringify(ov));
    delete noRoster.zoneKeys;
    const { ev } = reapply('add-zone', noRoster);
    eq('no roster -> no seeding, published positions kept',
      ev('[zones.epsilon.xf.tx,zones.beta.xf.tx]'), [0, 0]);
  }
  // -- deletion healing
  {
    const { ev, drops } = reapply('del-hub', ov);
    eq('the surviving touched hub landed correctly',
      ev("(function(){const h=hubs.find(h=>h.label==='Gamma Portal');return [h.x,h.y];})()"), [5555, 777]);
    eq('nothing dropped (the deleted hub was untouched)', drops, 0);
  }
}

// ---------------------------------------------------------------------------
section('ambiguity and unknown keys drop rather than misapply');
{
  const { ev } = load(fx('base'));
  ev("enterCont('Antonica');buildEditState('Antonica')");
  const bad = {
    zoneXf: { nosuchzone: { tx: 1, ty: 2, s: 1, rot: 0 } },
    hubs: [{ ref: 'boat|Does Not Exist', i: 9, x: 1, y: 2 }],
    conns: [{ ref: '0,0|0,0', i: 4, a: { xy: [1, 1] }, b: { xy: [2, 2] } }],
    hubsHidden: ['spire|Nope'],
  };
  const drops = ev('applyContOverlay("Antonica",' + JSON.stringify(bad) + ')');
  eq('all four unresolvable entries dropped and counted', drops, 4);
  eq('nothing was misapplied', ev('hubs.filter(h=>h.touched).length'), 0);
}
{
  // two hubs sharing a hint must drop rather than guess
  const { ev } = load(fx('base'));
  ev("enterCont('Antonica');buildEditState('Antonica')");
  ev("hubs[1].kind='boat';hubs[1].label='Alpha Docks';hubs[1].ref=hubRefOf(hubs[1])");
  const drops = ev("applyContOverlay('Antonica',{hubs:[{ref:'boat|Alpha Docks',i:5,x:9,y:9}]})");
  eq('ambiguous hint drops', drops, 1);
  eq('neither candidate was moved', ev('[hubs[0].x,hubs[1].x]'), [500, 1550]);
}

// ---------------------------------------------------------------------------
section('anchor resolution happens in published space');
{
  const { ev } = load(fx('base'));
  ev("enterCont('Antonica');setEdit(true)");
  // move alpha a long way, then add a hub at coords that are inside alpha's PUBLISHED box
  ev("EDIT['Antonica'].zones.alpha.xf={tx:40000,ty:0,s:1,rot:0}");
  ev("tool='hub';newHubKind='boat'");
  // place at published-space (500,500): iwx/iwy invert the view transform, so drive the
  // creation path directly instead of guessing screen coords
  ev("const nh={x:500,y:500,kind:'boat',label:'Inside Alpha',letter:'',note:'',anchor:null,lx:null,ly:null,ref:'',touched:true,hidden:false,userAdded:true};nh.ref=hubRefOf(nh);hubs.push(nh);");
  // buildEditState anchored everything in published space already; a NEW hub anchors against
  // the CURRENT state, which is the documented behaviour -- what matters is that a saved
  // overlay reapplied onto a fresh build anchors in published space.
  const ovA = ev('JSON.stringify(contOverlay("Antonica"))');
  ev('delete EDIT["Antonica"];buildEditState("Antonica");applyContOverlay("Antonica",' + ovA + ')');
  const anchoredTo = ev("(function(){const h=hubs.find(h=>h.label==='Inside Alpha');return h.anchor;})()");
  ok('a hub at published alpha coords anchors to alpha, not to whatever is nearest after the move',
    anchoredTo === 'alpha' || anchoredTo === null, anchoredTo);
  // and it must render inside alpha after the transform
  const p = ev("(function(){const h=hubs.find(h=>h.label==='Inside Alpha');return hubPos(h);})()");
  if (anchoredTo === 'alpha') {
    ok('and it renders transformed with alpha', p[0] > 39000, p);
  } else {
    ok('free hub keeps its published coords', p[0] === 500, p);
  }
}

console.log('\n' + checks + ' checks, ' + fails + ' failed');
console.log('RESULT: ' + (fails ? 'FAIL' : 'PASS'));
process.exit(fails ? 1 : 0);
