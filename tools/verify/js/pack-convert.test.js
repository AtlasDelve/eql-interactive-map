#!/usr/bin/env node
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  convert, buildHTML, parsePythonFloat, readText, splitLines, pyStrip,
} = require('../../../src/pack_convert.js');

const REPO = path.resolve(__dirname, '../../..');
const FX = path.join(REPO, 'tools', 'verify', 'packfx');
const VERSION = fs.readFileSync(path.join(REPO, 'VERSION'), 'ascii').trim();
const PINS = json(path.join(REPO, 'docs', 'internal', 'session-2026-08-23', 'plan3-pins.json'));
const py = process.argv[2] || process.env.EQL_PYTHON || 'python';

function runPython(args, options = {}) {
  const run = spawnSync(py, args, {
    cwd: REPO,
    encoding: 'buffer',
    shell: false,
    ...options,
  });
  return run;
}

function mustPython(args, options) {
  const run = runPython(args, options);
  if (run.status !== 0) throw new Error(`Python exited ${run.status}: ${run.stderr.toString('utf8')}`);
  return run.stdout;
}

function json(pathname) { return JSON.parse(fs.readFileSync(pathname, 'utf8')); }
function contDir(name) { return name.replace(/ /g, '_').replace(/'/g, ''); }

function loadAuthored(dataRoot) {
  const world = json(path.join(dataRoot, 'world.json'));
  const continents = {};
  for (const cont of world.order) {
    const dir = path.join(dataRoot, 'continents', contDir(cont));
    continents[cont] = {
      meta: json(path.join(dir, 'continent.json')),
      layout: json(path.join(dir, 'layout.json')),
    };
  }
  const travelPath = path.join(dataRoot, 'travel.json');
  return { world, travel: fs.existsSync(travelPath) ? json(travelPath) : {}, continents };
}

function reader(selected) {
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
      const bytes = fs.readFileSync(disk.get(key));
      reads.set(key, Buffer.from(bytes));
      return new Uint8Array(bytes);
    },
    reads,
  };
}

function sourceIdentity(reads) {
  const sources = [...reads].map(([key, bytes]) => [
    path.posix.basename(key), crypto.createHash('sha256').update(bytes).digest('hex'),
  ]).sort((a, b) => a[0] < b[0] ? -1 : (a[0] > b[0] ? 1 : (a[1] < b[1] ? -1 : (a[1] > b[1] ? 1 : 0))));
  const hash = crypto.createHash('sha256');
  for (const [name, sha] of sources) hash.update(`${name} ${sha}\n`, 'utf8');
  return { count: sources.length, fingerprint: hash.digest('hex') };
}

function assertNoDerivedTies(label, files, authored, packDir, rootDir) {
  const roster = [];
  for (const cont of authored.world.order) {
    const meta = authored.continents[cont].meta;
    for (const key of meta.zoneOrder) if (!roster.includes(key)) roster.push(key);
    for (const key of meta.detailZones || []) if (!roster.includes(key)) roster.push(key);
  }
  const rosterSet = new Set(roster.map(key => key.toLowerCase())), candidates = new Set();
  for (const dir of [packDir, rootDir]) {
    if (!dir) continue;
    const prefix = dir.toLowerCase().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '') + '/';
    for (const raw of files.keys()) {
      const key = String(raw).replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').toLowerCase();
      if (!key.startsWith(prefix)) continue;
      let name = key.slice(prefix.length);
      if (name.includes('/') || !name.endsWith('.txt')) continue;
      name = name.slice(0, -4).replace(/_(?:1|2|3)$/, '');
      if (!rosterSet.has(name)) candidates.add(name);
    }
  }
  for (const key of candidates) {
    const matches = roster.filter(parent => {
      const folded = parent.toLowerCase(), tail = key.startsWith(folded) ? key.slice(folded.length) : null;
      return (tail != null && /^(b|c|two|twoa|twob)$/.test(tail)) ||
        key === `old${folded}` || key === `${folded}_original`;
    });
    assert(matches.length <= 1, `${label}: derived-parent tie for ${key}: ${matches.join(', ')}`);
  }
  console.log(`PASS: ${label} derived-parent tie precondition (${candidates.size} candidate keys, none tied)`);
}

