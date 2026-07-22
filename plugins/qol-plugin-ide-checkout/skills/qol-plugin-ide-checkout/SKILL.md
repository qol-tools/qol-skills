---
name: qol-plugin-ide-checkout
description: Use when working on the qol-tray ide-checkout Task Runner plugin. Covers Rust supervision, the Python daemon boundary, config, status reporting, packaging, and synchronization with the browser-extension API contract.
---

# qol-plugin-ide-checkout

Task Runner has a Rust process boundary and a Python API daemon. The plugin skill owns supervision, packaging, config, and operational behavior; `qol-tray-task-runner-ide-checkout` owns endpoint schemas, security policy, and consumer compatibility.

## Contract sources

- `plugin.toml` owns plugin identity, runtime command/actions, daemon metadata, platforms, and artifacts.
- `qol-config.toml` owns editable app/script/temp-path shapes and defaults.
- `server.py` owns built-in action dispatch, default config used without an on-disk override, HTTP behavior, and interpreter syntax requirements.
- `src/main.rs` owns process supervision, health/status invocation, notification fallback, and packaged-script resolution.
- The API-contract skill owns externally consumed request/response/error semantics.

Change duplicated values such as daemon endpoints or config defaults at every owning boundary in one patch and add an executable consistency check where possible. Do not copy those values into this skill.

## Runtime boundary

The Rust binary locates the packaged daemon relative to its executable and hands process control to Python where the target supports that model. Debug daemon behavior in Python stdout/stderr; debug launch, packaging, or notification behavior in Rust.

Do not add environment/path overrides without considering symlinked executables, release layout, and untrusted input. The shipped artifact must include every runtime file the supervisor resolves.

## Common changes

**Add a built-in action:** implement and register it in `server.py`, update the external API contract when consumer-visible, validate parameters before filesystem/process access, and add request-level tests.

**Change a config shape/default:** update `qol-config.toml`, Python defaults/loading/validation, and API responses together.

**Change daemon addressing:** update the Python bind, Rust health probe, manifest daemon metadata, and every contract consumer. Prefer one generated/shared source over another copied constant.

**Change CORS/security:** the API-contract skill defines policy and `server.py` enforces it. Update tests for accepted and rejected origins, traversal, command interpolation, and localhost binding.

## Invariants

- Configured app/script identifiers never become unchecked shell fragments.
- Clone destinations stay beneath the validated task root.
- CORS and localhost binding are defense-in-depth, not substitutes for path/command validation.
- Runtime interpreter support is derived from `server.py`, packaging, and the test matrix, not a prose minimum version.
- Required tools are bundled or their absence becomes an explicit actionable error, consistent with `qol-mission`.
- Notifications may degrade through platform adapters, but health failures remain visible.
- Rust/Python release packaging is tested as one artifact.

## Verification

Run Rust format/build/Clippy/tests, Python syntax and API tests, packaging checks, and `cargo run -q -p qol -- check`. Exercise the external contract against the real daemon for any endpoint/security change.
