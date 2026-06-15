---
name: code-review
description: Run code reviews, from ordinary patch review to domain-focused sub-agent review boards. Use when the user asks to review code, review a patch/diff/PR, run security/correctness/performance/architecture/release/CI review, spin up reviewer agents, delegate reviewers, or synthesize pass/conditional/block findings with severity, confidence, actionability, and machine-parseable output.
---

# Code Review

## Overview

Run independent reviewer agents over the same change set, keep findings separated by domain, then synthesize a severity-ordered go/no-go.

The skill is for review orchestration, not implementation, unless the user explicitly asks to apply fixes after the review.

Default safety posture: read-only. Do not edit files or write comments unless the user explicitly requests edits.

Always persist the finished review to a temporary markdown file via the bundled writer (see "Persisting the review"). This applies to every run, board or solo, pass or block. Writing that one temp artifact is the sole exception to the read-only posture; it never touches the reviewed codebase.

## Board Mode Contract

- Treat an explicit `$code-review`, `$code-review:code-review`, or "use the code-review skill" invocation as review-board mode unless the user explicitly asks for a solo/no-agent review.
- Spawn agents for review-board mode. Do not perform a parent-thread solo review and present it as a code-review skill result.
- In Codex, explicit asks include phrases like "spawn agents", "review board", "delegate reviewers", "parallel reviewers", "one agent per point", naming multiple reviewer agents to run, or invoking the code-review skill by name.
- In Codex review-board mode, read `references/codex-adapter.md` before reviewer selection and obey it as mandatory execution mechanics.
- If Codex multi-agent tools are not visible, use `tool_search` with `multi-agent spawn_agent Codex`, then use the returned `multi_agent_v1` tools.
- If real agents cannot be spawned in review-board mode, start the final answer with `AGENT BOARD NOT RUN: <reason>`, set verdict to `invalid`, and do not silently fall back to a normal review.
- The final review-board output must include reviewer names and agent ids. If no agent ids are present, the code-review skill contract was not satisfied.
- Spawn agents only after defining the review scope.
- Use one canonical reviewer catalog for all runtimes. Runtime-specific agent files may exist, but they are generated/adapted from this skill contract.
- Define review scope before spawning:
  - changed files
  - commit range
  - branch pair (`base..head`)
  - or explicit paths
- Keep reviewers independent: pass scope + domain instructions without biasing expected findings.
- Set follow-up reviewers with only the smallest set of relevant findings.
- Keep any branch or checkout actions read-only unless explicitly permitted.

## Runtime routing

Keep review semantics shared, but keep subagent execution runtime-specific.

- In Codex, read `references/codex-adapter.md` before spawning reviewer agents.
- In Claude Code, read `references/claude-code-adapter.md` before spawning reviewer agents.
- Do not mix Claude Code `agents/*.md` assumptions into Codex execution.
- Do not mix Codex `multi_agent_v1` tool calls into Claude Code execution.
- If runtime-specific adapter guidance conflicts with this shared skill, this shared skill owns the review contract and the adapter owns the mechanics.

## Unified Runtime Approach

Use the same review semantics in Claude Code and Codex, but adapt execution to what the runtime actually supports.

- Canonical source: this `SKILL.md` plus `references/review-checklists.md`.
- Claude Code adapter: `references/claude-code-adapter.md`.
- Codex adapter: `references/codex-adapter.md`.
- Model preferences are advisory metadata, not correctness requirements. The review must still work when all reviewers run on the current parent model.
- If a generated runtime manifest disagrees with this skill, this skill wins.

## Inputs and Scope Capture

- If scope is unclear, collect it first:
  - explicit file list
  - commit hash or range
  - or `git diff`/`git show` target
- Prefer narrow reviewer context:
  - changed hunks first
  - directly touched files second
  - direct call graph or dependency-affect graph only when needed
  - broad repository context only for architecture/release questions that require it
- For workflow/release changes, capture workflow permissions, triggers, and guard conditions explicitly.
- Record command constraints that could affect review validity (network, root access, credentials, caches).

## Command index (reviewer entry points)

Use these as deterministic review commands. Each command name maps to one reviewer role; scope/context is provided externally.