function strippedTemplate() {
  const code = "import sys;sys.path.insert(0,'scripts');import build;sys.stdout.buffer.write(build.strip_regions(open('src/template.html',encoding='utf-8').read(),'user').encode('utf-8'))";
  return mustPython(['-c', code]).toString('utf8');
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
    else if (ch === closer && --depth === 0) return JSON.parse(text.slice(i, j + 1).replace(/<\\\//g, '</'));
  }
  throw new Error(`unterminated ${prefix}`);
}

const proseShadowControl = '// prose const ALL= mention\nconst ALL={"real":true};';
assert.notStrictEqual(
  proseShadowControl[proseShadowControl.indexOf('const ALL=') + 'const ALL='.length],
  '{',
  'prose-shadow control puts prose first',
);
assert.deepStrictEqual(
  extract(proseShadowControl, 'const ALL=', '{'),
  { real: true },
  'extract skips a prose declaration mention',
);
console.log('PASS: extractor skips a prose declaration mention');

const converterSource = fs.readFileSync(path.join(REPO, 'src', 'pack_convert.js'), 'utf8');
const convertArgs = converterSource.match(/async function convert\(\{([^}]+)\}\)/);
assert(convertArgs, 'convert argument boundary is directly inspectable');
assert.deepStrictEqual(convertArgs[1].split(',').map(value => value.trim()),
  ['authored', 'files', 'colors', 'packDir', 'rootDir'], 'convert argument boundary stays closed');
for (const token of ['createHash', 'crypto.subtle']) {
  assert(!converterSource.includes(token), `production converter contains forbidden crypto token ${token}`);
}

function blobs(text) {
  return {
    ALL: extract(text, 'const ALL=', '{'),
    DETAIL: extract(text, ', DETAIL=', '{'),
    HUBS: extract(text, 'const HUBS=', '{'),
  };
}

function normalized(text) { return text.replace(/\r\n/g, '\n'); }

function assertSame(label, actual, expected) {
  actual = normalized(actual); expected = normalized(expected);
  if (actual !== expected) {
    let at = 0;
    while (at < actual.length && at < expected.length && actual[at] === expected[at]) at++;
    throw new Error(`${label}: output differs at character ${at}: actual ${JSON.stringify(actual.slice(at, at + 100))}, expected ${JSON.stringify(expected.slice(at, at + 100))}`);
  }
}

function assertNoPrivateKeys(data) {
  const privateKeys = [];
  function scan(value, at) {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (key.startsWith('_')) privateKeys.push(`${at}.${key}`);
      scan(child, `${at}.${key}`);
    }
  }
  scan(data.ALL, 'ALL'); scan(data.DETAIL, 'DETAIL'); scan(data.TRAVEL, 'TRAVEL');
  assert.deepStrictEqual(privateKeys, [], 'private discovery state leaked into injected data');
}

function copyFixtureData(root) {
  const data = path.join(root, 'data');
  fs.cpSync(path.join(FX, 'data'), data, { recursive: true });
  return data;
}

function pythonPipeline(pack, data, ref) {
  const imp = runPython(['scripts/import_pack.py', '--pack', pack, '--data', data]);
  if (imp.status !== 0) throw new Error(`import failed: ${imp.stderr.toString('utf8')}`);
  return runPython(['scripts/build.py', '--data', data, '--out', ref]);
}

function assertNoRootLayer(pack) {
  const code = "import sys;sys.path.insert(0,'scripts');import import_pack;assert import_pack.root_layer(sys.argv[1]) is None";
  const run = runPython(['-c', code, pack]);
  if (run.status !== 0) throw new Error(`temporary pack unexpectedly acquired a root layer: ${run.stderr.toString('utf8')}`);
}

