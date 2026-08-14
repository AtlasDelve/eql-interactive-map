#!/usr/bin/env node
'use strict';

const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');
const { lift } = require('../../../src/pack_convert.js');

const REPO = path.resolve(__dirname, '../../..');
const py = process.argv[2] || process.env.EQL_PYTHON || 'python';

function python(args, input) {
  const run = spawnSync(py, args, {
    cwd: REPO,
    encoding: 'buffer',
    input: input == null ? undefined : Buffer.from(input, 'utf8'),
    shell: false,
  });
  if (run.status !== 0) {
    throw new Error(`Python exited ${run.status}: ${run.stderr.toString('utf8')}`);
  }
  return run.stdout.toString('utf8');
}

const colors = JSON.parse(python(['scripts/pack_colors.py', '--json']));
assert.strictEqual(Object.keys(colors).length, 83, 'canonical PACK_COLORS key count');

const triples = Object.keys(colors).map(key => key.split(',').map(Number));
triples.push(
  [0, 0, 0], [255, 255, 255],
  [204, 0, 0], [205, 0, 0], [206, 0, 0],
  [0, 204, 0], [0, 205, 0], [0, 206, 0],
  [205, 97, 50], [205, 98, 50],
  [50, 97, 205], [50, 98, 205],
);

// Fixed-seed LCG: enough broad coverage to pin scaling, luma wash, clamping, and rounding.
let state = 0x5eed1234;
function randomByte() {
  state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
  return state >>> 24;
}
for (let i = 0; i < 5000; i++) triples.push([randomByte(), randomByte(), randomByte()]);

const code = [
  'import json,sys',
  "sys.path.insert(0,'scripts')",
  'import pack_colors',
  'print(json.dumps([pack_colors.lift(x) for x in json.load(sys.stdin)]))',
].join(';');
const expected = JSON.parse(python(['-c', code], JSON.stringify(triples)));
const actual = triples.map(lift);
assert.deepStrictEqual(actual, expected);

console.log(`PASS: lift() agrees with Python over ${triples.length} triples (83 table keys, boundaries, fixed-seed sweep)`);