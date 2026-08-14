// Hide/restore (task 6), sparse buffer reopen (task 7) and file import/export (task 8).
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
const toastOf = (ev) => ev("document.getElementById('toast').textContent");

// ---------------------------------------------------------------------------
section('hide: not drawn, not hoverable, not clickable');
{
  const { ev } = load(fx('base'));
  ev("enterCont('Antonica');setEdit(true)");
  eq('3 hubs drawn initially', ev('hubScreens.length'), 3);
  ev("sel={type:'hub',id:1};refreshInspector()");
  ok('canonical hub offers Hide, not Delete',
    /id="bHubHide"/.test(ev("document.getElementById('inspBody').innerHTML"))
    && !/id="bHubDel"/.test(ev("document.getElementById('inspBody').innerHTML")));
  ev("hideItem('hub',1)");
  ok('hub is hidden', ev("EDIT['Antonica'].hubs[1].hidden") === true);
  ev('draw()');
  eq('hidden hub is not drawn', ev('hubScreens.length'), 2);
  eq('hidden hub is not in the hover/click cache', ev('hubScreens.some(s=>s.i===1)'), false);
  eq('badge counts it', ev("document.getElementById('bHiddenList').textContent"), '1 hidden');

  // connector guards: draw loop, pickConnEndpoint, pickConnBody
  ev("hideItem('conn',0)");
  eq('hidden connector is skipped by pickConnEndpoint',
    ev('(function(){const A=ep(conns[0],"a");return pickConnEndpoint(wx(A[0]),wy(A[1]));})()'), null);
  eq('hidden connector is skipped by pickConnBody',
    ev('(function(){const A=ep(conns[0],"a"),B=ep(conns[0],"b");return pickConnBody((wx(A[0])+wx(B[0]))/2,(wy(A[1])+wy(B[1]))/2);})()'), null);

  // ghost toggle brings them back for interaction
  ev('showHidden=true;draw()');
  eq('Show hidden re-draws the ghost hub', ev('hubScreens.length'), 3);
  ok('ghost connector is pickable again',
    ev('(function(){const A=ep(conns[0],"a");return pickConnEndpoint(wx(A[0]),wy(A[1]));})()') !== null);
  eq('ghost hover tip offers restore',
    ev("(function(){const s=hubScreens.find(s=>s.i===1);editMouseMove({clientX:s.X,clientY:s.Y});return document.getElementById('tip').textContent;})()"),
    'Hidden — click to restore.');

  // click a ghost -> restore
  ev("(function(){const s=hubScreens.find(s=>s.i===1);editMouseDown({clientX:s.X,clientY:s.Y});})()");
  eq('clicking the ghost restored it', ev("EDIT['Antonica'].hubs[1].hidden"), false);

  // restore-all from the list
  ev("restoreAllHidden()");
  eq('restore all clears everything', ev('hubs.concat(conns).some(o=>o.hidden)'), false);
  eq('badge back to zero', ev("document.getElementById('bHiddenList').textContent"), '0 hidden');
}

// ---------------------------------------------------------------------------
section('hide survives save -> reopen, and showHidden never leaks into view mode');
{
  const storage = {};
  {
    const { ev } = load(fx('base'), { storage });
    ev("enterCont('Antonica');setEdit(true)");
    ev("hideItem('hub',2);saveVersion()");
    ev('showHidden=true');
    ev('setEdit(false)');
    eq('leaving Edit clears showHidden', ev('showHidden'), false);
    eq('hidden hub still not drawn with Edit off', ev('hubScreens.length'), 2);
  }
  {
    const { ev, errors } = load(fx('base'), { storage });
    ok('no errors on reopen', errors.length === 0, errors);
    ev("enterCont('Antonica')");
    // R5-adjacent: the customization must show with Edit OFF, via the enterCont hook
    ok('edit-state was built eagerly from the buffer', ev("!!EDIT['Antonica']") === true);
    eq('weld detector did NOT run on plain view', ev("EDIT['Antonica'].linksReady"), false);
    eq('hide survived the reopen', ev("EDIT['Antonica'].hubs[2].hidden"), true);
    eq('and it is not drawn', ev('hubScreens.length'), 2);
  }
}

