---
name: write-plan
description: Write an implementation plan that Codex CLI will execute in a separate session. Use when planning a multi-file change, a 3+ step task, an architectural decision, or an ambiguous requirement in this repo, and whenever the user says "write a plan", "plan this out", or "hand this to Codex". Produces a topic-named plan under docs/internal/ from the handoff template. Not for reviewing work that already exists.
---

# Write a plan for Codex to execute

Phase 1 of three. The plan is not a note to yourself — it is the entire contract with a session
that has never seen this conversation, cannot ask a quick follow-up, and will read only what is on
disk. Everything implicit here becomes a guess there.

## Steps

**1. Read before you write.** `AGENTS.md`, then every `docs/reference/` file its routing table
points at for the subsystems in scope. A plan written without them proposes something already
tried and rejected with a measurement attached to it.

**2. Copy the template and follow its provenance rules.**
`.agents/skills/write-plan/assets/PLAN-TEMPLATE.md` → `docs/internal/<topic>-plan.md`, **named for
its topic**. The two rules beside its Handoff block govern acceptance criteria and later
amendments. A later session told to "execute the plan" is working in this repo; a generated name it
cannot guess is as good as no plan.

**3. Record the git boundary before anything else.** Branch `plan/<topic>`, and the base commit
SHA as it stands right now. Phase 3 diffs against that SHA — record it late or amend it and the
review silently covers the wrong range.

**4. Fill the four sections that do the real work.** The steps are the easy part; these are what
separate a plan Codex can execute from prose it has to interpret:

- **Acceptance criteria** — checkable without judgement. If someone has to decide whether it was
  met, it belongs under Goal instead.
- **Files to touch** — and why that file rather than the neighbour that looks equally plausible.
- **Out of scope** — name the adjacent thing that looks like it belongs. This is the section that
  stops a two-file change from becoming a nine-file one.
- **Open questions** — with who decides. An executor that answers these has silently made the
  decision the plan existed to surface.

**5. Give every step a verification.** A step whose completion cannot be observed will be reported
as done regardless of whether it was.

**6. Flag the stop conditions this change actually has.** The standing list lives in
`.codex/config.toml`; add per-step conditions only where this change has one the standing list
misses.

**7. Run the adversarial pass, then `advisor()`.** Per `CLAUDE.md` → *Plan review*. Fold each
finding in or reject it with a stated reason recorded in the plan file itself, so phase 3 can see
what was already considered and settled.

**8. Set Status to `READY FOR CODEX`.** Leave the Execution Log and Review sections empty — they
belong to the other two phases, and pre-filling them destroys the record of what actually happened.

## What not to do

Do not start implementing. The value of the split is that the executor reads the plan cold; a
half-built change makes the plan a description of work already done and the review a formality.

Do not soften the licensing boundary into a step. Anything touching `data/`, redistribution, the
pack traces or repo visibility goes in **Open questions** with the user as decider — `AGENTS.md`
is explicit that these are surfaced, never decided by an agent.
