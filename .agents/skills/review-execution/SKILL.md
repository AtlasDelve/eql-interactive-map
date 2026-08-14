---
name: review-execution
description: Verify work an executor session finished against the plan it was given. Use when the user says "review what Codex did", "verify the implementation", "check the execution", or points at a plan file with Status EXECUTED or AWAITING DECISION. Reviews the diff against the recorded base commit, runs the verification harness, and records findings without fixing them.
---

# Review a finished execution

Phase 3 of three, and a fresh session on purpose. You did not write the plan and did not execute
it, which is the whole point: neither prior session can see its own blind spot.

## Steps

**1. Read in this order, and do not reorder it.** Plan → Execution Log → diff. Reading the diff
first anchors you on what was built and makes the plan read as a description of it.

```
git diff <base>..HEAD --stat
git diff <base>..HEAD
```

The base SHA is in the plan's Handoff table. If `git rev-parse HEAD` sits on a different branch
than the plan names, or the base is not an ancestor of HEAD, say so and stop — the diff is not
the change.

**2. Run the harness yourself.** `python tools/verify/run.py`. Do not take the execution log's
word for it; a passing run recorded before the last two commits is not a passing run.

**3. Walk the acceptance criteria one at a time**, and cite the evidence for each — a diff hunk, a
harness layer, a command output. A criterion marked met with no evidence is not met.

**4. Arbitrate every logged deviation.** Accept it with a reason or reject it with one. This is
the judgement the split exists to produce, and it is the part that cannot be delegated back to the
user as "here are the differences".

**5. Look for what the log does not mention.** Diff hunks outside the plan's *Files to touch*
table, work that reached into *Out of scope*, an *Open question* that got quietly answered. An
unlogged deviation is the finding, independent of whether the code is good.

**6. Then review the code on its own terms**, against `AGENTS.md` and the `docs/reference/` files
the routing table names. The six principles are where real defects cluster: deriving at build time
what a cosmetic change could move, reading live edit state where published is required, silently
reconciling authored against regenerated, comparing a sparse overlay against identity.

**7. Append to the Review section and set Status to `REVIEWED`.**

## Do not fix anything

The moment you start patching, the review is over — you become an author defending your own work,
and there is no one left to catch it. Findings go back to the executor as an amendment appended to
the plan file, with the base SHA updated to the current HEAD for the next round.

The one exception is a finding you cannot describe without demonstrating it. Even then, write the
demonstration in the Review section, not into the tree.

## Reporting

Rank findings by whether they change the code or merely improve it, and lead with the first group.
Say plainly when a section is clean — a review padded with style notes buries the two findings
that mattered.
