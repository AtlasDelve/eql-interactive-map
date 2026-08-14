// The central invariant of a sparse overlay, checked against REAL data rather than fixtures:
// entering Edit on a continent and touching nothing must produce NO overlay at all.
//
// This is the check that exercises the published-comparison rule against the data that
// motivated it (Antonica 46 non-identity zoneXf + 11 links, Kunark 26 + 19). If any continent
// emits an entry here, then every save carries phantom overrides that pin the map to this
// release -- the exact R5 failure the overlay exists to prevent.
//
// Usage: node untouched.test.js <built.user.html>
const { load } = require('./lib');

const file = process.argv[2];
let fails = 0;
function ok(name, cond, extra) {
  if (cond) { console.log('  OK   ' + name); return; }
  fails++;
  console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : ''));
}

const { ev, errors } = load(file);
// Select the LAST expansion first, so every continent exists. Expansion filtering applies in
// edit mode too -- an author working on a later one switches expansion, exactly as they switch
// this sweep must still reach Kunark and Velious, which are the 26 zoneXf + 19 links the
// published-comparison rule was written for. Read off the authored roster rather than named, so
// a new expansion joins the sweep without touching this line.
ev('setXpac(XPACS.order[XPACS.order.length-1])');
const conts = ev('names');
console.log('  info  ' + conts.length + ' continents at expansion ' + ev('xpac'));

for (const c of conts) {
  ev("enterCont(" + JSON.stringify(c) + ");setEdit(true)");
  const ready = ev("EDIT[" + JSON.stringify(c) + "].linksReady");
  const ov = ev('JSON.stringify(contOverlay(' + JSON.stringify(c) + '))');
  const nz = ev("Object.keys(EDIT[" + JSON.stringify(c) + "].zones).length");
  const nl = ev("EDIT[" + JSON.stringify(c) + "].zoneLinks.length");
  const pub = ev("(ALL[" + JSON.stringify(c) + "].links||[]).length");
  ok(c.padEnd(16) + ' untouched -> no overlay  (' + nz + ' zones, ' + nl + ' welds, '
     + pub + ' published links)', ov === 'null' && ready === true, ov && ov.slice(0, 400));
  ev('setEdit(false)');
}

// and the world level, likewise
ev('enterWorld();setEdit(true)');
ok('world untouched -> no overlay', ev('JSON.stringify(worldOverlay())') === 'null',
  ev('JSON.stringify(worldOverlay())'));
ev('setEdit(false)');

// whole-document overlay must be empty too
const full = JSON.parse(ev('JSON.stringify(buildOverlay())'));
ok('buildOverlay() is empty for an untouched map',
  Object.keys(full.continents).length === 0 && Object.keys(full.world).length === 0, full);

ok('no console errors', errors.length === 0, errors);

console.log('\nRESULT: ' + (fails ? 'FAIL' : 'PASS'));
process.exit(fails ? 1 : 0);