// ---------------------------------------------------------------------------
section('R5 on the DEFAULT path: buffer reopen after an update is additive');
{
  const storage = {};
  {
    const { ev } = load(fx('base'), { storage });
    ev("enterCont('Antonica');setEdit(true)");
    ev("EDIT['Antonica'].zones.alpha.xf={tx:900,ty:0,s:1,rot:0}");
    ev("hubs[0].x=111;hubs[0].y=222;hubs[0].anchor=null;hubs[0].lx=null;hubs[0].ly=null;hubs[0].touched=true");
    ev('saveVersion()');
    ok('buffer written', Object.keys(storage).length > 0, Object.keys(storage));
  }
  // author ships an update adding a hub AND a connector, user reopens WITHOUT importing
  {
    const { ev, errors } = load(fx('add-hub'), { storage });
    ev("enterCont('Antonica')");
    ok('no errors', errors.length === 0, errors);
    eq('new canonical hub appears on the default reopen path',
      ev("hubs.some(h=>h.label==='Newly Added Docks')"), true);
    eq('prior override still applied',
      ev("(function(){const h=hubs.find(h=>h.label==='Alpha Docks');return [h.x,h.y];})()"), [111, 222]);
    eq('prior zone move still applied', ev('zones.alpha.xf.tx'), 900);
  }
  {
    const { ev } = load(fx('add-conn'), { storage });
    ev("enterCont('Antonica')");
    eq('new canonical connector appears too', ev('conns.length'), 3);
    eq('prior zone move still applied', ev('zones.alpha.xf.tx'), 900);
  }
}

// ---------------------------------------------------------------------------
section('world level: overlay applies with Edit off, and is additive');
{
  const storage = {};
  {
    const { ev } = load(fx('base'), { storage });
    ev('enterWorld();setEdit(true)');
    ev("WEDIT.meta['Antonica'].pos=[77.5,66.5]");
    ev("WEDIT.worldLinks[0].a=[1.5,2.5];WEDIT.worldLinks[0].touched=true");
    ev('worldSaveVersion()');
    const st = JSON.parse(ev('JSON.stringify(worldOverlay())'));
    eq('only the moved continent recorded', Object.keys(st.contPos), ['Antonica']);
    eq('one touched world link', st.worldConns.length, 1);
    // The endpoint form is now an object, and the derived anchor rides with it. Raw xy stays as
    // the free fallback, which is what the reopen assertion below reads.
    eq('endpoint serialized as an anchored object',
      [st.worldConns[0].a.anchor, st.worldConns[0].a.xy], ['Antonica', [1.5, 2.5]]);
  }
  {
    const { ev, errors } = load(fx('add-worldlink'), { storage });
    ok('no errors', errors.length === 0, errors);
    // enterUniverse runs at load; the world overlay must already be live with Edit off
    ok('WEDIT built eagerly from the buffer', ev('!!WEDIT') === true);
    eq('continent position applied with Edit off', ev("metaPos('Antonica')"), [77.5, 66.5]);
    eq('new canonical world link survived the update', ev('worldConns().length'), 3);
    eq('the touched world link healed onto the right entry',
      ev("worldConns().find(l=>l.touched).a"), [1.5, 2.5]);
    eq('and its anchor healed with it',
      ev("worldConns().find(l=>l.touched).anchorA"), 'Antonica');
    // The anchor is what the map actually draws: the endpoint follows the continent to its
    // customized position rather than sitting at the stale raw fallback.
    eq('so the endpoint resolves to the moved continent',
      ev("(function(){const l=worldConns().find(l=>l.touched);return wlPt(l,'a');})()"), [77.5, 66.5]);
  }
}

// ---------------------------------------------------------------------------
section('world links: a manual free survives a round trip, and v1 files still load');
{
  const { ev } = load(fx('base'));
  ev('enterWorld();setEdit(true)');
  eq('every fixture endpoint auto-anchored',
    ev('WEDIT.worldLinks.every(l=>l.anchorA&&l.anchorB)'), true);

  // Freeing is a deliberate override. If wlEndIn drops its `else`, the auto-anchor from
  // buildWorldEditState survives the reload and silently discards this choice.
  ev("toggleWlAnchor(0,'a')");
  eq('end A is free', ev('WEDIT.worldLinks[0].anchorA'), null);
  const o = ev('JSON.stringify(worldOverlay())');
  ev('buildWorldEditState()');
  eq('rebuild re-derives the anchor', ev('WEDIT.worldLinks[0].anchorA'), 'Antonica');
  ev('applyWorldOverlay(' + JSON.stringify(JSON.parse(o)) + ')');
  eq('the manual free survived the round trip', ev('WEDIT.worldLinks[0].anchorA'), null);
  eq('and end B is still anchored', ev('WEDIT.worldLinks[0].anchorB'), 'Faydwer');

  // v1 wrote bare [x,y] arrays. They must load as free coordinates -- that file recorded
  // absolute positions and no anchor intent.
  ev('buildWorldEditState()');
  ev("applyWorldOverlay({worldConns:[{ref:WEDIT.worldLinks[1].ref,i:1,a:[3.5,4.5],b:[5.5,6.5]}]})");
  eq('a v1 bare-array endpoint loads free', ev('WEDIT.worldLinks[1].anchorA'), null);
  eq('...at the coordinates it recorded', ev('WEDIT.worldLinks[1].a'), [3.5, 4.5]);
  eq('...and wlPt returns them', ev("wlPt(WEDIT.worldLinks[1],'a')"), [3.5, 4.5]);

  ev("importOverlay(JSON.stringify({v:1,continents:{},world:{contPos:{Antonica:[12,32]}}}))");
  eq('a v:1 file is accepted, not rejected', ev("metaPos('Antonica')"), [12, 32]);
  ok('and it reports as imported', /Layout imported/.test(toastOf(ev)), toastOf(ev));
}

