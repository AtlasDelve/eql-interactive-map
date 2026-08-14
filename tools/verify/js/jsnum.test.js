#!/usr/bin/env node
// The eight injected blobs must survive JS parse/stringify byte for byte. This
// file names them explicitly: adding a ninth injected structure must extend it.
'use strict';

const fs = require('fs');

const specs = [
  ['ALL', 'const ALL=', '{'],
  ['META', ', META=', '{'],
  ['DETAIL', ', DETAIL=', '{'],
  ['HUBS', 'const HUBS=', '{'],
  ['UNIVERSE', 'const UNIVERSE=', '['],
  ['WORLDLINKS', 'const WORLDLINKS=', '['],
  ['TRAVEL', 'const TRAVEL=', '{'],
  ['XPACS', 'const XPACS=', '{'],
];

function normalizedInjectedText(blob) {
  // inject() protects the script element with a legal JSON slash escape that
  // JSON.stringify deliberately does not reproduce. It is orthogonal to numbers.
  return blob.split('<\\/').join('</');
}

function checkBlob(label, blob) {
  const expected = normalizedInjectedText(blob);
  const roundTrip = JSON.stringify(JSON.parse(blob));
  if (roundTrip !== expected) {
    let at = 0;
    while (at < expected.length && expected[at] === roundTrip[at]) at++;
    throw new Error(`${label} JS round-trip differs at byte ${at}`);
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
  let depth = 0, inString = false, escaped = false, j = i;
  for (; j < text.length; j++) {
    const ch = text[j];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === opener) depth++;
    else if (ch === closer && --depth === 0) return text.slice(i, j + 1);
  }
  throw new Error(`unterminated ${prefix}`);
}

const proseShadowControl = '// prose const ALL= mention\nconst ALL={"real":true};';
if (proseShadowControl[proseShadowControl.indexOf('const ALL=') + 'const ALL='.length] === '{') {
  throw new Error('prose-shadow control does not put prose first');
}
if (extract(proseShadowControl, 'const ALL=', '{') !== '{"real":true}') {
  throw new Error('extract did not skip the prose declaration mention');
}
console.log('PASS: extractor skips a prose declaration mention');

const paths = process.argv.slice(2);
if (!paths.length) throw new Error('usage: node jsnum.test.js ARTIFACT.html [...]');
for (const path of paths) {
  const text = fs.readFileSync(path, 'utf8');
  for (const [name, prefix, opener] of specs) {
    const blob = extract(text, prefix, opener);
    checkBlob(`${path}: ${name}`, blob);
  }
  console.log(`PASS: ${path} - 8 injected blobs round-trip through JSON.stringify`);
}

// Current production data has no script-close string, so exercise the normalization
// independently or the original false-failure can return while every real artifact stays green.
const escapedControl = '{"x":"<\\/script>"}';
if (normalizedInjectedText(escapedControl) === escapedControl) {
  throw new Error('escaped-string control did not exercise slash normalization');
}
checkBlob('escaped-string control', escapedControl);
console.log('PASS: escaped-string control round-trips after injection-escape normalization');
