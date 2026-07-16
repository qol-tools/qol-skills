# QEMU Backend

## Contents

- [Boundary](#boundary)
- [Preflight and admission](#preflight-and-admission)
- [Image model](#image-model)
- [Launch construction](#launch-construction)
- [Ownership order](#ownership-order)
- [Process and identity model](#process-and-identity-model)
- [Guest control and development payloads](#guest-control-and-development-payloads)
- [Teardown and recovery](#teardown-and-recovery)
- [Security posture](#security-posture)

## Boundary

Keep QEMU behind the environment backend boundary. Expose backend-neutral lifecycle operations:

```text
resolve
prepare
boot
control
capture
stop
collect evidence
teardown
```

Keep QEMU flags, sockets, image mechanics, and monitor commands out of environment definitions and workflows.

## Preflight and admission

Resolve required binaries, image format, firmware, architecture, acceleration, memory, CPU, and run-root disk capacity before launch.

Classify missing acceleration as a capability failure. Do not silently switch to a slower accelerator unless the definition or user explicitly permits it.

Reserve concurrent lane, memory, CPU, and disk headroom through the shared host-global admission ledger. Use an OS file lock and durable writes so independent `qol` processes cannot race through the same capacity check.

Keep forced admission explicit and visible in the report.

## Image model

- Keep the base image immutable and reusable.
- Admit prepared qcow2 images only through the verified content-addressed import path.
- Create one disposable case image per lane.
- Record every mutable artifact before or as it is created.
- Remove disposable artifacts only after process identity and exit are verified.
- Preserve evidence reports even when case images are removed.

Do not retain a failed case image by accident. If a workflow supports deliberate retention, report that policy and artifact path explicitly.

## Launch construction

Build commands as argv arrays, never shell strings with dynamic values.

Derive the launch from structured inputs:

- accelerator and machine type
- memory and vCPU count
- case drive and format
- display mode
- network mode
- QMP endpoint
- serial control endpoint
- canonical machine name
- canonical pidfile
- optional guest media or mounts

Reserve endpoints before constructing the final launch. Keep endpoint allocation scoped to one run and report the selected identity.

## Ownership order

Persist enough truth before each irreversible transition:

1. Write the aggregate owner and complete lane plan.
2. Mark the lane as launching.
3. Write the child `preparing` report with a canonical pidfile path.
4. Record mutable artifacts and endpoints.
5. Mark spawn state as launching.
6. Spawn QEMU inside an owned process tree.
7. Record the observed QEMU PID and verify QMP machine identity.
8. Mark the child running.

Treat death before step 2 as never started. Treat death after launch becomes possible as uncertain until identity and cleanup are proven.

## Process and identity model

Own the full process tree, not only the immediate child:

- Use process groups on Unix-like hosts.
- Use nested job objects or the platform-equivalent tree owner on Windows.
- Make termination idempotent.
- Wait for verified tree exit before reporting cleanup complete.

Bind destructive control to multiple matching facts:

- run id and canonical run directory
- report kind and report run id
- supervisor PID and platform process-start identity
- canonical QEMU machine name
- canonical pidfile
- QMP identity
- process liveness and exit evidence

Never trust a report-provided arbitrary pidfile or artifact path over the canonical run layout.

## Guest control and development payloads

Run desktop automation through a versioned guest runner attached to a dedicated
virtio-serial port. Start it as the logged-in desktop user, then verify the protocol,
environment id, prepared-image revision, QEMU-provided run id, user, desktop, display
protocol, and graphical-session environment before sending typed argv commands. Keep
this channel guest-only; agent automation must not fall back to host input or host
window control.

Start automated desktop payload flows only from a worker that has cleared and then
verified the absence of host graphical-session variables. Treat that as defense in
depth, not same-user OS isolation. Require the aggregate report to record the cleared
environment, the lack of an OS security boundary around the host worker, headless guest
display, offline networking, disabled workspace mount, and read-only payload identity.
This contract does not cover Enter's manual windowed VM or make all of `qol dev` an
agent-security boundary.

Build real plugin artifacts once on the host and copy only those artifacts into an
immutable per-run staging directory. Package the verified tree as a read-only ISO,
attach the same image to every lane in the fan-out, and mount it `ro,nosuid,nodev,noexec`
inside the guest. Never expose the repository, worktree, home directory, or mutable
build directory. Bind the canonical staging path, image, and manifest digest to
parent/child run evidence, and collect guest results through a separate explicit
channel. This is an internal sandbox transport, not a substitute for the user-facing
injection `Medium` being tested.

Host compilation runs as the current user and may execute build scripts or procedural
macros. Do not claim hostile-source isolation. Add a separate-user, container, or build
VM boundary before accepting adversarial source or build dependencies.

## Teardown and recovery

Prefer graceful QMP shutdown, then escalate through the owned process tree when the timeout expires. Never signal only the supervisor or immediate child and infer that descendants exited. Record whether QEMU was alive, whether its exit was verified, whether the tree exited, which artifacts were removed, and why cleanup failed.

Recover orphaned runs through the normal scanners before reading aggregate lane state. A dead supervisor with a still-live QEMU process must trigger owned cleanup, not a stale-report verdict.

Keep uncertain launch state and cleanup failure nonterminal. Do not release the resource lease until the aggregate report proves cleanup for every planned lane.

## Security posture

Treat QEMU user networking and localhost QMP as development conveniences, not a hostile-code security boundary. Do not describe this harness as safe for arbitrary untrusted guest payloads without additional isolation.

Keep the endpoint reservation-to-bind window small and fail visibly on bind races.
