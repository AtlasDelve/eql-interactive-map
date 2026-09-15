#!/usr/bin/env node
// Fixture matrix for check-plan-codex-fold.js. Asserts on EXIT CODES, because the exit code is the
// whole contract: 0 lets the tool call through, 2 blocks it. Reading the source and agreeing with
// it is what let three silent passes survive in the first place.
//
// Run:  node .claude/hooks/check-plan-codex-fold.test.js
// Deliberately standalone -- not wired into tools/verify/run.py. That pipeline gates the map
// artifact and a release tag; this gates harness plumbing on no release path, and coupling the two
// would make a hook edit a release concern.

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOOK = path.join(__dirname, 'check-plan-codex-fold.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'planfold-'));

let fails = 0;
function check(name, payload, want) {
  const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify(payload), encoding: 'utf8' });
  const got = r.status;
  if (got === want) { console.log('  OK   ' + name); return; }
  fails++;
  console.log('  FAIL ' + name + '  -> exit ' + got + ', want ' + want);
}

// A file on disk under a chosen directory, so isPlan() sees a realistic path.
function planFile(dir, name) {
  const d = path.join(tmp, dir);
  fs.mkdirSync(d, { recursive: true });
  const p = path.join(d, name);
  fs.writeFileSync(p, '', 'utf8');
  return p;
}
const write = (file, content) => ({ tool_name: 'Write', tool_input: { file_path: file, content } });
const exitPlan = (plan) => ({ tool_name: 'ExitPlanMode', tool_input: { plan } });

const READY_ROW = '| **Status** | `READY FOR CODEX` |';
const FOLD = '## Codex fold - 2026-09-13\n\nFinding 1: folded in.\n';

// ---------------------------------------------------------------- baseline behaviour (regression)
console.log('\nBaseline -- must not change:');

check('non-plan file is ignored',
  write(planFile('src', 'app.js'), READY_ROW), 0);

check('plan with no readiness declaration passes',
  write(planFile('docs/internal', 'a-plan.md'), '# Plan\n\nNo status row.\n'), 0);

check('plan declared READY with a recorded fold passes',
  write(planFile('docs/internal', 'b-plan.md'), '# Plan\n\n' + READY_ROW + '\n\n' + FOLD), 0);

check('plan declared READY with no fold is blocked',
  write(planFile('docs/internal', 'c-plan.md'), '# Plan\n\n' + READY_ROW + '\n'), 2);

check('grandfathered "Arbitration record" counts as evidence',
  write(planFile('docs/internal', 'd-plan.md'),
    '# Plan\n\n' + READY_ROW + '\n\n## Arbitration record\n\nRuled.\n'), 0);

check('prose mentioning the marker outside a status row does not trigger',
  write(planFile('docs/internal', 'e-plan.md'),
    '# Plan\n\nThe gate marks a plan READY FOR CODEX only after the pass.\n'), 0);

// ------------------------------------------------------------------------------ trap 1: negation
console.log('\nTrap 1 -- a negated status row must not count as a declaration:');

check('lowercase "not ready for Codex" passes',
  write(planFile('docs/internal', 'f-plan.md'),
    '# Plan\n\n| **Status** | `AWAITING REVIEW` - **not ready for Codex.** |\n'), 0);

check('uppercase "NOT READY FOR CODEX" passes',
  write(planFile('docs/internal', 'g-plan.md'),
    '# Plan\n\n| **Status** | **NOT READY FOR CODEX** - the gate has not run. |\n'), 0);

check('a real READY row is still caught alongside a negated one',
  write(planFile('docs/internal', 'h-plan.md'),
    '# Plan\n\n| **Status** | was not ready for Codex |\n\n' + READY_ROW + '\n'), 2);

// -------------------------------------------------------------------------- trap 2: empty folds
console.log('\nTrap 2 -- an amendment must carry its own non-empty fold:');

const withAmendment = (foldBody) =>
  '# Plan\n\n' + READY_ROW + '\n\n' + FOLD +
  '\n## Amendment 1 - 2026-09-13, a ruling\n\nBody.\n' +
  '\n## Codex fold - Amendment 1, 2026-09-13\n' + foldBody;

check('newest amendment with an empty fold section is blocked',
  write(planFile('docs/internal', 'i-plan.md'), withAmendment('\n\n')), 2);

check('newest amendment with a real fold passes',
  write(planFile('docs/internal', 'j-plan.md'), withAmendment('\n\nFinding: rejected, reason.\n')), 0);

