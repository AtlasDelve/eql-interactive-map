#!/usr/bin/env node
// PreToolUse hook: when a git commit is about to run, remind the agent to check whether
// AGENTS.md (then CLAUDE.md, then the docs/reference/ file for the subsystem touched) needs
// updating for this change -- and name those reference files, derived from what the working
// tree actually changed rather than leaving the routing-table lookup to be skipped.
//
// Why a script rather than a settings-only `if` rule: commits here are compound commands
// ("git add x; git commit -m ...") so a prefix-wildcard rule anchored at "git commit" would
// never match. This also avoids jq, which is not installed on this machine.
//
// Non-blocking by design. It injects context and exits 0; it never vetoes a commit. Every git
// call is best-effort: any failure degrades to the generic reminder, because a commit must
// never fail on account of this hook.
//
// The judgement of what is worth recording belongs to the agent, not to a regex. Naming the
// files is a convenience; deciding whether they need an edit is not delegable.

const { execFileSync } = require('node:child_process');

// Mirrors the routing table in AGENTS.md -> "Subsystem references". Values are printed
// verbatim, so a value may name a reference file or a section of AGENTS.md itself.
const T_RUNTIME = 'docs/reference/travel-runtime.md';
const T_GRAPH = 'docs/reference/travel-graph.md';
const XPAC = 'docs/reference/expansion-selection.md';
const OVERLAY = 'docs/reference/customization-overlay.md';
const PACK = 'docs/reference/pack-import.md';
const BUILD = 'AGENTS.md -> Build pipeline + Two editions';
const VERIFY = 'tools/verify/README.md (plus the reference file for what the test covers)';
const LICENSING = 'docs/reference/licensing.md';
const BUILDER = 'docs/reference/builder.md';