- `review-router`: pick the smallest useful reviewer set from diff shape, touched systems, and risk boundaries.
- `security-reviewer`: trust boundaries, command execution surfaces, secrets, permissions, and workflow hardening.
- `correctness-reviewer`: regressions, edge cases, idempotency, migration, release semantics, and contract drift.
- `performance-reviewer`: complexity, process/fan-out, memory and I/O scaling, and avoidable recomputation.
- `quality-reviewer`: readability, naming, diagnostics, maintainability, and consistency with repo conventions.
- `requirements-reviewer`: explicit requirement coverage, acceptance criteria, and assumption gaps.
- `contextual-quick-wins-reviewer`: low-risk, low-cost improvements adjacent to the patch.
- `redundancy-reviewer`: duplication and reuse checks, redundant state/logic checks, and unnecessary parallelism.
- `history-reviewer`: backward compatibility, migration/deprecation continuity, and docs/changelog alignment.
- `style-reviewer`: context-aware style fit in target area (e.g., `qol-tray` UI vs CLI conventions).
- `optimization-reviewer`: cache misses, duplicate parsing, dependency churn, and hotspot complexity.
- `architecture-reviewer`: ownership boundaries, coupling, and data-flow integrity.
- `qol-vision-reviewer`: operator ergonomics, observability, and useful diagnostics.
- `cutting-edge-best-practices-reviewer`: deprecations, platform drift, and reproducibility changes.
- `tests-qa-reviewer`: coverage adequacy, flaky behavior, fixture quality, and oracle strength.
- `release-ci-reviewer`: triggers, permissions, checkout semantics, artifact publishing, and rerun idempotency.
- `ux-api-reviewer`: CLI/API compatibility, error UX, and config semantics.
- `compliance-and-risk-reviewer`: operational policy, provenance, and auditability risks.
- `adversarial-reviewer`: attack-path validation and assumption-breaking scenarios.

## Reviewer Board

Use the smallest set that matches the request and risk level.

Start with a lightweight router unless the user explicitly names reviewers:

- `review-router`: inspect the diff shape, user request, touched systems, and risk boundaries; select the smallest useful reviewer set. It must not produce final findings except "reviewer selection risk" notes. Prefer 3-5 reviewers for ordinary changes, 6-8 for release/security/workflow changes, and add adversarial/contextual passes only when warranted.

Core reviewers:

- `security-reviewer`: trust boundaries, command execution, path traversal, secrets, permissions, supply-chain trust, CI/workflow hardening.
- `correctness-reviewer`: regressions, edge cases, idempotency, release semantics, contract drift, migration and persistence correctness.
- `performance-reviewer`: algorithmic cost, subprocess count, parallelism, build/runtime fanout, memory and I/O scaling.
- `quality-reviewer`: maintainability, naming, structure, readability, testability, diagnostics, repo conventions.
- `requirements-reviewer`: explicit requirements, user promises, acceptance criteria, scope completeness, and undefined assumptions.

Specialized reviewers:

- `contextual-quick-wins-reviewer`: contextual nice-to-haves, unidentified quick wins, cheap diagnostics, small test gaps, local-operator ergonomics, and low-risk cleanup opportunities. This reviewer cannot block; cap output at 5 items and require each item to be actionable in one sitting.
- `redundancy-reviewer`: whether this already exists, whether existing helpers/patterns should be reused, duplicate logic/state/checks, and unjustified parallel mechanisms.
- `history-reviewer`: behavioral continuity, compatibility with old paths, migration/deprecation consistency, changelog/doc alignment, and regression risk against prior behavior.
- `style-reviewer`: context-specific style fit for the touched area, including local UI/CLI language, naming, density, component shape, diagnostics tone, and repo-specific conventions.
- `optimization-reviewer`: duplicate passes, cache misses, dependency churn, over-eager invalidation, complexity hotspots.
- `architecture-reviewer`: ownership boundaries, coupling, data flow, API contracts, rollback and migration paths.
- `qol-vision-reviewer`: operator ergonomics, diagnostics, observability, local/dev feedback loops, output readability.
- `cutting-edge-best-practices-reviewer`: deprecations, evolving platform/API constraints, toolchain drift, workflow reproducibility.
- `tests-qa-reviewer`: missing tests, flaky behavior, fixture quality, assertion and oracle gaps, CI signal quality.
- `release-ci-reviewer`: triggers, manual dispatch, checkout/build/ref alignment, permissions, cache behavior, artifact publication, idempotency.
- `ux-api-reviewer`: user-facing behavior, CLI/API compatibility, config semantics, error UX, accessibility.
- `compliance-and-risk-reviewer`: policy and operational risk (e.g. secrets handling, provenance, retention, auditability).
- `adversarial-reviewer`: malformed inputs, stale state, hostile refs, partial failures, race/retry behavior, assumptions that can be broken.