async function compareCase(label, pack, selected, packDir, rootDir, data, ref, template, colors, inspect) {
  const build = pythonPipeline(pack, data, ref);
  if (build.status !== 0) throw new Error(`${label}: build failed: ${build.stderr.toString('utf8')}`);
  const reference = fs.readFileSync(ref, 'utf8');
  const files = reader(selected);
  const result = await convert({ authored: loadAuthored(data), files, colors, packDir, rootDir });
  const actual = buildHTML(template, result.data, result.credit, VERSION);
  assertNoPrivateKeys(result.data);
  assertSame(label, actual, reference);
  if (inspect) inspect(blobs(reference), result, json(path.join(data, '_generated', 'manifest.json')), files);
  console.log(`PASS: ${label}`);
}

// Python float grammar: reject what Number() accepts, accept what Number() alone rejects.
for (const value of ['', '   ', '0x10', '0b11', '1.5x']) assert.throws(() => parsePythonFloat(value));
for (const [value, expected] of [
  ['1_0', 10], ['.5', 0.5], ['1.', 1], ['1.e2', 100], ['+.5', 0.5],
  ['1_0.0_1e1_0', 100100000000], ['inf', Infinity], ['+inf', Infinity],
  ['-Infinity', -Infinity],
]) assert.strictEqual(parsePythonFloat(value), expected, value);
assert(Number.isNaN(parsePythonFloat('nan')) && Number.isNaN(parsePythonFloat('NAN')));
assert.deepStrictEqual(splitLines('a\r\nb\x85c\u2028d\n\n'), ['a', 'b', 'c', 'd', '']);
assert.strictEqual(pyStrip('\x1c\x85 value \x1f'), 'value');
assert.strictEqual(readText(Uint8Array.from([0x43, 0x61, 0x66, 0xe9, 0x20, 0x92])), 'Café \x92');
assert.strictEqual(readText(Uint8Array.from([0xef, 0xbb, 0xbf, 0xef, 0xbb, 0xbf, 0x41])), '\uFEFFA');

const injectPlaceholders = [
  '__ALL__', '__META__', '__DETAIL__', '__HUBS__', '__UNIVERSE__',
  '__WORLDLINKS__', '__TRAVEL__', '__XPACS__', '__CRED__', '__VERSION__',
];
const injectTokens = injectPlaceholders.join(' ');
const injectData = {
  ALL: { probe: "__CRED__ $& $` $' $1 </script>" },
  META: { m: injectTokens },
  DETAIL: {}, HUBS: {}, UNIVERSE: [], WORLDLINKS: [], TRAVEL: {}, XPACS: {},
};
const injectCredit = `${injectTokens} O'Reilly & <builder> "quoted"`;
const injectVersion = VERSION;
const injectTemplate = injectPlaceholders.join('|');
for (const missing of injectPlaceholders) {
  assert.throws(
    () => buildHTML(injectTemplate.replace(missing, ''), injectData, injectCredit, injectVersion),
    new RegExp(`template missing placeholder ${missing}`),
    missing,
  );
}
const injectCode = "import json,sys;sys.path.insert(0,'scripts');import build;p=json.load(sys.stdin);keys=('ALL','META','DETAIL','HUBS','UNIVERSE','WORLDLINKS','TRAVEL','XPACS');sys.stdout.buffer.write(build.inject(p['template'],*(p[k] for k in keys),credit=p['credit'],version=p['version']).encode('utf-8'))";
const injectPayload = { template: injectTemplate, ...injectData, credit: injectCredit, version: injectVersion };
const pythonInjected = mustPython(['-c', injectCode], {
  input: Buffer.from(JSON.stringify(injectPayload), 'utf8'),
}).toString('utf8');
const jsInjected = buildHTML(injectTemplate, injectData, injectCredit, injectVersion);
assert.strictEqual(jsInjected, pythonInjected);
for (const token of injectPlaceholders) {
  assert(jsInjected.split(token).length - 1 >= 2, `${token} did not survive both embeddings`);
}
assert(jsInjected.includes('__CRED__') && jsInjected.includes('$&') && jsInjected.includes('$`')
  && jsInjected.includes("$'") && jsInjected.includes('$1'));

const template = strippedTemplate();
const colors = JSON.parse(mustPython(['scripts/pack_colors.py', '--json']).toString('utf8'));
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'eql-pack-convert-'));