// ---------------------------------------------------------------------------
section('file export / import round trip');
{
  const a = load(fx('base'));
  a.ev("enterCont('Antonica');setEdit(true)");
  a.ev("EDIT['Antonica'].zones.gamma.xf={tx:1234,ty:-56,s:2,rot:0.1}");
  a.ev("hideItem('hub',0)");
  a.ev("tool='hub';newHubKind='ring';editMouseDown({clientX:200,clientY:210})");
  a.ev('exportOverlay()');
  ok('a file was produced', a.downloads.length === 1, a.downloads.length);
  eq('export toast names the customization file', toastOf(a.ev),
    'Saved your layout → eql-map-customization.json');

  (async () => {
    const text = await a.downloads[0].text();
    const parsed = JSON.parse(text);
    eq('file declares v2', parsed.v, 2);
    ok('file carries the continent', !!parsed.continents.Antonica, Object.keys(parsed.continents));
    eq('hidden hub recorded as a ref', parsed.continents.Antonica.hubsHidden, ['boat|Alpha Docks']);

    // import into a fresh document
    const b = load(fx('base'));
    b.ev("enterCont('Antonica')");
    b.ev('importOverlay(' + JSON.stringify(text) + ')');
    eq('zone transform imported', b.ev('EDIT["Antonica"].zones.gamma.xf.tx'), 1234);
    eq('hide imported', b.ev('EDIT["Antonica"].hubs[0].hidden'), true);
    eq('added hub imported', b.ev("EDIT['Antonica'].hubs.filter(h=>h.userAdded).length"), 1);
    ok('import toast reports the continent count', /1 continent/.test(toastOf(b.ev)), toastOf(b.ev));
    // and it must have been persisted to the buffer, so a plain reload keeps it
    ok('import wrote the buffer', Object.keys(b.store).length > 0, Object.keys(b.store));

    // ---- malformed input leaves the map untouched --------------------------
    section('import error handling');
    const c = load(fx('base'));
    c.ev("enterCont('Antonica');setEdit(true)");
    const beforeC = c.ev('JSON.stringify(EDIT["Antonica"].zones)');
    c.ev("importOverlay('{ this is not json')");
    ok('truncated JSON toasts', /not valid JSON/.test(toastOf(c.ev)), toastOf(c.ev));
    eq('map unchanged after bad JSON', c.ev('JSON.stringify(EDIT["Antonica"].zones)'), beforeC);

    c.ev("importOverlay(JSON.stringify({v:99,continents:{Antonica:{zoneXf:{alpha:{tx:9,ty:9,s:1,rot:0}}}}}))");
    ok('v:99 toasts the version', /version 99/.test(toastOf(c.ev)), toastOf(c.ev));
    eq('map unchanged after future version', c.ev('JSON.stringify(EDIT["Antonica"].zones)'), beforeC);

    c.ev("importOverlay(JSON.stringify({v:1,continents:{Atlantis:{zoneXf:{x:{tx:1,ty:1,s:1,rot:0}}}}}))");
    ok('unknown continent skipped and counted', /skipped/.test(toastOf(c.ev)), toastOf(c.ev));

    c.ev("importOverlay('[1,2,3]')");
    ok('a JSON array is rejected', /not a layout/.test(toastOf(c.ev)), toastOf(c.ev));

    console.log('\n' + checks + ' checks, ' + fails + ' failed');
    console.log('RESULT: ' + (fails ? 'FAIL' : 'PASS'));
    process.exit(fails ? 1 : 0);
  })();
}
