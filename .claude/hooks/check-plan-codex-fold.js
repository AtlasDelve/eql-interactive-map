#!/usr/bin/env node
// PreToolUse hook: refuse to let a plan be marked READY FOR CODEX -- or to let ExitPlanMode fire --
// unless the Codex pass that CLAUDE.md -> "Plan review: a Codex pass, then advisor" requires is
// recorded in the plan itself.
//
// Why this exists as a hook rather than a sentence. That gate was prose, and prose competes with
// other prose: harness configuration can carry a blanket "do not call the Agent tool unless the
// user requested it", CLAUDE.md carried a paragraph claiming authority over it, and the agent
// weighed the two and skipped the pass -- twice. A blocking hook does not get weighed. Exit code 2
// stops the tool call and returns this message as feedback, which is the only mechanism here that
// an in-flight rationalisation cannot route around.
//
// Deliberately BLOCKING, unlike check-agent-docs.js. That one raises a question a human should
// answer; this one enforces an ordering that has already failed in practice. The judgement it
// removes is exactly the judgement that proved unreliable.
//
// It checks for the RECORD, not the pass. Nothing here can verify Codex actually ran -- a
// fabricated fold section would satisfy it. That is acceptable: the failure mode it exists to stop
// is forgetting or rationalising, not lying.
//
// Three silent passes, found 2026-08-28/08-30 and fixed 2026-09-13. Each is covered by a fixture in
// check-plan-codex-fold.test.js; change this file and run that one.
//
//   1. A NEGATED status row counted as a declaration of readiness. The readiness regex carried `i`,
//      so "not ready for Codex" -- the natural way to say the gate has not run -- registered as a
//      claim that it had. Over-strict rather than under-strict, but it taught people to reword
//      around the hook, which is how a gate stops being read as a gate. Now a marker preceded by a
//      negator in the same cell does not count.
//   2. An amendment could ride the original's fold heading. Headings were COUNTED, not matched to
//      the section needing them, so once a plan carried one fold an amendment with an EMPTY fold
//      passed silently. Now the newest amendment must carry its own non-empty fold, and an empty
//      section is not evidence of anything. Older amendments stay grandfathered: the hook cannot
//      fix history, same reason it still accepts "Arbitration record".
//   3. The hook never saw the file plan mode actually writes. isPlan() matched docs/internal/ only;
//      plan mode writes to ~/.claude/plans/<generated-name>.md, so ExitPlanMode proceeded with no
//      fold recorded -- hit for real on 2026-08-30, caught only because it was asked about. Widening the
//      path is the smaller half: a plan-mode file carries no Handoff status row, so seeing it
//      changes little. The load-bearing half is gating ExitPlanMode itself, the moment CLAUDE.md
//      names, where the predicate is different -- evidence must exist, unconditionally, rather than
//      being counted against declarations.
//
//      *** THIS HALF IS NOT VERIFIED AND MAY NOT WORK. Read before trusting it. ***
//      On 2026-09-13 an approved, fold-less ExitPlanMode produced NO PreToolUse event -- but the
//      matcher had been added to settings.json mid-session, and Claude Code snapshots hooks at
//      session start, so the test is confounded and proves nothing either way. Two possibilities
//      remain open: (a) the matcher simply was not loaded, or (b) PreToolUse does not dispatch
//      ExitPlanMode at all, in which case `"ExitPlanMode"` in settings.json is decoration and the
//      documented gate cannot be enforced from a hook. Nothing in the shipped binary settled it.
//      RETEST, in a session started AFTER the settings change: enter plan mode, write a plan with
//      no "## Codex fold", approve ExitPlanMode. Blocked => wired. Exits plan mode => not wired.
//      Until then treat the ExitPlanMode gate as a discipline, exactly as before.

// Layered on top of that: even if the event does arrive, the current ExitPlanMode schema passes no
// plan parameter, so planText() below may find nothing to read. That case exits 0 with a loud
// stderr diagnostic naming the keys it did receive -- never a silent pass.

