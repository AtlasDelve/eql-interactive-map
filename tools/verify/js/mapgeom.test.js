#!/usr/bin/env node
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const MapGeom = require('../../../src/mapgeom.js');

const REPO = path.resolve(__dirname, '../../..');
const py = process.argv[2] || process.env.EQL_PYTHON || 'python';
const EXPECTED_CORPUS_SHA256 = 'a16e339ad8a5be45f3a37d0e9ad9c7bfe7005931a0124321c61cb41632717a60';
const DX = -22407.44944409043;
const DY = 14778.172561699554;
const SQRT_VALUE = 26841.910789897913;
const COST_VALUE = 107.36764315959165;
const families = [];
function pass(name, detail) {
  families.push(name);
  console.log(`PASS: ${name}${detail ? ` (${detail})` : ''}`);
}

const PYTHON_ADAPTER = String.raw`
import json, math, os, struct, sys
sys.path.insert(0, os.path.join(os.getcwd(), 'scripts'))
import mapgeom

def bits(v):
    return struct.pack('>d', float(v)).hex()

def rounded_bits(v):
    v = round(v * 10) / 10
    if v == 0: v = 0.0
    return bits(v)

def zone_pair(dx, dy):
    zones = {'a': {'cx': 0.0, 'cy': 0.0, 'segs': []},
             'b': {'cx': 0.0, 'cy': 0.0, 'segs': []}}
    exits = {('a', 'b'): (-dx, -dy), ('b', 'a'): (0.0, 0.0)}
    return zones, exits

p = json.load(sys.stdin)
numeric_norm = []
numeric_cost = []
for r in p['corpus']['numeric']:
    numeric_norm.append(bits(mapgeom.norm(r['dx'], r['dy'])))
    zones, exits = zone_pair(r['dx'], r['dy'])
    numeric_cost.append(bits(mapgeom.cost_between(zones, 'a', 'b', False, exits)))

affine = []
for r in p['corpus']['affine']:
    z = {'cx': r['ox'], 'cy': r['oy'], 'segs': [],
         'xf': {'s': r['scale'], 'rot': r['rot'],
                'tx': r['ox'] / 7, 'ty': r['oy'] / 7}}
    tp = mapgeom.tpoint(z, r['x'], r['y'])
    ti = mapgeom.tinv(z, r['x'], r['y'])
    rt = mapgeom.tinv(z, tp[0], tp[1])
    affine.append([[rounded_bits(x) for x in tp],
                   [rounded_bits(x) for x in ti],
                   [rounded_bits(x) for x in rt]])

entries = [tuple(x) for x in p['entries']]
idx = mapgeom.zidx_from(entries)
def resolved(v):
    x = mapgeom.resolve_zone(idx, v)
    return list(x) if x else None

zone = p['geometry']['zone']
detail = p['geometry']['detail']
bad_detail = p['geometry']['badDetail']
exits = mapgeom.exit_points_from('alpha', zone, detail, idx)
exit_list = [[a, b, list(point)] for (a, b), point in exits.items()]

cost_zones = p['geometry']['costZones']
cost_exits = {(a, b): tuple(point) for a, b, point in p['geometry']['costExits']}
costs = []
for mode in ('both', 'forward', 'reverse', 'none'):
    chosen = {}
    if mode in ('both', 'forward'): chosen[('a', 'b')] = cost_exits[('a', 'b')]
    if mode in ('both', 'reverse'): chosen[('b', 'a')] = cost_exits[('b', 'a')]
    costs.append(bits(mapgeom.cost_between(cost_zones, 'a', 'b', False, chosen)))

thin_zone = p['geometry']['thinZone']
thin_a = mapgeom.cost_points(thin_zone, False)
thin_b = mapgeom.cost_points(thin_zone, False)
late = mapgeom.nearest_outline_point(p['geometry']['lateZone'], 9999, 9999, False)

out = {
  'numericNorm': numeric_norm, 'numericCost': numeric_cost, 'affine': affine,
  'constants': {
    'COST_SAMPLE': mapgeom.COST_SAMPLE, 'UNITS_PER_COST': mapgeom.UNITS_PER_COST,
    'ZALIAS': mapgeom.ZALIAS, 'DISCOVERY_EXCLUDE': sorted(mapgeom.DISCOVERY_EXCLUDE),
    'DISCOVERED_ZONE_COLOR': mapgeom.DISCOVERED_ZONE_COLOR,
    'LINK_OVERRIDE': mapgeom.LINK_OVERRIDE,
  },
  'resolution': {
    'ordinary': resolved('North Desert of Ro'), 'alias': resolved('North Ro'),
    'directional': resolved('north felwithe'), 'neriak': resolved('Neriak Foreign Quarter'),
    'collision': resolved('Same'),
    'transitions': [mapgeom.transition_targets(idx, z, label) for z, label in p['transitions']],
  },
  'discovery': {
    'series': [mapgeom.discovery_series_stem(x) for x in p['discovery']['series']],
    'derived': [mapgeom.discovery_derived_parent(x, set(p['discovery']['roster'])) for x in p['discovery']['derived']],
    'display': [mapgeom.discovery_display_name(x) for x in p['discovery']['display']],
  },
  'geometry': {
    'offset': list(mapgeom.detail_offset(zone, detail)),
    'badOffset': mapgeom.detail_offset(zone, bad_detail), 'exits': exit_list,
    'costs': costs, 'thinLength': len(thin_a), 'memoized': thin_a is thin_b,
    'privateKeys': sorted(k for k in thin_zone if k.startswith('_')), 'late': list(late),
  },
}
json.dump(out, sys.stdout, separators=(',', ':'))
`;

