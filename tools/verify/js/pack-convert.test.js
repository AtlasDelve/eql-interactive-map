#!/usr/bin/env node
'use strict';

const assert = require('assert');
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
  const parent = path.dirname(selected), keys = [], disk = new Map();
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
    async read(key) { return new Uint8Array(fs.readFileSync(disk.get(key))); },
  };
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

function copyFixtureData(root) {
  const data = path.join(root, 'data');
  fs.cpSync(path.join(FX, 'data'), data, { recursive: true });
  return data;
}

function pythonPipeline(pack, data, ref) {
  const imp = runPython(['scripts/import_pack.py', '--pack', pack, '--data', data]);
  if (imp.status !== 0) throw new Error(`import failed: ${imp.stderr.toString('utf8')}`);
  // Plan 3 removes this parity-only --no-discover when the browser converter consumes catalogs.
  return runPython(['scripts/build.py', '--data', data, '--out', ref, '--no-discover']);
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
  const result = await convert({ authored: loadAuthored(data), files: reader(selected), colors, packDir, rootDir });
  const actual = buildHTML(template, result.data, result.credit, VERSION);
  if (inspect) inspect(blobs(reference), result, json(path.join(data, '_generated', 'manifest.json')));
  assertSame(label, actual, reference);
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
      await compareCase('layered pack fixture', pack, selected, 'maps/Layered', 'maps', data, path.join(root, 'ref.html'), template, colors, (_d, result) => {
        assert.deepStrictEqual(result.report.rootZones.Testland, ['gamma']);
        assert.strictEqual(result.credit, 'EQL · Layered map data · 1 zone from the game\'s own maps');
      });
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
