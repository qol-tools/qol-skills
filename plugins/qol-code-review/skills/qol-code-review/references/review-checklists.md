# Review Checklists

## Severity and Evidence Standard

For each finding, include a concrete, reproducible signal:
- exact file + line (or command output)
- observed behavior
- Every finding includes a 30-second user-actionable reproduction naming the expected outcome; when the repro needs the live desktop session or an external condition, the finding names who must run it and what outcome to report back.
- impact estimate
- required action
- confidence level
- Behavioral claims about focus, visibility, or lifecycle cite runtime trace output (for example qol trace probes) when the repo has it, never inference alone.

Use this severity scale:
- blocker: corruption, release breakage, privilege/security escape, irreversible data loss
- high: likely functional regression with clear user impact
- medium: non-trivial risk with clear follow-through path
- low: optimization and maintainability defects
- note: useful observations with limited risk

Use these checklists to tailor agent prompts. Do not paste every item into every prompt; choose the concerns that match the change.

## Review Router

- Identify touched surfaces: runtime code, UI, CLI, CI/release, docs, scripts, manifests, migrations, tests.
- Choose the smallest reviewer set that covers real risk; avoid running every persona by default.
- Escalate to security/release/adversarial when refs, permissions, shell execution, secrets, artifacts, migrations, or data loss are in scope.
- Add style/redundancy/history only when the patch touches established local patterns, compatibility paths, or duplicate mechanisms.
- Report the selected reviewers and one-line rationale for each.

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
- Every wait-for-event path has a bound and a cleanup that restores the prior state; a copy of a repo pattern is always diffed against its canonical owner rather than accepted as a new variant.
- Every timed constant covers the evidence window the change itself cites, or is derived: a retry/timeout/guard constant tuned to the middle of an observed range is flagged.
- Every platform-gated mechanism is checked on every platform the artifact declares: a silent no-op on a declared platform is a coverage gap, not a feature.
- Prefer changed-hunk review first, then direct call graph/dependency impact before broad scans.

## Requirements

- Compare implementation against the user's explicit request, mission statements, issue text, and acceptance criteria.
- Flag missing acceptance tests, undefined assumptions, and behavior that is "implemented" but not actually user-verifiable.
- Separate deliberate out-of-scope work from accidental incompleteness.
- Check whether docs, command output, and final UX match what the change claims to provide.
- Confirm the smallest deterministic verification path is named.

## Redundancy

- Search for existing helpers, scripts, skills, components, workflows, or conventions before accepting new mechanisms.
- Identify duplicate logic, duplicate state updates, parallel manifests, redundant validation, and repeated parsing.
- Flag divergence risk when two paths enforce the same rule differently.
- Distinguish useful defense-in-depth from noise: redundancy is justified only when it adds fault tolerance or clearer diagnostics.
- Prefer extending established local patterns over adding a second abstraction.
- Byte-identical blocks pasted into multiple call sites are always flagged, even when the duplication predates the patch; one shared helper is required when the copies differ only in names.

## History / Compatibility

- Check behavior against prior release paths, old config/schema names, old plugin IDs, migration rules, and documented workflows.
- Validate deprecation and fallback behavior: old paths should fail loudly, migrate cleanly, or remain intentionally supported.
- Look for changes that break existing user muscle memory, automation, caches, or installed plugin layouts.
- Confirm changelog/docs/test updates cover compatibility-sensitive behavior.
- Treat "not reproducible from fresh install" and "only after restart/upgrade" as first-class review cases.
- Every "restores previous behavior" or "regression from a named commit" claim is verified with git history before it is accepted: `git log -S` / `git log -G` on the touched symbols finds when the mechanism first appeared, and the cited commit's message is read, since it may state the opposite rationale.

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

## Style / Local Fit

- Match the immediate context's style, not generic taste: UI density, CLI framing, naming, diagnostics, test shape, and file organization.
- Check whether new text sounds like the surrounding product/tool and avoids explanatory noise inside the UI.
- Reuse local components, helpers, command conventions, and result formats before introducing new ones.
- Flag formatting or structure that makes future patches harder to scan.
- For qol CLI/UI changes, preserve concise operator-focused surfaces and avoid marketing/explainer copy.

## QoL / Vision

- Keep output and diagnostics deterministic, concise, and actionable.
- Preserve intent in comments and user-facing messages.
- Avoid one-off behavior without a testable reason.
- Ensure reports and validation commands are useful for the human operator.
- Check operational ergonomics: reruns, manual dispatch, local dry runs, and failure recovery.
- Enforce deterministic ordering of logs and artifact names.
- Ensure error text is attributable and actionable with next steps.
- A mechanism that asserts focus, grabs input, raises windows, or holds modal state never fights the operator's natural next action: clicking another window, keeping typing, or switching apps.

## Contextual Quick Wins

- Look for cheap improvements adjacent to the patch that reviewers would otherwise skip: clearer step summaries, narrower validation commands, missing dry-run examples, small naming clarifications, and low-effort guardrails.
- Prefer opportunities that reduce future operator confusion, shorten feedback loops, or make the next review/test/debug session easier.
- Report only items with a concrete edit path and low blast radius; each item should be doable in one focused sitting.
- Do not duplicate security/correctness/release findings. If an item can break users or releases, escalate it to the proper domain reviewer instead of calling it a quick win.
- Cap the list at 5 items, ordered by expected usefulness. Return "none" when there are no strong candidates.
- Avoid speculative rewrites, broad refactors, taste-only style preferences, or improvements that require new product direction.

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