function bits(value) {
  const buffer = Buffer.allocUnsafe(8);
  buffer.writeDoubleBE(value);
  return buffer.toString('hex');
}

function roundedBits(value) { return bits(MapGeom.round1(value)); }

function corpus() {
  let s = 20260823;
  const next = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  const numeric = [];
  for (let i = 0; i < 4096; i++) {
    numeric.push({ dx: (next() * 2 - 1) * 60000, dy: (next() * 2 - 1) * 60000 });
  }
  const affine = [];
  for (let i = 0; i < 2048; i++) {
    affine.push({
      x: (next() * 2 - 1) * 60000, y: (next() * 2 - 1) * 60000,
      scale: 0.25 + next() * 4, rot: next() * 360,
      ox: (next() * 2 - 1) * 20000, oy: (next() * 2 - 1) * 20000,
    });
  }
  return { numeric, affine };
}

const entries = [
  ['Antonica', 'nro', 'North Desert of Ro'], ['Antonica', 'sro', 'South Desert of Ro'],
  ['Antonica', 'commons', 'East Commonlands'], ['Antonica', 'kithicor', 'Kithicor Forest'],
  ['Antonica', 'befallen', 'Befallen'], ['Faydwer', 'butcher', 'Butcherblock Mountains'],
  ['Faydwer', 'felwithea', 'Felwithe (North)'], ['Neriak', 'neriakforeign', 'Neriak (Foreign Quarter)'],
  ['Test', 'first', 'Same'], ['Test', 'second', 'Same'], ['Test', 'alpha', 'Alpha'],
  ['Test', 'beta', 'Beta'], ['Test', 'wrongcommon', 'The Commonlands'],
];
const transitions = [
  ['alpha', 'to_Beta'], ['alpha', 'to_North_Ro'],
  ['alpha', 'to_North_Ro&South_Ro'], ['kithicor', 'to_The_Commonlands'],
  ['alpha', 'not_a_transition'],
];
const geometry = {
  zone: { cx: 0, cy: 0, segs: [[10, 20, 20, 20], [30, 40, 40, 40]] },
  detail: {
    segs: [[5, 13, 15, 13], [25, 33, 35, 33]],
    labels: [[1, 2, 0, 2, 'to_Beta'], [3, 4, 0, 2, 'to_Beta']],
  },
  badDetail: { segs: [[5, 13, 15, 13], [2, 3, 4, 5]], labels: [] },
  costZones: {
    a: { cx: 0, cy: 0, segs: [[0, 10, 10, 10], [10, 10, 10, 0]] },
    b: { cx: 1000, cy: 1000, segs: [[990, 990, 1000, 990], [990, 1000, 1000, 1000]] },
  },
  costExits: [['a', 'b', [10, 10]], ['b', 'a', [990, 990]]],
  thinZone: { cx: 0, cy: 0, segs: Array.from({ length: 201 }, (_, i) => [i, i, i + 0.5, i + 0.5]) },
  lateZone: { cx: 0, cy: 0, segs: Array.from({ length: 300 }, (_, i) => [i, i, i + 0.25, i + 0.25]) },
};
geometry.lateZone.segs[299][2] = 9999;
geometry.lateZone.segs[299][3] = 9999;
const discovery = {
  series: ['sraa', 'sraj', 'sraz', 'ab1'],
  roster: ['chardok', 'kael', 'kithicor', 'lavastorm'],
  derived: ['chardokb', 'kaeltwo', 'oldkithicor', 'lavastorm_original', 'unrelated'],
  display: ['to_Kappa_Expedition_(click)', 'FROM_New_Sebilis_(exit)'],
};