Read `references/review-checklists.md` whenever a review spans more than two domains or touches release/CI/security boundaries.

## Sequencing

- Run `review-router` first when reviewer choice is not obvious.
- Run independent primary reviewers in parallel unless they share hard dependencies.
- In Codex, "run independent reviewers in parallel" means use the Codex adapter, not parent-thread roleplay.
- In Claude Code, "run independent reviewers in parallel" means use the Claude Code adapter, not parent-thread roleplay.
- Run sequentially when one pass should inform another (for example, correctness before architecture, then performance, then adversarial).
- Run `contextual-quick-wins-reviewer` after the primary risk reviewers have enough signal; keep it separate from must-fix review so nice-to-haves do not dilute blockers.
- Execute `adversarial-reviewer` last; ask it to target the highest-impact prior findings and report only newly discovered or under-severity risks.
- While reviewers run, do non-overlapping prep work:
  - capture diff slices
  - generate reproduction commands
  - prepare synthesis template
- Use incremental checkpoints for large boards:
  1) baseline findings
  2) cross-domain synthesis
  3) adversarial challenge
- Close each agent once its findings are incorporated.

## Severity and Confidence Rubric

Use this for every finding:

- `blocker`: release-corrupting, security-critical, or data-loss risks.
- `high`: likely regression or user-visible break that blocks safe merge.
- `medium`: moderate risk, clear follow-up required before broad rollout.
- `low`: cleanup, maintainability, or optimization that should be addressed.
- `note`: non-blocking observations with good signal.

Confidence levels:
- `high`: reproducible in code path and/or validated by command output.
- `medium`: strong evidence plus likely behavior.
- `low`: plausible concern needing follow-up verification.

Actionability gates:

- Report all `blocker` and `high` findings unless clearly disproven.
- Report `medium` findings only when confidence is `high` or `medium` and there is a concrete required action.
- Collapse `low` and `note` findings unless they reveal a pattern, explain residual risk, or are explicitly requested.
- Report contextual quick wins only when they are evidence-backed, low risk, cheap to apply, and not already covered by a higher-severity finding.
- Keep security, correctness, and release findings separate from style/noise.

## Agent Prompt Template

Use prompts like this, adjusting domain and scope. Require file/line evidence for each finding.

Primary reviewer prompt:

```text
Review the current uncommitted patch in <repo path> for <domain> only. Do not edit files.

Focus files: <paths or "the current diff">.
Scope: <commit, branch range, or issue reference>.
Timebox: <optional>.

Task: <domain> review. Produce findings first, ordered by severity, with file/line references and concrete failure modes. Specifically check:
- <domain-specific concern>
- <domain-specific concern>
- <domain-specific concern>

Return a concise code-review style report:
Findings
Open questions
Residual risk

For each finding include:
- stable id (`<domain>-<number>`)
- severity (blocker|high|medium|low|note)
- confidence (high|medium|low)
- file:line or line range
- rationale and impact
- required_action
- command to verify (if applicable)
```

Contextual quick wins reviewer prompt:

```text
Review the same patch for contextual nice-to-haves and unidentified quick wins only. Do not edit files.

Report at most 5 items. Return "none" if there are no strong candidates.

Only include opportunities that are evidence-backed, low risk, cheap to apply, and adjacent to the changed code.
Do not report blockers, broad refactors, taste-only style preferences, or duplicates of security/correctness/release findings.

For each item include:
- stable id (`quick-win-<number>`)
- confidence (high|medium|low)
- file:line or line range
- why it is useful now
- concrete edit path
- expected payoff
```