// Paths that route on their own. src/template.html is deliberately absent: one path there
// covers three subsystems, so it routes by symbol below.
const PATH_RULES = [
  [/^data\/travel\.json$/, [T_GRAPH]],
  [/^scripts\/derive_travel_graph\.py$/, [T_GRAPH]],
  [/^scripts\/mapgeom\.py$/, [T_GRAPH]],
  [/^src\/mapgeom\.js$/, [T_GRAPH]],
  [/^scripts\/(import_pack|pack_colors)\.py$/, [PACK]],
  [/^src\/pack_convert\.js$/, [PACK, BUILD]],
  [/^src\/builder\.html$/, [BUILDER, LICENSING]],
  [/^scripts\/build_builder\.py$/, [BUILDER, BUILD]],
  [/^data\/_generated\//, [PACK]],
  [/^scripts\/build\.py$/, [BUILD, T_RUNTIME]],
  [/^data\/world\.json$/, [BUILD, XPAC, T_GRAPH, OVERLAY]],
  [/^data\/continents\//, [OVERLAY, T_GRAPH]],
  [/^tools\/verify\//, [VERIFY]],
  [/^LICENSE$/, [LICENSING]],
];

// Changed lines in src/template.html route by the symbols the AGENTS.md table names.
const SYMBOL_RULES = [
  [/\b(tPlan|tRender|TROUTE|zoneDimmed|TRAVEL_AVAILABLE|travelUnavailable)\b/, [T_RUNTIME]],
  [/\b(recomputeXpac|XPAC_[A-Z]|ALTITUDES)\b|\bMETA\[/, [XPAC]],
  [/\b(contData|buildOverlay|applyContOverlay|applyWorldOverlay|WEDIT)\b|\bEDIT\[/, [OVERLAY]],
  [/\b(zoneXf|tPoint|hubHasLetter)\b/, [OVERLAY, T_GRAPH]],
  [/\bdetectLinks\b/, [PACK]],
  [/\bexportStandaloneHTML\b|__(?:END_)?(?:AUTHOR|USER)__/, [BUILD, LICENSING]],
];

const TEMPLATE = 'src/template.html';

function git(args) {
  return execFileSync('git', args, {
    encoding: 'utf8',
    timeout: 4000,
    maxBuffer: 16 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

// Both halves of the tree, because commits here are compound: "git add x; git commit" runs
// after this hook, so the index is not necessarily populated yet. Untracked files count as
// touched. Porcelain v1 paths are repo-root-relative with forward slashes on every platform.
function changedPaths() {
  const paths = new Set();
  for (const line of git(['-c', 'core.quotepath=false', 'status', '--porcelain']).split('\n')) {
    if (line.length < 4) continue;
    let p = line.slice(3);
    const arrow = p.indexOf(' -> ');            // rename/copy: route on the destination
    if (arrow !== -1) p = p.slice(arrow + 4);
    paths.add(p.replace(/^"(.*)"$/, '$1').trim());
  }
  return [...paths];
}

function templateSymbolHits() {
  const hits = new Set();
  const diff = git(['diff', 'HEAD', '-U0', '--', TEMPLATE]);
  const touched = diff
    .split('\n')
    .filter((l) => /^[+-]/.test(l) && !/^(\+\+\+|---)/.test(l))
    .join('\n');
  if (!touched) return { hits, scanned: false };
  for (const [re, docs] of SYMBOL_RULES) {
    if (re.test(touched)) docs.forEach((d) => hits.add(d));
  }
  return { hits, scanned: true };
}

// Returns { docs, matched, templateUnmatched }. Throws nothing: a git failure surfaces as an
// empty result and the caller falls back to the generic reminder.
//
// `matched` is only the paths that produced a doc, never the whole dirty set -- it is printed
// as the evidence for `docs`, and a truncated list of unrelated paths would argue against the
// conclusion above it (a data/_generated/ refresh dirties hundreds of files).
function route() {
  let paths = [];
  try {
    paths = changedPaths();
  } catch {
    return { docs: [], matched: [], templateUnmatched: false };
  }

  const docs = new Set();
  const matched = new Set();
  for (const p of paths) {
    for (const [re, targets] of PATH_RULES) {
      if (re.test(p)) {
        targets.forEach((d) => docs.add(d));
        matched.add(p);
      }
    }
  }

  let templateUnmatched = false;
  if (paths.includes(TEMPLATE)) {
    try {
      const { hits, scanned } = templateSymbolHits();
      hits.forEach((d) => docs.add(d));
      if (hits.size) matched.add(TEMPLATE);
      templateUnmatched = scanned && hits.size === 0;
    } catch {
      templateUnmatched = true;                  // no diff available: say so, don't guess
    }
  }

  return { docs: [...docs].sort(), matched: [...matched].sort(), templateUnmatched };
}

process.stdin.setEncoding('utf8');
let raw = '';
process.stdin.on('data', (d) => { raw += d; });
process.stdin.on('end', () => {
  let cmd = '';
  try {
    cmd = (JSON.parse(raw).tool_input || {}).command || '';
  } catch {
    process.exit(0);            // malformed payload: stay silent rather than block a commit
  }

  // Match a real commit invocation anywhere in a compound command, allowing flags between
  // (git -C path commit). Deliberately does NOT try to exclude a "git commit" occurring
  // inside a commit message; a spurious reminder is cheap, a missed one is not.
  if (!/\bgit\b(?:\s+-[^\s]+(?:\s+[^\s-][^\s]*)?)*\s+commit\b/.test(cmd)) process.exit(0);

  const { docs, matched, templateUnmatched } = route();

  const lines = [
    'Before this commit lands, re-read AGENTS.md, then CLAUDE.md, then every docs/reference/',
    'file for a subsystem you touched (plural - a change spanning two is the normal case).',
    '',
  ];

  if (docs.length) {
    lines.push('Routed from the working tree, per the AGENTS.md table - read these:');
    for (const d of docs) lines.push(`  ${d}`);
    const shown = matched.slice(0, 6).join(', ');
    lines.push(`  (matched from: ${shown}${matched.length > 6 ? `, +${matched.length - 6} more` : ''})`);
    lines.push('');
  }
  if (templateUnmatched) {
    lines.push(`No routing symbol matched the ${TEMPLATE} diff - check the AGENTS.md table`);
    lines.push('yourself. The table is keyed on symbols the mirror in this hook may not carry.');
    lines.push('');
  }

  lines.push(
    'Ask one question: did this change teach something a future reader cannot recover from',
    'the code itself, or falsify something those files already claim? If yes, update the file',
    'in THIS commit - and which file is decided by kind, not convenience:',
    '',
    '  AGENTS.md              an invariant the code relies on but does not state; a trap that',
    '                         looks like a bug and is not; a rule about where something goes.',
    '                         A couple of sentences, never a paragraph.',
    '  docs/reference/<sub>   the reasoning record: an alternative rejected and why, a measured',
    '                         figure, the derivation behind a constant, the argument for a rule',
    '                         AGENTS.md merely states.',
    '  tools/verify/README    what a verification layer covers and which bug it caught.',
    '',
    'These files are instructions, not a changelog. Do not add what-changed entries, dates,',
    'or version history, and do not restate what the code plainly says. When a fact in them',
    'stops being true, correct it in place instead of appending a newer note beside it.',
    '',
    'If nothing qualifies, say so in one line and proceed. See AGENTS.md, "Keeping these',
    'instructions current", which owns this split.',
  );

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      additionalContext: lines.join('\n'),
    },
  }));
});
