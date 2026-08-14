// Shared jsdom harness: load a built map artifact with a stubbed canvas 2D context.
//
// The page is a classic script, so its top-level `let`/`const` bindings (level, cur, EDIT,
// WEDIT, sel, editMode, zones, hubs, conns, zoneLinks) live in the global LEXICAL scope and
// never appear on `window`. They are reachable only through global eval -- hence ev().
const fs = require('fs');
const { JSDOM } = require('jsdom');

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

// A localStorage that persists across page loads within one test, so the
// "close the map, ship an update, reopen" path can actually be exercised.
function makeStore(backing) {
  return {
    getItem: (k) => (k in backing ? backing[k] : null),
    setItem: (k, v) => { backing[k] = String(v); },
    removeItem: (k) => { delete backing[k]; },
    clear: () => { for (const k of Object.keys(backing)) delete backing[k]; },
    key: (i) => Object.keys(backing)[i] ?? null,
    get length() { return Object.keys(backing).length; },
  };
}

// Returns { dom, w, ev, errors, downloads, toasts, store }
function load(file, opts) {
  opts = opts || {};
  const errors = [];
  const downloads = [];
  const toasts = [];
  const backing = opts.storage || {};
  const html = fs.readFileSync(file, 'utf8');

  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    beforeParse(window) {
      window.HTMLCanvasElement.prototype.getContext = function () { return makeCtx(); };
      Object.defineProperty(window, 'devicePixelRatio', { value: 1, configurable: true });
      Object.defineProperty(window, 'localStorage', {
        value: makeStore(backing), configurable: true,
      });
      // capture exported blobs instead of navigating
      window.URL.createObjectURL = (blob) => {
        downloads.push(blob);
        return 'blob:stub';
      };
      window.URL.revokeObjectURL = () => {};
      window.HTMLAnchorElement.prototype.click = function () {};
      window.confirm = () => true;
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
  return { dom, w, ev, errors, downloads, toasts, store: backing };
}

// Read the text of the most recent toast (the element keeps the last message).
function lastToast(ev) { return ev("document.getElementById('toast').textContent"); }

// Grab the JSON text of the most recent downloadBlob() call.
async function lastDownloadText(downloads) {
  if (!downloads.length) throw new Error('no download captured');
  return await downloads[downloads.length - 1].text();
}

module.exports = { load, lastToast, lastDownloadText };
