---
name: execute-plan
description: Execute an implementation plan written by another session, keeping the execution log as you go. Use when handed a path under docs/internal/ ending in -plan.md, when the user says "execute the plan", "implement this plan", "$execute-plan", or sets a goal pointing at a plan file. You are the executor, not the author -- stop and ask rather than redesign.
---

# Execute a plan you did not write

Phase 2 of three. The plan came from a session that read the reference material, argued the design
against a reviewer, and settled trade-offs you cannot see. Its steps are decisions, not
suggestions.

That does not make it correct. It makes disagreement worth **surfacing rather than resolving** —
the author is one message away, and a silent correction costs the reviewer in phase 3 far more
than a pause costs you now.

## Steps

**1. Read the plan whole before touching anything.** Then read `AGENTS.md`, then every
`docs/reference/` file the plan's Reference reading table names. Check Status is
`READY FOR CODEX`; anything else means the plan is not yours to run yet.

**2. Check out the branch and confirm the base.** `git rev-parse HEAD` must match the recorded
base commit. If it does not, stop — the review at the end depends on that boundary, and you
cannot repair it after the fact.

**3. Set Status to `IN PROGRESS`.**

**4. Work one step at a time, and commit each one.** A commit per step is what makes the phase-3
diff legible. The commit-time hook will name the docs the change routes to; act on it in that same
commit, as `AGENTS.md` → *Keeping these instructions current* requires.

**5. Append to the Execution Log as each step finishes — not at the end.** Commit SHA, what
actually changed, what deviated and why, what was left undone. A log written from memory after six
steps is a summary; the reviewer needs the record.

**6. Run the verification the plan names**, plus `python tools/verify/run.py` before you report
done if the change touched `src/template.html` or `scripts/build.py`.

**7. Set Status to `EXECUTED`** and report: steps completed, deviations, anything left undone,
and the head SHA.

## Stop and ask — do not work around

Halt, append the objection and the options to the Execution Log, set Status to
`AWAITING DECISION`, and wait. Do not pick one and continue.

- A step contradicts `AGENTS.md` or a `docs/reference/` file, or the plan asserts something one of
  them falsifies.
- A step needs something on the **Out of scope** list, or answering an **Open question**.
- Anything touching `data/`, the licensing boundary, redistribution, the pack traces, root-layer
  zones, or making the repo public. `AGENTS.md` is explicit: surface, never decide.
- Adding a ninth injected structure, or anything else the plan sized as one line and turns out to
  reach into `tools/verify/test_markers.py`, `fixture.py` and `verify.py`.
- A step cannot work as written, or the file it names does not contain what it expects.
- Verification fails for a reason the plan did not anticipate.

Waiting is cheap. The plan was reviewed before it reached you; departing from it unilaterally
throws that review away, and phase 3 has no way to tell a considered deviation from a mistake
unless you say which it was.

## What is yours to decide

Everything the plan left to implementation: naming inside a function, the order of independent
edits within a step, how to express something the plan describes but does not spell out. Log the
ones a reviewer would want to know about; do not log every variable name.
