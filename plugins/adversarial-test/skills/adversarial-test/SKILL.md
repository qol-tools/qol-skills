---
name: adversarial-test
description: Plan, run, and productize adversarial test storms against real application surfaces. Use when the user asks to break, battle-harden, stress, chaos-test, fuzz, race, test-storm, or heavily test a feature, especially in VMs or containers or across lifecycle, concurrency, persistence, authentication, resource, UI-state, and platform boundaries, and expects failures to be preserved as regression tests and verified against the live product path.
---

# Adversarial Test

Treat adversarial testing as an evidence-producing engineering loop, not random abuse. Attack explicit invariants through the same surface used by users and production, preserve every real failure, and turn stable attacks into one repeatable workflow.

## Establish authority

Classify the request before editing product code:

- **Test, diagnose, or report:** reproduce and explain bugs; do not implement fixes.
- **Battle-harden, stabilize, or make it work:** reproduce, add regression coverage, fix, and verify.
- **Ambiguous:** continue read-only and isolated testing; ask before a product change that materially expands scope.

Never let a test-storm broaden access to production data, destructive operations, external messages, or unrelated systems.

## Run the loop

1. **Load local rules.** Read repository instructions and applicable testing, architecture, platform, tracing, VM, and commit skills before acting.
2. **Define the contract.** Write the target, real entrypoint, user-visible invariants, exact platform/build/session, source revision and worktree state, state touched, destructive boundary, and pass criteria. Preserve unrelated user changes.
3. **Map the path.** Trace the request from entrypoint through process, IPC/network, persistence, and platform boundaries. Locate existing tests, isolation seams, logs, traces, cleanup commands, and native workflow runners. Stop reconnaissance once the real entrypoint, mutable boundaries, oracle, and safe launch command are known; do not inventory the whole repository.
4. **Decide observability.** Ask whether the flow needs a new trace target, richer fields on an existing target, or no trace because authoritative state and existing events suffice.
5. **Create isolation.** Prefer a disposable VM, container, temporary profile, scratch config root, separate socket/port, or fake account. Record enough environment identity to reproduce the run. Do not accidentally test the user's resident daemon or personal state.
6. **Prove the baseline literally.** Exercise the actual UI, hotkey, CLI, HTTP/socket route, daemon, or platform integration once before scripting. Confirm authoritative final state, not merely a zero exit code or a running process.
7. **Select attacks.** Read [attack-catalog.md](references/attack-catalog.md), select categories that cross the mapped boundaries, and state the invariant each attack tries to falsify.
8. **Storm the real surface.** Start with controlled cases, then add repetition, concurrency, ordering changes, lifecycle transitions, malformed input, and fresh-environment fanout. Keep seeds, counts, inputs, timings, and environment facts.
9. **Preserve each failure.** Stop widening that lane. Save the smallest exact reproduction and raw evidence, classify product defect versus harness defect, and prove the failure is repeatable.
10. **Create the regression first.** Add the narrowest deterministic test that fails on the unpatched product for the same reason. Run it and retain the failing evidence before changing implementation.
11. **Repair only when authorized.** Fix the owning boundary rather than masking the symptom. Keep platform-specific code in platform modules, avoid machine-specific paths, and use typed unsupported shims where a platform lacks the capability.
12. **Verify in layers.** Run the regression, focused suite, static/lint/build gates, the original literal reproduction, the full storm, restart/persistence checks, and fresh isolated fanout. Default to three independent lanes when economical. When fanout is irrelevant or unavailable, record why.
13. **Restore exact state.** Delete storm-created records, close spawned apps, stop environments, and compare final state to the captured baseline. Cleanup failure makes the run fail.
14. **Productize stable work.** Extend the repository's native orchestrator before creating a parallel runner. Make one human command reproduce the storm and emit a machine-readable report. Apply the `workflow-nodes` skill when available.

## Failure discipline

- Distinguish a **product failure** from a **harness failure** using authoritative state.
- Treat all-success responses with missing persisted state as failure.
- Treat restart survival, atomicity, uniqueness, ordering, and exact cleanup as separate invariants.
- Never weaken an assertion because current behavior disagrees with it.
- Never add sleeps as the primary correctness oracle. Poll a semantic condition with a bounded timeout.
- Do not use process existence alone to prove readiness or shutdown; zombies and stale processes make it unreliable. Prefer the service API, socket/port state, persisted state, or another semantic signal.
- Mark externally invalidated runs `invalid` or `inconclusive`; do not blend them into passing totals.
- Preserve test and fix as logically distinct commits when repository policy or the user requires it.
- Do not claim “fixed” from unit tests alone. Repeat the live path that originally failed.

## Build the workflow node

Expose a small input surface: target/environment, repeat count or fanout, seed when relevant, and an artifact root. Infer everything else safely.

The node must:

- fail early on missing prerequisites;
- use argv-safe process invocation;
- build or install the exact artifact under test;
- isolate every lane and identify it in the report;
- exercise the production entrypoint;
- retain traces and minimized failure evidence;
- perform bounded cleanup even after failure;
- write `report.json` on both pass and failure;
- print the report path and next useful command.

Read [report-contract.md](references/report-contract.md) when implementing or reviewing a storm runner. Adapt to an existing native report schema instead of creating a competing format.

Keep OS commands, paths, and scripts in platform adapters. Shared orchestration should express capabilities and verdicts, not contain Linux shell embedded as universal behavior.

## Completion gate

Do not finish until:

- every claimed bug has a repeatable reproduction;
- every authorized fix has a pre-fix failing regression test, or a recorded reason that deterministic coverage is impossible;
- focused and repository-required checks pass;
- the original live path passes after the fix;
- relevant fresh-run fanout reports exact pass/fail counts, or its omission is explicit;
- persistence and cleanup invariants pass;
- no disposable environment or spawned process remains;
- the report names artifacts, limitations, invalid runs, and untested platforms.

Report the outcome first: bugs caught, fixes made, storm count, live environments, and remaining limitations. Link the regression test, fix, workflow entrypoint, and report artifact. If no bug was found, name the attacked boundaries and be explicit that absence of evidence is not proof of correctness.
