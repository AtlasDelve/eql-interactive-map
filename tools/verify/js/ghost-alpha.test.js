// Verifies ghost items actually RENDER dimmed, by recording ctx.globalAlpha at every
// fill/stroke rather than trusting that setting it once holds. drawHubPortal internally
// resets globalAlpha, which would otherwise leave a hidden portal hub drawing its rings,
// outer ring and letter at full opacity -- dimmed body, undimmed everything else.
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const FX = path.join(__dirname, '..', '_fx');
let fails = 0;
function ok(name, cond, extra) {
  if (cond) { console.log('  OK   ' + name); return; }
  fails++;
  console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : ''));
}

// A recording 2D context: every paint op logs the globalAlpha in force at that moment.
function makeRecorder(log) {
  const grad = { addColorStop() {} };
  const ctx = {
    globalAlpha: 1,
    measureText: (s) => ({ width: (s || '').length * 6 }),
    createRadialGradient: () => grad,
    createLinearGradient: () => grad,
    getImageData: () => ({ data: new Uint8ClampedArray(4) }),
  };
  for (const m of ['setTransform', 'transform', 'clearRect', 'beginPath', 'closePath',
    'moveTo', 'lineTo', 'arc', 'arcTo', 'ellipse', 'rect', 'quadraticCurveTo',
    'bezierCurveTo', 'clip', 'save', 'restore', 'translate', 'rotate', 'scale',
    'setLineDash', 'getLineDash', 'drawImage', 'putImageData']) ctx[m] = () => {};
  for (const m of ['fill', 'stroke', 'fillRect', 'strokeRect', 'fillText', 'strokeText']) {
    ctx[m] = () => { log.push(ctx.globalAlpha); };
  }
  return ctx;
}

const log = [];
const dom = new JSDOM(fs.readFileSync(path.join(FX, 'fx-base.user.html'), 'utf8'), {
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  beforeParse(window) {
    window.HTMLCanvasElement.prototype.getContext = function () { return makeRecorder(log); };
    Object.defineProperty(window, 'devicePixelRatio', { value: 1, configurable: true });
    window.URL.createObjectURL = () => 'blob:stub';
    window.URL.revokeObjectURL = () => {};
    window.confirm = () => true;
  },
});
const ev = (e) => dom.window.eval(e);

ev("enterCont('Antonica');setEdit(true)");
// hub 2 is the PORTAL ('Gamma Portal', letter G) -- the glyph that manipulates alpha
ev("hubs[2].hidden=true;showHidden=true");

// isolate the hub pass: clear the log, draw one ghost portal directly
log.length = 0;
ev('(function(){const P=hubPos(hubs[2]);ctx.globalAlpha=0.32;drawHub(hubs[2],wx(P[0]),wy(P[1]),11);ctx.globalAlpha=1;})()');
const maxGhost = Math.max.apply(null, log);
ok('portal ghost paints nothing at full opacity', maxGhost <= 0.33, { ops: log.length, maxAlpha: maxGhost });

log.length = 0;
ev('(function(){const P=hubPos(hubs[0]);drawHub(hubs[0],wx(P[0]),wy(P[1]),11);})()');
ok('a non-ghost hub still paints at full opacity', Math.max.apply(null, log) === 1,
  Math.max.apply(null, log));

// and the real draw path: a ghost portal must not leave alpha dirty for later items
ev('draw()');
ok('draw() leaves globalAlpha reset', ev('ctx.globalAlpha') === 1, ev('ctx.globalAlpha'));

// with the toggle off the ghost must not paint at all
ev('showHidden=false;draw()');
ok('ghost is absent from the hover/click cache when the toggle is off',
  ev('hubScreens.some(s=>s.i===2)') === false);

console.log('\nRESULT: ' + (fails ? 'FAIL' : 'PASS'));
process.exit(fails ? 1 : 0);