Adversarial review prompt:

```text
Review the same patch for how a motivated operator could break assumptions made by prior reviewers.

Start from prior findings:
- <finding id 1 and severity>
- <finding id 2 and severity>

Produce only new/overruled findings, and only if evidence supports them.
```

## Synthesis

After reviewers return:

1. Group findings by severity and domain.
2. Deduplicate overlapping findings.
3. Keep the strictest severity when reviewers disagree.
4. Resolve conflicts:
   - if one reviewer flags and another disagrees, keep the higher confidence + stricter outcome.
5. Separate confirmed findings from plausible risks.
6. Mark must-fix items by severity and release impact.
7. Keep the verdict conservative when evidence is incomplete.
8. Rerun targeted validation when conclusions depend on dynamic behavior (security, release, persistence, migration).

Final output shape (ordered by risk):

```text
Review board result:
- Scope: <scope summary>
- Verdict: <pass | conditional | block>
- Agent board: <reviewer -> agent id/status list; required in board mode>
- Confirmed blockers: <findings only>
- Confirmed high: <findings only>
- Confirmed medium: <findings only>
- Confirmed low: <findings only>
- Notes: <informational findings>
- Contextual quick wins: <capped non-blocking opportunities or "none">
- Must fix before commit: <items>
- Deferred follow-ups: <items>
- Risks now accepted by design: <items or "none">
- Verification commands: <smallest useful commands, with results if run>
- Open questions: <items>
```

Also include a machine-parseable block for downstream CI or follow-up agents:

```json
{
  "verdict": "pass|conditional|block",
  "agent_board": [
    {
      "reviewer": "correctness-reviewer",
      "agent_id": "agent-id-returned-by-runtime",
      "status": "completed|failed|closed"
    }
  ],
  "counts": {
    "blocker": 0,
    "high": 0,
    "medium": 0,
    "low": 0,
    "note": 0
  },
  "must_fix": [
    {
      "id": "security-1",
      "severity": "high",
      "confidence": "high",
      "file": "path/to/file",
      "line": 42,
      "required_action": "Concrete action"
    }
  ],
  "deferred_followups": [],
  "contextual_quick_wins": [],
  "accepted_risks": [],
  "verification": []
}
```

Required rule: security/correctness/release blockers must appear before any lower-priority notes.

After producing the output above, persist it (see "Persisting the review"). The saved file path is part of the deliverable you report back.

## Persisting the review (required)

Every completed review ends by writing the full review to a temporary markdown file. Do not leave the review only in the chat transcript. The chat reply is a summary; the temp file is the durable artifact a human or a follow-up agent reads.

This is a workflow node, not a manual step. A bundled writer owns the canonical temp path and emits a sidecar report, so you never hand-invent a path or reformat by hand. Resolve `scripts/save-review.cjs` against this skill's base directory (the path announced as "Base directory for this skill"; in Claude Code that is `${CLAUDE_PLUGIN_ROOT}/skills/code-review`).

1. Put the full final review (the human-readable result plus the machine-parseable JSON block) into a file, or stream it on stdin.
2. Run the writer:

   ```bash
   node "<skill-dir>/scripts/save-review.cjs" \
     --verdict <pass|conditional|block|invalid> \
     --slug <short-scope-slug> \
     --in <path-to-review.md>
   # or stream it:
   #   <review-producing command> | node "<skill-dir>/scripts/save-review.cjs" --verdict <v> --slug <slug>
   ```

3. The writer creates `<tmpdir>/code-review/<run-id>/review.md` plus `report.json`, prints the absolute `review:` path, and prints the next command. Report that `review:` path to the user as part of the deliverable.

Node contract:

```text
input : review markdown via --in <file> or stdin; --verdict and --slug modifiers;
        optional --json <file> to persist the machine-parseable block as summary.json;
        optional --out-dir / --run-id overrides; optional CODE_REVIEW_OUT_DIR env to relocate the base
work  : compute a stable run id, create the temp run dir, write review.md (+ summary.json), write report.json
output: review.md (primary), report.json, optional summary.json; the canonical path printed to stdout
```

The writer fails early if the review content is empty. Node is always available in both runtimes, so this step has no extra dependency.
