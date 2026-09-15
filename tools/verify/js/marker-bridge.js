'use strict';

const fs = require('fs');
const assert = require('assert');

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

function assertMarkerBridge(artifact, manifest, geom, requireMarkers) {
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
  if (requireMarkers) assert(count >= 1, 'instrumented fixture bridge checked zero marker-derived catalog entries');
  const crossContinent = [...keyContinents].filter(([, continents]) => continents.size > 1)
    .map(([key, continents]) => ({ key, continents: [...continents].sort() }));
  return { count, resolutions, keyCount: keyContinents.size, crossContinent };
}

module.exports = { extract, assertMarkerBridge };