const fs = require('node:fs');
const path = require('node:path');

// Either heading is evidence of a Codex pass. "Codex fold" is the current convention;
// "Arbitration record" is what the plans written before this hook used for the same thing, and
// grandfathering them keeps the hook from firing on history it cannot fix.
const EVIDENCE_HEADING = /^(Codex fold|Arbitration record)\b/i;
// "## Amendment 7 - 2026-09-11, ..." declares an amendment; "## Codex fold - Amendment 7, ..."
// folds it. Both spell the number the same way, so one pattern pairs them.
const AMENDMENT_TAG = /\bAmendment\s+(\d+)\b/i;
// Only the canonical Handoff-table status row counts as a declaration. Matching bare
// "READY FOR CODEX" anywhere over-counts: a plan discusses its own gate in prose, and a hook that
// fires on a sentence describing the rule just teaches people to route around the rule.
const STATUS_ROW = /^\|\s*\*\*Status\*\*\s*\|([^|]*)\|?/gim;
const MARKER = /READY FOR CODEX/gi;
// A negator at the end of the cell text preceding the marker. Markdown emphasis is stripped first,
// so "**NOT READY FOR CODEX**" and "- **not ready for Codex.**" both read as negated.
const NEGATOR = /(?:^|\W)(not|never|no longer|un)\s*$/i;

