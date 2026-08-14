// REAL-BROWSER pass over the paths jsdom could not cover:
//   - the #ovFile <input type=file> picker, driven through a genuine file chooser
//   - FileReader / importOverlayFile (jsdom tests called importOverlay(text) directly)
//   - the window 'drop' listener, via a real DataTransfer carrying a real File
//   - a genuine download from downloadBlob()
//   - visibility through the real CSS cascade (getComputedStyle), per the AGENTS.md lesson
//     that a display:none stylesheet rule silently wins over a cleared inline style
//
// Runs against installed Brave (Chromium) with a throwaway profile, so the user's own
// profile, session and extensions are untouched.
//
// Usage: node browser.test.js [baseUrl]
const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright-core');

// Any installed Chromium-family browser will do; playwright-core drives it via
// executablePath, which avoids the ~150 MB `playwright install` browser download.
// Override with EQL_BROWSER=/path/to/browser if yours is somewhere else.
const CANDIDATES = [
  process.env.EQL_BROWSER,
  'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/brave-browser', '/usr/bin/google-chrome', '/usr/bin/chromium',
].filter(Boolean);
const BROWSER = CANDIDATES.find((p) => { try { return fs.existsSync(p); } catch { return false; } });
const BASE = process.argv[2] || 'http://127.0.0.1:8731';
const OUT = path.join(__dirname, '..', '_out');
const CONT = 'Antonica';

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

