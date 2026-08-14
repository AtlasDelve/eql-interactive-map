// jsdom smoke test for a built map artifact.
//
// Loads the HTML with a stubbed canvas 2D context and drives the real navigation
// and Edit-toggle paths. Catches marker-induced syntax errors and dangling
// references (DOM *and* function) that a "parses without error" check would miss --
// e.g. getPristine() being called from retained setEdit() code.
//
// Note: the page is a classic script, so top-level `let`/`const` (level, cur, EDIT,
// sel, editMode) are global *lexical* bindings and never appear on `window`. They are
// reachable only through global eval, which is what ev() below is for. Function
// declarations do land on window, but we call everything through ev() for uniformity.
//
// Usage: node smoke.js <built.html> [expect-author|expect-user]
const fs = require('fs');
const { JSDOM } = require('jsdom');

const file = process.argv[2];
const expect = process.argv[3] || 'expect-user';

function makeCtx() {
  const grad = { addColorStop() {} };
  const ctx = {
    measureText: (s) => ({ width: (s || '').length * 6 }),
    createRadialGradient: () => grad,
    createLinearGradient: () => grad,
    getImageData: () => ({ data: new Uint8ClampedArray(4) }),
  };
  for (const m of ['setTransform', 'transform', 'fillRect', 'clearRect', 'strokeRect',
    'beginPath', 'closePath', 'moveTo', 'lineTo', 'arc', 'arcTo', 'ellipse', 'rect',
    'quadraticCurveTo', 'bezierCurveTo', 'fill', 'stroke', 'clip', 'save', 'restore',
    'translate', 'rotate', 'scale', 'setLineDash', 'getLineDash', 'fillText',
    'strokeText', 'drawImage', 'putImageData']) ctx[m] = () => {};
  return ctx;
}

const errors = [];
const html = fs.readFileSync(file, 'utf8');

const dom = new JSDOM(html, {
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  beforeParse(window) {
    window.HTMLCanvasElement.prototype.getContext = function () { return makeCtx(); };
    window.URL.createObjectURL = () => 'blob:stub';
    window.URL.revokeObjectURL = () => {};
    window.confirm = () => true;
    Object.defineProperty(window, 'devicePixelRatio', { value: 1, configurable: true });
    window.addEventListener('error', (e) => errors.push('window.error: ' + (e.message || e.error)));
    const origErr = window.console.error;
    window.console.error = (...a) => {
      errors.push('console.error: ' + a.join(' '));
      origErr.apply(window.console, a);
    };
  },
});

const w = dom.window;
const ev = (expr) => w.eval(expr);

function step(name, fn) {
  try {
    fn();
    console.log('  OK   ' + name);
  } catch (e) {
    errors.push(name + ': ' + e.message);
    console.log('  FAIL ' + name + ': ' + e.message);
  }
}

console.log('== ' + file + ' (' + expect + ') ==');

step('loaded at universe level', () => {
  const lv = ev('level');
  if (lv !== 'universe') throw new Error('level=' + lv);
});

step('travel-unavailable notice hidden on real artifact', () => {
  const notice = w.document.getElementById('travelUnavailable');
  const display = w.getComputedStyle(notice).display;
  if (display !== 'none') throw new Error('display=' + display);
});

// The only gate on deriving ALTITUDES from META.alt instead of restating it as a literal.
// verify.py datacmp cannot see it -- it extracts the INJECTED structures only, and ALTITUDES
// is computed in the template. Written out longhand rather than re-derived, because a second
// derivation would just compare the bug to itself; and the ARRAY ORDER is asserted, not only
// the membership, because it is the globe draw and label order. This is what catches iterating
// META (whose key order puts Odus before Faydwer) instead of `names`.
const ALTITUDES_EXPECTED = {
  Norrath: ['Antonica', 'Faydwer', 'Odus', 'Kunark', 'Velious',
    'Ocean of Tears', "Erud's Crossing", 'Timorous Deep'],
  'The Planes': ['Plane of Fear', 'Plane of Hate', 'Plane of Sky'],
};
step('ALTITUDES derives from META.alt, keys and array order intact', () => {
  const got = JSON.parse(ev('JSON.stringify(ALTITUDES)'));
  const g = JSON.stringify(got), w2 = JSON.stringify(ALTITUDES_EXPECTED);
  if (g !== w2) throw new Error('\n       got  ' + g + '\n       want ' + w2);
});

