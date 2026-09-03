// Calibration-family isolation for browser buffers and portable customization files.
const path = require('path');
const { load, lastToast } = require('./lib');

const FX = path.join(__dirname, '..', '_fx');
const fx = (v, ed) => path.join(FX, 'fx-' + v + '.' + ed + '.html');

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
function retainLegacy(store, pairs) {
  const kept = {};
  for (const [current, legacy] of pairs) kept[legacy] = store[current];
  for (const k of Object.keys(store)) delete store[k];
  Object.assign(store, kept);
}

section('user legacy buffers migrate once per destination key');
{
  const storage = {};
  const seed = load(fx('base', 'user'), { storage });
  seed.ev("enterCont('Antonica');setEdit(true);zones.alpha.xf.tx=101;saveVersion();setEdit(false)");
  seed.ev("enterCont('Faydwer');setEdit(true);zones.delta.xf.tx=202;saveVersion();setEdit(false)");
  seed.ev("enterWorld();setEdit(true);WEDIT.meta.Antonica.pos=[44,55];worldSaveVersion()");
  retainLegacy(storage, [
    ['eql_editor_Antonica_default_u1', 'eql_editor_Antonica_u1'],
    ['eql_editor_Faydwer_default_u1', 'eql_editor_Faydwer_u1'],
    ['eql_editor_world_default_u1', 'eql_editor_world_u1'],
  ]);

  const p = load(fx('pack-brewall', 'user'), { storage });
  eq('visiting the universe migrates and applies the world buffer', p.ev("metaPos('Antonica')"), [44, 55]);
  p.ev("enterCont('Antonica')");
  eq('visiting Antonica migrates its legacy buffer', p.ev('zones.alpha.xf.tx'), 101);
  p.ev("enterCont('Faydwer')");
  eq('visiting Faydwer migrates its separate legacy buffer', p.ev('zones.delta.xf.tx'), 202);
  for (const k of ['eql_editor_Antonica_brewall_u1', 'eql_editor_Faydwer_brewall_u1',
                   'eql_editor_world_brewall_u1']) {
    ok(k + ' exists', k in storage, Object.keys(storage));
    eq(k + ' migration marker exists', storage[k + '_migrated'], '1');
  }
  p.ev("setEdit(true);document.getElementById('bReset').click()");
  ok('reset removes the destination buffer', !('eql_editor_Faydwer_brewall_u1' in storage));
  const reload = load(fx('pack-brewall', 'user'), { storage });
  reload.ev("enterCont('Faydwer')");
  eq('reload after reset does not resurrect the legacy buffer', reload.ev("!!EDIT.Faydwer"), false);
  ok('the per-destination marker survives reset', 'eql_editor_Faydwer_brewall_u1_migrated' in storage);
}

section('author legacy snapshots migrate with their own format');
{
  const storage = {};
  const seed = load(fx('base', 'author'), { storage });
  seed.ev("enterCont('Antonica');setEdit(true);zones.alpha.xf.tx=303;saveVersion();setEdit(false)");
  seed.ev("enterCont('Faydwer');setEdit(true);zones.delta.xf.tx=404;saveVersion();setEdit(false)");
  seed.ev("enterWorld();setEdit(true);WEDIT.meta.Antonica.pos=[66,77];worldSaveVersion()");
  retainLegacy(storage, [
    ['eql_editor_Antonica_default_v1', 'eql_editor_Antonica_v1'],
    ['eql_editor_Faydwer_default_v1', 'eql_editor_Faydwer_v1'],
    ['eql_editor_world_default_v1', 'eql_editor_world_v1'],
  ]);

  const p = load(fx('pack-goods', 'author'), { storage });
  p.ev("enterCont('Antonica');setEdit(true)");
  eq('author Antonica snapshot migrated', p.ev('zones.alpha.xf.tx'), 303);
  eq('author snapshot retained every hub and connector', p.ev('[hubs.length,conns.length]'), [3, 2]);
  p.ev("setEdit(false);enterCont('Faydwer');setEdit(true)");
  eq('author Faydwer snapshot migrated independently', p.ev('zones.delta.xf.tx'), 404);
  p.ev("setEdit(false);enterWorld();setEdit(true)");
  eq('author world snapshot migrated independently', p.ev("metaPos('Antonica')"), [66, 77]);
  ok('author migration did not throw or lose data', p.errors.length === 0, p.errors);
  for (const k of ['eql_editor_Antonica_goods_v1', 'eql_editor_Faydwer_goods_v1',
                   'eql_editor_world_goods_v1']) {
    ok(k + ' exists', k in storage, Object.keys(storage));
    eq(k + ' migration marker exists', storage[k + '_migrated'], '1');
  }
  p.ev("setEdit(false);enterCont('Antonica');setEdit(true);document.getElementById('bReset').click()");
  const reload = load(fx('pack-goods', 'author'), { storage });
  reload.ev("enterCont('Antonica');setEdit(true)");
  eq('author reset then reload does not resurrect the legacy snapshot', reload.ev('zones.alpha.xf.tx'), 0);
  eq('author reset reload retains published arrays', reload.ev('[hubs.length,conns.length]'), [3, 2]);
}

section('different pack keys isolate writes and portable files warn across packs');
{
  const storage = {};
  const b = load(fx('pack-brewall', 'user'), { storage });
  b.ev("enterCont('Antonica');setEdit(true);zones.alpha.xf.tx=11;saveVersion()");
  eq('Brewall destination key', b.ev("lsKeyFor('Antonica')"), 'eql_editor_Antonica_brewall_u1');
  const ov = b.ev("(function(){zones.alpha.xf.tx=12;return JSON.stringify(buildOverlay());})()");
  eq('customization file records the source pack', JSON.parse(ov).pack, 'brewall');

  const g = load(fx('pack-goods', 'user'), { storage });
  g.ev("enterCont('Antonica')");
  eq('Good\'s does not read Brewall state', g.ev("!!EDIT.Antonica"), false);
  g.ev("setEdit(true);zones.alpha.xf.tx=22;saveVersion()");
  eq('Good\'s destination key', g.ev("lsKeyFor('Antonica')"), 'eql_editor_Antonica_goods_u1');
  ok('both pack buffers coexist',
    'eql_editor_Antonica_brewall_u1' in storage && 'eql_editor_Antonica_goods_u1' in storage,
    Object.keys(storage));
  g.ev('importOverlay(' + JSON.stringify(ov) + ')');
  eq('cross-pack import still applies', g.ev('zones.alpha.xf.tx'), 12);
  ok('cross-pack import emits a warning naming both packs',
    /warning: layout pack brewall, this build goods/.test(lastToast(g.ev)), lastToast(g.ev));
}

console.log('\n' + checks + ' checks, ' + fails + ' failed');
console.log('RESULT: ' + (fails ? 'FAIL' : 'PASS'));
process.exit(fails ? 1 : 0);
