'use strict';

const MapGeom = (() => {
  const COST_SAMPLE = 200;
  const UNITS_PER_COST = 250.0;

  function roundHalfEven(x) {
    const f = Math.floor(x), d = x - f;
    if (d > 0.5) return f + 1;
    if (d < 0.5) return f;
    return f % 2 === 0 ? f : f + 1;
  }

  function round1(x) {
    const value = roundHalfEven(x * 10) / 10;
    return Object.is(value, -0) ? 0 : value;
  }

  function norm(dx, dy) {
    return Math.sqrt(dx * dx + dy * dy);
  }

  function tpoint(z, x, y) {
    const xf = z.xf || {};
    const s = xf.s == null ? 1 : xf.s;
    const rot = xf.rot || 0;
    const dx = (x - z.cx) * s, dy = (y - z.cy) * s;
    const c = Math.cos(rot), si = Math.sin(rot);
    return [z.cx + dx * c - dy * si + (xf.tx || 0),
      z.cy + dx * si + dy * c + (xf.ty || 0)];
  }

  function tinv(z, X, Y) {
    const xf = z.xf || {};
    const s = xf.s == null ? 1 : xf.s;
    const rot = xf.rot || 0;
    const dx = X - z.cx - (xf.tx || 0), dy = Y - z.cy - (xf.ty || 0);
    const c = Math.cos(-rot), si = Math.sin(-rot);
    return [z.cx + (dx * c - dy * si) / s,
      z.cy + (dx * si + dy * c) / s];
  }

  const SPELL = Object.freeze([
    ['forrest', 'forest'], ['excile', 'exile'], ['cablis', 'cabilis'],
    ['toxullia', 'toxxulia'], ['feerott', 'feerrott'], ['aquaduct', 'aqueduct'],
    ['northern', 'north'], ['southern', 'south'], ['eastern', 'east'], ['western', 'west'],
  ]);
  const ZALIAS = Object.freeze({
    butcherblock: 'butcherblock mountains', 'kerra ridge': 'kerra isle',
    'castle of mistmoore': 'castle mistmoore', 'city of guk': 'upper guk',
    'erudin city': 'erudin', 'erudin docks': 'erudin',
    'north ro': 'north desert of ro', 'south ro': 'south desert of ro',
    'permafrost keep': 'permafrost caverns', 'temple of cazic-thule': 'cazic-thule',
    'skyshrine lower level': 'skyshrine', 'ruins of old guk': 'lower guk',
    'ruins of old paineel': 'warrens', 'ruins of sebilis': 'old sebilis',
    'city of thurgadin': 'thurgadin', 'qeynos aqueduct system': 'qeynos catacombs',
    'liberated citadel of runnyeye': 'runnyeye citadel',
    'valley of king xorbb': 'gorge of king xorbb',
  });
  const DISCOVERY_EXCLUDE = new Set([
    'arcstone', 'arginhiz', 'barren', 'bloodfalls', 'breedinggrounds', 'brellsrest',
    'broodlands', 'commonlands', 'corathus', 'crystalshard', 'delvea', 'dragonscale',
    'eastwastesshard', 'ethernere', 'feerrott2', 'freeportacademy', 'freeportcityhall',
    'freeporthall', 'freeportmilitia', 'freeportsewers', 'freeporttheater', 'freeportwest',
    'gorowyn', 'growthplane', 'gunthak', 'highpasshold', 'jaggedpine', 'kaelshard',
    'korshaext', 'lopingplains', 'mischiefplane', 'mistythicket', 'moors', 'neriakd',
    'oceangreenhills', 'oceanoftears', 'scorchedwoods', 'soldungc', 'steamfontmts',
    'takishruins', 'toxxulia', 'xorbb',
  ]);
  const DISCOVERED_ZONE_COLOR = '#8f78d4';
  const LINK_OVERRIDE = Object.freeze({
    'kithicor|to_The_Commonlands': 'commons',
    'befallen|to_The_Commonlands': 'commons',
  });

  function znorm(value) {
    let s = value.toLowerCase().replace(/`/g, "'").replace(/_/g, ' ');
    s = s.replace(/^\s*(to|from)\s+/, '');
    s = s.replace(/\(.*?\)/g, '');
    s = s.replace(/:.*$/, '');
    s = s.replace(/\bone[- ]way\b/g, '').replace(/&/g, ' ').replace(/ - /g, ' ');
    for (const [a, b] of SPELL) s = s.split(a).join(b);
    s = s.split('plains of karana').join('karana');
    s = s.replace(/^(the|clan)\s+/, '');
    return s.replace(/\s+/g, ' ').replace(/^[ -]+|[ -]+$/g, '');
  }

  function zidxFrom(entries) {
    const idx = Object.create(null);
    function put(raw, value) {
      const key = raw.trim();
      if (key && !Object.prototype.hasOwnProperty.call(idx, key)) idx[key] = value;
    }
    for (const [cont, key, name] of entries) {
      const lower = name.toLowerCase();
      put(znorm(name), { cont, key });
      const directional = lower.match(/\((north|south|east|west)\)/);
      if (directional) {
        const base = znorm(lower.replace(/\s*\((north|south|east|west)\)/, ''));
        put(`${directional[1]} ${base}`, { cont, key });
        put(`${base} ${directional[1]}`, { cont, key });
      }
      const neriak = lower.match(/neriak \((.*)\)/);
      if (neriak) put(`neriak ${neriak[1]}`, { cont, key });
    }
    return idx;
  }

  function resolveZone(idx, label) {
    const normalized = znorm(label);
    if (Object.prototype.hasOwnProperty.call(idx, normalized)) return idx[normalized];
    const alias = ZALIAS[normalized];
    return alias && Object.prototype.hasOwnProperty.call(idx, alias) ? idx[alias] : null;
  }

  function transitionTargets(idx, zoneKey, full) {
    if (!/^(to|from)_/i.test(full)) return [];
    const override = LINK_OVERRIDE[`${zoneKey}|${full}`];
    if (override) return [override];
    const amp = full.indexOf('&');
    const pieces = amp < 0 ? [full] : [full.slice(0, amp), full.slice(amp + 1)];
    const out = [];
    for (const piece of pieces) {
      const target = resolveZone(idx, piece);
      if (target) out.push(target.key);
    }
    return out;
  }

  function discoverySeriesStem(key) {
    key = key.toLowerCase();
    return key.length >= 4 && /^[a-j0-9]$/.test(key.slice(-1)) ? key.slice(0, -1) : null;
  }

  function discoveryDerivedParent(key, roster) {
    key = key.toLowerCase();
    const matches = [];
    for (let parent of roster) {
      parent = parent.toLowerCase();
      const tail = key.startsWith(parent) ? key.slice(parent.length) : null;
      if ((tail !== null && /^(b|c|two|twoa|twob)$/.test(tail)) ||
          key === `old${parent}` || key === `${parent}_original`) matches.push(parent);
    }
    if (!matches.length) return null;
    return matches.reduce((best, value) => value.length > best.length ? value : best);
  }

  function discoveryDisplayName(label) {
    return label.replace(/^(to|from)_/i, '').replace(/\(.*?\)/g, '')
      .replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
  }

  function detailOffset(zone, detail) {
    if (!zone.segs.length || !detail.segs.length) return null;
    const ox = zone.segs[0][0] - detail.segs[0][0];
    const oy = zone.segs[0][1] - detail.segs[0][1];
    const middle = Math.floor(Math.min(zone.segs.length, detail.segs.length) / 2);
    const a = zone.segs[middle], b = detail.segs[middle];
    if (Math.abs((a[0] - b[0]) - ox) > 1.5 || Math.abs((a[1] - b[1]) - oy) > 1.5) return null;
    return [ox, oy];
  }

  function pairKey(from, to) { return `${from}\0${to}`; }

  function exitPointsFrom(zoneKey, zone, detail, idx) {
    const offset = detailOffset(zone, detail);
    const out = new Map();
    if (!offset) return out;
    for (const label of detail.labels) {
      for (const target of transitionTargets(idx, zoneKey, label[4])) {
        const key = pairKey(zoneKey, target);
        if (!out.has(key)) out.set(key, [label[0] + offset[0], label[1] + offset[1]]);
      }
    }
    return out;
  }

  function nearestOutlinePoint(zone, px, py, transformed) {
    let best = Infinity, point = [zone.cx, zone.cy];
    for (const seg of zone.segs) {
      for (const candidate of [[seg[0], seg[1]], [seg[2], seg[3]]]) {
        const q = transformed ? tpoint(zone, candidate[0], candidate[1]) : candidate;
        const distance = (q[0] - px) ** 2 + (q[1] - py) ** 2;
        if (distance < best) { best = distance; point = q; }
      }
    }
    return point;
  }

  function costPoints(zone, transformed) {
    const key = transformed ? '_cpts_t' : '_cpts';
    if (!Object.prototype.hasOwnProperty.call(zone, key)) {
      let points = [];
      for (const seg of zone.segs) points.push([seg[0], seg[1]], [seg[2], seg[3]]);
      if (points.length > COST_SAMPLE) {
        const step = points.length / COST_SAMPLE;
        points = Array.from({ length: COST_SAMPLE }, (_, i) => points[Math.trunc(i * step)]);
      }
      zone[key] = transformed ? points.map(p => tpoint(zone, p[0], p[1])) : points;
    }
    return zone[key];
  }

  function costBetween(zones, key1, key2, transformed, exits = null) {
    const z1 = zones[key1], z2 = zones[key2];
    const fwd = transformed ? (z, p) => tpoint(z, p[0], p[1]) : (_z, p) => p;
    const c1 = fwd(z1, [z1.cx, z1.cy]), c2 = fwd(z2, [z2.cx, z2.cy]);
    const e1 = exits && exits.get(pairKey(key1, key2));
    const e2 = exits && exits.get(pairKey(key2, key1));
    let pa, pb;
    if (e1 && e2) {
      pa = fwd(z1, e1); pb = fwd(z2, e2);
    } else if (e1) {
      pa = fwd(z1, e1); pb = nearestOutlinePoint(z2, pa[0], pa[1], transformed);
    } else if (e2) {
      pb = fwd(z2, e2); pa = nearestOutlinePoint(z1, pb[0], pb[1], transformed);
    } else {
      const left = costPoints(z1, transformed), right = costPoints(z2, transformed);
      let best = Infinity; pa = c1; pb = c2;
      for (const a of left) for (const b of right) {
        const distance = (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2;
        if (distance < best) { best = distance; pa = a; pb = b; }
      }
    }
    return (norm(c1[0] - pa[0], c1[1] - pa[1]) +
      norm(pb[0] - c2[0], pb[1] - c2[1])) / UNITS_PER_COST;
  }

  return Object.freeze({
    COST_SAMPLE, UNITS_PER_COST, ZALIAS, DISCOVERY_EXCLUDE, DISCOVERED_ZONE_COLOR,
    LINK_OVERRIDE, roundHalfEven, round1, norm, tpoint, tinv, znorm, zidxFrom,
    resolveZone, transitionTargets, discoverySeriesStem, discoveryDerivedParent,
    discoveryDisplayName, detailOffset, exitPointsFrom, nearestOutlinePoint, costPoints,
    costBetween,
  });
})();

if (typeof module !== 'undefined' && module.exports) module.exports = MapGeom;
