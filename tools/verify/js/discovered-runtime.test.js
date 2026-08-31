#!/usr/bin/env node
'use strict';

// Runtime half of discovered-zone coverage. The pack fixtures prove conversion and the
// real-pack bridge proves that marker-derived catalog records reach this shape; this tiny fixture
// proves the viewer treats that shape exactly like any authored zone.
const path = require('path');
const { load } = require('./lib.js');

const FX = path.join(__dirname, '..', '_fx');
let fails = 0, checks = 0;
function ok(name, cond, extra) {
  checks++;
  if (cond) { console.log('  OK   ' + name); return true; }
  fails++;
  console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : ''));
  return false;
}
function eq(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  return ok(name + (g === w ? '' : ' (got ' + g + ', want ' + w + ')'), g === w);
}

const page = load(path.join(FX, 'fx-discovered-zone.user.html'));
ok('fixture loads without errors', page.errors.length === 0, page.errors);
const ev = page.ev;

ev("enterZone('Antonica','alpha')");
eq('the anchor marker is a zlink targeting the discovered key',
  JSON.parse(ev("JSON.stringify(zlinks.map(z=>({full:z.full,key:z.key})))")),
  [{ full: 'to_Discovered_Reach', key: 'discovered' }]);

eq('clicking the marker enters the discovered zone', JSON.parse(ev(`JSON.stringify((function(){
  const L=zlinks[0];
  if(L){
    const x=wx(L.x), y=wy(L.y);
    cv.dispatchEvent(new MouseEvent('click',{clientX:x,clientY:y,bubbles:true}));
  }
  return {level,cont:cur,key:zcur};
})())`)), { level: 'zone', cont: 'Antonica', key: 'discovered' });

ok('zoneExitPoint resolves the discovered doorway',
  JSON.parse(ev("JSON.stringify(zoneExitPoint('Antonica','alpha','discovered'))")) !== null,
  ev("zoneExitPoint('Antonica','alpha','discovered')"));

ok('travel search finds the discovered display name',
  JSON.parse(ev("JSON.stringify(tFind('Discovered Reach',9).map(e=>e.kind+':'+e.key))"))
    .includes('zone:discovered'));

eq('a planned itinerary contains the derived leg and cost', JSON.parse(ev(`JSON.stringify((function(){
  for(const k in TCAPS)TCAPS[k]=false;
  TADJ=null;
  const r=tPlan(['alpha'],['discovered']);
  return r&&{total:r.total,legs:r.legs.map(l=>({from:l.from,to:l.to,kind:l.kind,cost:l.cost}))};
})())`)), { total: 6.7, legs: [{ from: 'alpha', to: 'discovered', kind: 'walk', cost: 6.7 }] });

console.log('\n' + checks + ' checks, ' + fails + ' failed');
console.log('RESULT: ' + (fails ? 'FAIL' : 'PASS'));
process.exit(fails ? 1 : 0);