(async () => {
  try {
    // 1: flat pack.
    {
      const root = path.join(scratch, 'flat'); fs.mkdirSync(root);
      const data = copyFixtureData(root), pack = path.join(FX, 'pack'), ref = path.join(root, 'ref.html');
      await compareCase('flat pack fixture', pack, pack, 'pack', null, data, ref, template, colors, (d, result) => {
        assert.strictEqual(d.HUBS.Testland[0].label, 'Test </script> hub');
        assert.strictEqual(d.ALL.Testland.links.length, 2);
        assert.deepStrictEqual(d.ALL.Testland.zones.gamma.xf, { tx: 3, ty: -2, s: 1, rot: 0 });
        assert.strictEqual(result.report.skipped.Testland.length, 0);
      });
    }

    // 2: maps/<Pack> layered cascade and mixed-provenance credit.
    {
      const root = path.join(scratch, 'layered'); fs.mkdirSync(root);
      const data = copyFixtureData(root);
      const selected = path.join(FX, 'layered', 'maps'), pack = path.join(selected, 'Layered');
      await compareCase('layered pack fixture', pack, selected, 'maps/Layered', 'maps', data, path.join(root, 'ref.html'), template, colors, (d, result, manifest, files) => {
        assert.deepStrictEqual(Object.keys(result).sort(), ['credit', 'data', 'report']);
        assert.deepStrictEqual(Object.keys(result.report).sort(), [
          'baseless', 'collisions', 'discovered', 'discoveredSources', 'discoveryRejected',
          'rootZones', 'skipped', 'unknownRecords', 'unseenColors', 'warnings',
        ]);
        assert.deepStrictEqual(result.report.rootZones.Testland, ['gamma']);
        assert.strictEqual(result.credit, PINS.cred_on);
        assert.deepStrictEqual(result.report.discovered.Testland, PINS.discovered);
        assert.deepStrictEqual(result.report.discoveredSources.Testland,
          PINS.discoveredSources_names.map(name => ({ name, from: 'root' })));
        const discoveredNames = new Set(PINS.discoveredSources_names);
        const acceptedReads = new Map([...files.reads].filter(([key]) => discoveredNames.has(path.posix.basename(key))));
        const identity = sourceIdentity(acceptedReads);
        assert.deepStrictEqual(identity, {
          count: PINS.discoveredSourceCount,
          fingerprint: PINS.discoveredSourceFingerprint,
        });
        assert.strictEqual(manifest.continents.Testland.discoveredSourceCount, identity.count);
        assert.strictEqual(manifest.continents.Testland.discoveredSourceFingerprint, identity.fingerprint);
        assert.deepStrictEqual(Object.keys(d.ALL.Testland.zones), PINS.build_on.ALL_zone_keys);
        assert.deepStrictEqual(Object.keys(d.DETAIL.Testland.zones), PINS.build_on.DETAIL_zone_keys);
        assert.deepStrictEqual(d.DETAIL.Testland.palette, PINS.build_on.DETAIL_palette);
        assert.deepStrictEqual(result.data.TRAVEL, {});
        assert.deepStrictEqual(result.data.ALL.Testland.placed, ['alpha', 'beta', 'gamma']);
        assert.deepStrictEqual(result.data.ALL.Testland.unplaced, []);
        assert.deepStrictEqual(result.data.ALL.Testland.links, PINS.build_on.ALL_links);
        assert(!Object.prototype.hasOwnProperty.call(result.data.ALL.Testland, 'skipped'));
        assert.deepStrictEqual(result.report.discoveryRejected, [
          { key: 'alphab', reason: 'derived', detail: 'alpha' },
          { key: 'betab', reason: 'derived', detail: 'beta' },
          { key: 'delta', reason: 'unresolved', detail: 'no resolved outward transition' },
          { key: 'eta', reason: 'baseless', detail: 'pack' },
          { key: 'sraa', reason: 'series', detail: 'sra' },
          { key: 'srab', reason: 'series', detail: 'sra' },
          { key: 'srac', reason: 'series', detail: 'sra' },
          { key: 'zeta', reason: 'baseless', detail: 'root' },
        ]);
      });
      assertNoDerivedTies('layered fixture', reader(selected), loadAuthored(data),
        'maps/Layered', 'maps');
    }

    // 3: one skipped zone, one filtered link, one surviving link.
    {
      const root = path.join(scratch, 'skip-one'); fs.mkdirSync(root);
      const data = copyFixtureData(root), pack = path.join(root, 'selected-pack');
      fs.cpSync(path.join(FX, 'pack'), pack, { recursive: true });
      for (const name of fs.readdirSync(pack)) if (/^gamma(?:_[123])?\.txt$/i.test(name)) fs.rmSync(path.join(pack, name));
      assertNoRootLayer(pack);
      await compareCase('one skipped zone', pack, pack, path.basename(pack), null, data, path.join(root, 'ref.html'), template, colors, (d, result, manifest) => {
        assert.deepStrictEqual(d.ALL.Testland.skipped, ['gamma']);
        assert(d.ALL.Testland.links.some(link => link.z1 === 'alpha' && link.z2 === 'beta'));
        assert(!d.ALL.Testland.links.some(link => link.z1 === 'gamma' || link.z2 === 'gamma'));
        assert.deepStrictEqual(result.report.skipped.Testland, manifest.continents.Testland.skippedZones);
      });
    }

    // 4: no rostered source file, but the zero-zone continent remains in ALL.
    {
      const root = path.join(scratch, 'skip-all'); fs.mkdirSync(root);
      const data = copyFixtureData(root), pack = path.join(root, 'empty-pack'); fs.mkdirSync(pack);
      fs.writeFileSync(path.join(pack, 'readme_2.txt'), 'fixture only\n');
      assertNoRootLayer(pack);
      await compareCase('all zones skipped', pack, pack, path.basename(pack), null, data, path.join(root, 'ref.html'), template, colors, (d, result, manifest) => {
        assert.deepStrictEqual(d.ALL.Testland.zones, {});
        assert.deepStrictEqual(d.ALL.Testland.skipped, ['alpha', 'beta', 'gamma']);
        assert(!Object.prototype.hasOwnProperty.call(d.DETAIL, 'Testland'));
        assert(!Object.prototype.hasOwnProperty.call(d.HUBS, 'Testland'));
        assert.deepStrictEqual(result.report.skipped.Testland, manifest.continents.Testland.skippedZones);
      });
    }

    // 5: Python cache load and the no-cache twin reject the same tiny nonzero Z.
    {
      const root = path.join(scratch, 'number-domain'); fs.mkdirSync(root);
      const data = copyFixtureData(root), pack = path.join(root, 'number-pack');
      fs.cpSync(path.join(FX, 'pack'), pack, { recursive: true });
      assertNoRootLayer(pack);
      const alpha = path.join(pack, 'alpha.txt');
      const text = fs.readFileSync(alpha, 'utf8');
      const changed = text.replace('L 0.5, -1.5, 10.0,', 'L 0.5, -1.5, 0.00001,');
      assert.notStrictEqual(changed, text, 'tiny-Z mutation anchor');
      fs.writeFileSync(alpha, changed);
      const imported = runPython(['scripts/import_pack.py', '--pack', pack, '--data', data]);
      assert.strictEqual(imported.status, 0, imported.stderr.toString('utf8'));
      const built = runPython(['scripts/build.py', '--data', data, '--out', path.join(root, 'ref.html')]);
      assert.notStrictEqual(built.status, 0, 'Python build must reject sub-1e-4 cache number');
      assert.match(built.stderr.toString('utf8') + built.stdout.toString('utf8'), /below 1e-4/);
      await assert.rejects(
        convert({ authored: loadAuthored(data), files: reader(pack), colors, packDir: path.basename(pack), rootDir: null }),
        /0\.00001.*below 1e-4/,
      );
      console.log('PASS: number-domain guard rejects sub-1e-4 Z in Python and JavaScript');
    }

    console.log('RESULT: PASS');
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
})().catch(err => {
  console.error(err.stack || err);
  process.exitCode = 1;
});