check('newest amendment with NO fold section at all is blocked',
  write(planFile('docs/internal', 'k-plan.md'),
    '# Plan\n\n' + READY_ROW + '\n\n' + FOLD + '\n## Amendment 1 - 2026-09-13\n\nBody.\n'), 2);

check('older unfolded amendments are grandfathered when the newest is folded',
  write(planFile('docs/internal', 'l-plan.md'),
    '# Plan\n\n' + READY_ROW + '\n\n' + FOLD +
    '\n## Amendment 1 - 2026-09-13\n\nUnfolded history.\n' +
    '\n## Amendment 2 - 2026-09-13\n\nBody.\n' +
    '\n## Codex fold - Amendment 2, 2026-09-13\n\nFinding: folded.\n'), 0);

check('an Execution Log "### Amendment N" does not declare an amendment',
  write(planFile('docs/internal', 'n-plan.md'),
    '# Plan\n\n' + READY_ROW + '\n\n' + FOLD +
    '\n## Amendment 1 - 2026-09-13\n\nBody.\n' +
    '\n## Codex fold - Amendment 1, 2026-09-13\n\nFinding: folded.\n' +
    '\n## Execution Log\n\n### Amendment 2 Item 4 - STOP, standing invariant\n\nCodex wrote this.\n'), 0);

check('a base fold with an empty body does not satisfy the base declaration',
  write(planFile('docs/internal', 'm-plan.md'),
    '# Plan\n\n' + READY_ROW + '\n\n## Codex fold - 2026-09-13\n\n'), 2);

// ------------------------------------------------------- trap 3: plan-mode path and ExitPlanMode
console.log('\nTrap 3 -- plan-mode files and ExitPlanMode itself:');

check('a plan written under .claude/plans is seen',
  write(planFile('.claude/plans', 'some-generated-name.md'), '# Plan\n\n' + READY_ROW + '\n'), 2);

check('ExitPlanMode with no fold in the plan body is blocked',
  exitPlan('# Plan\n\n## Context\n\nA multi-step change.\n'), 2);

check('ExitPlanMode with a fold in the plan body passes',
  exitPlan('# Plan\n\n## Context\n\nA change.\n\n' + FOLD), 0);

check('ExitPlanMode with an empty fold section is blocked',
  exitPlan('# Plan\n\n## Context\n\nA change.\n\n## Codex fold - 2026-09-13\n\n'), 2);

check('ExitPlanMode with a grandfathered Arbitration record passes',
  exitPlan('# Plan\n\n## Arbitration record\n\nRuled: proceed.\n'), 0);

// The current ExitPlanMode schema passes NO plan parameter -- it says the plan is read from the
// plan file. If the payload carries a path instead of the text, read the file.
check('ExitPlanMode reads the plan from a file path when given one',
  { tool_name: 'ExitPlanMode', tool_input: { plan_file_path: (() => {
      const p = planFile('.claude/plans', 'by-path.md');
      fs.writeFileSync(p, '# Plan\n\nNo fold here.\n', 'utf8');
      return p;
    })() } }, 2);

// An unreadable plan must NOT silently pass as "fine". Exit 0 so a gate that cannot read its input
// never blocks work, but the caller writes a diagnostic to stderr -- assert that it does.
{
  const r = spawnSync(process.execPath, [HOOK],
    { input: JSON.stringify({ tool_name: 'ExitPlanMode', tool_input: {} }), encoding: 'utf8' });
  const loud = r.status === 0 && /carried no readable plan text/.test(r.stderr);
  if (loud) console.log('  OK   ExitPlanMode with no readable plan exits 0 but says so loudly');
  else { fails++; console.log('  FAIL ExitPlanMode with no readable plan must warn  -> exit ' + r.status + ', stderr ' + JSON.stringify(r.stderr.slice(0, 80))); }
}

// ------------------------------------------------------------------------------------ robustness
console.log('\nRobustness -- a fault here must never wedge the session:');

check('malformed payload passes', { tool_name: 'Write' }, 0);
check('unreadable Edit target passes',
  { tool_name: 'Edit', tool_input: { file_path: path.join(tmp, 'docs/internal/nope.md'), old_string: 'a', new_string: 'b' } }, 0);

fs.rmSync(tmp, { recursive: true, force: true });
console.log('\n' + (fails === 0 ? 'PASS -- all checks green' : 'FAIL -- ' + fails + ' check(s) failed'));
process.exit(fails === 0 ? 0 : 1);
