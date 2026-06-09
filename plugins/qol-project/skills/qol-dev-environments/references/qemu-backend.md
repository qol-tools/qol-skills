# QEMU Backend

QEMU is the first backend, not the whole system. Keep the QEMU implementation behind the environment backend boundary so other backends can be added later.

## Host preflight

Check host capability before attempting a run:

```bash
qemu-system-x86_64 --version
qemu-img --version
test -e /dev/kvm
free -h
df -h <image-root> <run-root>
```

Preflight should classify missing acceleration as a capability issue. It should not silently switch to a slow mode unless the environment definition or user explicitly allows it.

## Image model

- Base image: immutable, reusable, stored under the configured image root.
- Case image: disposable `qcow2` clone stored under the configured run root.
- Runtime writes: happen inside the case image or declared run directory only.
- Teardown: removes disposable case state, never the base image.

Prefer snapshot-backed runs when they preserve the evidence needed for reports. Keep a failing case image only when the run explicitly asks to retain it for debugging.

## Launch inputs

A QEMU launch should be built from structured args, not shell-string concatenation:

- accelerator (`kvm`, `tcg`, or platform equivalent)
- memory
- CPU count
- base/case drive path
- display mode
- network/SSH forwarding
- shared workspace mount
- serial/log capture

Use argv arrays from the implementation language when dynamic values are involved.

## Common failure classes

- Host capability miss: QEMU installed but acceleration unavailable.
- Resource starvation: insufficient RAM or disk headroom causing boot flakes.
- Image mismatch: local config points to the wrong image type or stale base.
- Clone corruption: base image mutated or clone created with wrong backing format.
- Boot flake: display, network, RNG, or guest-agent assumptions not declared.
- Permission mismatch: shared-folder user/group permissions block in-guest access.
- Teardown leak: leftover QEMU process, temp image, or stale run lock.

Each class should produce a distinct report message. Do not collapse all of them into "VM failed".

## Backend boundary

The runner should expose backend-neutral operations:

```text
resolve environment
prepare case
boot
run command/action
reboot
collect artifacts
teardown
```

QEMU-specific flags and image mechanics belong under the QEMU backend implementation, not in scenario definitions.

