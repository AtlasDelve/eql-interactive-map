#!/usr/bin/env node
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { convert, buildHTML } = require('../../../src/pack_convert.js');
const MapGeom = require('../../../src/mapgeom.js');

const REPO = path.resolve(__dirname, '../../..');
const DATA = path.join(REPO, 'data');
const FX = path.join(REPO, 'tools', 'verify', '_fx');
const OUT = path.join(REPO, 'tools', 'verify', '_out');
const CONFIG = path.join(DATA, 'pack.local.json');
const MANIFEST = path.join(DATA, '_generated', 'manifest.json');
const VERSION = fs.readFileSync(path.join(REPO, 'VERSION'), 'ascii').trim();
const py = process.argv[2] || process.env.EQL_PYTHON || 'python';
const userReference = process.argv[3] || path.join(OUT, 'user.html');

function runPython(args) {
  return spawnSync(py, args, { cwd: REPO, encoding: 'buffer', shell: false });
}

function mustPython(args) {
  const run = runPython(args);
  if (run.status !== 0) throw new Error(`Python exited ${run.status}: ${run.stderr.toString('utf8')}`);
  return run.stdout;
}

function json(filename) { return JSON.parse(fs.readFileSync(filename, 'utf8')); }
function contDir(name) { return name.replace(/ /g, '_').replace(/'/g, ''); }

function loadAuthored(dataRoot) {
  const world = json(path.join(dataRoot, 'world.json')), continents = {};
  for (const cont of world.order) {
    const dir = path.join(dataRoot, 'continents', contDir(cont));
    continents[cont] = {
      meta: json(path.join(dir, 'continent.json')),
      layout: json(path.join(dir, 'layout.json')),
    };
  }
  const travel = path.join(dataRoot, 'travel.json');
  return { world, travel: fs.existsSync(travel) ? json(travel) : {}, continents };
}

function trackingReader(selected) {
  const parent = path.dirname(selected), keys = [], disk = new Map(), reads = new Map();
  function walk(dir) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(absolute);
      else if (ent.isFile()) {
        const key = path.relative(parent, absolute).split(path.sep).join('/');
        keys.push(key); disk.set(key, absolute);
      }
    }
  }
  walk(selected);
  return {
    keys() { return keys; },
    has(key) { return disk.has(key); },
    async read(key) {
      const absolute = disk.get(key);
      if (!absolute) throw new Error('reader missing key ' + key);
      reads.set(key, absolute);
      return new Uint8Array(fs.readFileSync(absolute));
    },
    reads,
  };
}

function sourceIdentity(reads) {
  const sources = [];
  for (const absolute of reads.values()) {
    const sha = crypto.createHash('sha256').update(fs.readFileSync(absolute)).digest('hex');
    sources.push([path.basename(absolute), sha]);
  }
  sources.sort((a, b) => a[0] < b[0] ? -1 : (a[0] > b[0] ? 1 : (a[1] < b[1] ? -1 : (a[1] > b[1] ? 1 : 0))));
  const hash = crypto.createHash('sha256');
  for (const [name, sha] of sources) hash.update(`${name} ${sha}\n`, 'utf8');
  return { count: sources.length, fingerprint: hash.digest('hex') };
}

