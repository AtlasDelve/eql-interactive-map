// Confirms the weld-detection deferral on real data: applying a customization on plain
// continent VIEW must not pay detectLinks(), which samples up to 700 points per zone and
// compares every zone pair (Antonica: 49 zones -> 1,176 pairs).
//
// Both halves are timed on the SAME warmed-up page, so the comparison isolates the deferral
// rather than one-time warmup. An earlier version timed enterCont() on a freshly loaded page
// against setEdit() later in that page's life, so the first measurement absorbed all the JIT
// and first-draw cost; on a slower jsdom build the supposedly cheap view path then measured
// SLOWER than the edit path it is meant to beat. Only the ratio is asserted - absolute
// milliseconds are reported as info, being machine- and runtime-dependent.
//
// Usage: node perf.test.js <built.user.html>
const { load } = require('./lib');

const file = process.argv[2];
const CONT = 'Antonica';
let fails = 0;
function ok(name, cond, extra) {
  if (cond) { console.log('  OK   ' + name); return; }
  fails++;
  console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : ''));
}

const storage = {};

// --- pass 1: customize and save a buffer -----------------------------------
{
  const { ev } = load(file, { storage });
  ev("enterCont('" + CONT + "');setEdit(true)");
  const nz = ev('Object.keys(zones).length');
  // move a third of the zones, so the overlay is realistically large
  ev("(function(){const ks=Object.keys(zones);for(let i=0;i<ks.length;i+=3)" +
     "zones[ks[i]].xf={tx:500+i,ty:-200-i,s:1.1,rot:0.05};})()");
  ev("hubs[0].x=1;hubs[0].y=2;hubs[0].anchor=null;hubs[0].lx=null;hubs[0].ly=null;hubs[0].touched=true");
  ev('saveVersion()');
  const ov = JSON.parse(ev('JSON.stringify(contOverlay("' + CONT + '"))'));
  console.log('  info  ' + nz + ' zones; overlay records ' + Object.keys(ov.zoneXf).length
    + ' zoneXf + ' + (ov.hubs ? ov.hubs.length : 0) + ' hub(s)');
  ok('overlay is sparse, not the whole roster', Object.keys(ov.zoneXf).length < nz,
    Object.keys(ov.zoneXf).length + '/' + nz);
}

// --- pass 2: reopen, assert the structural contract, then time both halves --
{
  const { ev } = load(file, { storage });
  ev("enterCont('" + CONT + "')");

  // Deterministic and machine-independent - this is the actual contract.
  ok('customization applied on plain view', ev("!!EDIT['" + CONT + "']") === true);
  ok('weld detector deferred on the view path',
    ev("EDIT['" + CONT + "'].linksReady") === false);
  ok('a zone transform really is live',
    ev("Object.values(EDIT['" + CONT + "'].zones).some(z=>z.xf.tx>0)") === true);
  ev('setEdit(true)');
  ok('welds detected once Edit opens', ev("EDIT['" + CONT + "'].linksReady") === true);
  const welds = ev("EDIT['" + CONT + "'].zoneLinks.length");

  const t = ev(`(function(){
    const K=${JSON.stringify(CONT)};
    // warm both paths once, so neither timed run pays first-call cost
    delete EDIT[K]; applyStoredCont(K); ensureLinks(K);
    let a=0,b=0;
    for(let i=0;i<3;i++){
      const t0=Date.now(); delete EDIT[K]; applyStoredCont(K); const t1=Date.now();
      ensureLinks(K);                                          const t2=Date.now();
      a+=t1-t0; b+=t2-t1;
    }
    return {view:a/3, edit:b/3};
  })()`);

  console.log('  info  apply overlay on view: ' + t.view.toFixed(0)
    + ' ms   |   deferred weld detection: ' + t.edit.toFixed(0)
    + ' ms   (' + welds + ' welds, mean of 3)');
  ok('deferring weld detection saves most of the view-path work ('
     + (t.edit / Math.max(t.view, 1)).toFixed(1) + 'x)',
    t.edit > t.view * 2, { view: Math.round(t.view), edit: Math.round(t.edit) });
}

console.log('\nRESULT: ' + (fails ? 'FAIL' : 'PASS'));
process.exit(fails ? 1 : 0);
