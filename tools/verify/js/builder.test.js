#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

try {
  require.resolve('jsdom');
} catch (error) {
  if (error && error.code === 'MODULE_NOT_FOUND') {
    console.log('SKIP: builder jsdom checks (run npm install in tools/verify/js)');
    process.exit(0);
  }
  throw error;
}

const { load } = require('./lib.js');
const REPO = path.resolve(__dirname, '../../..');
const FX = path.join(REPO, 'tools', 'verify', 'packfx');
const OUT = path.join(REPO, 'tools', 'verify', '_out');
const BUILDER_FX = path.join(OUT, 'builder-fx.html');
const BUILDER_REAL = path.join(OUT, 'builder.html');
const py = process.argv[2] || process.env.EQL_PYTHON || 'python';
let checks = 0;

function check(name, fn) {
  fn(); checks++;
  console.log('  OK   ' + name);
}

async function checkAsync(name, fn) {
  await fn(); checks++;
  console.log('  OK   ' + name);
}

function runPython(args, options = {}) {
  return spawnSync(py, args, { cwd: REPO, encoding: 'utf8', shell: false, ...options });
}

function mustPython(args, options) {
  const run = runPython(args, options);
  if (run.status !== 0) throw new Error(`Python exited ${run.status}: ${run.stderr}`);
  return run.stdout;
}

function normalized(text) { return text.replace(/\r\n/g, '\n'); }
function hostArray(value) { return Array.from(value); }
function collapseRuns(values) {
  return values.filter((value, index) => index === 0 || value !== values[index - 1]);
}

function assertSame(label, actual, expected) {
  actual = normalized(actual); expected = normalized(expected);
  if (actual !== expected) {
    let at = 0;
    while (at < actual.length && at < expected.length && actual[at] === expected[at]) at++;
    throw new Error(`${label}: output differs at character ${at}: actual ${JSON.stringify(actual.slice(at, at + 100))}, expected ${JSON.stringify(expected.slice(at, at + 100))}`);
  }
}

function walkFiles(selected) {
  const parent = path.dirname(selected), files = [];
  function walk(dir) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(absolute);
      else if (ent.isFile()) {
        const webkitRelativePath = path.relative(parent, absolute).split(path.sep).join('/');
        files.push({
          webkitRelativePath,
          async arrayBuffer() {
            const value = fs.readFileSync(absolute);
            return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
          },
        });
      }
    }
  }
  walk(selected);
  return files;
}

function copyFixtureData(root) {
  const data = path.join(root, 'data');
  fs.cpSync(path.join(FX, 'data'), data, { recursive: true });
  return data;
}

function pythonReference(pack, data, reference) {
  let run = runPython(['scripts/import_pack.py', '--pack', pack, '--data', data]);
  if (run.status !== 0) throw new Error('fixture import failed: ' + run.stderr);
  // Plan 3 removes this parity-only --no-discover when the browser converter consumes catalogs.
  run = runPython(['scripts/build.py', '--data', data, '--out', reference, '--no-discover']);
  if (run.status !== 0) throw new Error('fixture build failed: ' + run.stderr);
  return fs.readFileSync(reference, 'utf8');
}

function choice(page, files, label) {
  const result = page.w.packChoices(files);
  const record = result.packs.find(item => item.label === label);
  if (!record) throw new Error(`no ${label} choice in ${JSON.stringify(result)}`);
  return { result, record };
}

async function pageBuild(page, files, record, observeRead, version) {
  // File-like plain objects deliberately fabricate webkitRelativePath in jsdom. This drives the
  // page's real adapter but cannot prove a browser populates the property; the browser/manual
  // layers own that question.
  const calls = [];
  const adapter = page.w.filesFromFileList(files, key => {
    calls.push(key);
    if (observeRead) observeRead(key);
  });
  const built = await page.w.buildMap({
    files: adapter, packDir: record.packDir, rootDir: record.rootDir, version,
  });
  return { built, calls };
}

function zoneOf(key) {
  return path.posix.basename(key).replace(/\.txt$/i, '').replace(/_[123]$/, '').toLowerCase();
}

function waitFor(predicate, message) {
  return new Promise((resolve, reject) => {
    let remaining = 100;
    const poll = () => {
      if (predicate()) return resolve();
      if (!remaining--) return reject(new Error(message));
      setTimeout(poll, 10);
    };
    poll();
  });
}

