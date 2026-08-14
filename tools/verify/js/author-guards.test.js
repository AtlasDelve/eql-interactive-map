// Two author-edition hazards created by making importOverlay available in both editions.
const path = require('path');
const { load, lastToast } = require('./lib');

const FX = path.join(__dirname, '..', '_fx');
const fx = (v, ed) => path.join(FX, 'fx-' + v + '.' + ed + '.html');

let fails = 0;
function ok(name, cond, extra) {
  if (cond) { console.log('  OK   ' + name); return; }
  fails++;
  console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : ''));
}
function eq(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  return ok(name + (g === w ? '' : ' (got ' + g + ', want ' + w + ')'), g === w);
}

// Build a customization file using the USER edition, then feed it to the AUTHOR edition.
let ovText;
{
  const u = load(fx('base', 'user'));
  u.ev("enterCont('Antonica');setEdit(true)");
  u.ev("EDIT['Antonica'].zones.alpha.xf={tx:321,ty:-21,s:1,rot:0}");
  u.ev("drag={mode:'cend',i:0,which:'a',moved:true};conns[0].a=[7,7];editMouseUp({})");
  u.ev('exportOverlay()');
  ovText = require('fs').readFileSync;   // placeholder to keep lint quiet
  ovText = u.downloads[0];
}

(async () => {
  const text = await ovText.text();
  ok('overlay file has a touched connector', /"conns"/.test(text));

  // ---- 1. the author's own buffer must not be poisoned with sparse data ----
  console.log('\n-- author import must not write a sparse overlay into the full-snapshot buffer');
  {
    const a = load(fx('base', 'author'));
    a.ev("enterCont('Antonica')");
    a.ev('importOverlay(' + JSON.stringify(text) + ')');
    eq('import applied in memory', a.ev("EDIT['Antonica'].zones.alpha.xf.tx"), 321);
    eq('author localStorage untouched by import', Object.keys(a.store), []);
    // the real symptom: entering Edit reads the buffer back through the full-snapshot
    // applyState, which would throw on c.a.slice() (a is {xy:[...]}, not an array)
    a.ev('setEdit(true)');
    ok('no error entering Edit after an author import', a.errors.length === 0, a.errors);
    ok('hub list intact after Edit entry', a.ev('hubs.length') === 3, a.ev('hubs.length'));
    ok('hub content intact (not blanked by a mis-parsed buffer)',
      a.ev('hubs.every(h=>!!h.kind&&h.label!==undefined)') === true,
      a.ev('JSON.stringify(hubs.map(h=>[h.kind,h.label]))'));
  }
  // and the user edition must still persist, since that IS its durable path
  {
    const u = load(fx('base', 'user'));
    u.ev("enterCont('Antonica')");
    u.ev('importOverlay(' + JSON.stringify(text) + ')');
    ok('user import DOES write the buffer', Object.keys(u.store).length > 0, Object.keys(u.store));
  }

  // ---- 2. exports must not strip published links off unvisited continents ----
  console.log('\n-- lazy welds must not silently delete published links on export');
  {
    const a = load(fx('base', 'author'));
    a.ev("enterCont('Faydwer');setEdit(true);setEdit(false)");   // visit a DIFFERENT continent
    a.ev('importOverlay(' + JSON.stringify(text) + ')');
    eq('Antonica edit-state exists but welds were never detected',
      [a.ev("!!EDIT['Antonica']"), a.ev("EDIT['Antonica'].linksReady")], [true, false]);

    const lay = JSON.parse(a.ev("JSON.stringify(buildLayoutObject('Antonica'))"));
    eq('buildLayoutObject falls back to the published links',
      lay.links, [{ z1: 'alpha', z2: 'beta', locked: false },
                  { z1: 'beta', z2: 'gamma', locked: true, manual: true }]);

    a.ev('exportStandaloneHTML()');
    const html = await a.downloads[a.downloads.length - 1].text();
    ok('standalone export still carries the published lock exceptions',
      /"links":\[\{"z1":"alpha","z2":"beta","locked":false\},\{"z1":"beta","z2":"gamma","locked":true,"manual":true\}\]/.test(html),
      (html.match(/"Antonica":\{[\s\S]{0,80}/) || [''])[0]);

    // and once welds ARE detected, the recomputed path is used
    a.ev("enterCont('Antonica');setEdit(true)");
    eq('welds detected now', a.ev("EDIT['Antonica'].linksReady"), true);
    const lay2 = JSON.parse(a.ev("JSON.stringify(buildLayoutObject('Antonica'))"));
    eq('recomputed path preserves the same exception',
      lay2.links, [{ z1: 'alpha', z2: 'beta', locked: false },
                   { z1: 'beta', z2: 'gamma', locked: true, manual: true }]);
  }

  console.log('\n-- partial builds protect authored state while user overlays remain safe');
  {
    const a = load(fx('skip-zone', 'author'));
    a.ev("enterCont('Antonica');exportLayout();exportWorld();saveVersion()");
    eq('partial author export/save downloads nothing', a.downloads.length, 0);
    eq('partial author save writes no browser snapshot', Object.keys(a.store), []);
    ok('the refusal names the partial build', /partial build/.test(lastToast(a.ev)), lastToast(a.ev));

    const full = load(fx('base', 'author'));
    full.ev("enterCont('Antonica');setEdit(true);exportLayout();exportWorld()");
    eq('full author exports still succeed', full.downloads.length, 2);

    const u = load(fx('skip-zone', 'user'));
    u.ev("enterCont('Antonica');setEdit(true)");
    u.ev("EDIT['Antonica'].zones.alpha.xf.tx+=1");
    const ov = JSON.parse(u.ev("JSON.stringify(contOverlay('Antonica'))"));
    ok('partial overlay retains the skipped key in its authored roster', ov.zoneKeys.includes('gamma'), ov.zoneKeys);
    ok('partial overlay records no false deletion touching gamma',
      !(ov.links || []).some(l => l.deleted && (l.z1 === 'gamma' || l.z2 === 'gamma')), ov.links);
  }

  console.log('\nRESULT: ' + (fails ? 'FAIL' : 'PASS'));
  process.exit(fails ? 1 : 0);
})();
