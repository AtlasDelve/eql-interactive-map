'use strict';

// DOM-free twin of scripts/import_pack.py plus scripts/build.py's composition/injection.
// I/O is supplied by the caller so the same converter runs under Node and in builder.html.

const GEOM = (typeof require === 'function') ? require('./mapgeom.js') : MapGeom;

const LAYER_SUFFIXES = ['', '_1', '_2', '_3'];
const PY_WS = '[\\t\\n\\v\\f\\r \\x1c-\\x1f\\x85\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]';
const PY_STRIP = new RegExp('^' + PY_WS + '+|' + PY_WS + '+$', 'g');
const FLOAT_RE = /^[+-]?(?:(?:inf(?:inity)?|nan)|(?:(?:[0-9](?:_?[0-9])*)(?:\.(?:[0-9](?:_?[0-9])*)?)?|\.(?:[0-9](?:_?[0-9])*))(?:[eE][+-]?(?:[0-9](?:_?[0-9])*))?)$/i;
const PLACEHOLDERS = ['__WORLDLINKS__', '__UNIVERSE__', '__DETAIL__', '__TRAVEL__', '__VERSION__', '__XPACS__', '__META__', '__HUBS__', '__CRED__', '__ALL__'];
// Keep these measured thresholds aligned with scripts/pack_colors.py; see docs/reference/pack-import.md.
const LIFT_MAX = 205.0;
const LIFT_LUMA = 124.3;

function roundHalfEven(x) {
  // Coordinates use Python round(): half-to-even, not JavaScript Math.round.
  const f = Math.floor(x), d = x - f;
  if (d > 0.5) return f + 1;
  if (d < 0.5) return f;
  return (f % 2 === 0) ? f : f + 1;
}

function lift(rgb) {
  // Pack colour fallback deliberately uses the other rule: floor(x + 0.5).
  let [r, g, b] = rgb.map(Number);
  const mx = Math.max(r, g, b);
  if (mx <= 0) return '#afafaf';
  if (mx < LIFT_MAX) {
    const k = LIFT_MAX / mx;
    r *= k; g *= k; b *= k;
  }
  const luma = 0.299 * r + 0.587 * g + 0.114 * b;
  if (luma < LIFT_LUMA) {
    const t = (LIFT_LUMA - luma) / (255.0 - luma);
    r += (255.0 - r) * t;
    g += (255.0 - g) * t;
    b += (255.0 - b) * t;
  }
  const channel = v => Math.max(0, Math.min(255, Math.floor(v + 0.5)));
  return '#' + [r, g, b].map(v => channel(v).toString(16).padStart(2, '0')).join('');
}

function pyStrip(s) {
  return s.replace(PY_STRIP, '');
}

function splitLines(s) {
  if (s === '') return [];
  const parts = s.split(/\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/);
  if (parts[parts.length - 1] === '') parts.pop();
  return parts;
}

function parsePythonFloat(value) {
  const s = pyStrip(String(value));
  if (!FLOAT_RE.test(s)) throw new Error('could not convert string to float: ' + JSON.stringify(value));
  // Deliberate safe-direction non-parity: Python accepts Unicode decimal digits; pack files
  // use ASCII, and rejecting an exotic spelling is preferable to silently changing a map.
  const clean = s.replace(/_/g, '');
  if (/^[+-]?inf(?:inity)?$/i.test(clean)) return clean[0] === '-' ? -Infinity : Infinity;
  if (/^[+-]?nan$/i.test(clean)) return NaN;
  return Number(clean);
}

function parsePythonIntFloat(value) {
  const n = parsePythonFloat(value);
  if (!Number.isFinite(n)) throw new Error('cannot convert non-finite float to integer');
  return Math.trunc(n);
}

function latin1(bytes) {
  const chunks = [];
  for (let i = 0; i < bytes.length; i += 0x8000) {
    chunks.push(String.fromCharCode(...bytes.subarray(i, Math.min(i + 0x8000, bytes.length))));
  }
  return chunks.join('');
}

function readText(bytes) {
  try {
    // TextDecoder consumes one UTF-8 BOM, matching Python's decode-plus-one-strip path.
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (_) {
    // TextDecoder('latin1') means Windows-1252; Python requires true ISO-8859-1 here.
    return latin1(bytes);
  }
}

function pathJoin(...parts) {
  return parts.filter(Boolean).join('/').replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/^\/+|\/+$/g, '');
}

