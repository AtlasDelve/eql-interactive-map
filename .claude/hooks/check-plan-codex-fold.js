#!/usr/bin/env node
// PreToolUse hook: refuse to let a plan under docs/internal/ be marked READY FOR CODEX unless the
// Codex pass that CLAUDE.md -> "Plan review: a Codex pass, then advisor" requires is recorded in
// the file itself.
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

const fs = require('node:fs');
const path = require('node:path');

// Either heading is evidence of a Codex pass. "Codex fold" is the current convention;
// "Arbitration record" is what the plans written before this hook used for the same thing, and
// grandfathering them keeps the hook from firing on history it cannot fix.
const EVIDENCE = /^##+\s+(Codex fold|Arbitration record)\b/gim;
// Only the canonical Handoff-table status row counts as a declaration. Matching bare
// "READY FOR CODEX" anywhere over-counts: a plan discusses its own gate in prose, and a hook that
// fires on a sentence describing the rule just teaches people to route around the rule.
const READY = /^\|\s*\*\*Status\*\*\s*\|[^|]*READY FOR CODEX/gim;

function count(text, re) {
  re.lastIndex = 0;
  return (text.match(re) || []).length;
}

// Only plan files. A stray "READY FOR CODEX" in source or a reference doc is not this hook's business.
function isPlan(file) {
  const norm = file.replace(/\\/g, '/');
  return /\/docs\/internal\/.*\.md$/i.test(norm);
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

let raw = '';
try { raw = fs.readFileSync(0, 'utf8'); } catch { process.exit(0); }

try {
  const payload = JSON.parse(raw || '{}');
  const toolName = payload.tool_name;
  const input = payload.tool_input || {};
  const file = input.file_path;
  if (!file || !isPlan(file)) process.exit(0);
  if (toolName !== 'Write' && toolName !== 'Edit') process.exit(0);

  const next = prospectiveContent(toolName, input);
  if (next === null) process.exit(0);

  const ready = count(next, READY);
  if (ready === 0) process.exit(0);
  const folds = count(next, EVIDENCE);
  if (folds >= ready) process.exit(0);

  const name = path.basename(file);
  process.stderr.write(
    `BLOCKED: ${name} would carry ${ready} "READY FOR CODEX" marker(s) but only ${folds} ` +
    `recorded Codex pass(es).\n\n` +
    `CLAUDE.md -> "Plan review: a Codex pass, then advisor" requires the pass BEFORE the plan is ` +
    `marked ready, and before advisor(). Run it, then record it:\n\n` +
    `  codex exec -s read-only -c model_reasoning_effort=high "<prompt naming ${name}>" < /dev/null\n\n` +
    `Then append a "## Codex fold" section naming each finding and whether it was folded in or ` +
    `rejected with a reason, and retry this write.\n\n` +
    `Do not work around this by deleting the status marker or writing an empty fold section. If ` +
    `Codex is genuinely unavailable, say so to the user and let them decide -- per CLAUDE.md a ` +
    `failed pass must not block advisor(), but it does block claiming the plan is ready.\n`
  );
  process.exit(2);
} catch {
  // Never wedge the session on a malformed payload. The condition above is what blocks; an
  // internal fault here should not.
  process.exit(0);
}