async function main() {
  if (!fs.existsSync(BUILDER_FX) || !fs.existsSync(BUILDER_REAL)) {
    throw new Error('missing tools/verify/_out builder artifacts; run scripts/build_builder.py for the real and packfx data trees');
  }
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'eql-builder-jsdom-'));
  try {
    const page = load(BUILDER_FX);
    check('fixture builder parses without page errors', () => assert.deepStrictEqual(page.errors, []));
    check('page exposes adapter and four named seams', () => {
      for (const name of ['filesFromFileList', 'packChoices', 'buildMap', 'renderReport', 'downloadHTML']) {
        assert.strictEqual(typeof page.w[name], 'function', name);
      }
    });

    // Flat fixture: the exact browser adapter feeds the byte-identity comparison.
    const flatFiles = walkFiles(path.join(FX, 'pack'));
    const flatChoice = choice(page, flatFiles, 'pack (root alone)');
    check('flat choice comes from packChoices', () => {
      assert.strictEqual(flatChoice.result.selectionName, 'pack');
      assert.deepStrictEqual(
        { packDir: flatChoice.record.packDir, rootDir: flatChoice.record.rootDir },
        { packDir: 'pack', rootDir: null });
    });
    const flatRoot = path.join(scratch, 'flat'); fs.mkdirSync(flatRoot);
    const flatData = copyFixtureData(flatRoot);
    const flatReference = pythonReference(path.join(FX, 'pack'), flatData, path.join(flatRoot, 'ref.html'));
    check('Python reference artifact contains LF only', () => assert(!flatReference.includes('\r')));
    const flat = await pageBuild(page, flatFiles, flatChoice.record);
    check('page output is byte-identical to Python over flat pack', () =>
      assertSame('flat builder', flat.built.html, flatReference));
    const mismatchedVersion = fs.readFileSync(path.join(REPO, 'VERSION'), 'ascii').trim() + '-mismatch';
    const versionMutant = await pageBuild(
      page, flatFiles, flatChoice.record, undefined, mismatchedVersion);
    check('control: browser-side version mismatch breaks Python byte identity', () =>
      assert.throws(
        () => assertSame('version mismatch', versionMutant.built.html, flatReference),
        /differs/));
    check('browser-built artifact contains LF only', () => assert(!flat.built.html.includes('\r')));
    check('control: one perturbed reference byte is caught', () =>
      assert.throws(() => assertSame('perturbed', flat.built.html, flatReference + 'x'), /differs/));
    check('browser adapter read every resolved roster zone', () =>
      assert.deepStrictEqual([...new Set(flat.calls.map(zoneOf))].sort(), ['alpha', 'beta', 'gamma']));

    const progressElement = page.w.document.getElementById('progress');
    const progressTexts = [];
    const progressObserver = new page.w.MutationObserver(() => {
      progressTexts.push(progressElement.textContent);
    });
    progressObserver.observe(progressElement, { childList: true, subtree: true });
    const pageFiles = flatFiles.map(file => ({
      webkitRelativePath: file.webkitRelativePath,
      async arrayBuffer() {
        await new Promise(resolve => setTimeout(resolve, 0));
        return file.arrayBuffer();
      },
    }));
    Object.defineProperty(page.w.document.getElementById('folder'), 'files', {
      value: pageFiles, configurable: true,
    });
    page.w.document.getElementById('folder').dispatchEvent(new page.w.Event('change'));
    page.w.document.getElementById('build').click();
    await waitFor(() => progressElement.textContent.includes('— complete'),
      'page-driven build did not complete');
    progressObserver.disconnect();
    check('flat progress follows authored roster positions through completion', () =>
      assert.deepStrictEqual(collapseRuns(progressTexts), [
        'Converting Testland: alpha (1/3)',
        'Converting Testland: beta (2/3)',
        'Converting Testland: gamma (3/3)',
        'Converting Testland: gamma (3/3) — complete',
      ]));

    const mapPath = path.join(scratch, 'captured-map.html');
    fs.writeFileSync(mapPath, flat.built.html, 'utf8');
    const map = load(mapPath);
    check('captured map boots with canvas and no errors', () => {
      assert(map.w.document.querySelector('canvas'));
      assert.deepStrictEqual(map.errors, []);
    });
    check('map without travel data shows a persistent unavailable notice', () => {
      const notice = map.w.document.getElementById('travelUnavailable');
      assert.strictEqual(map.ev('TRAVEL_AVAILABLE'), false);
      assert.strictEqual(map.w.getComputedStyle(notice).display, 'block');
      assert.strictEqual(notice.textContent, 'Travel unavailable: this map was built without travel data.');
    });
    check('control: hidden-notice predicate rejects travel-less fixture', () => {
      const notice = map.w.document.getElementById('travelUnavailable');
      assert.notStrictEqual(map.w.getComputedStyle(notice).display, 'none');
    });
    check('map without travel data disables Travel and keeps its panel closed', () => {
      const button = map.w.document.getElementById('bTravel');
      assert.strictEqual(button.getAttribute('aria-disabled'), 'true');
      button.click();
      assert.strictEqual(map.ev('travelOpen'), false);
      assert.strictEqual(map.w.getComputedStyle(map.w.document.getElementById('travel')).display, 'none');
    });
    check('captured map navigates into a continent', () => {
      map.ev("enterCont('Testland')");
      assert.strictEqual(map.ev('level'), 'continent');
    });
    check('travel-less map enumerates and hit-tests every hub', () => {
      assert.strictEqual(map.ev('hubScreens.length'), map.ev('HUBS.Testland.length'));
      assert(map.ev('pickHub(hubScreens[0].X, hubScreens[0].Y)'));
    });
    check('captured map navigates back to world', () => {
      map.ev('enterWorld()');
      assert.strictEqual(map.ev('level'), 'world');
    });
    map.dom.window.close();

    const presentTravel = JSON.stringify({
      version: 1, groups: {}, capabilities: [], overrides: {}, walk: [], routes: [],
    });
    const presentPath = path.join(scratch, 'present-empty-travel.html');
    const absentDeclaration = 'const TRAVEL={};';
    check('captured fixture has one absent-travel declaration to control', () =>
      assert.strictEqual(flat.built.html.split(absentDeclaration).length - 1, 1));
    fs.writeFileSync(presentPath,
      flat.built.html.replace(absentDeclaration, `const TRAVEL=${presentTravel};`), 'utf8');
    const presentMap = load(presentPath);
    check('schema-complete empty travel data retains normal Travel UI', () => {
      assert.deepStrictEqual(presentMap.errors, []);
      assert.strictEqual(presentMap.ev('TRAVEL_AVAILABLE'), true);
      assert.strictEqual(
        presentMap.w.getComputedStyle(presentMap.w.document.getElementById('travelUnavailable')).display,
        'none');
      const button = presentMap.w.document.getElementById('bTravel');
      assert.strictEqual(button.hasAttribute('aria-disabled'), false);
      button.click();
      assert.strictEqual(presentMap.ev('travelOpen'), true);
      assert.notStrictEqual(
        presentMap.w.getComputedStyle(presentMap.w.document.getElementById('travel')).display,
        'none');
    });
    presentMap.dom.window.close();

    // Layered fixture: packChoices, not literals, supplies both directories.
    const layeredSelected = path.join(FX, 'layered', 'maps');
    const layeredFiles = walkFiles(layeredSelected);
    const layeredChoice = choice(page, layeredFiles, 'Layered');
    check('maps/Layered choice derives the maps root', () => assert.deepStrictEqual(
      { packDir: layeredChoice.record.packDir, rootDir: layeredChoice.record.rootDir },
      { packDir: 'maps/Layered', rootDir: 'maps' }));
    const layeredRoot = path.join(scratch, 'layered'); fs.mkdirSync(layeredRoot);
    const layeredData = copyFixtureData(layeredRoot);
    const layeredReference = pythonReference(
      path.join(layeredSelected, 'Layered'), layeredData, path.join(layeredRoot, 'ref.html'));
    const layered = await pageBuild(page, layeredFiles, layeredChoice.record);
    check('layered report pins root-sourced gamma', () =>
      assert.deepStrictEqual(hostArray(layered.built.report.rootZones.Testland), ['gamma']));
    check('layered credit pins one game-root zone', () =>
      assert.strictEqual(layered.built.credit, "EQL · Layered map data · 1 zone from the game's own maps"));
    check('page output is byte-identical to Python over layered pack', () =>
      assertSame('layered builder', layered.built.html, layeredReference));

    const rootChoice = choice(page, layeredFiles, 'maps (root alone)');
    const rootPageFiles = layeredFiles.map(file => ({
      webkitRelativePath: file.webkitRelativePath,
      async arrayBuffer() {
        await new Promise(resolve => setTimeout(resolve, 0));
        return file.arrayBuffer();
      },
    }));
    Object.defineProperty(page.w.document.getElementById('folder'), 'files', {
      value: rootPageFiles, configurable: true,
    });
    page.w.document.getElementById('folder').dispatchEvent(new page.w.Event('change'));
    page.w.document.getElementById('pack').value = rootChoice.record.packDir;
    const rootProgressTexts = [];
    const rootProgressObserver = new page.w.MutationObserver(() => {
      rootProgressTexts.push(progressElement.textContent);
    });
    rootProgressObserver.observe(progressElement, { childList: true, subtree: true });
    page.w.document.getElementById('build').click();
    await waitFor(() => progressElement.textContent.includes('— complete'),
      'root-only page-driven build did not complete');
    rootProgressObserver.disconnect();
    check('root-only progress jumps over the skipped roster position', () => {
      assert.strictEqual(page.w.document.getElementById('pack').selectedOptions[0].textContent,
        'maps (root alone)');
      assert.deepStrictEqual(collapseRuns(rootProgressTexts), [
        'Converting Testland: alpha (1/3)',
        'Converting Testland: gamma (3/3)',
        'Converting Testland: gamma (3/3) — complete',
      ]);
    });

    // The same directory tree renamed away from maps must lose the base layer in both front ends.
    const renamedParent = path.join(scratch, 'renamed'); fs.mkdirSync(renamedParent);
    const renamedSelected = path.join(renamedParent, 'EQmaps');
    fs.cpSync(layeredSelected, renamedSelected, { recursive: true });
    const renamedFiles = walkFiles(renamedSelected);
    const renamedChoice = choice(page, renamedFiles, 'Layered');
    check('renamed selection does not derive a root layer', () => assert.deepStrictEqual(
      { packDir: renamedChoice.record.packDir, rootDir: renamedChoice.record.rootDir },
      { packDir: 'EQmaps/Layered', rootDir: null }));
    const renamedCase = path.join(scratch, 'renamed-case'); fs.mkdirSync(renamedCase);
    const renamedData = copyFixtureData(renamedCase);
    const renamedReference = pythonReference(
      path.join(renamedSelected, 'Layered'), renamedData, path.join(renamedCase, 'ref.html'));
    const renamed = await pageBuild(page, renamedFiles, renamedChoice.record);
    check('renamed report has no root-sourced zones', () =>
      assert.deepStrictEqual(hostArray(renamed.built.report.rootZones.Testland), []));
    check('renamed credit has no game-root clause', () =>
      assert(!renamed.built.credit.includes("game's own maps")));
    check('renamed page output agrees byte-for-byte with Python', () =>
      assertSame('renamed builder', renamed.built.html, renamedReference));

    const mutantPath = path.join(scratch, 'builder-root-mutant.html');
    const fxSource = fs.readFileSync(BUILDER_FX, 'utf8');
    const rootRule = "rootDir: selectionName.toLowerCase() === 'maps' ? selectionName : null,";
    assert.strictEqual(fxSource.split(rootRule).length - 1, 1, 'root rule mutation anchor');
    fs.writeFileSync(mutantPath, fxSource.replace(rootRule, 'rootDir: selectionName,'), 'utf8');
    const mutantPage = load(mutantPath);
    check('control: always-root packChoices mutant fails renamed half', () => {
      const mutantChoice = choice(mutantPage, renamedFiles, 'Layered').record;
      assert.notStrictEqual(mutantChoice.rootDir, null);
    });
    mutantPage.dom.window.close();

    let downloadName = null;
    page.w.HTMLAnchorElement.prototype.click = function () { downloadName = this.download; };
    page.w.downloadHTML(flat.built.html);
    check('download uses exact user-distributable filename', () =>
      assert.strictEqual(downloadName, 'eql-interactive-map.html'));
    check('download is a genuine Blob containing the map', () => {
      assert(page.downloads.length);
      assert.strictEqual(Object.prototype.toString.call(page.downloads.at(-1)), '[object Blob]');
    });
    const downloadedText = await page.downloads.at(-1).text();
    check('downloaded Blob text equals built HTML', () =>
      assert.strictEqual(downloadedText, flat.built.html));

    const emptySelected = path.join(scratch, 'empty-pack'); fs.mkdirSync(emptySelected);
    fs.writeFileSync(path.join(emptySelected, 'readme_2.txt'), 'fixture only\n');
    const emptyFiles = walkFiles(emptySelected);
    const emptyChoice = choice(page, emptyFiles, 'empty-pack (root alone)');
    const empty = await pageBuild(page, emptyFiles, emptyChoice.record);
    page.w.renderReport(empty.built.report);
    check('all-skipped report names every fixture zone', () => {
      const text = page.w.document.getElementById('report').textContent;
      for (const zone of ['alpha', 'beta', 'gamma']) assert(text.includes(zone), zone);
    });
    check('all-skipped report links eqmaps.info', () =>
      assert(page.w.document.querySelector('#report a[href*="eqmaps.info"]')));
    page.w.renderReport({ unseenColors: ['10,0,0', '9,0,0'] });
    check('unseen colours render in numeric RGB order', () => {
      const text = page.w.document.getElementById('report').textContent;
      assert(text.indexOf('9,0,0') < text.indexOf('10,0,0'));
    });
    check('converter arrival order differs from numeric display order', () => {
      const raw = ['10,0,0', '9,0,0'].join('; ');
      assert(raw.indexOf('9,0,0') > raw.indexOf('10,0,0'));
    });

    const badFiles = walkFiles(path.join(FX, 'badpack'));
    Object.defineProperty(page.w.document.getElementById('folder'), 'files', {
      value: badFiles, configurable: true,
    });
    page.w.document.getElementById('folder').dispatchEvent(new page.w.Event('change'));
    page.w.document.getElementById('build').click();
    await waitFor(() => page.w.document.getElementById('error').style.display === 'block',
      'converter error did not reach the page');
    check('malformed record error reaches DOM with file and line', () => {
      const text = page.w.document.getElementById('error').textContent;
      assert(/alpha\.txt:3\b/i.test(text), text);
    });

    const real = load(BUILDER_REAL);
    check('real builder parses without page errors', () => assert.deepStrictEqual(real.errors, []));
    check('real builder carries four complete payloads', () => {
      assert.strictEqual(real.ev('typeof TPL'), 'string');
      assert.strictEqual(real.ev('Object.keys(AUTHORED.continents).length'), 11);
      assert.strictEqual(real.ev('Object.keys(COLORS).length'), 83);
      assert.strictEqual(real.ev('BUILDER_PAGE_READY'), true);
    });
    check('real builder exposes converter and page seams', () => {
      for (const name of ['convert', 'buildHTML', 'filesFromFileList', 'packChoices', 'buildMap', 'renderReport']) {
        assert.strictEqual(real.ev(`typeof ${name}`), 'function', name);
      }
    });
    real.dom.window.close();

    const hostileDir = path.join(scratch, 'hostile');
    mustPython(['tools/verify/test_builder.py', '--write-hostile', hostileDir]);
    const hostile = load(path.join(hostileDir, 'builder-hostile.html'));
    const expectedScripts = 2;
    check('hostile builder tokenizes into the expected scripts', () =>
      assert.strictEqual(hostile.w.document.querySelectorAll('script').length, expectedScripts));
    check('hostile builder executes the final script block', () =>
      assert.strictEqual(hostile.w.BUILDER_PAGE_READY, true));
    hostile.dom.window.close();
    const closeOnly = load(path.join(hostileDir, 'builder-hostile-close-only.html'));
    check('control: close-only escaping breaks tokenizer assertion', () => {
      const valid = closeOnly.w.document.querySelectorAll('script').length === expectedScripts
        && closeOnly.w.BUILDER_PAGE_READY === true;
      assert.strictEqual(valid, false);
    });
    closeOnly.dom.window.close();

    // Mutate before load: a classic-script function is a non-configurable window property in
    // jsdom, so runtime delete cannot create the missing-source state this control needs.
    const adapterMutantPath = path.join(scratch, 'builder-adapter-mutant.html');
    const adapterDeclaration = 'function filesFromFileList(list, onRead) {';
    assert.strictEqual(fxSource.split(adapterDeclaration).length - 1, 1,
      'adapter declaration mutation anchor');
    fs.writeFileSync(adapterMutantPath,
      fxSource.replace(adapterDeclaration, 'function filesFromFileList_DELETED(list, onRead) {'), 'utf8');
    const adapterMutant = load(adapterMutantPath);
    await checkAsync('control: removing filesFromFileList breaks adapter-fed path', async () => {
      assert.strictEqual(adapterMutant.ev('typeof filesFromFileList'), 'undefined');
      await assert.rejects(pageBuild(adapterMutant, flatFiles, flatChoice.record),
        /filesFromFileList is not a function/);
    });
    adapterMutant.dom.window.close();

    page.dom.window.close();
    console.log(`\nRESULT: PASS (${checks})`);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error.stack || error);
  process.exit(1);
});