// Split into headings with their bodies. A section's body runs to the next heading at the same or
// a higher level, so sub-headings inside a fold count as content rather than ending it.
function sections(text) {
  const lines = String(text).split(/\r?\n/);
  const heads = [];
  lines.forEach((line, i) => {
    const m = /^(#{1,6})\s+(.*)$/.exec(line);
    if (m) heads.push({ level: m[1].length, title: m[2].trim(), line: i });
  });
  return heads.map((h, i) => {
    let end = lines.length;
    for (let j = i + 1; j < heads.length; j++) {
      if (heads[j].level <= h.level) { end = heads[j].line; break; }
    }
    return { level: h.level, title: h.title, body: lines.slice(h.line + 1, end).join('\n') };
  });
}

// An empty fold section is not evidence. Markdown punctuation alone is not content either: a
// section holding only "---" or "|   |" records nothing.
const hasContent = (body) => /[A-Za-z0-9]/.test(String(body));

// Evidence sections that actually say something, tagged with the amendment they fold (or null for
// the plan's base fold).
function folds(text) {
  return sections(text)
    .filter((s) => EVIDENCE_HEADING.test(s.title) && hasContent(s.body))
    .map((s) => {
      const m = AMENDMENT_TAG.exec(s.title);
      return { amendment: m ? Number(m[1]) : null };
    });
}

// The highest-numbered "## Amendment N" heading, or null. Only the newest is enforced -- an
// earlier unfolded amendment is history, and blocking every future edit on it would make the hook
// unusable on the plans it most needs to gate.
//
// Level 2 only, and that is load-bearing rather than tidiness. An amendment is DECLARED at `##`;
// `###` and below are Execution Log and Review entries that name the amendment they are working
// under ("### Amendment 6 Item 4 -- STOP: standing invariant"). Counting those would let the log
// invent an amendment that was never declared and false-block a plan that is correctly folded.
// Convention checked across the b9, landing, browser-discovery, python and mapgeom plans.
function newestAmendment(text) {
  let newest = null;
  for (const s of sections(text)) {
    if (s.level !== 2) continue;
    if (EVIDENCE_HEADING.test(s.title)) continue;      // a fold names an amendment; it isn't one
    const m = /^Amendment\s+(\d+)\b/i.exec(s.title);
    if (m) { const n = Number(m[1]); if (newest === null || n > newest) newest = n; }
  }
  return newest;
}

// Status rows declaring readiness, ignoring rows where the marker is negated.
function readyCount(text) {
  let n = 0;
  STATUS_ROW.lastIndex = 0;
  let row;
  while ((row = STATUS_ROW.exec(String(text))) !== null) {
    const cell = row[1];
    MARKER.lastIndex = 0;
    let hit;
    while ((hit = MARKER.exec(cell)) !== null) {
      const before = cell.slice(0, hit.index).replace(/[*_`~]/g, '');
      if (!NEGATOR.test(before)) { n++; break; }
    }
  }
  return n;
}

// Only plan files. A stray "READY FOR CODEX" in source or a reference doc is not this hook's
// business. Both homes count: docs/internal/ is where this repo keeps plans, and .claude/plans/ is
// where plan mode puts one before it is moved.
function isPlan(file) {
  const norm = String(file).replace(/\\/g, '/');
  return /\/docs\/internal\/.*\.md$/i.test(norm) || /\/\.claude\/plans\/.*\.md$/i.test(norm);
}

// The plan text behind an ExitPlanMode call. Two shapes are known and neither is guaranteed:
// harness builds up to ~2026-09 passed the whole plan inline as `tool_input.plan` (confirmed in
// this project's session transcripts), while the current ExitPlanMode schema takes no plan
// parameter and documents that the plan is read from the plan file instead. So try inline first,
// then any field that looks like a path to the plan file. Anything unrecognised falls through to
// the loud no-op in the caller rather than being guessed at.
function planText(input) {
  if (typeof input.plan === 'string' && input.plan.trim()) return input.plan;
  for (const key of ['plan_file_path', 'planFilePath', 'file_path', 'path']) {
    const p = input[key];
    if (typeof p === 'string' && /\.md$/i.test(p)) {
      try { return fs.readFileSync(p, 'utf8'); } catch { /* fall through */ }
    }
  }
  return '';
}

// The content the tool is about to produce, so the check runs against the result rather than the
// current file. Edit is applied against the file on disk; Write supplies the whole body.
function prospectiveContent(toolName, input) {
  if (toolName === 'Write') return input.content ?? '';
  if (toolName !== 'Edit') return null;
  let current = '';
  try { current = fs.readFileSync(input.file_path, 'utf8'); } catch { return null; }
  const from = input.old_string ?? '';
  const to = input.new_string ?? '';
  if (!from) return current;
  return input.replace_all
    ? current.split(from).join(to)
    : current.replace(from, to);
}

const HOW = (name) =>
  `Run the pass, then record it:\n\n` +
  `  codex exec -s read-only -c model_reasoning_effort=high "<prompt naming ${name}>" < /dev/null\n\n` +
  `Then append a "## Codex fold" section naming each finding and whether it was folded in or ` +
  `rejected with a reason, and retry.\n\n` +
  `Do not work around this by deleting the status marker or writing an empty fold section. If ` +
  `Codex is genuinely unavailable, say so to the user and let them decide -- per CLAUDE.md a ` +
  `failed pass must not block advisor(), but it does block claiming the plan is ready.\n`;

function block(message) {
  process.stderr.write(message);
  process.exit(2);
}

let raw = '';
try { raw = fs.readFileSync(0, 'utf8'); } catch { process.exit(0); }

try {
  const payload = JSON.parse(raw || '{}');
  const toolName = payload.tool_name;
  const input = payload.tool_input || {};

  // ---- ExitPlanMode: the moment CLAUDE.md actually names -------------------------------------
  // The payload carries the plan body inline, so the check runs on the text being submitted. The
  // predicate is not the Edit/Write one: a plan being submitted has no Handoff status row to count
  // against, so evidence is required outright.
  if (toolName === 'ExitPlanMode') {
    const plan = planText(input);
    // No readable plan text. UNVERIFIED as of 2026-09-13: this branch has never been observed
    // running -- see the header note. Older harness builds passed the plan inline as
    // `tool_input.plan`; the current ExitPlanMode schema takes no plan parameter at all and says
    // the plan is read from the plan file. So this may receive a payload shape nothing here
    // anticipates.
    //
    // Exit 0, because a gate that cannot read its input must not block work. But say so loudly and
    // dump the keys that DID arrive, because the alternative is the silent pass this whole hook
    // exists to stop -- and because that stderr line is how the payload shape finally gets
    // recorded. If you are reading this in a transcript: paste it into the hook and finish the job.
    if (!plan.trim()) {
      process.stderr.write(
        `check-plan-codex-fold.js: ExitPlanMode reached the gate but carried no readable plan ` +
        `text -- NOT gating this call.\n` +
        `  tool_input keys: ${JSON.stringify(Object.keys(input))}\n` +
        `  payload keys:    ${JSON.stringify(Object.keys(payload))}\n` +
        `  Record this shape in planText() so the gate can read it.\n`
      );
      process.exit(0);
    }
    if (folds(plan).length === 0) {
      block(
        `BLOCKED: this plan records no Codex pass.\n\n` +
        `CLAUDE.md -> "Plan review: a Codex pass, then advisor" applies to ExitPlanMode. The plan ` +
        `carries no "## Codex fold" or "## Arbitration record" section with content in it.\n\n` +
        `Codex reviews what is on disk, so write the plan under docs/internal/ first and name that ` +
        `path in the request. ` + HOW('the plan file') +
        `\nIf the fold is recorded in the file on disk but not in the text submitted here, include ` +
        `it in the submitted plan -- this hook can only see what you pass it.\n`
      );
    }
    const newest = newestAmendment(plan);
    if (newest !== null && !folds(plan).some((f) => f.amendment === newest)) {
      block(
        `BLOCKED: Amendment ${newest} carries no fold of its own.\n\n` +
        `The plan has a "## Amendment ${newest}" section but no "## Codex fold - Amendment ` +
        `${newest}" section with content in it. An earlier fold does not cover a later amendment.\n\n` +
        HOW('the plan file')
      );
    }
    process.exit(0);
  }

  // ---- Edit/Write on a plan file --------------------------------------------------------------
  const file = input.file_path;
  if (!file || !isPlan(file)) process.exit(0);
  if (toolName !== 'Write' && toolName !== 'Edit') process.exit(0);

  const next = prospectiveContent(toolName, input);
  if (next === null) process.exit(0);

  const ready = readyCount(next);
  if (ready === 0) process.exit(0);

  const name = path.basename(file);
  const recorded = folds(next);

  if (recorded.length < ready) {
    block(
      `BLOCKED: ${name} would carry ${ready} "READY FOR CODEX" marker(s) but only ` +
      `${recorded.length} recorded Codex pass(es) with content in them.\n\n` +
      `CLAUDE.md -> "Plan review: a Codex pass, then advisor" requires the pass BEFORE the plan is ` +
      `marked ready, and before advisor(). ` + HOW(name)
    );
  }

  const newest = newestAmendment(next);
  if (newest !== null && !recorded.some((f) => f.amendment === newest)) {
    block(
      `BLOCKED: ${name} would be declared READY, but Amendment ${newest} carries no fold of its ` +
      `own.\n\n` +
      `The plan has a "## Amendment ${newest}" section and no "## Codex fold - Amendment ` +
      `${newest}" section with content in it. The fold recorded for an earlier amendment does not ` +
      `cover this one -- that coarseness is exactly what let an empty fold pass before.\n\n` +
      `Older amendments are grandfathered; only the newest is enforced.\n\n` + HOW(name)
    );
  }

  process.exit(0);
} catch (e) {
  // Never wedge the session on a malformed payload. The conditions above are what block; an
  // internal fault here should not.
  //
  // But say so. A bare `catch { exit 0 }` turns a defect in the gate into a silent pass -- the
  // exact failure class this hook exists to stop, now aimed at the hook itself. This was not
  // hypothetical: while fixing the three traps, a bug in the new pairing check was swallowed here
  // and read as "the plan is fine". Exit 0 still, so a fault cannot block work; stderr so it
  // cannot be invisible.
  process.stderr.write(
    `check-plan-codex-fold.js: internal fault, NOT gating this call -- ${e && e.stack}\n`
  );
  process.exit(0);
}
