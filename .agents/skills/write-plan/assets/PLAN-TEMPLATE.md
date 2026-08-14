# <Topic> — implementation plan

<!--
  Three hands touch this file, and each owns exactly one part of it.

    Phase 1  Claude Code  writes everything down to "Execution Log" and stops.
    Phase 2  Codex CLI    appends to "Execution Log" and edits nothing above it.
    Phase 3  Claude Code  appends to "Review".

  Live in docs/internal/, which is git-ignored — so this file survives branch switches and never
  lands in a commit. That is deliberate: it is the side channel between sessions, not an artifact.
-->

## Handoff

| | |
|---|---|
| **Executor** | Codex CLI, launched from the repo root |
| **Branch** | `plan/<topic>` |
| **Base commit** | `<sha>` |
| **Status** | `DRAFT` → `READY FOR CODEX` → `IN PROGRESS` → `AWAITING DECISION` → `EXECUTED` → `REVIEWED` |

The base commit is what phase 3 diffs against. Record the SHA *before* Codex starts and never
amend it — a wrong SHA silently produces a review of the wrong change.

Two provenance rules apply to this plan and every later amendment:

1. Each acceptance criterion is derived from the command or artifact it checks, never from a prior
   round's prose, and **names the expected set rather than counting it**. A phase-2 skip-category
   count was transcribed as a step count in the next round, producing a criterion no run had met.
2. When an amendment changes the contract, **supersede it in place** and leave a short note saying
   what changed and why; do not restate the changed contract alongside the old one.

## Goal

One paragraph. What is materially different about the repository when this is finished. Not the
method — the outcome.

## Acceptance criteria

Testable, checkable without judgement calls. If a criterion needs someone to decide whether it was
met, it is a goal, not a criterion.

- [ ] `python tools/verify/run.py` passes
- [ ] …

## Reference reading

From the `AGENTS.md` routing table. Two rows is the normal case, not a sign the wrong file was
picked.

| Because the change touches | Read first |
|---|---|
| … | `docs/reference/….md` |

## Files to touch

| File | Change | Why this file and not a neighbour |
|---|---|---|
| … | … | … |

## Out of scope

The list that stops the change from growing. Name the adjacent thing that looks like it belongs
and does not, and say why it is being left alone.

- …

## Open questions — do not resolve these alone

Each one names who decides. An executor that answers these has substituted its judgement for the
decision this plan was supposed to surface.

- …

## Steps

### Step 1 — <title>

**Do:** …

**Verify:** the command or observation that closes this step.

**Stop and ask if:** the specific condition, if this step has one beyond the standing list.

### Step 2 — <title>

…

---

## Execution Log — Codex appends here

> One entry per step, appended as the step finishes. This is the only record of what actually
> happened; phase 3 reads it before the diff. An unlogged deviation reads as a defect.

### Step 1 — `done` | `deviated` | `stopped`

- **Commit:** `<sha>` `<subject>`
- **Did:** what actually changed, in one or two lines.
- **Deviated:** what departed from the plan and the reason. `none` if none.
- **Left undone:** anything the step called for that did not happen, and why.

---

## Review — Claude appends here

> Phase 3. Reviews `git diff <base>..HEAD` against the acceptance criteria and the execution log,
> runs the verification harness, and records findings. Does not fix them.

- **Verify run:** command, result.
- **Criteria met:** …
- **Findings:** each with the file and line that grounds it.
- **Deviations accepted / rejected:** with the reason for each.