const generated = corpus();
const payload = { corpus: generated, entries, transitions, geometry, discovery };
const corpusHash = crypto.createHash('sha256').update(JSON.stringify(generated)).digest('hex');
assert.strictEqual(corpusHash, EXPECTED_CORPUS_SHA256, 'fixed corpus SHA-256 drifted');
const discriminating = generated.numeric.filter(r =>
  Math.hypot(r.dx, r.dy) !== Math.sqrt(r.dx * r.dx + r.dy * r.dy)).length;
assert(discriminating > 0, 'fixed corpus has no Math.hypot-discriminating record');

const run = spawnSync(py, ['-c', PYTHON_ADAPTER], {
  cwd: REPO, input: JSON.stringify(payload), encoding: 'utf8', shell: false,
  maxBuffer: 64 * 1024 * 1024,
});
if (run.status !== 0) throw new Error(`Python adapter exited ${run.status}: ${run.stderr || run.stdout}`);
const python = JSON.parse(run.stdout);

const productionZones = {
  a: { cx: 0, cy: 0, segs: [] }, b: { cx: 0, cy: 0, segs: [] },
};
const productionExits = new Map([
  ['a\0b', [22407.44944409043, -14778.172561699554]], ['b\0a', [0, 0]],
]);
assert.strictEqual(MapGeom.norm(DX, DY), SQRT_VALUE, 'pinned explicit-sqrt value');
assert.strictEqual(bits(MapGeom.norm(DX, DY)), bits(SQRT_VALUE), 'pinned norm bits');
assert.strictEqual(MapGeom.costBetween(productionZones, 'a', 'b', false, productionExits), COST_VALUE,
  'production cost fixture');
const jsNorm = generated.numeric.map(r => bits(MapGeom.norm(r.dx, r.dy)));
const jsCost = generated.numeric.map(r => {
  const zones = { a: { cx: 0, cy: 0, segs: [] }, b: { cx: 0, cy: 0, segs: [] } };
  const exits = new Map([['a\0b', [-r.dx, -r.dy]], ['b\0a', [0, 0]]]);
  return bits(MapGeom.costBetween(zones, 'a', 'b', false, exits));
});
assert.deepStrictEqual(jsNorm, python.numericNorm, 'raw norm bit corpus');
assert.deepStrictEqual(jsCost, python.numericCost, 'raw untransformed cost bit corpus');
pass('numeric', `${generated.numeric.length + 1} norms, ${generated.numeric.length + 1} costs; corpus ${corpusHash}; ${discriminating} hypot-discriminating`);

const affine = generated.affine.map(r => {
  const z = { cx: r.ox, cy: r.oy, segs: [], xf: {
    s: r.scale, rot: r.rot, tx: r.ox / 7, ty: r.oy / 7,
  } };
  const tp = MapGeom.tpoint(z, r.x, r.y);
  const ti = MapGeom.tinv(z, r.x, r.y);
  const rt = MapGeom.tinv(z, tp[0], tp[1]);
  return [tp.map(roundedBits), ti.map(roundedBits), rt.map(roundedBits)];
});
assert.deepStrictEqual(affine, python.affine, 'rounded affine corpus');
for (const xf of [undefined, { s: null }, { tx: 4, ty: -7 }, { rot: 0.75 }, { s: 2, rot: -0.5 }]) {
  const z = { cx: -2, cy: 3, segs: [], ...(xf === undefined ? {} : { xf }) };
  const point = MapGeom.tpoint(z, -11, 17);
  assert.deepStrictEqual(MapGeom.tinv(z, point[0], point[1]).map(MapGeom.round1), [-11, 17]);
}
pass('transforms', `${generated.affine.length} affine records plus missing/null/full round trips`);