function basename(path) {
  const bits = String(path).replace(/\\/g, '/').replace(/\/+$/, '').split('/');
  return bits[bits.length - 1] || '';
}

function rgbKey(rgb) { return rgb.join(','); }

function validateNumber(value, path) {
  if (!Number.isFinite(value)) throw new Error(path + ': non-canonical JSON number ' + String(value));
  if (value !== 0 && Math.abs(value) < 1e-4) {
    throw new Error(path + ': non-canonical JSON float ' + String(value) + ' is below 1e-4');
  }
  if (Math.abs(value) > Number.MAX_SAFE_INTEGER) {
    throw new Error(path + ': non-canonical JSON number ' + String(value) + ' is outside JS safe range');
  }
}

function validateNumbers(value, path) {
  if (typeof value === 'number') {
    validateNumber(value, path);
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => validateNumbers(v, path + '[' + i + ']'));
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) validateNumbers(v, path + '.' + k);
  }
}

function makeFileIndex(files) {
  const byLower = new Map(), collisions = [];
  for (const raw of files.keys()) {
    const key = String(raw).replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    const folded = key.toLowerCase();
    if (byLower.has(folded) && byLower.get(folded) !== key) collisions.push([byLower.get(folded), key]);
    else byLower.set(folded, key);
  }
  return {
    has(key) { return byLower.has(pathJoin(key).toLowerCase()); },
    actual(key) { return byLower.get(pathJoin(key).toLowerCase()); },
    keys() { return byLower.values(); },
    collisions,
  };
}

function zoneFileKeys(index, dir, zoneKey) {
  const out = [];
  for (const suffix of LAYER_SUFFIXES) {
    const key = pathJoin(dir, zoneKey + suffix + '.txt');
    if (index.has(key)) out.push(key);
  }
  return out;
}

function resolveZoneSource(index, packDir, rootDir, zoneKey) {
  for (const suffixes of [[''], LAYER_SUFFIXES]) {
    for (const [dir, tag] of [[packDir, 'pack'], [rootDir, 'root']]) {
      if (dir && suffixes.some(s => index.has(pathJoin(dir, zoneKey + s + '.txt')))) return [dir, tag];
    }
  }
  return [null, null];
}

