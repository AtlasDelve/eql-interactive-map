# Codex CLI setup for this repo

The Codex-side twin of `.claude/`. Same three capabilities, different wiring: project
instructions, a commit-time docs reminder, and the subagents behind the review gates.

`AGENTS.md` is the part that needed no work — Codex discovers and loads it natively, which is why
`CLAUDE.md` imports it rather than duplicating it. Everything in this directory exists to
reproduce the pieces `.claude/settings.json` and the Claude Code-only half of `CLAUDE.md` provide.

## Turn it on

```
codex
```

from the repo root, and accept the trust prompt. **Nothing here loads in an untrusted project** —
not `config.toml`, not `hooks.json`, not `agents/` — and the session gives no obvious sign of it.
That is the first thing to check if the gate never fires. To declare trust ahead of time, in
`~/.codex/config.toml`:

```toml
[projects."C:\\source\\repos\\eql-interactive-map"]
trust_level = "trusted"
```

Then run `/hooks` once. Codex requires you to review and trust each non-managed hook before it
runs, and it records that trust against the hook's **current hash** — so editing
`check-agent-docs.js` or `hooks.json` marks the hook for review again and it stays skipped until
you re-approve. Expect to revisit `/hooks` after any change to either file.

Launch Codex from the repo root. Both harnesses pass the hook a path relative to the working
directory, and Codex runs hook commands with the session `cwd`, not the repo root.

## What maps to what

| Claude Code | Codex | Notes |
|---|---|---|
| `CLAUDE.md` → `@AGENTS.md` import | `AGENTS.md`, loaded natively | No wiring needed. `project_doc_max_bytes` caps how much is read if it ever grows. |
| Claude Code-only half of `CLAUDE.md` | `developer_instructions` in `.codex/config.toml` | Injected every session, so it stays short. |
| `.claude/settings.json` → `hooks.PreToolUse` | `.codex/hooks.json` | Same event names, same stdin payload, same `hookSpecificOutput.additionalContext` reply — one script serves both. |
| `.claude/hooks/check-agent-docs.js` | *(same file, shared)* | Not duplicated. It lives under `.claude/` for historical reasons only; nothing in it is Claude-specific. |
| `plansDirectory: "docs/internal"` | *(no equivalent)* | Codex has no managed plans directory. The rule moved into `developer_instructions`, which is why it names the `docs/internal/<topic>-plan.md` path explicitly. |
| Subagents (`Plan`, `Explore`, `codex:codex-rescue`) | `.codex/agents/*.toml` + built-ins | `explorer` ships with Codex. `planner` and `reviewer` are here. |
| Plan-review gate in `CLAUDE.md` | `developer_instructions` + the `reviewer` agent | Applies when Codex works alone. In the split workflow below, planning happens on the Claude side and the gate runs there. |
| Slash commands (`/review`, `/security-review`) | skills, invoked with `$` | Codex ships `/review` for a working-tree diff. `$execute-plan` covers the handoff case. |
| `.claude/skills/`, plugins | `.agents/skills/` (repo root) | Codex scans `.agents/skills` from cwd up to the repo root, plus `~/.agents/skills` for personal ones. |

## Files

- **`config.toml`** — project-scoped config. Carries `developer_instructions` (the harness rules),
  `[features].hooks`, and the `[agents]` thread/depth caps.
- **`hooks.json`** — `PreToolUse` on `Bash`, running the shared docs-reminder script. Advisory:
  it injects context and exits 0, and can never veto a commit.
- **`agents/reviewer.toml`** — read-only adversarial review of a plan or a diff.
- **`agents/planner.toml`** — read-only design pass, for when Codex works without a handed-down
  plan. Produces the plan; never writes it.

## The split workflow

Substantial work here runs across three sessions: **Claude Code plans, Codex implements, a fresh
Claude Code session verifies.** Codex's role is executor — it implements a plan it did not write,
and **stops and asks** rather than redesigning. The stop conditions are in `config.toml` →
`developer_instructions`; the Claude side is in `CLAUDE.md` → *The split workflow*.

The three phases have a skill each, in `.agents/skills/` at the repo root (Codex scans that path;
Claude reads them directly):

| Phase | Session | Skill |
|---|---|---|
| 1 | Claude Code | `write-plan` — builds `docs/internal/<topic>-plan.md` from the template |
| 2 | Codex | `execute-plan` — implements it, keeps the Execution Log |
| 3 | Claude Code, fresh | `review-execution` — diffs against the base SHA, runs the harness |

Running phase 2:

```
codex
/goal Execute docs/internal/<topic>-plan.md
```

Point the goal at the file rather than pasting the plan — goals cap at 4,000 characters, and the
plan is the artifact both other sessions read. `docs/internal/` is git-ignored, so it survives
branch switches and never lands in a commit.

Three things hold the loop together, and each fails quietly when skipped: the **base commit SHA**
recorded before Codex starts (phase 3 diffs against it), the **Execution Log** written as each
step lands rather than reconstructed at the end, and **one commit per step** so the phase-3 diff
stays legible. The commit-time hook fires on every one of those commits, which is how the docs
reminder reaches Codex at all.

## Two known warts

**The reminder text says "then CLAUDE.md".** Under Codex the equivalent is
`.codex/config.toml` → `developer_instructions`, and the hook does not know which harness called
it. Harmless — the surrounding advice is harness-neutral — but the line is worth rewording to
name both when the script is next touched. Same for `AGENTS.md` → "Keeping these instructions
current", which says the same thing.

**Trust is per-hash, not per-file.** See the `/hooks` note above. Editing the hook silently
disables it until re-approved, which looks exactly like the hook not working.

## What lives outside this repo

Project-local config deliberately cannot set provider, auth, notification, telemetry or
profile-selection keys — Codex ignores `model_provider`, `notify`, `profile`, `profiles`, `otel`
and friends here and warns at startup. Those belong in `~/.codex/config.toml`, along with:

- `model`, `model_reasoning_effort`, `approval_policy`, `sandbox_mode` — session defaults.
- `[mcp_servers.*]` — the Codex analogue of Claude Code's MCP config. Same idea, TOML instead of
  JSON; `enabled_tools` / `disabled_tools` narrow a server's surface, `startup_timeout_sec`
  defaults to 10 and `tool_timeout_sec` to 60.
- `~/.agents/skills/` — personal skills, available in every repo.
- `[[skills.config]]` — disable a skill by path without deleting it.

Custom prompts (`~/.codex/prompts/*.md`, invoked as `/prompts:name`) still work but are
**deprecated** in favour of skills. Don't build new ones there.
