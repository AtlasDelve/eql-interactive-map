// A hub label containing a script-close sequence must not break the page it is baked
// into. Labels are free text the author types, so this is reachable without malice.
//
// Two independent defences, escaping differently, and neither had a test:
//   build.py inject()           rewrites "</" as "<\/"            (every build)
//   exportStandaloneHTML() esc  rewrites every "<" as a unicode   (author only)
//                               escape, which is what the regex below looks for
//
// The failure mode is not a thrown error: the <script> element ends early and the rest
// of the map is parsed as markup, so the assertion that matters is that the label
// survives as data, byte for byte.
const fs = require('fs');
const path = require('path');
const { load } = require('./lib');

const FX = path.join(__dirname, '..', '_fx');
const OUT = path.join(__dirname, '..', '_out');
const fx = (v, ed) => path.join(FX, 'fx-' + v + '.' + ed + '.html');

// Must match fixture.py's script-label variant exactly.
const LABEL = 'Docks </script><b>x</b>';

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

(async () => {
  // ---- 1. the built page: build.py's escaping, in both editions ----
  console.log('-- a script-close sequence in a hub label survives the build');
  for (const ed of ['user', 'author']) {
    const p = load(fx('script-label', ed));
    ok(ed + ' edition loads with no errors', p.errors.length === 0, p.errors);
    // Read the injected const directly: `hubs` is only populated once edit state binds,
    // and what matters here is that the baked data itself is intact.
    eq(ed + ' edition hub label round-trips intact',
      p.ev("HUBS['Antonica'][0].label"), LABEL);
    // If the script element had ended early, the tail of the map would have been
    // parsed as markup instead of code, leaving the later globals undefined.
    eq(ed + ' edition parsed its whole script (all 11 continents)',
      p.ev('names.length'), 11);
  }

  // ---- 2. the standalone export: the client-side esc(), author edition only ----
  console.log('\n-- and survives being re-serialized by the standalone export');
  const a = load(fx('script-label', 'author'));
  a.ev("enterCont('Antonica')");
  a.ev('setEdit(true)');            // PRISTINE is captured at first Edit entry, not at load
  ok('author edition entered Edit cleanly', a.errors.length === 0, a.errors);
  eq('label intact through buildEditState', a.ev('hubs[0].label'), LABEL);
  a.ev('exportStandaloneHTML()');
  ok('an export was produced', a.downloads.length > 0);

  const html = await a.downloads[a.downloads.length - 1].text();
  ok('export escaped "<" in the injected data', /\\u003c/.test(html));

  // Re-parse the export as a second document. This is the check that would fail if the
  // client-side esc() were dropped: the label's own </script> would close the block.
  fs.mkdirSync(OUT, { recursive: true });
  const exported = path.join(OUT, 'script-escape-export.html');
  fs.writeFileSync(exported, html);

  const r = load(exported);
  ok('export re-opens with no errors', r.errors.length === 0, r.errors);
  eq('label still intact in the re-parsed export',
    r.ev("HUBS['Antonica'][0].label"), LABEL);
  eq('re-parsed export ran its whole script', r.ev('names.length'), 11);

  console.log('\nRESULT: ' + (fails ? 'FAIL' : 'PASS'));
  process.exit(fails ? 1 : 0);
})();
