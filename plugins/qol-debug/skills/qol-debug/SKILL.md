---
name: qol-debug
description: Use when asked to locate, hunt for bugs, or find security vulnerabilities in a qol-tools repo (qol-monorepo, qol-skills) - first-pass identification, evidence-gathering, and high-confidence reporting without fixing. Triggers on "locate bugs", "find bugs", "bug hunt", "first pass", "hunt for defects", "report back what you found", "find security vulnerabilities", "security review", "hunt for vulnerabilities", "find exploits", or any read-only debugging or security sweep. Covers baseline verification (clippy + full test suite), live qol-dev session log mining, recent-fix and newest-feature prioritization, the static bug-shape and security grep catalogs, per-suspect source verification, multi-perspective review for high-value targets, guest-VM confirmation of runtime findings, and the report template that ships only high-confidence findings.
---

# qol-debug

A first-pass bug or vulnerability hunt is an evidence loop, not a code read: establish a clean baseline, mine the live runtime, scan for known bug and attack shapes, verify every suspect in source, confirm runtime-dependent impact in a guest, and report only findings that survive verification.

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

A failing test is not automatically a finding: isolate it, rerun the suite at least 3 times, and classify. Deterministic = regression; passes in isolation or not reproducible = flake. Report flakes as baseline anomalies with the isolation evidence; never build findings on them.

### 2. Mine live evidence first

The user often runs `qol dev` from the current tree. The live session is the strongest bug source:

- `~/.local/share/qol-tray/logs/qol-dev-<ts>-<pid>.log`: the dev console log of the running session (globbing `qol-dev-*.log` and picking the newest entry is safer than a fixed pattern)
- `~/.local/share/qol-tray/logs/qol-tray.<date>.log`: structured startup events
- `~/.local/share/qol-tray/logs/qol-daemons.log`: daemon output (multi-day history; check timestamps before trusting an entry, and check the file size before a full grep: it can grow very large and a naive `error|warn|fail|panic` scan returns thousands of hits)

These are the Linux host paths; resolve the tray log dir from the host's data dir on other platforms.

Pin what the live session actually runs before trusting its logs: the process list must resolve into the tree under review (for example `target/debug/plugin-*` or `target/qol-dev/runtime/<hash>/qol-tray`). Record that with the evidence: a stale session's logs look authentic but prove nothing. The provenance mechanics belong to `qol-tray:qol-tray-dev-recompile`; reference it instead of re-deriving. Also check `qol env runs` / `qol flow runs` / `qol env doctor`: active guest lanes and stale cleanup warnings contextualize what is really running. When a finding touches a running daemon, read its socket paths and environment from `/proc/<pid>/environ` instead of guessing.

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
- For security hunts, order by attacker position: remote-reachable endpoints first, then local multi-user, then same-user paths.
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

#### Security sweep (vulnerability hunts)

Start with a threat model, not greps: enumerate every listener and IPC endpoint, and for each one record the bind address, authentication mechanism (or none), peer-credential check, payload bounds, and what actions a peer can trigger. Rank by attacker position: remote > local multi-user > same-user > dev-only. Then run the security grep catalog:

- `UdpSocket|TcpListener|UnixListener|\.bind\(` - for each listener: 0.0.0.0 vs loopback, auth, source validation
- `Command::new` / `sh -c` / `bash -c` / eval - trace every interpolated value back to its source (config, .desktop files, window titles, network input, profile imports)
- `remove_dir_all|remove_file` plus `canonicalize`/`symlink_metadata` - deletion revalidation, traversal, symlink following
- `set_permissions|PermissionsExt|from_mode` - socket and state-file modes, world-writable IPC
- secret/token literals, `danger_accept_invalid_certs`, plaintext `http://` for downloads/sync/updates
- `zip|tar|unpack_in` - archive extraction and path traversal
- fixed `/tmp` paths opened with create/append - symlink races and world-readable trace data
- `unwrap()`/`expect()` on data parsed from sockets or files - remote or local DoS
- Python: `pickle`, `yaml.load(`, `eval(`/`exec(`, `shell=True`

High-signal shapes learned in the field:

- Loopback binding treated as an authentication boundary: TCP loopback is reachable by every local user. The codebase's own SO_PEERCRED same-uid pattern (`qol_runtime::local_ipc`) is the bar; plugin daemons that skip it are inconsistent gates.
- Secrets that never rotate; one-shot pairing ceremonies without proof-of-possession (first requester wins, plaintext transport, no revocation path).
- Unbounded thread-per-connection accept loops.
- Corrupt persistent state bricks the service with no regenerate-on-invalid path (and check what the supervisor does after repeated failures: suppression can make it permanent).
- Advisory-only readiness checks: doctor reports ready but nothing gates the backend.
- Attacker-controlled numeric input cast and fed into a dependency loop (for example f64 `as i64` driving an `abs()` iteration count): clamp and bound before the value reaches a library that iterates.

### 5. Verify each suspect

- Read the function, its callers, and every guard before arithmetic or indexing.
- Check the tests that pin the behavior: a tested tradeoff is a design decision, not a bug; mention it only when the user must know.
- Confirm against actual control flow. "This looks odd" is not a finding; "this path provably never runs / underflows / gives up" is.
- If an impact statement contains a magnitude (duration, bytes, iterations, rate), either bound it in a guest (Section 7) or label it `magnitude unverified`. Measured beats estimated; extrapolation must show its arithmetic.

### 6. Multi-perspective review (high-value targets)

Before reporting on a high-value target, review it from multiple lenses: protocol/crypto (MAC construction, replay, key lifecycle), end-to-end threat model (attacker timeline), lifecycle/config/handoff (restarts, secret paths, port races), platform backends (bind addresses, input sinks), and resource abuse (rate limits, amplification, log volume). Subagents are an optimization, never a dependency: every hunt must be executable inline, and a failed spawn falls back to sequential passes.

### 7. Confirm runtime findings in a guest

For findings whose impact depends on runtime behavior (magnitude, timing, supervision loops, protocol mechanics), run an artifact-backed lane instead of guessing: `qol env up <environment> --dev-worktree <absolute-worktree>` (mechanics: `qol-project:qol-dev-environments`). Pin provenance with the evidence: `target/debug` binary mtimes, lane id, bundle origin, plus `git status` / `git log -1`.

In the guest: locate the process and its sockets (`pgrep -af`, `ss -lunp`), recover daemon env from `/proc/<pid>/environ`, transfer PoC scripts base64-encoded through `qol env exec /bin/bash -c` to survive quoting, and prefer measurable evidence over screenshots (timing via `xdotool` polling, supervisor loops via the structured tray log). Destructive in-guest tests (secret corruption, input storms, killing supervised daemons) belong only in a disposable lane. Tear down with `qol env down`; reports stay. Never reproduce on the host session.

### 8. Report

Evidence-first template, one block per finding:

```markdown
### <Area>: <one-line summary>
- Location: <file:line, function>
- Evidence: <exact log line / command output / provable code-path contradiction>
- Root cause: <what the code does and why that is wrong>
- Impact: <user-visible or system-level consequence>
- Fix direction: <short, only when the user asked>
```

Precede the findings with a method summary: baseline results with the real command output, what was swept so coverage is visible, and any medium-confidence candidates only when the user asked for them. For security findings, state the exploitability chain - attacker position -> prerequisite -> action -> impact - and grade by attacker position: remote without auth or with an auth bypass > remote with a credential > local multi-user > same-user > dev-only builds. A security finding without a concrete chain drops below the high-confidence bar. On multi-pass hunts, add a `Deltas vs first pass` element to each finding: upgraded, downgraded, or confirmed with measured magnitude. Never claim "no other bugs"; claim "nothing else found in this sweep". End by offering the fix only if the original request was locate-only.

## Boundaries

- Reading host logs is evidence, not experimentation: reproducing or verifying runtime behavior happens in a disposable guest VM under `qol-project:qol-dev-environments`, never on the host session.
- For runtime-only findings, the trace-target decision follows `qol-trace-discipline:qol-trace-discipline`.
- A dirty worktree changes what the live session runs: record `git status` and `git log -1` with the evidence so the finding is pinned to a revision. For runtime or security findings, also pin artifact mtimes, daemon env/socket paths, and guest lane id.
- Fixes follow the delivery rules of the repo being fixed (`qol-workflow:qol-monorepo-rules`, `qol-workflow:git-trees`); the hunt itself never commits.
