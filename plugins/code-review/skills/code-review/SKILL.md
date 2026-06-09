---
name: code-review
description: Run code reviews, from ordinary patch review to domain-focused sub-agent review boards. Use when the user asks to review code, review a patch/diff/PR, run security/correctness/performance/architecture/release/CI review, spin up reviewer agents, delegate reviewers, or synthesize pass/conditional/block findings with severity, confidence, actionability, and machine-parseable output.
---

# Code Review

## Overview

Run independent reviewer agents over the same change set, keep findings separated by domain, then synthesize a severity-ordered go/no-go.

The skill is for review orchestration, not implementation, unless the user explicitly asks to apply fixes after the review.

Default safety posture: read-only. Do not edit files or write comments unless the user explicitly requests edits.

## Preconditions

- Spawn agents only when the user explicitly asks for review-board style delegation.
- If multi-agent support is unavailable, use `tool_search` to discover it before retrying.
- Define review scope before spawning:
  - changed files
  - commit range
  - branch pair (`base..head`)
  - or explicit paths
- Keep reviewers independent: pass scope + domain instructions without biasing expected findings.
- Set follow-up reviewers with only the smallest set of relevant findings.
- Keep any branch or checkout actions read-only unless explicitly permitted.

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

## Reviewer Board

Use the smallest set that matches the request and risk level.

Core reviewers:

- `security-reviewer`: trust boundaries, command execution, path traversal, secrets, permissions, supply-chain trust, CI/workflow hardening.
- `correctness-reviewer`: regressions, edge cases, idempotency, release semantics, contract drift, migration and persistence correctness.
- `performance-reviewer`: algorithmic cost, subprocess count, parallelism, build/runtime fanout, memory and I/O scaling.
- `quality-reviewer`: maintainability, naming, structure, readability, testability, diagnostics, repo conventions.

Specialized reviewers:

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

- Run independent primary reviewers in parallel unless they share hard dependencies.
- Run sequentially when one pass should inform another (for example, correctness before architecture, then performance, then adversarial).
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
- Confirmed blockers: <findings only>
- Confirmed high: <findings only>
- Confirmed medium: <findings only>
- Confirmed low: <findings only>
- Notes: <informational findings>
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
  "accepted_risks": [],
  "verification": []
}
```

Required rule: security/correctness/release blockers must appear before any lower-priority notes.