(async () => {
  if (!BROWSER) {
    console.log('SKIP: no Chromium-family browser found. Set EQL_BROWSER=/path/to/browser.');
    console.log('  looked in:\n    ' + CANDIDATES.join('\n    '));
    process.exit(0);   // a missing browser is not a failing map
  }
  console.log('  browser: ' + BROWSER);
  fs.mkdirSync(OUT, { recursive: true });
  // Throwaway profile, never the user's own: their real profile has extensions and a live
  // session, and Chromium refuses a second launch against a profile already in use.
  const browser = await chromium.launch({ executablePath: BROWSER, headless: true });
  const ctx = await browser.newContext({ acceptDownloads: true, viewport: { width: 1400, height: 900 } });
  const page = await ctx.newPage();

  // The map is one self-contained file with no external resources, so the only request the
  // test server can 404 is /favicon.ico. Filter by the message's own URL rather than by the
  // text "404", so a genuinely missing resource would still fail the check.
  const watch = (p, sink) => {
    p.on('pageerror', (e) => sink.push('pageerror: ' + e.message));
    p.on('console', (m) => {
      if (m.type() !== 'error') return;
      const url = (m.location() && m.location().url) || '';
      if (/favicon\.ico$/i.test(url)) return;
      sink.push('console.error: ' + m.text() + (url ? '  [' + url + ']' : ''));
    });
  };
  const errors = [];
  watch(page, errors);

  // ------------------------------------------------ no-install browser builder
  section('no-install builder: real directory input, conversion, notice and download');
  const builderScratch = fs.mkdtempSync(path.join(os.tmpdir(), 'eql-builder-browser-'));
  const mapsDir = path.join(builderScratch, 'maps');
  fs.mkdirSync(mapsDir);
  const selectedZones = ['freporte', 'freportw', 'nro'];
  const mapLine = 'L 0, 0, 0, 10, 10, 0, 255, 0, 0\n';
  for (const zone of selectedZones) fs.writeFileSync(path.join(mapsDir, zone + '.txt'), mapLine);

  const bp = await ctx.newPage();
  const builderErrors = [];
  watch(bp, builderErrors);
  await bp.goto(BASE + '/builder.html', { waitUntil: 'load', timeout: 120000 });
  await bp.waitForFunction('window.BUILDER_PAGE_READY===true', null, { timeout: 120000 });
  ok('builder loads without page errors', builderErrors.length === 0, builderErrors);
  ok('builder input carries webkitdirectory',
    await bp.$eval('#folder', el => el.hasAttribute('webkitdirectory')));
  ok('Required Notice is visible through the real CSS cascade',
    await bp.$eval('#notice', el => getComputedStyle(el).display !== 'none'));
  ok('visible notice contains the required copyright line',
    (await bp.$eval('#notice', el => el.textContent)).includes(
      'Required Notice: Copyright (c) 2026 AtlasDelve'));

  let pickerPopulated = false;
  let pickerDetail = '';
  try {
    await bp.locator('#folder').setInputFiles(mapsDir);
    const relativePaths = await bp.$eval('#folder', el =>
      Array.from(el.files || [], file => file.webkitRelativePath));
    pickerPopulated = relativePaths.length === selectedZones.length
      && relativePaths.every(value => /^maps\//i.test(value));
    pickerDetail = relativePaths.join(', ');
  } catch (error) {
    pickerDetail = error.message;
  }
  console.log('  INFO directory picker webkitRelativePath: '
    + (pickerPopulated ? 'populated (' + pickerDetail + ')' : 'not populated; using synthetic adapter (' + pickerDetail + ')'));

  const builderEntries = selectedZones.map(zone => ({key:'maps/' + zone + '.txt', text:mapLine}));
  let builderDownload;
  if (pickerPopulated) {
    ok('real directory selection enables the build control',
      await bp.$eval('#build', button => !button.disabled));
    builderDownload = await Promise.all([
      bp.waitForEvent('download', { timeout: 120000 }),
      bp.click('#build'),
    ]).then(result => result[0]);
  } else {
    await bp.evaluate(async entries => {
      const enc = new TextEncoder(), disk = new Map(entries.map(entry => [entry.key, entry.text]));
      const files = {
        keys() { return Array.from(disk.keys()); },
        async read(key) { return enc.encode(disk.get(key)); },
      };
      window.__builderBrowserResult = await buildMap({files, packDir:'maps', rootDir:null});
      renderReport(window.__builderBrowserResult.report);
    }, builderEntries);
    builderDownload = await Promise.all([
      bp.waitForEvent('download', { timeout: 120000 }),
      bp.evaluate('downloadHTML(window.__builderBrowserResult.html)'),
    ]).then(result => result[0]);
  }
  eq('builder download filename', builderDownload.suggestedFilename(), 'eql-interactive-map.html');
  const builderMapPath = path.join(OUT, 'builder-browser-map.html');
  await builderDownload.saveAs(builderMapPath);
  const builderMapText = fs.readFileSync(builderMapPath, 'utf8');
  ok('real-engine conversion returned a self-contained map',
    builderMapText.startsWith('<!DOCTYPE html>') && builderMapText.includes('const ALL='),
    builderMapText.length);
  const builderReport = await bp.$eval('#report', el => el.textContent);
  ok('partial real-engine conversion reports skipped authored zones',
    builderReport.includes('ecommons') && builderReport.includes('eqmaps.info'), builderReport);
  ok('builder remains free of page errors after conversion', builderErrors.length === 0, builderErrors);

  // The fixture builder intentionally embeds no travel file. Load its returned map in the real
  // engine so the missing-data warning is tested through the CSS cascade, not only in jsdom.
  const bfx = await ctx.newPage();
  const fxBuilderErrors = [];
  watch(bfx, fxBuilderErrors);
  await bfx.goto(BASE + '/builder-fx.html', { waitUntil: 'load', timeout: 120000 });
  await bfx.waitForFunction('window.BUILDER_PAGE_READY===true', null, { timeout: 120000 });
  const fixtureEntries = ['alpha', 'beta', 'gamma'].map(zone => ({
    key:'pack/' + zone + '.txt', text:mapLine,
  }));
  const noTravelMap = await bfx.evaluate(async entries => {
    const enc = new TextEncoder(), disk = new Map(entries.map(entry => [entry.key, entry.text]));
    const files = {
      keys() { return Array.from(disk.keys()); },
      async read(key) { return enc.encode(disk.get(key)); },
    };
    return (await buildMap({files, packDir:'pack', rootDir:null})).html;
  }, fixtureEntries);
  ok('fixture builder runs without page errors in the real engine',
    fxBuilderErrors.length === 0, fxBuilderErrors);
  const ntp = await ctx.newPage();
  const noTravelErrors = [];
  watch(ntp, noTravelErrors);
  await ntp.setContent(noTravelMap, { waitUntil: 'load', timeout: 120000 });
  await ntp.waitForFunction("typeof enterCont==='function'", null, { timeout: 120000 });
  ok('map built without travel data boots in the real engine', noTravelErrors.length === 0, noTravelErrors);
  ok('missing-travel warning is visible through the real CSS cascade',
    await ntp.$eval('#travelUnavailable', el => getComputedStyle(el).display !== 'none'));
  eq('missing-travel warning explains why Travel is unavailable',
    await ntp.$eval('#travelUnavailable', el => el.textContent),
    'Travel unavailable: this map was built without travel data.');
  await ntp.click('#bTravel');
  ok('missing-travel button is disabled and cannot open its panel', await ntp.evaluate(`(function(){
    return bTravel.getAttribute('aria-disabled')==='true'
      && getComputedStyle(document.getElementById('travel')).display==='none'
      && travelOpen===false;})()`));
  await ntp.close();
  await bfx.close();
  await bp.close();

  // ---------------------------------------------------------------- load
  section('load the user edition in Brave');
  await page.goto(BASE + '/user.html', { waitUntil: 'load', timeout: 120000 });
  await page.waitForFunction("typeof enterCont==='function'", null, { timeout: 120000 });
  ok('no page errors at load', errors.length === 0, errors);
  eq('starts at universe', await page.evaluate('level'), 'universe');
  ok('canvas actually sized by the real layout',
    await page.evaluate('cv.width>0 && cv.height>0'),
    await page.evaluate('[cv.width,cv.height]'));

  // ------------------------------------------------- real CSS cascade check
  section('visibility through the real CSS cascade (not an inline-style assertion)');
  const legendDisp = () => page.evaluate("getComputedStyle(document.getElementById('legend')).display");
  eq('legend hidden at universe level', await legendDisp(), 'none');
  await page.evaluate("enterCont(" + JSON.stringify(CONT) + ")");
  eq('#insp hidden with Edit off',
    await page.evaluate("getComputedStyle(document.getElementById('insp')).display"), 'none');
  // The zone legend, through the cascade. enterCont shows it by CLEARING the inline style, so
  // reading back .style.display returns '' whether or not the panel is on screen -- which is
  // precisely how a display:none stylesheet rule kept it invisible without any test noticing.
  eq('legend visible at continent level', await legendDisp() !== 'none', true);
  ok('legend really occupies the top-right slot',
    await page.evaluate("(function(){const r=document.getElementById('legend').getBoundingClientRect();"
      + "return r.width>0&&r.height>0&&r.right>innerWidth*0.5&&r.bottom<=innerHeight;})()"),
    await page.evaluate("JSON.stringify(document.getElementById('legend').getBoundingClientRect())"));
  ok('legend lists one row per zone',
    await page.evaluate("document.querySelectorAll('#legend div.z').length"
      + "===Object.keys(ALL[" + JSON.stringify(CONT) + "].zones).length"),
    await page.evaluate("document.querySelectorAll('#legend div.z').length"));
  await page.evaluate('enterWorld()');
  eq('legend hidden at world level', await legendDisp(), 'none');
  await page.evaluate("enterCont(" + JSON.stringify(CONT) + ")");
  await page.evaluate('setEdit(true)');
  await page.evaluate("sel={type:'zone',id:Object.keys(zones)[0]};refreshInspector()");
  eq('#insp visible with Edit on',
    await page.evaluate("getComputedStyle(document.getElementById('insp')).display"), 'block');
  eq('#editbar visible with Edit on',
    await page.evaluate("getComputedStyle(document.getElementById('editbar')).display") !== 'none', true);
  eq('hidden-items block visible at continent level',
    await page.evaluate("getComputedStyle(document.getElementById('hiddenBlock')).display") !== 'none', true);
  ok('author export buttons genuinely absent from the DOM',
    await page.evaluate("!document.getElementById('bExport') && !document.getElementById('bExportHTML')"));

  // ------------------------------------------------------------ customize
  section('customize: move a zone, hide a hub, add a hub');
  await page.evaluate(`(function(){
    const k=Object.keys(zones)[0];
    zones[k].xf={tx:2500,ty:-800,s:1.25,rot:0.12};
    window.__k=k;
    hideItem('hub',0);
    const nh={x:1234,y:5678,kind:'teleport',label:'Browser Test Hub',letter:'B',note:'added by the browser pass',
              anchor:null,lx:null,ly:null,ref:'',touched:true,hidden:false,userAdded:true};
    nh.ref=hubRefOf(nh); hubs.push(nh);
    refreshHiddenUI(); draw();
  })()`);
  eq('badge shows one hidden',
    await page.evaluate("document.getElementById('bHiddenList').textContent"), '1 hidden');
  ok('added hub is present', await page.evaluate("hubs.some(h=>h.userAdded)"));
  await page.screenshot({ path: path.join(OUT, '1-customized.png') });

  // ------------------------------------------------- real download of the overlay
  section('Export my layout — a genuine browser download');
  const dl = await Promise.all([
    page.waitForEvent('download', { timeout: 30000 }),
    page.click('#bOvExport'),
  ]).then((r) => r[0]);
  eq('download filename', dl.suggestedFilename(), 'eql-map-customization.json');
  const savedPath = path.join(OUT, 'eql-map-customization.json');
  await dl.saveAs(savedPath);
  const ovText = fs.readFileSync(savedPath, 'utf8');
  const ov = JSON.parse(ovText);
  eq('overlay v2', ov.v, 2);
  ok('records the moved zone', !!ov.continents[CONT].zoneXf, Object.keys(ov.continents[CONT] || {}));
  eq('records one hidden hub', (ov.continents[CONT].hubsHidden || []).length, 1);
  eq('records one added hub', (ov.continents[CONT].hubsAdded || []).length, 1);
  ok('carries the zone roster', Array.isArray(ov.continents[CONT].zoneKeys));

  // --------------------------------------- reload: customization applies with Edit OFF
  section('reload: buffer restores the customization with Edit off');
  await page.evaluate('saveVersion()');
  await page.reload({ waitUntil: 'load', timeout: 120000 });
  await page.waitForFunction("typeof enterCont==='function'", null, { timeout: 120000 });
  await page.evaluate("enterCont(" + JSON.stringify(CONT) + ")");
  eq('Edit is off', await page.evaluate('editMode'), false);
  ok('zone move applied without entering Edit',
    await page.evaluate("Math.round(EDIT[" + JSON.stringify(CONT) + "].zones[Object.keys(EDIT[" + JSON.stringify(CONT) + "].zones)[0]].xf.tx)") === 2500);
  eq('weld detector still deferred on the view path',
    await page.evaluate("EDIT[" + JSON.stringify(CONT) + "].linksReady"), false);
  eq('hidden hub is not drawn', await page.evaluate("hubScreens.some(s=>s.h.hidden)"), false);
  await page.screenshot({ path: path.join(OUT, '2-reloaded-edit-off.png') });

  // ------------------------------------------- FILE PICKER path (untested until now)
  section('Import layout via the real file picker (#ovFile + FileReader)');
  await page.evaluate('localStorage.clear()');
  await page.reload({ waitUntil: 'load', timeout: 120000 });
  await page.waitForFunction("typeof enterCont==='function'", null, { timeout: 120000 });
  await page.evaluate("enterCont(" + JSON.stringify(CONT) + ");setEdit(true)");
  ok('starts from published state after clearing storage',
    await page.evaluate("Object.values(EDIT[" + JSON.stringify(CONT) + "].zones).every(z=>!z.xf.tx||Math.abs(z.xf.tx)!==2500)"));

  const chooser = await Promise.all([
    page.waitForEvent('filechooser', { timeout: 30000 }),
    page.click('#bOvImport'),
  ]).then((r) => r[0]);
  ok('clicking Import layout opened a real file chooser', !!chooser);
  await chooser.setFiles(savedPath);
  await page.waitForFunction(
    "document.getElementById('toast').textContent.indexOf('Layout imported')>=0",
    null, { timeout: 30000 });
  const toast1 = await page.evaluate("document.getElementById('toast').textContent");
  ok('import toast shown: ' + JSON.stringify(toast1), /Layout imported/.test(toast1));
  ok('FileReader path applied the zone move',
    await page.evaluate("Math.round(EDIT[" + JSON.stringify(CONT) + "].zones[window.__k||Object.keys(EDIT[" + JSON.stringify(CONT) + "].zones)[0]].xf.tx)") === 2500);
  eq('added hub restored', await page.evaluate("hubs.filter(h=>h.userAdded).length"), 1);
  eq('hidden hub restored as hidden', await page.evaluate("hubs.filter(h=>h.hidden).length"), 1);
  await page.screenshot({ path: path.join(OUT, '3-imported-via-picker.png') });

  // ------------------------------------------- DRAG-AND-DROP path (untested until now)
  section('Import via drag-and-drop (real DataTransfer + File on window drop)');
  await page.evaluate('localStorage.clear()');
  await page.reload({ waitUntil: 'load', timeout: 120000 });
  await page.waitForFunction("typeof enterCont==='function'", null, { timeout: 120000 });
  await page.evaluate("enterCont(" + JSON.stringify(CONT) + ")");

  // Pass a real function, not a string: page.evaluate() treats a string as an EXPRESSION and
  // ignores the argument, so a stringified arrow function just evaluates to a function object.
  const dropped = await page.evaluate((text) => {
    const dt = new DataTransfer();
    dt.items.add(new File([text], 'eql-map-customization.json', { type: 'application/json' }));
    const ev = new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true });
    const notCancelled = window.dispatchEvent(ev);
    return { defaultPrevented: ev.defaultPrevented, notCancelled: notCancelled, files: dt.files.length };
  }, ovText);
  ok('drop handler called preventDefault (no browser navigation)', dropped.defaultPrevented === true, dropped);
  await page.waitForFunction(
    "document.getElementById('toast').textContent.indexOf('Layout imported')>=0",
    null, { timeout: 30000 });
  ok('drag-and-drop import applied the zone move',
    await page.evaluate("Math.round(EDIT[" + JSON.stringify(CONT) + "].zones[Object.keys(EDIT[" + JSON.stringify(CONT) + "].zones)[0]].xf.tx)") === 2500);
  eq('drag-and-drop restored the added hub',
    await page.evaluate("hubs.filter(h=>h.userAdded).length"), 1);

  // dragover must also preventDefault, or Chromium opens the file instead
  const dragover = await page.evaluate(() => {
    const dt = new DataTransfer();
    const ev = new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true });
    window.dispatchEvent(ev);
    return ev.defaultPrevented;
  });
  ok('dragover also preventDefaults (otherwise the browser navigates to the file)', dragover === true);

  // ------------------------------------------------------ malformed file, real path
  section('a malformed file through the real FileReader leaves the map alone');
  const badPath = path.join(OUT, 'broken.json');
  fs.writeFileSync(badPath, '{ "v":1, "continents": { truncated');
  const before = await page.evaluate("JSON.stringify(EDIT[" + JSON.stringify(CONT) + "].zones)");
  const chooser2 = await Promise.all([
    page.waitForEvent('filechooser', { timeout: 30000 }),
    page.evaluate("setEdit(true)").then(() => page.click('#bOvImport')),
  ]).then((r) => r[0]);
  await chooser2.setFiles(badPath);
  await page.waitForFunction(
    "document.getElementById('toast').textContent.indexOf('not valid JSON')>=0",
    null, { timeout: 30000 });
  ok('toast reports invalid JSON',
    /not valid JSON/.test(await page.evaluate("document.getElementById('toast').textContent")));
  eq('map unchanged', await page.evaluate("JSON.stringify(EDIT[" + JSON.stringify(CONT) + "].zones)"), before);

  // ------------------------------------------------------------- ghost visuals
  section('ghost toggle and user-added marking render');
  await page.evaluate("showHidden=false;draw()");
  const nGhostOff = await page.evaluate('hubScreens.length');
  await page.click('#bShowHidden');
  const nGhostOn = await page.evaluate('hubScreens.length');
  ok('Show hidden adds the ghost back to the pick cache (' + nGhostOff + ' -> ' + nGhostOn + ')',
    nGhostOn === nGhostOff + 1);
  await page.screenshot({ path: path.join(OUT, '4-ghost-on.png') });

  // ------------------------------------------- PIXELS: the two visual affordances
  // Everything above this point could pass with a stubbed canvas. These read the real
  // rendered bitmap, which is the only way to know the ghost dimming and the user-added
  // ring actually appear on screen.
  section('rendered pixels: ghost dimming and the user-added ring');
  const pix = await page.evaluate(() => {
    const dpr = devicePixelRatio;
    // centre the view on a given continent-frame point (inverse of wx/wy)
    const centreOn = (p, k) => {
      view.k = k; view.x = cv.width / 2 - p[0] * k; view.y = cv.height / 2 + p[1] * k; draw();
    };
    const grab = (X, Y, r) => ctx.getImageData(
      Math.round(X - r), Math.round(Y - r), Math.round(2 * r), Math.round(2 * r)).data;
    // Mean absolute per-pixel difference from a baseline. Mean LUMINANCE is useless here:
    // hubHalo() paints a DARK backing disc, so dimming the glyph dims its halo too and lets
    // brighter map lines show through - a ghost can measure brighter than the solid glyph.
    // What "dimmer" really means is "changes the pixels less", which is what this measures.
    const deltaFrom = (base, X, Y, r) => {
      const d = grab(X, Y, r);
      let s = 0, n = 0;
      for (let i = 0; i < d.length; i += 4) {
        s += Math.abs(d[i] - base[i]) + Math.abs(d[i + 1] - base[i + 1]) + Math.abs(d[i + 2] - base[i + 2]);
        n++;
      }
      return s / n;
    };
    // count magenta pixels (#ff5cc8 = 255,92,200) in an annulus around a glyph
    const magentaRing = (X, Y, r) => {
      const R = Math.round(r + 10 * dpr);
      const d = ctx.getImageData(Math.round(X - R), Math.round(Y - R), 2 * R, 2 * R).data;
      let n = 0;
      for (let i = 0; i < d.length; i += 4) {
        const rr = d[i], gg = d[i + 1], bb = d[i + 2];
        if (rr > 170 && bb > 120 && rr - gg > 70 && bb - gg > 40) n++;
      }
      return n;
    };
    const out = {};
    const added = hubs.find((h) => h.userAdded);
    const ghost = hubs.find((h) => h.hidden);
    out.haveAdded = !!added; out.haveGhost = !!ghost;

    // --- user-added ring, checked against EVERY published hub kind so a marker that
    //     collided with a glyph colour (as cyan did with the spire body) cannot pass
    if (added) {
      showHidden = false;
      centreOn(hubPos(added), 0.08);
      let s = hubScreens.find((x) => x.h === added);
      out.addedOnScreen = !!s;
      if (s) out.addedMagenta = magentaRing(s.X, s.Y, s.r);
      out.peerWorst = 0; out.peerWorstKind = null;
      const seen = {};
      for (const h of hubs) {
        if (h.userAdded || h.hidden || seen[h.kind]) continue;
        seen[h.kind] = 1;
        centreOn(hubPos(h), 0.08);
        const t = hubScreens.find((x) => x.h === h);
        if (!t) continue;
        const m = magentaRing(t.X, t.Y, t.r);
        if (m > out.peerWorst) { out.peerWorst = m; out.peerWorstKind = h.kind; }
      }
      out.peerKinds = Object.keys(seen);
    }

    // --- ghost dimming, measured as change-from-no-hub at identical position and zoom
    if (ghost) {
      centreOn(hubPos(ghost), 0.08);
      showHidden = false; draw();                       // hub absent entirely -> baseline
      let s = null;
      showHidden = true; draw();
      s = hubScreens.find((x) => x.h === ghost);
      out.ghostOnScreen = !!s;
      if (s) {
        showHidden = false; draw();
        const base = grab(s.X, s.Y, s.r);
        showHidden = true; draw();
        out.ghostDelta = deltaFrom(base, s.X, s.Y, s.r);
        ghost.hidden = false; draw();
        out.restoredDelta = deltaFrom(base, s.X, s.Y, s.r);
        ghost.hidden = true; draw();
      }
    }
    return out;
  });

  ok('found an added hub and a hidden hub to inspect', pix.haveAdded && pix.haveGhost, pix);
  ok('added hub is on screen after centring', pix.addedOnScreen === true, pix);
  ok('user-added hub is ringed in magenta (' + pix.addedMagenta + ' px)', pix.addedMagenta > 40, pix);
  ok('no published hub kind reads as magenta — worst was '
     + pix.peerWorstKind + ' at ' + pix.peerWorst + ' px across ' + (pix.peerKinds || []).join('/'),
    pix.peerWorst < pix.addedMagenta / 4, pix);
  ok('ghost hub is on screen after centring', pix.ghostOnScreen === true, pix);
  ok('ghost changes the pixels far less than the solid glyph ('
     + pix.ghostDelta.toFixed(1) + ' vs ' + pix.restoredDelta.toFixed(1) + ')',
    pix.ghostDelta < pix.restoredDelta * 0.6, pix);
  await page.screenshot({ path: path.join(OUT, '5-pixels.png') });

  // Tight crops so the two affordances can be judged by eye, not only by the numbers above.
  for (const shot of [
    { name: '6-added-hub-magenta-ring.png', pick: 'hubs.find(h=>h.userAdded)', ghosts: false },
    { name: '7-ghost-vs-solid.png', pick: 'hubs.find(h=>h.hidden)', ghosts: true },
  ]) {
    const box = await page.evaluate(`(function(){
      showHidden=${shot.ghosts};
      const h=${shot.pick}; if(!h) return null;
      const p=hubPos(h),k=0.6;
      view.k=k; view.x=cv.width/2-p[0]*k; view.y=cv.height/2+p[1]*k; draw();
      const dpr=devicePixelRatio, S=70;
      return {x:Math.round(cv.width/2/dpr-S), y:Math.round(cv.height/2/dpr-S), width:2*S, height:2*S};
    })()`);
    if (box) await page.screenshot({ path: path.join(OUT, shot.name), clip: box });
  }

  // ------------------------------------------------------- travel panel & slot
  // A fresh page: the customization above left Edit on and a hub hidden, and none of that is
  // what these assertions are about.
  const tp = await ctx.newPage();
  const tErrors = [];
  watch(tp, tErrors);
  await tp.goto(BASE + '/user.html', { waitUntil: 'load', timeout: 120000 });
  await tp.waitForFunction("typeof enterCont==='function'", null, { timeout: 120000 });
  const disp = (id) => tp.evaluate("getComputedStyle(document.getElementById('" + id + "')).display");

  section('travel panel: in the HUD, through the real cascade');
  ok('no page errors at load', tErrors.length === 0, tErrors);
  eq('travel panel starts hidden', await disp('travel'), 'none');
  ok('the Travel button is visible at universe level, where setHUD passes tools=false',
    await disp('bTravel') !== 'none', await disp('bTravel'));
  await tp.click('#bTravel');
  eq('clicking Travel opens the panel', await disp('travel') !== 'none', true);
  ok('the panel lives inside the HUD, next to the button that opens it',
    await tp.evaluate("document.getElementById('hud').contains(document.getElementById('travel'))"));
  ok('...and renders on the left, clear of the legend slot',
    await tp.evaluate("(function(){const r=document.getElementById('travel').getBoundingClientRect();"
      + "return r.width>0&&r.height>0&&r.right<innerWidth*0.5;})()"),
    await tp.evaluate("JSON.stringify(document.getElementById('travel').getBoundingClientRect())"));
  eq('one toggle per authored capability',
    await tp.evaluate("document.querySelectorAll('#tvCaps .btn').length"),
    await tp.evaluate('TRAVEL.capabilities.length'));

  section('panel lifecycle: a trip in progress survives navigating the map');
  await tp.evaluate('enterWorld()');
  eq('travel still open after entering the world', await tp.evaluate('travelOpen'), true);
  eq('...and still on screen', await disp('travel') !== 'none', true);
  await tp.evaluate("enterCont(" + JSON.stringify(CONT) + ")");
  eq('entering a continent does not dismiss it', await disp('travel') !== 'none', true);
  // The two panels no longer contend for one slot, so the legend shows regardless.
  eq('the legend shows alongside it at continent level', await disp('legend') !== 'none', true);
  await tp.click('#bTravel');
  eq('closing travel leaves the legend alone', await disp('legend') !== 'none', true);
  eq('...and the panel is gone', await disp('travel'), 'none');
  await tp.evaluate('enterWorld()');
  eq('leaving the continent takes the legend away', await disp('legend'), 'none');
  await tp.evaluate("enterCont(" + JSON.stringify(CONT) + ")");

  section('legend: alphabetical, and clicking a row centres the view on that zone');
  {
    const names = await tp.evaluate(
      "[...document.querySelectorAll('#legend div.z')].map(e=>e.textContent)");
    const sorted = names.slice().sort((x, y) => x.localeCompare(y));
    eq('rows are in alphabetical order', names, sorted);
    ok('and it is not merely the stored draw order',
      JSON.stringify(names) !== JSON.stringify(
        await tp.evaluate("Object.keys(ALL[" + JSON.stringify(CONT) + "].zones)"
          + ".map(k=>ALL[" + JSON.stringify(CONT) + "].zones[k].name)")));
    // Click a row and check the zone's centroid lands at the canvas centre, in real pixels.
    const centred = await tp.evaluate(`(function(){
      const rows=[...document.querySelectorAll('#legend div.z')];
      const target=rows[rows.length-1];                 // last alphabetically, far from centre
      const k=view.k;
      target.dispatchEvent(new MouseEvent('click',{bubbles:true}));
      const d=contData(cur), z=Object.keys(d.zones).find(q=>d.zones[q].name===target.textContent);
      const c=zoneCentroid(d.zones[z]);
      return {focus:focus===z, zoomHeld:view.k===k,
              dx:Math.abs(wx(c[0])-cv.width/2), dy:Math.abs(wy(c[1])-cv.height/2)};})()`);
    ok('the clicked row becomes the focused zone', centred.focus, centred);
    ok('its centroid lands on the canvas centre',
      centred.dx < 1 && centred.dy < 1, centred);
    ok('and the zoom level is left alone', centred.zoomHeld, centred);
  }

  section('a planned trip renders, and the reagent note reaches the leg');
  await tp.click('#bTravel');
  await tp.fill('#tvFrom', 'west freeport');
  await tp.waitForTimeout(120);
  ok('typing offers suggestions', await disp('tvFromSug') !== 'none',
    await tp.evaluate("document.getElementById('tvFromSug').textContent"));
  await tp.click('#tvFromSug div:first-child');
  eq('picking one fills the field', await tp.inputValue('#tvFrom'), 'West Freeport');
  eq('...and the suggestion list closes', await disp('tvFromSug'), 'none');
  await tp.evaluate("document.querySelector('#tvCaps .btn[data-cap=wizard]').click()");
  await tp.fill('#tvTo', 'plane of sky');
  await tp.waitForTimeout(120);
  await tp.click('#tvToSug div:first-child');
  const itin = await tp.evaluate("document.getElementById('tvOut').textContent");
  ok('the itinerary names the destination', /Plane of Sky/.test(itin), itin);
  ok('the consumed component is shown on the leg', /Cloudy Stone of Veeshan/.test(itin), itin);
  eq('the user edition prints no cost figures',
    await tp.evaluate("document.querySelectorAll('#travel .leg .c').length"), 0);
  await tp.screenshot({ path: path.join(OUT, '8-travel-panel.png') });

  // ------------------------------------------- PIXELS: the route actually reaches the canvas
  // A stubbed canvas cannot verify appearance, and neither can an assertion that a colour was
  // assigned. Two things need real pixels: that the line is painted at all, and that its hue is
  // not one the map already uses - AGENTS.md's lesson from the cyan marker that collided with
  // the spire body. The near neighbour here is the teleport glyph's #ff9d3a.
  section('rendered pixels: the route line, its hue, and the dimming');
  const rp = await tp.evaluate(() => {
    const dpr = devicePixelRatio;
    const grab = (X, Y, r) => ctx.getImageData(
      Math.round(X - r), Math.round(Y - r), Math.round(2 * r), Math.round(2 * r)).data;
    // Mean absolute per-pixel difference from a baseline, the same measure the ghost-dimming
    // check above uses: "changes the pixels less" is what dimmer actually means here.
    const deltaFrom = (base, X, Y, r) => {
      const d = grab(X, Y, r);
      let s = 0, n = 0;
      for (let i = 0; i < d.length; i += 4) {
        s += Math.abs(d[i] - base[i]) + Math.abs(d[i + 1] - base[i + 1]) + Math.abs(d[i + 2] - base[i + 2]);
        n++;
      }
      return s / n;
    };
    // Deep-orange predicate, on the green channel alone. It has to clear gold #ffd24a (g=210)
    // AND every anti-aliased blend of the teleport glyph #ff9d3a, whose edges fade toward a dark
    // halo and a black letter stroke: at fraction t that lands on (255t, 157t, 58t), so r>210
    // forces t>0.82 and therefore g>129. The route's own g is 90 and its blends toward the
    // casing reach ~76, which is what leaves 115 a gap and not a fitted number.
    const routePx = (X, Y, r) => {
      const d = grab(X, Y, r);
      let n = 0;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i] > 210 && d[i + 1] < 115 && d[i + 2] < 60) n++;
      }
      return n;
    };
    const out = {};
    // A walk-only Antonica trip, so the drawn legs are all in one continent view. The
    // capability state is borrowed and put back: the reload check below reads the wizard toggle
    // the previous section left on.
    const saved = {};
    for (const k in TCAPS) { saved[k] = TCAPS[k]; TCAPS[k] = false; }
    TADJ = null;
    setTravel(true);
    tPick('from', { kind: 'zone', key: 'freportw', name: 'West Freeport' });
    tPick('to', { kind: 'zone', key: 'nro', name: 'North Desert of Ro' });
    out.legs = TROUTE ? TROUTE.legs.map((l) => l.from + '>' + l.to) : null;
    enterCont('Antonica');
    const d = contData('Antonica');
    const mid = (a, b) => {
      const p = zoneCentroid(d.zones[a]), q = zoneCentroid(d.zones[b]);
      return [(wx(p[0]) + wx(q[0])) / 2, (wy(p[1]) + wy(q[1])) / 2];
    };
    const leg = TROUTE.legs[0], M = mid(leg.from, leg.to);
    const R = 14 * dpr;
    // baseline: identical view, no route
    const live = TROUTE;
    TROUTE = null; draw();
    const base = grab(M[0], M[1], R);
    out.baseOrange = routePx(M[0], M[1], R);
    TROUTE = live; draw();
    out.legDelta = deltaFrom(base, M[0], M[1], R);
    out.legOrange = routePx(M[0], M[1], R);
    // a control point on a stretch of map the route does not cross
    const off = zoneCentroid(d.zones['oasis']), O = [wx(off[0]), wy(off[1])];
    TROUTE = null; draw();
    const obase = grab(O[0], O[1], R);
    TROUTE = live; draw();
    out.offOrange = routePx(O[0], O[1], R);
    out.offDelta = deltaFrom(obase, O[0], O[1], R);
    // Hue separation, measured with the route OFF: the question is whether a glyph or its gold
    // ring reads as the route colour on its own. Measured with the route on it cannot answer
    // that - North Ro is a wizard spire and the trip ends there, so the line and its pip land
    // inside the glyph's own annulus and 29 px of genuine route came back as a false positive.
    TROUTE = null; draw();
    let worst = 0, worstAt = null;
    for (const s of hubScreens) {
      const m = routePx(s.X, s.Y, s.r + 8 * dpr);
      if (m > worst) { worst = m; worstAt = s.h.kind; }
    }
    out.hubWorst = worst; out.hubWorstKind = worstAt; out.hubsSeen = hubScreens.length;
    TROUTE = live; draw();
    // dimming, measured on the outlines themselves rather than on a colour name
    const onR = zoneCentroid(d.zones['nro']), offR = zoneCentroid(d.zones['oasis']);
    const gauge = (c) => {
      const X = wx(c[0]), Y = wy(c[1]), r = 40 * dpr;
      TROUTE = null; draw();
      const b = grab(X, Y, r);
      TROUTE = live; draw();
      return deltaFrom(b, X, Y, r);
    };
    out.dimOnRoute = gauge(onR);
    out.dimOffRoute = gauge(offR);
    for (const k in saved) TCAPS[k] = saved[k];
    TADJ = null; tBuildCaps();
    return out;
  });
  ok('a walk-only Antonica trip is planned (' + (rp.legs || []).join(', ') + ')',
    !!rp.legs && rp.legs.length >= 2, rp.legs);
  ok('the route line reaches the canvas (delta ' + rp.legDelta.toFixed(1) + ' at a leg midpoint)',
    rp.legDelta > 12, rp);
  ok('...in the route colour (' + rp.legOrange + ' px, ' + rp.baseOrange + ' without it)',
    rp.legOrange > 40 && rp.baseOrange < rp.legOrange / 8, rp);
  ok('and nowhere the route does not go (' + rp.offOrange + ' px, delta '
     + rp.offDelta.toFixed(1) + ')', rp.offOrange === 0, rp);
  ok('no hub glyph or gold ring reads as the route colour across ' + rp.hubsSeen
     + ' glyphs — worst was ' + rp.hubWorstKind + ' at ' + rp.hubWorst + ' px',
    rp.hubWorst < rp.legOrange / 8, rp);
  ok('an off-route zone is dimmed: it changes ' + rp.dimOffRoute.toFixed(1)
     + ' against an on-route ' + rp.dimOnRoute.toFixed(1),
    rp.dimOffRoute > rp.dimOnRoute * 1.5, rp);
  // Frame the route before shooting. At the continent fit-zoom two adjacent Freeport zones are
  // ~30 px apart, so the line is a few orange pixels in a 1400 px frame - the numbers above pass
  // and the artifact is unreviewable, which defeats the point of keeping one.
  await tp.evaluate(`(function(){const d=contData('Antonica');
    let x0=1e18,y0=1e18,x1=-1e18,y1=-1e18;
    for(const k in TROUTE.on){const zo=d.zones[k];if(!zo)continue;const c=zoneCentroid(zo);
      x0=Math.min(x0,c[0]);x1=Math.max(x1,c[0]);y0=Math.min(y0,c[1]);y1=Math.max(y1,c[1]);}
    const pad=Math.max(2500,(x1-x0)*0.35,(y1-y0)*0.35);
    fitBox([x0-pad,y0-pad,x1+pad,y1+pad]);draw();})()`);
  await tp.screenshot({ path: path.join(OUT, '9-route-continent.png') });
  // A different trip for the world shot: the two-leg Freeport walk above is a few globe units
  // long, so its line hides under its own pips and the artifact shows nothing about this level.
  // The ungated Ocean of Tears crossing is what the world view is for.
  await tp.evaluate(`(function(){for(const k in TCAPS)TCAPS[k]=false;TADJ=null;
    tPick('from',{kind:'zone',key:'freportw',name:'West Freeport'});
    tPick('to',{kind:'zone',key:'butcher',name:'Butcherblock Mountains'});
    enterWorld();wv={x:0,y:0,k:1};draw();})()`);
  ok('the world shot has a cross-continent trip to draw',
    await tp.evaluate("TROUTE&&TROUTE.legs.some(l=>l.kind==='boat')"), true);
  await tp.screenshot({ path: path.join(OUT, '10-route-world.png') });
  // tLoadCaps re-reads the persisted toggles, which is exactly the state the section below
  // expects: the wizard click above went through tSaveCaps.
  await tp.evaluate("tLoadCaps();tBuildCaps();TADJ=null;setTravel(false);enterCont('Antonica')");

  // ------------------------------------------------------------ expansion selection
  // Here rather than in jsdom for the two things jsdom cannot answer: whether the control is
  // actually on screen through the CSS cascade, and whether a filtered world link is really
  // absent from the painted bitmap. A stubbed canvas would pass either way.
  section('the expansion picker, through the real cascade');
  await tp.evaluate('setTravel(false);enterWorld()');
  ok('the picker is visible at world level, where setHUD passes tools=false',
    await disp('xpacbar') !== 'none', await disp('xpacbar'));
  eq('one button per authored expansion',
    await tp.evaluate("document.querySelectorAll('#xpacPick .k').length"),
    await tp.evaluate('XPACS.order.length'));
  eq('...and none of them landed in the capability row, which is size-checked above',
    await tp.evaluate("document.querySelectorAll('#tvCaps .btn[data-xpac]').length"), 0);
  eq('the authored default is the one marked on',
    await tp.evaluate("document.querySelector('#xpacPick .k.on').dataset.xpac"),
    await tp.evaluate('XPACS.default'));
  eq('the button text comes from the authored labels',
    await tp.evaluate("[...document.querySelectorAll('#xpacPick .k')].map(b=>b.textContent)"),
    await tp.evaluate('XPACS.order.map(e=>XPACS.labels[e])'));
  await tp.evaluate('enterUniverse()');
  ok('...and it is still there at universe level', await disp('xpacbar') !== 'none');
  // The HUD stacks title, buttons, #travel, #xpacbar, #editbar. An open travel panel with a full
  // itinerary pushes the picker down, so check it is still reachable rather than off the bottom.
  await tp.evaluate(`enterCont(${JSON.stringify(CONT)});setTravel(true);
    tPick('from',{kind:'zone',key:'freportw',name:tzName('freportw')});
    tPick('to',{kind:'zone',key:'oasis',name:tzName('oasis')});`);
  ok('the picker stays on screen under an open travel panel with an itinerary',
    await tp.evaluate(`(function(){const e=document.getElementById('xpacbar').getBoundingClientRect();
      return e.height>0 && e.top>0 && e.bottom<=innerHeight;})()`),
    await tp.evaluate("JSON.stringify(document.getElementById('xpacbar').getBoundingClientRect())"));
  await tp.evaluate("setTravel(false);enterWorld()");

  section('rendered world: a later expansion is absent, and clicking the control brings it back');
  {
    const LAST = await tp.evaluate('XPACS.order[XPACS.order.length-1]');
    eq('Kunark is not on the globe at the first expansion',
      await tp.evaluate("'Kunark' in worldRects"), false);
    eq('...nor pickable there', await tp.evaluate(`(function(){
      const r=ALL['Kunark']?1:0; return worldPick(cv.width/2,cv.height/2)==='Kunark';})()`), false);

    // Pixels, on the segment of a world link that belongs to a later expansion. Sampled along
    // the whole segment because the line is DASHED, so most single points sit in a gap; the
    // question is whether any of it is painted. Gold is #ffd24a.
    const goldOnLink = (idx) => tp.evaluate(`(function(){
      const c=WORLDLINKS[${idx}], wm=worldMap(), ctx2=cv.getContext('2d');
      const A=[wm.gx(c.a[0])*wv.k+wv.x, wm.gy(c.a[1])*wv.k+wv.y];
      const B=[wm.gx(c.b[0])*wv.k+wv.x, wm.gy(c.b[1])*wv.k+wv.y];
      let n=0;
      for(let s=0;s<=240;s++){const t=s/240;
        const X=Math.round(A[0]+(B[0]-A[0])*t), Y=Math.round(A[1]+(B[1]-A[1])*t);
        if(X<1||Y<1||X>=cv.width-1||Y>=cv.height-1)continue;
        const d=ctx2.getImageData(X-1,Y-1,3,3).data;
        for(let p=0;p<d.length;p+=4)
          if(d[p]>200&&d[p+1]>150&&d[p+1]<215&&d[p+2]<120){n++;break;}}
      return n;})()`);
    const hiddenIdx = await tp.evaluate('[...XPAC_WL].sort((a,b)=>a-b)[0]');
    const shownIdx = await tp.evaluate(
      '[...WORLDLINKS.keys()].filter(i=>!XPAC_WL.has(i)&&WORLDLINKS[i].alt===alt)[0]');
    const goldHiddenBefore = await goldOnLink(hiddenIdx);
    const goldShownBefore = await goldOnLink(shownIdx);
    ok('an in-expansion world link is painted (' + goldShownBefore + ' gold samples)',
      goldShownBefore > 0, goldShownBefore);
    eq('an out-of-expansion world link is not painted at all', goldHiddenBefore, 0);

    // Drive the control itself, not setXpac() -- the click wiring is half of what ships.
    await tp.click(`#xpacPick .k[data-xpac="${LAST}"]`);
    eq('clicking the last expansion selects it', await tp.evaluate('xpac'), LAST);
    eq('...and marks only that button',
      await tp.evaluate("[...document.querySelectorAll('#xpacPick .k.on')].map(b=>b.dataset.xpac)"),
      [LAST]);
    eq('Kunark is on the globe now', await tp.evaluate("'Kunark' in worldRects"), true);
    ok('and the world link is painted (' + (await goldOnLink(hiddenIdx)) + ' gold samples)',
      await goldOnLink(hiddenIdx) > 0);
    await tp.screenshot({ path: path.join(OUT, '11-xpac-last.png') });

    // Standing inside a continent that stops existing must not leave the map showing it.
    await tp.evaluate("enterCont('Kunark')");
    eq('an author can enter it at its expansion', await tp.evaluate('cur'), 'Kunark');
    await tp.click(`#xpacPick .k[data-xpac="${await tp.evaluate('XPACS.default')}"]`);
    eq('...and switching away retreats to the globe', await tp.evaluate('level'), 'world');
    eq('...with nothing left selected', await tp.evaluate('sel===null'), true);
    await tp.screenshot({ path: path.join(OUT, '12-xpac-first.png') });
  }

  section('capability choices survive a reload, and the editions stay isolated');
  eq('wizard is on before reloading', await tp.evaluate('TCAPS.wizard'), true);
  await tp.reload({ waitUntil: 'load', timeout: 120000 });
  await tp.waitForFunction("typeof enterCont==='function'", null, { timeout: 120000 });
  eq('wizard survived the reload', await tp.evaluate('TCAPS.wizard'), true);
  eq('and the toggle came back on', await tp.evaluate(
    "document.querySelector('#tvCaps .btn[data-cap=wizard]').classList.contains('on')"), true);
  eq('the user edition key is suffixed _u1', await tp.evaluate('travelLsKey()'), 'eql_travel_caps_u1');
  // The expansion pick rides its own key, deliberately outside the customization overlay: that file is
  // shareable, and a shared layout must not carry the sharer's server progress.
  eq('the expansion key is suffixed _u1 too', await tp.evaluate('xpacLsKey()'), 'eql_map_xpac_u1');
  eq('the expansion pick survived the reload', await tp.evaluate('xpac'),
    await tp.evaluate('XPACS.default'));
  await tp.evaluate("setXpac(XPACS.order[XPACS.order.length-1])");
  await tp.reload({ waitUntil: 'load', timeout: 120000 });
  await tp.waitForFunction("typeof enterCont==='function'", null, { timeout: 120000 });
  eq('a changed expansion survives too', await tp.evaluate('xpac'),
    await tp.evaluate('XPACS.order[XPACS.order.length-1]'));
  ok('and the picker came back on it', await tp.evaluate(
    "document.querySelector('#xpacPick .k.on').dataset.xpac===XPACS.order[XPACS.order.length-1]"));
  // Checked as a KEY sweep over a NON-EMPTY overlay, not as a substring of the serialized blob,
  // and the regex stays ANCHORED. Both halves are deliberate: a substring test reports a false
  // PASS on the empty overlay a fresh page produces, and an unanchored one collides with zone
  // keys -- `lakerathe` contains the old "expansion" spelling, which is what taught us this. "xpac" is
  // not a substring of anything in data/ today, so the anchor is cheap insurance, not dead weight.
  eq('the expansion pick never enters the shareable customization file', await tp.evaluate(`(function(){
    enterCont(${JSON.stringify(CONT)});setEdit(true);hubs[0].touched=true;
    const ov=buildOverlay(), bad=[];
    (function walk(o){ if(!o||typeof o!=='object')return;
      for(const k in o){ if(/^xpac/i.test(k))bad.push(k); walk(o[k]); } })(ov);
    const n=Object.keys(ov.continents).length;
    setEdit(false);
    return n>0?bad:['overlay was empty, so this proved nothing'];})()`), []);

  // --------------------------------------------- world-link endpoint handle colour
  // Here rather than in jsdom because a stubbed canvas cannot see a colour, and this is exactly
  // the failure AGENTS.md warns about: drawEndpoint takes an `anchored` flag and used to be
  // handed a hard-coded false, which every other layer passes with. Green (#66d68f) vs the
  // free yellow (#ffd24a) is the whole affordance. Green is the discriminator in both
  // directions, since the connector LINE is already that same yellow.
  section('rendered world: an anchored endpoint handle is green, a freed one is not');
  {
    await tp.evaluate("setTravel(false);enterWorld();setEdit(true);sel=null;draw()");
    const idx = await tp.evaluate(
      "worldConns().findIndex((l,i)=>l.anchorA&&(!l.alt||l.alt===alt)&&!xpacWlHidden(l,i)&&!isGhost(l))");
    ok('some world-link end auto-anchored to its landmass', idx >= 0, idx);
    // A square of half-size 4*dpr sits on the resolved point; sample a slightly wider box.
    const greenAtA = () => tp.evaluate(`(function(){
      const l=worldConns()[${idx}], wm=worldMap(), ctx2=cv.getContext('2d');
      const p=wlPt(l,'a');
      const X=Math.round(wm.gx(p[0])*wv.k+wv.x), Y=Math.round(wm.gy(p[1])*wv.k+wv.y);
      const R=Math.round(7*devicePixelRatio);
      if(X-R<0||Y-R<0||X+R>=cv.width||Y+R>=cv.height)return -1;
      const d=ctx2.getImageData(X-R,Y-R,2*R,2*R).data;
      let n=0;
      for(let i=0;i<d.length;i+=4){const r=d[i],g=d[i+1],b=d[i+2];
        if(g>r+40&&b>r&&g>120)n++;}
      return n;})()`);
    const anchored = await greenAtA();
    ok('the anchored handle paints green (' + anchored + ' px)', anchored > 0, anchored);
    await tp.evaluate('toggleWlAnchor(' + idx + ",'a');draw()");
    const freed = await greenAtA();
    eq('freeing the end takes the green away', freed, 0);
    // ...and the handle is still there, just yellow: the picker finds it at the same point.
    ok('the freed handle is still drawn and pickable', await tp.evaluate(`(function(){
      const l=worldConns()[${idx}],p=wlPt(l,'a'),S=globeToScreen(p[0],p[1]);
      const h=pickWConnEndpoint(S[0],S[1]);return !!h&&h.i===${idx}&&h.which==='a';})()`));
    await tp.screenshot({ path: path.join(OUT, '13-world-anchor-handles.png') });
    await tp.evaluate('toggleWlAnchor(' + idx + ",'a');setEdit(false)");
  }

  // ------------------------------------------------------------ author edition
  section('author edition loads and keeps its export buttons');
  const p2 = await ctx.newPage();
  const aErrors = [];
  watch(p2, aErrors);
  await p2.goto(BASE + '/author.html', { waitUntil: 'load', timeout: 120000 });
  await p2.waitForFunction("typeof enterCont==='function'", null, { timeout: 120000 });
  await p2.evaluate("enterCont(" + JSON.stringify(CONT) + ");setEdit(true)");
  ok('author: no page errors (getPristine runs here)', aErrors.length === 0, aErrors);
  ok('author: export buttons present',
    await p2.evaluate("!!document.getElementById('bExport') && !!document.getElementById('bExportHTML')"));
  ok('author: no hidden-items block', await p2.evaluate("!document.getElementById('hiddenBlock')"));
  // Same origin as user.html, so this is a genuine cross-edition isolation check: the user
  // edition set wizard=true a moment ago under its own suffixed key.
  eq('author: travel key is suffixed _v1', await p2.evaluate('travelLsKey()'), 'eql_travel_caps_v1');
  eq('author: expansion key is suffixed _v1', await p2.evaluate('xpacLsKey()'), 'eql_map_xpac_v1');
  eq('author: does not inherit the user edition expansion choice', await p2.evaluate('xpac'),
    await p2.evaluate('XPACS.default'));
  eq('author: does not inherit the user edition capability choice',
    await p2.evaluate('TCAPS.wizard'), false);
  eq('author: shows a per-leg cost the user edition withholds', await p2.evaluate(`(function(){
    TCAPS.wizard=true;TADJ=null;
    tPick('from',{kind:'zone',key:'freportw',name:'West Freeport'});
    tPick('to',{kind:'zone',key:'airplane',name:'Plane of Sky'});
    return document.querySelectorAll('#travel .leg .c').length;})()`), 1);

  // the standalone export is the heaviest author path: ~18MB serialize + download
  const dl2 = await Promise.all([
    p2.waitForEvent('download', { timeout: 120000 }),
    p2.click('#bExportHTML'),
  ]).then((r) => r[0]);
  // Must NOT be eql-interactive-map.html — that is the user distributable's name, and this file
  // carries the author surface. The suffix is what .gitignore's *.author.html guard matches.
  eq('standalone export filename', dl2.suggestedFilename(), 'eql-interactive-map.author.html');
  const standalone = path.join(OUT, 'standalone.html');
  await dl2.saveAs(standalone);
  const sz = fs.statSync(standalone).size;
  ok('standalone export is a plausible full document (' + Math.round(sz / 1048576) + ' MB)', sz > 15e6);

  // re-parse the export as a second document
  const p3 = await ctx.newPage();
  const sErrors = [];
  watch(p3, sErrors);
  await p3.goto('file:///' + standalone.replace(/\\/g, '/'), { waitUntil: 'load', timeout: 120000 });
  await p3.waitForFunction("typeof enterCont==='function'", null, { timeout: 120000 });
  ok('standalone export re-opens with no errors', sErrors.length === 0, sErrors);
  eq('standalone export has all 11 continents', await p3.evaluate('names.length'), 11);

  await browser.close();
  fs.rmSync(builderScratch, { recursive: true, force: true });
  console.log('\nscreenshots + downloads in: ' + OUT);
  console.log(checks + ' checks, ' + fails + ' failed');
  console.log('RESULT: ' + (fails ? 'FAIL' : 'PASS'));
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR: ' + e.stack); process.exit(2); });
