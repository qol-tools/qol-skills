---
name: qol-debug
description: Use when asked to locate or hunt for bugs in a qol-tools repo (qol-monorepo, qol-skills) - first-pass identification, evidence-gathering, and high-confidence reporting without fixing. Triggers on "locate bugs", "find bugs", "bug hunt", "first pass", "hunt for defects", "report back what you found", or any read-only debugging sweep. Covers baseline verification (clippy + full test suite), live qol-dev session log mining, recent-fix and newest-feature prioritization, the static bug-shape grep catalog, per-suspect source verification, and the report template that ships only high-confidence findings.
---

# qol-debug

A first-pass bug hunt is an evidence loop, not a code read: establish a clean baseline, mine the live runtime, scan for known bug shapes, verify every suspect in source, and report only findings that survive verification.

## Scope discipline

Classify the request before touching anything:

- **Locate / identify / report**: read-only. No fixes, no edits, no commits.
- **Locate then fix**: deliver the findings first, then fix under the standard delivery rules.
- **Ambiguous**: hunt read-only; ask before editing product code.

**Report only high-confidence findings.** A finding qualifies when it has all four: (1) a concrete location, (2) evidence (a log line, command output, or a provable contradiction in the code path), (3) a root cause that survives re-reading the code and its callers, and (4) an impact statement. Drop anything below that bar unless the user explicitly asks for a low-confidence list.

## The loop

### 1. Baseline (start early; scan while it runs)

These commands apply to Rust workspace roots (qol-monorepo). Adapt the baseline to the target repo's toolchain elsewhere: a Node repo runs its own test suite and has no `target/` cache.

- Check for a warm `target/` directory first: clippy and tests reuse it.
- `cargo clippy --workspace --all-targets`: zero warnings means the bugs are logic-level, not lint-level. Host clippy only proves the host platform; the recurring regression class is Linux-green / macOS-red under `-D warnings` (`qol-project:qol-arch-cross-platform`). Add per-crate cross-target checks where the host toolchain allows, but a full workspace cross-check is not always practical.
- `cargo test --workspace -q`: a fully green suite means bugs hide in untested or newly-added paths. Note the caveat: qol-tray gates a large test surface behind `feature = "dev"` with `default = []`, so the plain workspace run skips it. Add the dev-gated suite to the baseline (`cargo test -p qol-tray --features dev -q` or the equivalent for the crate under review) or state the skip explicitly. A green default run says nothing about a surface that never compiled.
- Run both in the background with output to a file, keep scanning meanwhile, and paste the real results into the report.

### 2. Mine live evidence first

The user often runs `qol dev` from the current tree. The live session is the strongest bug source:

- `~/.local/share/qol-tray/logs/qol-dev-<ts>-<pid>.log`: the dev console log of the running session (globbing `qol-dev-*.log` and picking the newest entry is safer than a fixed pattern)
- `~/.local/share/qol-tray/logs/qol-tray.<date>.log`: structured startup events
- `~/.local/share/qol-tray/logs/qol-daemons.log`: daemon output (multi-day history; check timestamps before trusting an entry, and check the file size before a full grep: it can grow very large and a naive `error|warn|fail|panic` scan returns thousands of hits)

These are the Linux host paths; resolve the tray log dir from the host's data dir on other platforms.

Pin what the live session actually runs before trusting its logs: the process list must resolve into the tree under review (for example `target/debug/plugin-*` or `target/qol-dev/runtime/<hash>/qol-tray`). Record that with the evidence: a stale session's logs look authentic but prove nothing. The provenance mechanics belong to `qol-tray:qol-tray-dev-recompile`; reference it instead of re-deriving.

Grep for `error|warn|fail|panic`, then read every hit in context. False positives are common and must be filtered before they become findings:

- window titles captured by alt-tab that happen to contain "error"
- handled error strings returned by Cinnamon/BlueZ/shell evals (the plugin surfaces them by design)
- transient environment states ("no focused window", autostart blocks for dev-linked plugins)

A genuine runtime failure in the current tree outranks any static suspicion. Read the triggering code path end-to-end before classifying it.

### 3. Prioritize areas

- `git log --oneline -40`: fix commits name the fragile subsystems; look for siblings of each fixed bug class in nearby code.
- Newest features are least battle-tested: `git log --oneline -5 -- <area>` before reading the area.
- Shared libs with real logic (parsing, retry, admission, migrations, state machines) before UI code.
- Concurrency, timeouts, lifecycle ordering, and platform-specific code before straight-line code.
- Stop when the sweep stops producing suspects: cover the baseline, the live evidence, and the areas named by recent fix commits, then report. Do not inventory the whole repository.

### 4. Static pattern scans (grep catalog)

Every hit is a suspect, not a finding: verify in source before claiming.

- `len() - 1` and missing `saturating_sub` where an empty collection underflows
- inverted clamps: `.min(...).max(...)` chains, `.min(len - 1)` without an empty guard
- `Duration::from_millis(0)` / `Duration::ZERO` in hot paths
- `unwrap()` / `expect()` in non-test production paths
- `#[ignore]` tests: benchmarks are fine; unexplained ignores may hide real failures
- self-comparisons (`if a == a`), `0..=` ranges over possibly-empty collections, `!=`/`==` against literals in conditions that gate loops
- fixed deadlines with no retry and no re-arm: in event-driven code, the event that flips the waited-on condition must also trigger the repair. If only one event type is subscribed, the recovery path never runs.
- inconsistent gates: the same readiness condition checked differently on two paths that should behave the same (an auto path failing where the manual path succeeds is a strong signal)

### 5. Verify each suspect

- Read the function, its callers, and every guard before arithmetic or indexing.
- Check the tests that pin the behavior: a tested tradeoff is a design decision, not a bug; mention it only when the user must know.
- Confirm against actual control flow. "This looks odd" is not a finding; "this path provably never runs / underflows / gives up" is.

### 6. Report

Evidence-first template, one block per finding:

```markdown
### <Area>: <one-line summary>
- Location: <file:line, function>
- Evidence: <exact log line / command output / provable code-path contradiction>
- Root cause: <what the code does and why that is wrong>
- Impact: <user-visible or system-level consequence>
- Fix direction: <short, only when the user asked>
```

Precede the findings with a method summary: baseline results with the real command output, what was swept so coverage is visible, and any medium-confidence candidates only when the user asked for them. Never claim "no other bugs"; claim "nothing else found in this sweep". End by offering the fix only if the original request was locate-only.

## Boundaries

- Reading host logs is evidence, not experimentation: reproducing or verifying runtime behavior happens in a disposable guest VM under `qol-project:qol-dev-environments`, never on the host session.
- For runtime-only findings, the trace-target decision follows `qol-trace-discipline:qol-trace-discipline`.
- A dirty worktree changes what the live session runs: record `git status` and `git log -1` with the evidence so the finding is pinned to a revision.
- Fixes follow the delivery rules of the repo being fixed (`qol-workflow:qol-monorepo-rules`, `qol-workflow:git-trees`); the hunt itself never commits.