step('edition-specific symbols', () => {
  const hasAuthor = ev("typeof exportStandaloneHTML==='function'||typeof buildLayoutObject==='function'||typeof getPristine==='function'");
  const bExport = w.document.getElementById('bExport');
  const bExportHTML = w.document.getElementById('bExportHTML');
  if (expect === 'expect-author') {
    if (!hasAuthor) throw new Error('author build missing export functions');
    if (!bExport || !bExportHTML) throw new Error('author build missing export buttons');
    if (ev('canEditHubContent({})') !== true) throw new Error('author canEditHubContent should be true');
    if (ev('delLinkBtn(0)') === '') throw new Error('author delLinkBtn should render');
  } else {
    if (hasAuthor) throw new Error('user build still exposes author export functions');
    if (bExport || bExportHTML) throw new Error('user build still has export buttons');
    if (ev('canEditHubContent({})') !== false) throw new Error('user canEditHubContent(canonical) should be false');
    if (ev('canEditHubContent({userAdded:true})') !== true) throw new Error('user canEditHubContent(added) should be true');
    if (ev('delLinkBtn(0)') !== '') throw new Error('user delLinkBtn should be empty');
  }
  if (ev("typeof downloadBlob") !== 'function') throw new Error('downloadBlob missing');
});

// ---- Edit toggle at every level (the getPristine dangling-call trap) -------
step('Edit on/off at universe level', () => {
  ev('setEdit(true)');
  if (ev('editMode') !== true) throw new Error('editMode did not turn on');
  ev('setEdit(false)');
});

step('enter world', () => { ev('enterWorld()'); if (ev('level') !== 'world') throw new Error(ev('level')); });
step('Edit on/off at world level', () => { ev('setEdit(true)'); ev('setEdit(false)'); });

const cont = 'Antonica';
step('enter continent ' + cont, () => {
  ev("enterCont('" + cont + "')");
  if (ev('level') !== 'continent' || ev('cur') !== cont) throw new Error(ev('level') + '/' + ev('cur'));
});
step('Edit on at continent level (builds edit state + welds)', () => {
  ev('setEdit(true)');
  if (ev('editMode') !== true) throw new Error('editMode off');
  if (!ev("!!EDIT['" + cont + "']")) throw new Error('EDIT[' + cont + '] not built');
});
step('welds detected for ' + cont, () => {
  const n = ev("EDIT['" + cont + "'].zoneLinks.length");
  if (!n) throw new Error('no zoneLinks detected');
  console.log('       (' + n + ' welds, ' + ev("Object.keys(EDIT['" + cont + "'].zones).length") + ' zones, '
    + ev("EDIT['" + cont + "'].hubs.length") + ' hubs, ' + ev("EDIT['" + cont + "'].conns.length") + ' connectors)');
});
step('select a zone + refreshInspector', () => {
  ev("sel={type:'zone',id:Object.keys(zones)[0]};refreshInspector()");
  const body = w.document.getElementById('inspBody').innerHTML;
  if (!/Scale/.test(body)) throw new Error('zone inspector did not render');
});
step('select a canonical hub + refreshInspector', () => {
  ev("sel={type:'hub',id:0};refreshInspector()");
  const body = w.document.getElementById('inspBody').innerHTML;
  const hasKind = /id="hKind"/.test(body);
  if (expect === 'expect-author' && !hasKind) throw new Error('author hub inspector lost its Type row');
  if (expect === 'expect-user' && hasKind) throw new Error('user hub inspector exposed a Type row on a canonical hub');
});
step('select a connector + refreshInspector', () => {
  ev("sel={type:'conn',id:0};refreshInspector()");
});
step('inspector visible via computed style (not just inline)', () => {
  const disp = w.getComputedStyle(w.document.getElementById('insp')).display;
  if (disp === 'none') throw new Error('#insp computed display:none while editing');
});
step('save + revert a buffer version', () => {
  ev('saveVersion()');
  ev('revertLast()');
});
step('Edit off at continent level', () => { ev('setEdit(false)'); });
step('back to world then universe', () => { ev('enterWorld()'); ev('enterUniverse()'); });

console.log('');
if (errors.length) {
  console.log('RESULT: FAIL (' + errors.length + ')');
  errors.forEach((e) => console.log('  - ' + e));
  process.exit(1);
}
console.log('RESULT: PASS');