const wantExports = ['COST_SAMPLE', 'UNITS_PER_COST', 'ZALIAS', 'DISCOVERY_EXCLUDE',
  'DISCOVERED_ZONE_COLOR', 'LINK_OVERRIDE', 'roundHalfEven', 'round1', 'norm', 'tpoint', 'tinv',
  'znorm', 'zidxFrom', 'resolveZone', 'transitionTargets', 'discoverySeriesStem',
  'discoveryDerivedParent', 'discoveryDisplayName', 'detailOffset', 'exitPointsFrom',
  'nearestOutlinePoint', 'costPoints', 'costBetween'].sort();
assert.deepStrictEqual(Object.keys(MapGeom).sort(), wantExports, 'exact public export set');
assert.deepStrictEqual(MapGeom.ZALIAS, python.constants.ZALIAS);
assert.deepStrictEqual(MapGeom.LINK_OVERRIDE, python.constants.LINK_OVERRIDE);
assert.deepStrictEqual([...MapGeom.DISCOVERY_EXCLUDE].sort(), python.constants.DISCOVERY_EXCLUDE);
assert.strictEqual(MapGeom.DISCOVERY_EXCLUDE.size, 42);
assert.strictEqual(MapGeom.DISCOVERED_ZONE_COLOR, '#8f78d4');
const idx = MapGeom.zidxFrom(entries);
const asPair = value => value ? [value.cont, value.key] : null;
const resolution = {
  ordinary: asPair(MapGeom.resolveZone(idx, 'North Desert of Ro')),
  alias: asPair(MapGeom.resolveZone(idx, 'North Ro')),
  directional: asPair(MapGeom.resolveZone(idx, 'north felwithe')),
  neriak: asPair(MapGeom.resolveZone(idx, 'Neriak Foreign Quarter')),
  collision: asPair(MapGeom.resolveZone(idx, 'Same')),
  transitions: transitions.map(([z, label]) => MapGeom.transitionTargets(idx, z, label)),
};
assert.deepStrictEqual(resolution, python.resolution);
assert.deepStrictEqual(resolution.collision, ['Test', 'first'], 'first-wins name index');
assert.deepStrictEqual(resolution.transitions[2], ['nro', 'sro'], 'ampersand split');
assert.deepStrictEqual(resolution.transitions[3], ['commons'], 'override before ordinary resolution');
pass('resolution', 'tables, first-wins, directional/Neriak aliases, ordinary/alias/ampersand/override transitions');

const discoveryActual = {
  series: discovery.series.map(MapGeom.discoverySeriesStem),
  derived: discovery.derived.map(x => MapGeom.discoveryDerivedParent(x, discovery.roster)),
  display: discovery.display.map(MapGeom.discoveryDisplayName),
};
assert.deepStrictEqual(discoveryActual, python.discovery);
assert.deepStrictEqual(discoveryActual.series, ['sra', 'sra', null, null]);
assert.deepStrictEqual(discoveryActual.derived, ['chardok', 'kael', 'kithicor', 'lavastorm', null]);
assert.strictEqual(discoveryActual.display[0], 'Kappa Expedition');
pass('discovery classifiers', 'closed derived grammar, [a-j0-9] series grammar, presentation-preserving names');

const offset = MapGeom.detailOffset(geometry.zone, geometry.detail);
const exits = MapGeom.exitPointsFrom('alpha', geometry.zone, geometry.detail, idx);
const exitList = [...exits].map(([key, point]) => [...key.split('\0'), point]);
const costExits = new Map(geometry.costExits.map(([a, b, point]) => [`${a}\0${b}`, point]));
function chosen(mode) {
  const out = new Map();
  if (mode === 'both' || mode === 'forward') out.set('a\0b', costExits.get('a\0b'));
  if (mode === 'both' || mode === 'reverse') out.set('b\0a', costExits.get('b\0a'));
  return out;
}
const costs = ['both', 'forward', 'reverse', 'none'].map(mode =>
  bits(MapGeom.costBetween(structuredClone(geometry.costZones), 'a', 'b', false, chosen(mode))));
