# Review Checklists

## Severity and Evidence Standard

For each finding, include a concrete, reproducible signal:
- exact file + line (or command output)
- observed behavior
- reproduction command (or reasoning + why command is unavailable)
- impact estimate
- required action
- confidence level

Use this severity scale:
- blocker: corruption, release breakage, privilege/security escape, irreversible data loss
- high: likely functional regression with clear user impact
- medium: non-trivial risk with clear follow-through path
- low: optimization and maintainability defects
- note: useful observations with limited risk

Use these checklists to tailor agent prompts. Do not paste every item into every prompt; choose the concerns that match the change.

## Security

- Validate command inputs, shell usage, quoting, and path handling.
- Check for interpolation of untrusted strings in shell, command args, regexes, and file paths.
- Confirm token/credential and signing material exposure in logs, artifacts, caches, and workflow env.
- Verify workflow permissions are scoped by job and least-privilege by trust boundary.
- Verify pinned third-party actions and trusted registries in release or CI chains.
- Stress ambiguous refs, tag names, TOCTOU, path traversal, and stale-worktree assumptions.
- Confirm there is an auditable trail for security-sensitive decisions.

## Correctness

- Compare behavior against the actual user goal and existing contracts.
- Check edge cases: false positives/false negatives, stale state, partial writes, idempotency, retry behavior.
- Verify tag/version/manifest consistency and exact build inputs for each release/job.
- Confirm failure modes are explicit, recoverable, and do not mask deeper corruption.
- Look for data-loss, migration, persistence, concurrency, and ordering regressions.
- Validate compatibility boundaries (API/schema/contract) across supported plugin/workspace variants.
- Prefer changed-hunk review first, then direct call graph/dependency impact before broad scans.

## Performance

- Identify loops over large sets, recursive scans, repeated parsing, and repeated subprocesses.
- Check complexity as commits, plugins, files, users, or data size grows.
- Verify expensive dependency checks are cached, deduplicated, and batched.
- Confirm CI/runtime jobs avoid full workspace rebuilds when unnecessary.
- Check artifact downloads/copies and release fanout for redundant network/IO.
- Verify fanout strategy is bounded where possible.

## Optimization

- Remove duplicate parsing and repeated git reads across files.
- Prefer precomputed structures and memoized dependency closures.
- Compare old vs new complexity and justify increases.
- Evaluate whether guard checks are cheap and early-returning.
- Identify broad invalidation policies that can be made dependency-aware.
- Spot avoidable lock contention and process startup overhead.

## Architecture

- Confirm ownership boundaries and dependency direction stay intact.
- Validate data flow, error propagation, and rollback/migration paths.
- Check whether impact analysis is conservative on ambiguous changes.
- Verify the design belongs in this layer instead of a shared library or workflow.
- Identify extension points for the next similar feature.
- Check for circular dependencies, unexpected abstraction leaks, and API lock-in.
- Confirm there is a clear rollback path if release automation fails partway.

## QoL / Vision

- Keep output and diagnostics deterministic, concise, and actionable.
- Preserve intent in comments and user-facing messages.
- Avoid one-off behavior without a testable reason.
- Ensure reports and validation commands are useful for the human operator.
- Check operational ergonomics: reruns, manual dispatch, local dry runs, and failure recovery.
- Enforce deterministic ordering of logs and artifact names.
- Ensure error text is attributable and actionable with next steps.

## Cutting-Edge Practices

- Check for deprecated APIs or syntax in touched stacks.
- Confirm lint/type/test/tool versions remain aligned with repo conventions.
- Verify automation supports deterministic replays.
- Prefer structured parsing over ad-hoc regex for structured formats.
- Check whether current platform docs affect GitHub Actions, SDKs, CLIs, or build tools.
- Validate compatibility with current deprecations (GitHub Actions permissions, Node/Python/SDK version floor, YAML schema drift).
- Prefer machine-checkable outputs (JSON/YAML tables) for high-volume diagnostics.

## Tests / QA

- Identify missing unit, integration, snapshot, property, or workflow tests.
- Check whether validation covers the risky behavior, not just syntax.
- Watch for flaky commands, environment assumptions, and hidden network dependencies.
- Prefer targeted validation over expensive full-suite runs unless blast radius requires it.
- Add command-backed assertions for each top risk rather than only static reasoning.
- Verify negative tests exist for parsing/validation paths.

## Release / CI

- Verify trigger patterns, manual dispatch inputs, and tag/ref checkout behavior.
- Check permissions by job, not only workflow-wide.
- Confirm release jobs build the exact ref being published.
- Validate artifact names, cache behavior, retention, and idempotent reruns.
- Check duplicate tag/release behavior and failure recovery.
- Ensure artifact provenance and signing expectations are explicit where relevant.
- Confirm release automation is resistant to rerun, retry, and partial failure.
- Emit a compact machine-parseable verdict block when findings may be consumed by CI or follow-up agents.

## Adversarial Pass

- Try to break high-confidence prior findings.
- Attack malformed inputs, ambiguous refs, stale tags, dirty worktrees, missing files, and partial failures.
- Look for under-severity issues or hidden assumptions.
- Report only new findings or corrections to prior findings.
- Include a minimum of one adversarial scenario per major domain.
- Attempt to disprove each high-confidence blocker with a concrete counterexample.
