# CLAUDE.md

Guidance for Claude Code (claude.ai/code) in this repository.

Project guidance applies to any coding agent, so it lives in `AGENTS.md` and is imported here — what
this is, commands, the two editions, the build pipeline, the data model, the principles the whole tree
obeys, verification, and the licensing boundary:

@AGENTS.md

**Per-subsystem depth is not in that file.** The travel graph and runtime, expansion selection, the
customization overlay and the pack importer each have a reference file under `docs/reference/`,
reached from `AGENTS.md`'s routing table. They are deliberately *not* imported — inlining them would
rebuild the file the split dismantled — so read the matching one before touching that code.

Claude Code-only instructions follow — harness features, skills, subagent routing, tool
permissions. Put anything a different agent would also need in `AGENTS.md` instead.

## The split workflow: you plan and verify, Codex implements

Substantial work in this repo runs in three sessions, and **you are two of them**. Claude Code
writes the plan and later verifies the result; Codex CLI does the implementation in between. The
sessions share nothing but the repository and one file.

| Phase | Session | Skill | Owns |
|---|---|---|---|
| 1 | Claude Code | `.agents/skills/write-plan/` | `docs/internal/<topic>-plan.md`, everything above its Execution Log |
| 2 | Codex CLI | `.agents/skills/execute-plan/` | the commits, and the Execution Log |
| 3 | Claude Code, **fresh** | `.agents/skills/review-execution/` | the Review section |

The plan file is the entire contract. Codex has no access to the conversation that produced it and
cannot ask a quick follow-up, so anything left implicit becomes a guess — which is why the template
at `.agents/skills/write-plan/assets/PLAN-TEMPLATE.md` forces acceptance criteria, an explicit
*Out of scope* list, and *Open questions* naming who decides.

**Three rules carry most of the value, and each fails silently when skipped.**

- **Record the base commit SHA before Codex starts, and never amend it.** Phase 3 reviews
  `git diff <base>..HEAD`. A late or amended SHA produces a confident review of the wrong range.
- **The Execution Log is not optional.** Codex will deviate, often correctly. Undeviated plans do
  not exist. Without the log, phase 3 compares code against a plan that was quietly abandoned and
  cannot tell a considered departure from a defect.
- **Phase 3 does not fix anything.** The moment the reviewer patches, it becomes an author
  defending its own work and there is nobody left to catch it. Findings go back as an amendment
  appended to the plan file, with the base SHA advanced to the current HEAD.

Phase 3 is a *new* session on purpose. Reviewing in the session that wrote the plan buys almost
nothing: it remembers the reasoning and reads the gaps as obvious.

Codex's side of this — the executor role and its stop-and-ask list — lives in `.codex/config.toml`
→ `developer_instructions`, with the wiring explained in `.codex/README.md`.

## Plan review: a Codex pass, then advisor

Before finalizing or submitting a plan in this repo, run a Codex pass over it, fold the findings
in, and **then** call `advisor()`. The rule covers `ExitPlanMode` and any plan for a
multi-file change, a 3+ step task, an architectural decision, or an ambiguous requirement — the
same threshold that sends the work into plan mode in the first place. **On the `Edit|Write` path a
hook enforces it; on `ExitPlanMode` nothing does, so that half is yours to keep** (below).

**This is the closing step of phase 1 above**, and the split workflow makes it worth more than it
was: the pass now runs on the same engine that has to execute the plan, so an objection is a
feasibility signal as well as a design one. A plan Codex argues with at review time is a plan
Codex will stop on at step three.

**The order is load-bearing, not a preference.** `advisor()` receives the entire transcript, so
running Codex first puts its objections in front of the stronger reviewer and lets that reviewer
arbitrate them. Reversed, the Codex findings land after the only reviewer able to rule on them has
already spoken, and nothing adjudicates a disagreement between the two. Fold each finding into the
plan or reject it with a stated reason *before* the advisor call, so what advisor sees is the
revised plan plus the open disagreements.

**Write the plan to a file under `docs/internal/` first, and name that path in the request.** Codex
runs as a separate process with no access to this conversation — it reviews what is on disk, so an
unwritten plan gets reviewed as nothing. (`docs/internal/` is the git-ignored home for planning
material; see `AGENTS.md`.) This doubles as the durability an advisor call wants anyway.

**Run the pass with `codex exec` through the Bash tool**, not through a subagent:

```
codex exec -s read-only -c model_reasoning_effort=high "<prompt naming the plan path>" < /dev/null
```

`-s read-only` is the point: it makes "review only, do not edit" a sandbox property instead of a
sentence in the prompt that a reviewer may read past. `< /dev/null` keeps it from waiting on stdin.
Run it with `run_in_background: true` — a high-effort pass over a large plan takes minutes.

**Do not route this gate through the `Agent` tool.** An earlier version of this section called for
the `codex:codex-rescue` subagent and declared itself a standing authorization for that call. That
failed twice, for two independent reasons, and naming a subagent here is what caused both:

- Harness configuration can carry a blanket "do not call the Agent tool unless the user requested it" instruction. It is injected into the system prompt and is **not** in any settings file in this repo or under `~/.claude/`, so it cannot be edited away. A `CLAUDE.md` paragraph asserting authority over it is prose arguing with prose, and it loses often enough to be worthless.
- That subagent's headless path deny-ACEs `.git` in this repo, so it fails here regardless.

`codex exec` sidesteps both: it is a Bash call, so no subagent rule engages and there is nothing to
weigh. Deleting the mechanism beats defending it.

`/codex:adversarial-review` also cannot serve this gate: it is `disable-model-invocation: true`, so
only a human can type it, and it is scoped to a git diff, which a plan does not have. It remains
the right tool for challenging an *implementation* once code exists.

**A plan or amendment is not `READY FOR CODEX` until the pass is recorded in the file.** Append a
`## Codex fold` section — same convention as the existing `## Review fold` and `## Advisor fold` —
naming each finding and whether it was folded in or rejected with a reason.
`.claude/hooks/check-plan-codex-fold.js` blocks the write that would mark a plan ready without
one; if it fires, run the pass rather than working around it. An `## Arbitration record` counts
too — that is what the pre-hook plans used to record the same thing. A fold section with **no
content** does not count, and once a plan carries amendments the **newest** `## Amendment N` needs
its own `## Codex fold — Amendment N`; earlier ones are grandfathered.

**On `ExitPlanMode` the gate is a discipline, not a mechanism — run the pass yourself.** This is
settled, not provisional: **as of Claude Code 2.1.270 no `PreToolUse` invocation reaches the hook for
`ExitPlanMode`**, measured from a fresh session with out-of-band instrumentation logging every
invocation — it recorded the plan-file `Write` and recorded nothing for an approved, fold-less
`ExitPlanMode`. So the matcher in `settings.json` is inert and **nothing blocks you here.** The
measurement is version-scoped and decays on Anthropic's release schedule; re-measure only if a
changelog suggests it, and instrument the same way. **Do not re-run the old two-outcome retest — it
is spent.**

If Codex is missing, unauthenticated, or the pass fails, say so plainly and continue: a failed or
skipped Codex pass must never block the `advisor()` call.

## Harness wiring for the `AGENTS.md` rules

Both live in `.claude/settings.json`, which is checked in — so they apply to anyone working this
repo in Claude Code, not just this machine.

- **Plan location — `plansDirectory` does not work; assume the opposite of what it promises.**
  `.claude/settings.json` sets `plansDirectory: "docs/internal"`, and it has had no effect since it
  was added in `b06c67f` (2026-08-13). Plan mode still writes to `~/.claude/plans/<generated-name>.md`
  — verified directly on 2026-09-13, and by files dated 2026-09-03 and 2026-09-04 sitting there.
  **So there IS a second copy to keep in sync, and the plan file you must hand to Codex is not the
  one plan mode wrote.** Move it to `docs/internal/<topic>-plan.md` yourself and give it a topic
  name; the harness generates one a later session cannot guess. The b9 plan's own *Step 0* is a
  manual `mv` for exactly this reason — that is the workaround, not an oversight.
- **Commit-time docs reminder.** A `PreToolUse` hook (`.claude/hooks/check-agent-docs.js`) prints
  the reminder from `AGENTS.md` → *Keeping these instructions current* when a `git commit` is about
  to run, and **names the reference files the change routes to**, derived from `git status` plus a
  mirror of that file's routing table — so the lookup that gets skipped is already done. Deliberately
  **non-blocking**: it raises the question at the right moment and leaves the judgement where that
  section puts it. Keeping the mirror in step with the table is an `AGENTS.md` rule, stated beside
  the table itself.