const thin = structuredClone(geometry.thinZone);
const firstPoints = MapGeom.costPoints(thin, false), secondPoints = MapGeom.costPoints(thin, false);
const late = MapGeom.nearestOutlinePoint(geometry.lateZone, 9999, 9999, false);
assert.deepStrictEqual(offset, python.geometry.offset);
assert.strictEqual(MapGeom.detailOffset(geometry.zone, geometry.badDetail), null);
assert.deepStrictEqual(exitList, python.geometry.exits);
assert.strictEqual(exits.size, 1, 'duplicate exit labels preserve first');
assert.deepStrictEqual(exits.get('alpha\0beta'), [6, 9], 'first duplicate exit point');
assert.deepStrictEqual(costs, python.geometry.costs, 'all doorway/fallback cost branches');
assert.strictEqual(firstPoints.length, 200, '200-point thinning');
assert.strictEqual(firstPoints, secondPoints, 'memoized array identity');
assert.deepStrictEqual(Object.keys(thin).filter(k => k.startsWith('_')).sort(), ['_cpts']);
assert(!JSON.stringify({ cx: thin.cx, cy: thin.cy, segs: thin.segs }).includes('_cpts'));
assert.deepStrictEqual(late, [9999, 9999], 'nearest outline scans every endpoint');
assert.deepStrictEqual({ offset, badOffset: null, exits: exitList, costs, thinLength: firstPoints.length,
  memoized: firstPoints === secondPoints, privateKeys: ['_cpts'], late }, python.geometry);
pass('detail/exit geometry', 'confirmed offset, rejection, duplicate first-wins, exhaustive nearest scan');
pass('cost paths', 'four doorway/fallback branches, 200-point thinning, _cpts memoization');

const ties = [-3.5, -2.5, -1.5, -0.5, 0.5, 1.5, 2.5, 3.5];
assert.deepStrictEqual(ties.map(MapGeom.roundHalfEven), [-4, -2, -2, 0, 0, 2, 2, 4]);
assert.strictEqual(Object.is(MapGeom.round1(-0), -0), false);
const source = fs.readFileSync(path.join(REPO, 'src', 'mapgeom.js'), 'utf8');
assert(/^'use strict';/.test(source), 'strict directive must be first');
assert(!/\b(window|document|File|FileList|fetch|Blob|localStorage|navigator|process|globalThis)\b|require\(|^import |^export /m.test(source),
  'mapgeom.js must remain dependency-, filesystem-, and DOM-free');
const runner = fs.readFileSync(path.join(REPO, 'tools', 'verify', 'run.py'), 'utf8');
const parityCall = runner.indexOf('step("mapgeom Python/JavaScript parity"');
const dependencyBlock = runner.indexOf('if have_node:', runner.indexOf('# Dependency-free twin gates'));
const quickGate = runner.indexOf('if args.quick:', dependencyBlock);
const npmGate = runner.indexOf('if not (have_node and have_mods):');
assert(parityCall > dependencyBlock && parityCall < quickGate,
  'mapgeom parity registration must run under Node and outside the --quick guard');
assert(parityCall < npmGate, 'mapgeom parity registration must precede the node_modules gate');
assert(runner.includes('results.append(("mapgeom Python/JavaScript parity", "SKIP"))'),
  'no-Node branch must append the exact named SKIP result');
const bridgeSource = fs.readFileSync(path.join(REPO, 'tools', 'verify', 'js',
  'pack-convert-full.test.js'), 'utf8');
assert(bridgeSource.includes("const MapGeom = require('../../../src/mapgeom.js')"),
  'real-pack bridge must import MapGeom');
assert(bridgeSource.includes('geom = MapGeom') && bridgeSource.includes('geom.zidxFrom(entries)') &&
  bridgeSource.includes('geom.transitionTargets(zidx, record.anchor, full)'),
  'real-pack bridge must expose and consume the injected MapGeom seam');
assert(!/function\s+znorm\b/.test(bridgeSource), 'real-pack bridge must not restore local znorm');
assert.deepStrictEqual(families, ['numeric', 'transforms', 'resolution', 'discovery classifiers',
  'detail/exit geometry', 'cost paths'], 'all named PASS families must execute in order');

console.log('RESULT: PASS');