function samePath(a, b) {
  const left = path.resolve(a), right = path.resolve(b);
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function strippedTemplate() {
  const code = "import sys;sys.path.insert(0,'scripts');import build;sys.stdout.buffer.write(build.strip_regions(open('src/template.html',encoding='utf-8').read(),'user').encode('utf-8'))";
  return mustPython(['-c', code]).toString('utf8');
}

function normalized(text) { return text.replace(/\r\n/g, '\n'); }
function compare(label, actual, expected) {
  actual = normalized(actual); expected = normalized(expected);
  if (actual !== expected) {
    let at = 0;
    while (at < actual.length && at < expected.length && actual[at] === expected[at]) at++;
    throw new Error(`${label}: output differs at character ${at}: actual ${JSON.stringify(actual.slice(at, at + 100))}, expected ${JSON.stringify(expected.slice(at, at + 100))}`);
  }
}

function extract(text, prefix, opener) {
  let at = 0, i;
  while (true) {
    at = text.indexOf(prefix, at);
    if (at < 0) throw new Error(`missing ${prefix}`);
    i = at + prefix.length;
    if (text[i] === opener) break;
    at = i;
  }
  const closer = opener === '{' ? '}' : ']';
  let depth = 0, inString = false, escaped = false;
  for (let j = i; j < text.length; j++) {
    const ch = text[j];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === opener) depth++;
    else if (ch === closer && --depth === 0) {
      return JSON.parse(text.slice(i, j + 1).replace(/<\\\//g, '</'));
    }
  }
  throw new Error(`unterminated ${prefix}`);
}

function assertMarkerBridge(artifact, manifest, geom = MapGeom) {
  const detail = extract(fs.readFileSync(artifact, 'utf8'), ', DETAIL=', '{');
  const entries = [], keyContinents = new Map();
  for (const [cont, block] of Object.entries(detail)) {
    for (const [key, zone] of Object.entries(block.zones)) {
      entries.push([cont, key, zone.name]);
      if (!keyContinents.has(key)) keyContinents.set(key, new Set());
      keyContinents.get(key).add(cont);
    }
  }
  const zidx = geom.zidxFrom(entries);
  let count = 0, resolutions = [];
  for (const [cont, meta] of Object.entries(manifest.continents || {})) {
    for (const record of meta.discovered || []) {
      if (record.nameFrom !== 'marker') continue;
      count++;
      const anchor = detail[cont] && detail[cont].zones[record.anchor];
      assert(anchor, `${cont}/${record.key}: missing anchor detail ${record.anchor}`);
      const targets = [];
      for (const label of anchor.labels) {
        const full = label[4];
        for (const target of geom.transitionTargets(zidx, record.anchor, full)) {
          targets.push({ key: String(target), source: target });
        }
      }
      const matched = targets.filter(t => t.key === record.key &&
        keyContinents.get(t.key) && keyContinents.get(t.key).has(cont));
      resolutions = resolutions.concat(matched);
      assert(matched.length > 0,
        `${cont}/${record.anchor}: no zlink targets marker-derived ${record.key}`);
    }
  }
  assert(count >= 1, 'root-only discovery bridge checked zero marker-derived catalog entries');
  return { count, resolutions };
}

function copyAuthoredWithoutCache(target) {
  fs.cpSync(DATA, target, {
    recursive: true,
    filter(source) { return path.basename(source) !== '_generated'; },
  });
}

async function runBrewall(pack, selected, packDir, rootDir, template, colors) {
  const manifest = json(MANIFEST);
  if (!samePath(manifest.pack, pack)) {
    throw new Error(`Brewall reference cache was built from ${manifest.pack}, not remembered ${pack}; run python scripts/import_pack.py`);
  }
  const files = trackingReader(selected);
  const result = await convert({ authored: loadAuthored(DATA), files, colors, packDir, rootDir });
  const identity = sourceIdentity(files.reads);
  if (identity.count !== manifest.sourceCount || identity.fingerprint !== manifest.sourceFingerprint) {
    throw new Error(`Brewall pack bytes differ from the cache fingerprint; run python scripts/import_pack.py (read ${identity.count} files, fingerprint ${identity.fingerprint})`);
  }
  if (!fs.existsSync(userReference)) throw new Error('missing Brewall reference ' + userReference);
  compare('Brewall real pack', buildHTML(template, result.data, result.credit, VERSION), fs.readFileSync(userReference, 'utf8'));
  console.log(`PASS: Brewall real pack (${identity.count} source files compared, fingerprint current)`);
  return true;
}

async function runRootOnly(mapsRoot, template, colors) {
  fs.mkdirSync(FX, { recursive: true });
  fs.mkdirSync(OUT, { recursive: true });
  const scratch = fs.mkdtempSync(path.join(FX, 'rootonly-data-'));
  const reference = path.join(OUT, 'rootonly.html');
  const discoveryReference = path.join(OUT, 'rootonly-discover.html');
  const resolvedFx = path.resolve(FX) + path.sep;
  if (!path.resolve(scratch).startsWith(resolvedFx) || !path.basename(scratch).startsWith('rootonly-data-')) {
    throw new Error('refusing unsafe root-only scratch path ' + scratch);
  }
  try {
    copyAuthoredWithoutCache(scratch);
    let run = runPython(['scripts/import_pack.py', '--pack', mapsRoot, '--data', scratch]);
    if (run.status !== 0) throw new Error(`root-only import failed: ${run.stderr.toString('utf8')}`);
    // Plan 3 removes this parity-only --no-discover when the browser converter consumes catalogs.
    run = runPython(['scripts/build.py', '--data', scratch, '--out', reference, '--no-discover']);
    if (run.status !== 0) throw new Error(`root-only build failed: ${run.stderr.toString('utf8')}`);
    run = runPython(['scripts/build.py', '--data', scratch, '--out', discoveryReference]);
    if (run.status !== 0) throw new Error(`root-only discovery build failed: ${run.stderr.toString('utf8')}`);

    const bridge = assertMarkerBridge(
      discoveryReference, json(path.join(scratch, '_generated', 'manifest.json')));
    const INDEX_TAG = Symbol('instrumented MapGeom index');
    const TARGET_TAG = Symbol('instrumented MapGeom target');
    let indexCalls = 0, transitionCalls = 0, taggedIndex;
    const instrumented = {
      zidxFrom(entries) {
        indexCalls++;
        taggedIndex = MapGeom.zidxFrom(entries);
        taggedIndex[INDEX_TAG] = true;
        return taggedIndex;
      },
      transitionTargets(index, zoneKey, label) {
        transitionCalls++;
        assert.strictEqual(index, taggedIndex, 'marker bridge bypassed the injected MapGeom index');
        assert(index[INDEX_TAG], 'marker bridge used an untagged index');
        return MapGeom.transitionTargets(index, zoneKey, label).map(key => {
          const tagged = new String(key);
          tagged[TARGET_TAG] = true;
          return tagged;
        });
      },
    };
    const observed = assertMarkerBridge(
      discoveryReference, json(path.join(scratch, '_generated', 'manifest.json')), instrumented);
    assert(indexCalls >= 1, 'instrumented zidxFrom was not consumed');
    assert(transitionCalls >= 1, 'instrumented transitionTargets was not consumed');
    assert(observed.resolutions.length >= 1 && observed.resolutions.every(r => r.source[TARGET_TAG]),
      'a marker resolution did not come from the injected MapGeom transition result');
    console.log(`PASS: marker-derived catalog entries bridge to anchor zlinks (${bridge.count} checked; MapGeom ownership observed)`);

    const packDir = path.basename(mapsRoot), files = trackingReader(mapsRoot);
    const result = await convert({ authored: loadAuthored(scratch), files, colors, packDir, rootDir: null });
    const identity = sourceIdentity(files.reads);
    const skipped = Object.values(result.report.skipped).filter(zones => zones.length);
    const skippedCount = skipped.reduce((n, zones) => n + zones.length, 0);
    const surviving = Object.values(result.data.ALL).reduce((n, cont) => n + Object.keys(cont.zones).length, 0);
    assert.strictEqual(skipped.length, 5, 'root-only skipped continent count');
    assert.strictEqual(skippedCount, 32, 'root-only skipped zone count');
    assert.strictEqual(surviving, 88, 'root-only surviving zone count');
    assert.deepStrictEqual(result.data.ALL['Plane of Hate'].zones, {}, 'zero-zone continent retained');
    assert.strictEqual(result.credit, 'EQL · selected maps folder');
    compare('root-only real pack', buildHTML(template, result.data, result.credit, VERSION), fs.readFileSync(reference, 'utf8'));
    console.log(`PASS: maps/ root alone (${identity.count} source files compared; 32 skipped across 5 continents, 88 surviving, Plane of Hate retained empty)`);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

(async () => {
  if (!fs.existsSync(CONFIG)) {
    console.log('SKIP: Brewall real-pack case needs data/pack.local.json');
    console.log('SKIP: maps/ root real-pack case needs data/pack.local.json');
    return;
  }
  const configured = json(CONFIG).pack;
  if (!configured || !fs.existsSync(configured)) throw new Error('remembered pack path is missing: ' + configured);
  const pack = path.resolve(configured), parent = path.dirname(pack);
  const underMaps = path.basename(parent).toLowerCase() === 'maps';
  const packIsMaps = path.basename(pack).toLowerCase() === 'maps';
  const selected = underMaps ? parent : pack;
  const packDir = underMaps
    ? path.relative(path.dirname(parent), pack).split(path.sep).join('/')
    : path.basename(pack);
  const rootDir = underMaps ? path.basename(parent) : null;
  const mapsRoot = underMaps ? parent : (packIsMaps ? pack : null);

  const started = process.hrtime.bigint();
  const template = strippedTemplate();
  const colors = JSON.parse(mustPython(['scripts/pack_colors.py', '--json']).toString('utf8'));
  const brewallRan = await runBrewall(pack, selected, packDir, rootDir, template, colors);
  let rootRan = false;
  if (mapsRoot) {
    await runRootOnly(mapsRoot, template, colors);
    rootRan = true;
  } else {
    throw new Error(`maps/ root real-pack case needs a remembered pack under maps/ or the maps/ root itself; got ${pack}`);
  }
  const seconds = Number(process.hrtime.bigint() - started) / 1e9;
  const heap = process.memoryUsage();
  const heapFlag = process.execArgv.find(arg => arg.startsWith('--max-old-space-size')) || 'default Node heap (no --max-old-space-size)';
  console.log(`WALL: ${seconds.toFixed(2)}s; heapUsed ${(heap.heapUsed / 1048576).toFixed(1)} MiB; ${heapFlag}`);
  console.log(brewallRan && rootRan ? 'RESULT: PASS' : 'RESULT: PASS (one or more real-pack cases skipped)');
})().catch(err => {
  console.error(err.stack || err);
  process.exitCode = 1;
});
