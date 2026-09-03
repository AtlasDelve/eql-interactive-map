// Published continent anchors: authored host intent, pack-relative rendering, absence, and export.
const fs = require('fs');
const path = require('path');
const { load } = require('./lib');

const FX = path.join(__dirname, '..', '_fx');
const OUT = path.join(__dirname, '..', '_out');
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
function section(name) { console.log('\n-- ' + name); }

(async () => {
  section('an effective pack transform carries every published attachment');
  {
    const p = load(fx('anchor-move'));
    p.ev("enterCont('Antonica')");
    eq('published hub resolves through tPoint(host, lx, ly)',
      p.ev("hubPos(HUBS.Antonica[2],ALL.Antonica.zones)"), [6100, 500]);
    eq('and is not drawn at its flat x,y fallback',
      p.ev("(function(){const s=hubScreens.find(s=>s.h.label==='Gamma Portal');return [Math.round(iwx(s.X)),Math.round(iwy(s.Y))];})()"),
      [6100, 500]);
    eq('published connector end resolves through the same host transform',
      p.ev("ep(ALL.Antonica.connectors[1],'b',ALL.Antonica.zones)"), [5900, 400]);
    ok('the connector did not use its flat xy fallback',
      p.ev("ep(ALL.Antonica.connectors[1],'b',ALL.Antonica.zones)[0]!==ALL.Antonica.connectors[1].b.xy[0]"));
  }

  section('plain view never inherits another continent edit state');
  {
    const p = load(fx('base'));
    p.ev("enterCont('Antonica');setEdit(true);setEdit(false)");
    p.ev("ALL.Faydwer.zones.delta.xf={tx:333,ty:0,s:1,rot:0};enterCont('Faydwer')");
    eq('Faydwer still has no edit state', p.ev("!!EDIT.Faydwer"), false);
    eq('its published hub uses Faydwer zones, not the bound Antonica globals',
      p.ev("(function(){const s=hubScreens.find(s=>s.h.label==='Delta Ring');return [Math.round(iwx(s.X)),Math.round(iwy(s.Y))];})()"),
      [733, 400]);
    eq('its published connector uses Faydwer zones too',
      p.ev("ep(ALL.Faydwer.connectors[0],'b',contData(cur).zones)"), [1133, 400]);
  }

  section('buildEditState preserves authored host decisions');
  {
    const p = load(fx('base'));
    p.ev("HUBS.Antonica[0].x=1550;ALL.Antonica.connectors[0].a.xy=[1550,500]");
    p.ev("enterCont('Antonica');buildEditState('Antonica')");
    eq('hub keeps authored alpha although its fallback is nearer beta', p.ev('hubs[0].anchor'), 'alpha');
    eq('connector end keeps authored alpha although its fallback is nearer beta', p.ev('conns[0].anchorA'), 'alpha');
  }

  section('an absent host suppresses view, edit, picking, and inspection');
  {
    const p = load(fx('skip-zone'));
    p.ev("enterCont('Antonica')");
    eq('absent-host hub never enters hubScreens', p.ev('hubScreens.map(s=>s.h.label)'),
      ['Alpha Docks', 'Beta Spires']);
    p.ev("window._absentCalls=0;window._baseEp=ep;ep=function(c,w,z){if(c===contData(cur).conns[1])window._absentCalls++;return window._baseEp(c,w,z);};draw()");
    eq('absent-host connector is not drawn in view mode', p.ev('window._absentCalls'), 0);
    const q = p.ev("(function(){const P=[5300,400];return [wx(P[0]),wy(P[1])];})()");
    const hq = p.ev("(function(){const P=[5500,500];return [wx(P[0]),wy(P[1])];})()");
    eq('absent connector endpoint is not pickable', p.ev(`pickConnEndpoint(${q[0]},${q[1]})`), null);
    eq('absent connector body is not pickable', p.ev(`pickConnBody(${q[0]},${q[1]})`), null);
    eq('absent hub position is not pickable', p.ev(`pickHubAt(${hq[0]},${hq[1]})`), null);

    p.ev("setEdit(true);showHidden=true;window._absentCalls=0;draw()");
    eq('Show hidden does not resurrect the hub', p.ev('hubScreens.map(s=>s.h.label)'),
      ['Alpha Docks', 'Beta Spires']);
    eq('Show hidden does not draw connector lines or handles', p.ev('window._absentCalls'), 0);
    eq('Show hidden does not make the endpoint pickable', p.ev(`pickConnEndpoint(${q[0]},${q[1]})`), null);
    p.ev("sel={type:'hub',id:2};refreshInspector()");
    eq('an absent-host selection is cleared', p.ev('sel'), null);
    eq('and no inspector is shown', p.ev("document.getElementById('insp').style.display"), 'none');
  }

  section('standalone export retains anchors and a freed hub stays exactly put');
  {
    const p = load(fx('anchor-move', 'author'));
    p.ev("enterCont('Antonica');setEdit(true);exportStandaloneHTML()");
    const html = await p.downloads[p.downloads.length - 1].text();
    fs.mkdirSync(OUT, { recursive: true });
    const exported = path.join(OUT, 'anchor-standalone.author.html');
    fs.writeFileSync(exported, html);
    const r = load(exported);
    eq('re-parsed standalone hub carries its anchor', r.ev('HUBS.Antonica[2].anchor'), 'gamma');
    eq('re-parsed standalone connector end carries its anchor',
      r.ev('ALL.Antonica.connectors[1].b.anchor'), 'gamma');
    const before = r.ev("hubPos(HUBS.Antonica[2],ALL.Antonica.zones)");
    r.ev("ALL.Antonica.zones.gamma.xf.tx+=111");
    const after = r.ev("hubPos(HUBS.Antonica[2],ALL.Antonica.zones)");
    eq('moving the host in the re-parsed export moves the hub', after, [before[0] + 111, before[1]]);
    eq('moving the host in the re-parsed export moves the connector end',
      r.ev("ep(ALL.Antonica.connectors[1],'b',ALL.Antonica.zones)"), [6011, 400]);

    const f = load(fx('base'));
    f.ev("enterCont('Antonica');setEdit(true);zones.alpha.xf.tx=1234;sel={type:'hub',id:0};refreshInspector()");
    const fixed = f.ev('hubPos(hubs[0],zones)');
    f.ev("document.getElementById('hAnc').click()");
    eq('freeing a published anchored hub after its host moved leaves it exactly drawn',
      f.ev('hubPos(hubs[0],zones)'), fixed);
    eq('the free fallback captured that exact point', f.ev('[hubs[0].x,hubs[0].y]'), fixed);
  }

  console.log('\n' + checks + ' checks, ' + fails + ' failed');
  console.log('RESULT: ' + (fails ? 'FAIL' : 'PASS'));
  process.exit(fails ? 1 : 0);
})();