async function parseZone(files, index, srcDir, zoneKey) {
  const records = [], unknown = {};
  for (let layer = 0; layer < LAYER_SUFFIXES.length; layer++) {
    const name = zoneKey + LAYER_SUFFIXES[layer] + '.txt';
    const key = pathJoin(srcDir, name);
    if (!index.has(key)) continue;
    const bytes = await files.read(index.actual(key));
    const text = readText(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
    let lineno = 0;
    for (let line of splitLines(text)) {
      lineno++;
      line = pyStrip(line);
      if (!line) continue;
      const kind = line[0];
      if (kind !== 'L' && kind !== 'P') {
        unknown[kind] = (unknown[kind] || 0) + 1;
        continue;
      }
      let fields;
      if (kind === 'L') {
        fields = line.slice(1).split(',').map(pyStrip);
      } else {
        const raw = line.slice(1).split(',');
        fields = raw.length <= 8
          ? raw.map(pyStrip)
          : raw.slice(0, 7).map(pyStrip).concat([pyStrip(raw.slice(7).join(','))]);
      }
      const need = kind === 'L' ? 9 : 8;
      if (fields.length !== need) throw new Error(`${name}:${lineno}: malformed ${kind} line (${fields.length} fields, need ${need}): ${line}`);
      try {
        let rec;
        if (kind === 'L') {
          rec = [fields.slice(0, 6).map(parsePythonFloat), fields.slice(6, 9).map(parsePythonIntFloat)];
        } else {
          rec = [fields.slice(0, 3).map(parsePythonFloat), fields.slice(3, 6).map(parsePythonIntFloat), parsePythonIntFloat(fields[6]), fields[7]];
        }
        records.push([layer, kind, rec, name, lineno]);
      } catch (err) {
        throw new Error(`${name}:${lineno}: malformed ${kind} line (${err.message}): ${line}`);
      }
    }
  }
  return [records, unknown];
}

function detailRecords(records, sourcePath) {
  const segs = [], segz = [], seglayer = [], labels = [], lablayer = [], rawX = [], rawY = [];
  for (const [layer, kind, rec] of records) {
    if (kind === 'L') {
      const [n, rgb] = rec;
      segs.push([roundHalfEven(n[0]), roundHalfEven(-n[1]), roundHalfEven(n[3]), roundHalfEven(-n[4]), rgb]);
      const z = [n[2], n[5]];
      z.forEach((v, i) => validateNumber(v, `${sourcePath}.segz[${segz.length}][${i}]`));
      segz.push(z); seglayer.push(layer);
      rawX.push(n[0], n[3]); rawY.push(-n[1], -n[4]);
    } else {
      const [n, rgb, size, text] = rec;
      labels.push([roundHalfEven(n[0]), roundHalfEven(-n[1]), rgb, size, text]);
      lablayer.push(layer); rawX.push(n[0]); rawY.push(-n[1]);
    }
  }
  return { segs, segz, seglayer, labels, lablayer, rawX, rawY };
}

function geometryRecords(records, off, sourcePath) {
  const ox = Number(off[0]), oy = Number(off[1]), segs = [], segz = [];
  for (const [layer, kind, rec] of records) {
    if (layer !== 0 || kind !== 'L') continue;
    const n = rec[0];
    segs.push([roundHalfEven(n[0] + ox), roundHalfEven(-n[1] + oy), roundHalfEven(n[3] + ox), roundHalfEven(-n[4] + oy)]);
    const z = [n[2], n[5]];
    z.forEach((v, i) => validateNumber(v, `${sourcePath}.segz[${segz.length}][${i}]`));
    segz.push(z);
  }
  return { segs, segz };
}

function pyMin(values) { let out = values[0]; for (let i = 1; i < values.length; i++) if (values[i] < out) out = values[i]; return out; }
function pyMax(values) { let out = values[0]; for (let i = 1; i < values.length; i++) if (values[i] > out) out = values[i]; return out; }
function bboxOf(xs, ys) { return xs.length ? [pyMin(xs), pyMin(ys), pyMax(xs), pyMax(ys)] : [0, 0, 0, 0]; }

function isIdentity(xf) {
  return !xf || ((xf.tx ?? 0) === 0 && (xf.ty ?? 0) === 0 && (xf.s ?? 1) === 1 && (xf.rot ?? 0) === 0);
}

function composeZone(az, geometry, xf) {
  const out = { name: az.name, segs: geometry.segs, cx: az.cx, cy: az.cy, color: az.color };
  if (xf != null) out.xf = xf;
  return out;
}

function composeDetail(az, detail, palette) {
  const labels = detail.labels.slice(), traced = new Set(detail.labels.map(l => l[4]));
  for (const lab of az.labels || []) {
    const [x, y, color, size, text] = lab;
    if (traced.has(text)) continue;
    const index = palette.indexOf(color);
    if (index < 0) throw new Error(`authored label ${JSON.stringify(text)} on zone ${JSON.stringify(az.name)} wants colour ${color}, which this pack's palette does not contain`);
    labels.push([x, y, index, size, text]);
  }
  return { name: az.name, segs: detail.segs, labels, bbox: detail.bbox };
}

function colorFor(rgb, colors, unseen) {
  const key = rgbKey(rgb), hit = colors[key];
  if (hit != null) return hit;
  unseen.push(key);
  return lift(rgb);
}

function looksLikeRootMaps(index, packDir) {
  const reasons = [];
  if (basename(packDir).toLowerCase() === 'maps') reasons.push("directory is named 'maps'");
  const prefix = pathJoin(packDir).toLowerCase() + '/';
  let grids = 0;
  for (const key of index.keys()) {
    const lower = key.toLowerCase();
    if (lower.startsWith(prefix) && !lower.slice(prefix.length).includes('/') && lower.endsWith('_2.txt')) grids++;
  }
  if (grids < 50) reasons.push(`only ${grids} *_2.txt grid layers (a pack has hundreds)`);
  return reasons;
}

function discoveryIndexEntries(index, authored, packDir, rootDir) {
  const entries = [];
  for (const cont of authored.world.order) {
    const meta = authored.continents[cont].meta;
    const roster = meta.zoneOrder.slice();
    for (const zk of meta.detailZones || []) if (!roster.includes(zk)) roster.push(zk);
    const resolved = new Set();
    for (const zk of roster) {
      const [srcDir] = resolveZoneSource(index, packDir, rootDir, zk);
      if (srcDir) resolved.add(zk);
    }
    for (const zk of meta.detailZones || []) {
      if (resolved.has(zk)) entries.push([cont, zk, meta.zones[zk].name]);
    }
  }
  return entries;
}

function discoveryBaseKeys(index, packDir, rootDir) {
  const keys = new Set();
  const suffixes = LAYER_SUFFIXES.filter(Boolean).map(s => s.toLowerCase());
  for (const srcDir of [packDir, rootDir]) {
    if (!srcDir) continue;
    const prefix = pathJoin(srcDir).toLowerCase() + '/';
    for (const actual of index.keys()) {
      const folded = actual.toLowerCase();
      if (!folded.startsWith(prefix)) continue;
      const name = folded.slice(prefix.length);
      if (name.includes('/') || !name.endsWith('.txt')) continue;
      let stem = name.slice(0, -4);
      for (const suffix of suffixes) {
        if (stem.endsWith(suffix)) { stem = stem.slice(0, -suffix.length); break; }
      }
      keys.add(stem);
    }
  }
  return [...keys].sort();
}

async function detectDiscoveries(files, index, packDir, rootDir, roster, zoneIndex) {
  const rosterSet = new Set([...roster].map(key => key.toLowerCase()));
  const keyContinent = new Map();
  for (const { cont, key } of Object.values(zoneIndex)) keyContinent.set(key, cont);
  const candidates = [], rejected = [];
  const reject = (key, reason, detail) => rejected.push({ key, reason, detail });

  for (const key of discoveryBaseKeys(index, packDir, rootDir)) {
    if (rosterSet.has(key)) continue;
    const [srcDir, source] = resolveZoneSource(index, packDir, rootDir, key);
    if (!srcDir) continue;
    if (!index.has(pathJoin(srcDir, key + '.txt'))) {
      reject(key, 'baseless', source);
      continue;
    }
    const [records] = await parseZone(files, index, srcDir, key);
    const targets = new Set();
    for (const [layer, kind, record] of records) {
      if (layer === 1 && kind === 'P') {
        for (const target of GEOM.transitionTargets(zoneIndex, key, record[3])) {
          if (keyContinent.has(target)) targets.add(target);
        }
      }
    }
    const sortedTargets = [...targets].sort();
    const continents = [...new Set(sortedTargets.map(target => keyContinent.get(target)))].sort();
    if (!sortedTargets.length) {
      reject(key, 'unresolved', 'no resolved outward transition');
      continue;
    }
    if (continents.length !== 1) {
      reject(key, 'ambiguous', continents.join(', '));
      continue;
    }
    candidates.push({ key, from: source, continent: continents[0], targets: sortedTargets });
  }

  const groups = new Map();
  for (const candidate of candidates) {
    const stem = GEOM.discoverySeriesStem(candidate.key);
    if (!stem) continue;
    if (!groups.has(stem)) groups.set(stem, []);
    groups.get(stem).push(candidate);
  }
  const seriesKeys = new Set();
  for (const [stem, members] of groups) {
    if (members.length >= 3 && members.every(member => member.targets.length === 1) &&
        new Set(members.map(member => member.targets[0])).size === 1) {
      for (const member of members) {
        seriesKeys.add(member.key);
        reject(member.key, 'series', stem);
      }
    }
  }

  const accepted = Object.create(null);
  for (const candidate of candidates) {
    if (seriesKeys.has(candidate.key)) continue;
    const parent = GEOM.discoveryDerivedParent(candidate.key, rosterSet);
    if (parent != null) {
      reject(candidate.key, 'derived', parent);
      continue;
    }
    if (GEOM.DISCOVERY_EXCLUDE.has(candidate.key)) {
      reject(candidate.key, 'excluded', 'DISCOVERY_EXCLUDE');
      continue;
    }
    if (!accepted[candidate.continent]) accepted[candidate.continent] = [];
    accepted[candidate.continent].push(candidate);
  }
  for (const records of Object.values(accepted)) records.sort((a, b) => a.key.localeCompare(b.key));
  rejected.sort((a, b) => a.key.localeCompare(b.key));
  return { accepted, rejected };
}

function candidateDoorway(records, zoneIndex, key, target) {
  for (const [layer, kind, record] of records) {
    if (layer !== 1 || kind !== 'P') continue;
    const [nums, , , label] = record;
    if (GEOM.transitionTargets(zoneIndex, key, label).includes(target)) {
      return [roundHalfEven(nums[0]), roundHalfEven(-nums[1])];
    }
  }
  throw new Error(`discovery target ${key} -> ${target} lost its source marker`);
}

function reciprocalMarker(records, zoneIndex, anchor) {
  const unresolved = [];
  for (const [layer, kind, record] of records) {
    if (layer !== 1 || kind !== 'P') continue;
    const [nums, , , label] = record;
    if (!/^(to|from)_/i.test(label)) continue;
    if (!GEOM.transitionTargets(zoneIndex, anchor, label).length) {
      unresolved.push([roundHalfEven(nums[0]), roundHalfEven(-nums[1]), label]);
    }
  }
  return unresolved.length === 1 ? unresolved[0] : null;
}

function writtenCentroid(segs, key) {
  if (!segs.length) throw new Error(`discovered zone ${JSON.stringify(key)} has no base-layer line geometry`);
  let sx = 0, sy = 0;
  for (const seg of segs) {
    sx += seg[0] + seg[2];
    sy += seg[1] + seg[3];
  }
  const count = segs.length * 2;
  return [roundHalfEven(sx / count), roundHalfEven(sy / count)];
}

async function assembleDiscoveries({ files, index, cont, candidates, packDir, rootDir,
  parsed, meta, zoneIndex, palette, colors, unseen, authoredDetails }) {
  const catalog = [], sources = [], discoveredPalette = [];
  const paletteIndex = new Map(palette.map((color, i) => [color, i]));
  const azones = meta.zones || {}, targetsByKey = new Map(), candidateDetails = new Map();

  // Cost calculations own their records: costBetween memoizes on zone objects.
  const costZones = Object.create(null);
  for (const key of meta.zoneOrder) {
    if (!parsed.has(key)) continue;
    const geometry = geometryRecords(parsed.get(key).records, azones[key].off, `${cont}/${key}`);
    costZones[key] = composeZone(azones[key], geometry, null);
  }

  for (const partial of [...candidates].sort((a, b) => a.key.localeCompare(b.key))) {
    const key = partial.key, targets = [...partial.targets].sort(), anchor = targets[0];
    targetsByKey.set(key, targets);
    const [srcDir, source] = resolveZoneSource(index, packDir, rootDir, key);
    if (!srcDir || source !== partial.from) {
      throw new Error(`discovered source changed during conversion for ${key}`);
    }
    const [records] = await parseZone(files, index, srcDir, key);
    const doorway = candidateDoorway(records, zoneIndex, key, anchor);
    const reciprocal = reciprocalMarker(parsed.get(anchor).records, zoneIndex, anchor);
    let off, name, nameFrom;
    if (reciprocal) {
      off = [azones[anchor].off[0] + reciprocal[0] - doorway[0],
        azones[anchor].off[1] + reciprocal[1] - doorway[1]];
      name = GEOM.discoveryDisplayName(reciprocal[2]);
      if (GEOM.znorm(name) !== GEOM.znorm(reciprocal[2])) {
        throw new Error(`discovered display name changed marker identity for ${key}`);
      }
      if (GEOM.resolveZone(zoneIndex, name) != null) {
        throw new Error(`discovered marker name collides with authored content: ${name}`);
      }
      nameFrom = 'marker';
    } else {
      const anchorZone = costZones[anchor];
      const point = GEOM.nearestOutlinePoint(anchorZone, anchorZone.cx, anchorZone.cy, false);
      off = [point[0] - doorway[0], point[1] - doorway[1]];
      name = key;
      nameFrom = 'key';
    }

    const geometry = geometryRecords(records, off, `${cont}/${key}`);
    const [cx, cy] = writtenCentroid(geometry.segs, key);
    const zone = composeZone({ name, color: GEOM.DISCOVERED_ZONE_COLOR, cx, cy }, geometry, null);
    costZones[key] = zone;

    const detail = detailRecords(records, `${cont}/${key}`);
    for (const [item, slot] of [
      ...detail.segs.map(item => [item, 4]),
      ...detail.labels.map(item => [item, 2]),
    ]) {
      const color = colorFor(item[slot], colors, unseen);
      if (!paletteIndex.has(color)) {
        paletteIndex.set(color, palette.length + discoveredPalette.length);
        discoveredPalette.push(color);
      }
      item[slot] = paletteIndex.get(color);
    }
    detail.bbox = bboxOf(detail.rawX, detail.rawY);
    candidateDetails.set(key, detail);
    for (const fileKey of zoneFileKeys(index, srcDir, key)) {
      sources.push({ name: basename(fileKey), from: source });
    }
    catalog.push({ key, name, nameFrom, color: GEOM.DISCOVERED_ZONE_COLOR, cx, cy,
      off, anchor, from: source });
  }

  const byName = new Map();
  for (const record of catalog) {
    const normalized = GEOM.znorm(record.name);
    if (!byName.has(normalized)) byName.set(normalized, []);
    byName.get(normalized).push(record);
  }
  for (const collision of [...byName.values()].filter(records => records.length > 1)) {
    const keyNorms = collision.map(record => GEOM.znorm(record.key));
    if (new Set(keyNorms).size !== keyNorms.length) {
      throw new Error(`discovered zone keys still collide after name fallback: ${collision.map(record => record.key).join(', ')}`);
    }
    for (const record of collision) {
      record.name = record.key;
      record.nameFrom = 'key';
    }
  }

  const edgeIndex = Object.assign(Object.create(null), zoneIndex);
  const discoveredIndex = GEOM.zidxFrom(catalog.map(record => [cont, record.key, record.name]));
  for (const [normalized, target] of Object.entries(discoveredIndex)) {
    if (!Object.prototype.hasOwnProperty.call(edgeIndex, normalized)) edgeIndex[normalized] = target;
  }
  const extendedPalette = palette.concat(discoveredPalette);
  const outputZones = Object.create(null), outputDetails = Object.create(null);
  for (const record of catalog) {
    const key = record.key;
    const candidateDetail = composeDetail(record, candidateDetails.get(key), extendedPalette);
    const candidateExits = GEOM.exitPointsFrom(key, costZones[key], candidateDetail, edgeIndex);
    const edges = [];
    for (const neighbour of targetsByKey.get(key)) {
      const neighbourExits = GEOM.exitPointsFrom(
        neighbour, costZones[neighbour], authoredDetails[neighbour], edgeIndex);
      const exits = new Map(candidateExits);
      for (const [pair, point] of neighbourExits) exits.set(pair, point);
      const candidateNamed = exits.has(`${key}\0${neighbour}`);
      const neighbourNamed = exits.has(`${neighbour}\0${key}`);
      let named;
      if (candidateNamed && neighbourNamed) named = 'both';
      else if (candidateNamed) named = 'candidate';
      else if (neighbourNamed) named = 'neighbour';
      else throw new Error(`accepted discovery edge lost both doorway markers: ${key}/${neighbour}`);
      const rawCost = GEOM.costBetween(costZones, key, neighbour, false, exits);
      edges.push({ z: neighbour, cost: GEOM.round1(Math.max(rawCost, 0.1)), named });
    }
    record.edges = edges;
    outputZones[key] = composeZone(record, { segs: costZones[key].segs }, null);
    outputDetails[key] = candidateDetail;
  }
  return { catalog, sources, discoveredPalette, outputZones, outputDetails };
}

function htmlEscape(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
}

function creditText(packDir, rootCount) {
  const name = basename(packDir);
  let text = name.toLowerCase() === 'maps' ? 'EQL · selected maps folder' : `EQL · ${name} map data`;
  if (rootCount) text += ` · ${rootCount} zone${rootCount === 1 ? '' : 's'} from the game's own maps`;
  return text;
}

function jsonForScript(value) {
  return JSON.stringify(value).replace(/<\//g, '<\\/');
}

function buildHTML(template, data, credit, version) {
  const replacements = {
    __ALL__: jsonForScript(data.ALL), __META__: jsonForScript(data.META),
    __DETAIL__: jsonForScript(data.DETAIL), __HUBS__: jsonForScript(data.HUBS),
    __UNIVERSE__: jsonForScript(data.UNIVERSE), __WORLDLINKS__: jsonForScript(data.WORLDLINKS),
    __TRAVEL__: jsonForScript(data.TRAVEL), __XPACS__: jsonForScript(data.XPACS),
    __CRED__: htmlEscape(credit), __VERSION__: version,
  };
  for (const ph of PLACEHOLDERS) if (!template.includes(ph)) throw new Error('template missing placeholder ' + ph);
  const pattern = new RegExp(PLACEHOLDERS.map(ph => ph.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).sort((a, b) => b.length - a.length).join('|'), 'g');
  return template.replace(pattern, match => replacements[match]);
}

async function convert({ authored, files, colors, packDir, rootDir }) {
  if (!authored || !authored.world || !authored.continents) throw new Error('authored world and continents are required');
  if (!files || typeof files.keys !== 'function' || typeof files.read !== 'function') throw new Error('files reader is required');
  if (!colors || typeof colors !== 'object') throw new Error('colors table is required');
  packDir = pathJoin(packDir);
  rootDir = rootDir == null ? null : pathJoin(rootDir);
  if (!packDir) throw new Error('packDir is required');

  const index = makeFileIndex(files);
  const world = authored.world, order = world.order;
  const ALL = {}, META = world.meta, DETAIL = {}, HUBS = {};
  const UNIVERSE = world.universe || [], WORLDLINKS = world.worldLinks || [];
  let TRAVEL = authored.travel || {};
  const XPACS = world.xpacs || {};
  const skippedReport = {}, rootReport = {}, baseless = [], unseen = [], warnings = looksLikeRootMaps(index, packDir);
  const collisions = index.collisions.map(pair => `file key collision: ${pair[0]} | ${pair[1]}`);
  const unknownRecords = {}, discoveredReport = {}, discoveredSourcesReport = {};
  let rootCount = 0;

  const discoveryRoster = new Set();
  for (const cont of order) {
    const meta = authored.continents[cont].meta;
    for (const zk of meta.zoneOrder) discoveryRoster.add(zk);
    for (const zk of meta.detailZones || []) discoveryRoster.add(zk);
  }
  const discoveryIndex = GEOM.zidxFrom(discoveryIndexEntries(index, authored, packDir, rootDir));
  const discoveries = await detectDiscoveries(
    files, index, packDir, rootDir, discoveryRoster, discoveryIndex);

  for (const cont of order) {
    const entry = authored.continents[cont];
    if (!entry) throw new Error('missing authored continent ' + cont);
    const meta = entry.meta, layout = entry.layout;
    const roster = meta.zoneOrder.slice();
    for (const zk of meta.detailZones || []) if (!roster.includes(zk)) roster.push(zk);
    const parsed = new Map(), skipped = [], rootZones = [], contBaseless = [];

    for (const zk of roster) {
      const [srcDir, source] = resolveZoneSource(index, packDir, rootDir, zk);
      if (!srcDir) { skipped.push(zk); continue; }
      const [records, unknown] = await parseZone(files, index, srcDir, zk);
      if (!records.length) {
        const names = zoneFileKeys(index, srcDir, zk).map(basename).join(', ');
        throw new Error(`no usable map records for zone ${JSON.stringify(zk)} (continent ${cont}): the ${source} layer has ${names} but not one L or P line. Looked in ${srcDir}`);
      }
      parsed.set(zk, { records, srcDir, source });
      if (source === 'root') { rootZones.push(zk); rootCount++; }
      if (!index.has(pathJoin(srcDir, zk + '.txt'))) { contBaseless.push(zk); baseless.push(`${cont}/${zk}`); }
      for (const [kind, count] of Object.entries(unknown)) unknownRecords[kind] = (unknownRecords[kind] || 0) + count;
    }
    skippedReport[cont] = skipped;
    rootReport[cont] = rootZones;

    const paletteIndex = new Map(), paletteRgb = [], detailCache = new Map();
    for (const zk of meta.detailZones || []) {
      if (!parsed.has(zk)) continue;
      const records = parsed.get(zk).records;
      const d = detailRecords(records, `${cont}/${zk}`);
      detailCache.set(zk, d);
      // Preserve first-seen order across interleaved L and P records.
      for (const record of records) {
        const rgb = record[2][1], key = rgbKey(rgb);
        if (!paletteIndex.has(key)) { paletteIndex.set(key, paletteRgb.length); paletteRgb.push(rgb); }
      }
    }
    const palette = paletteRgb.map(rgb => colorFor(rgb, colors, unseen));
    for (const zk of meta.detailZones || []) {
      if (!parsed.has(zk)) continue;
      const traced = new Set(detailCache.get(zk).labels.map(l => l[4]));
      for (const lab of ((meta.zones || {})[zk]?.labels || [])) {
        if (!traced.has(lab[4]) && !palette.includes(lab[2])) palette.push(lab[2]);
      }
    }

    const zones = {}, skippedSet = new Set(skipped), azones = meta.zones || {}, xfs = layout.zoneXf || {};
    for (const zk of meta.zoneOrder) {
      if (skippedSet.has(zk)) continue;
      const az = azones[zk];
      if (!az || az.off == null) throw new Error(`${cont}/${zk}: no authored off in continent metadata`);
      const geom = geometryRecords(parsed.get(zk).records, az.off, `${cont}/${zk}`);
      const xf = xfs[zk];
      zones[zk] = composeZone(az, geom, isIdentity(xf) ? null : xf);
    }
    const allEntry = { zones };
    const skippedOrdered = meta.zoneOrder.filter(zk => skippedSet.has(zk));
    if (skippedOrdered.length) allEntry.skipped = skippedOrdered;
    if (Object.prototype.hasOwnProperty.call(meta, 'labels') && meta.labels != null) allEntry.labels = meta.labels;
    allEntry.bbox = meta.bbox;
    allEntry.connectors = layout.connectors || [];
    const links = (layout.links || []).filter(link => !skippedSet.has(link.z1) && !skippedSet.has(link.z2));
    if (links.length) allEntry.links = links;
    allEntry.placed = meta.placed || [];
    allEntry.unplaced = meta.unplaced || [];
    ALL[cont] = allEntry;

    const dz = {};
    for (const zk of meta.detailZones || []) {
      if (skippedSet.has(zk)) continue;
      const d = detailCache.get(zk);
      for (const seg of d.segs) seg[4] = paletteIndex.get(rgbKey(seg[4]));
      for (const lab of d.labels) lab[2] = paletteIndex.get(rgbKey(lab[2]));
      d.bbox = bboxOf(d.rawX, d.rawY);
      const traced = new Set(d.labels.map(l => l[4]));
      for (const lab of (azones[zk].labels || [])) if (traced.has(lab[4])) collisions.push(`${cont}/${zk}: ${lab[4]}`);
      dz[zk] = composeDetail(azones[zk], d, palette);
    }
    const assembled = await assembleDiscoveries({
      files, index, cont, candidates: discoveries.accepted[cont] || [], packDir, rootDir,
      parsed, meta, zoneIndex: discoveryIndex, palette, colors, unseen, authoredDetails: dz,
    });
    discoveredReport[cont] = assembled.catalog;
    discoveredSourcesReport[cont] = assembled.sources;
    for (const record of assembled.catalog) {
      zones[record.key] = assembled.outputZones[record.key];
      dz[record.key] = assembled.outputDetails[record.key];
      if (record.from === 'root') rootCount++;
    }
    const extendedPalette = palette.concat(assembled.discoveredPalette);
    if (extendedPalette.length || Object.keys(dz).length) DETAIL[cont] = { palette: extendedPalette, zones: dz };
    const hubs = layout.hubs || [];
    if (hubs.length && Object.keys(zones).length) HUBS[cont] = hubs;
  }

  if (Object.keys(TRAVEL).length) {
    TRAVEL = { ...TRAVEL };
    const authoredPairs = new Set((TRAVEL.walk || []).map(edge => [...edge.z].sort().join('\0')));
    const records = Object.values(discoveredReport).flat().sort((a, b) => a.key.localeCompare(b.key));
    const derived = [];
    for (const record of records) {
      for (const edge of [...record.edges].sort((a, b) => a.z.localeCompare(b.z))) {
        const pair = [record.key, edge.z].sort().join('\0');
        if (authoredPairs.has(pair)) {
          throw new Error(`discovered walk edge duplicates authored pair: ${pair.replace('\0', '|')}`);
        }
        derived.push({ z: [record.key, edge.z], cost: edge.cost });
      }
    }
    TRAVEL.walk = (TRAVEL.walk || []).concat(derived);
  }

  const data = { ALL, META, DETAIL, HUBS, UNIVERSE, WORLDLINKS, TRAVEL, XPACS };
  for (const [name, value] of Object.entries(data)) validateNumbers(value, name);
  const report = {
    skipped: skippedReport, rootZones: rootReport, baseless,
    unseenColors: [...new Set(unseen)].sort(), warnings, collisions: [...new Set(collisions)].sort(),
    unknownRecords, discovered: discoveredReport, discoveryRejected: discoveries.rejected,
    discoveredSources: discoveredSourcesReport,
  };
  return { data, credit: creditText(packDir, rootCount), report };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    convert, buildHTML, roundHalfEven, lift, readText, splitLines, pyStrip,
    parsePythonFloat, parsePythonIntFloat, validateNumbers, creditText,
  };
}
