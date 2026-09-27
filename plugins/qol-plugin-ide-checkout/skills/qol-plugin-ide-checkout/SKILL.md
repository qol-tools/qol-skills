---
name: qol-plugin-ide-checkout
description: Use when working on the qol-tray IDE Checkout plugin. Covers its Rust daemon, checkout workflow, config, status reporting, platform lifecycle, packaging, and browser-extension contract boundary.
---

# qol-plugin-ide-checkout

IDE Checkout runs a Rust local HTTP daemon. Locate the plugin through the manifest declaring `id = "qol-ide-checkout"`; paths below are relative to that plugin. This skill owns implementation boundaries; [the API skill](../qol-tray-task-runner-ide-checkout/SKILL.md) owns consumer guidance.

## Contract sources

- `plugin.toml` owns identity, runtime actions, daemon addressing/listener inheritance, platforms, and artifacts.
- `qol-config.toml` and `src/daemon/config.rs` own app paths, temporary-root configuration, typed loading, and contract-derived defaults.
- `src/main.rs` and the CLI boundary own headless dispatch and status/settings entrypoints.
- `src/daemon/mod.rs` owns daemon startup, config loading, and lifecycle wiring.
- `src/daemon/server.rs` owns HTTP parsing, routing, request/response models, and mutation-origin checks.
- `src/daemon/checkout.rs` owns repository/branch validation, clone refresh, process invocation, and configured-app launch.
- `src/daemon/platform/` owns inherited listeners, executable checks, and host-death behavior; `src/daemon/takeover.rs` owns standalone bind/takeover.

## Runtime boundary

The daemon adopts the host's inherited listener when supplied, otherwise uses its bind/takeover path. Preserve shared lifecycle behavior and derive support from manifest-selected adapters. There is no Python daemon or packaged script to resolve.

## Common changes

**Change checkout behavior:** use the checkout module, keep validation before filesystem/process work, and update router-level compatibility cases when responses change.

**Change config:** update the config contract and Rust model together; derive defaults through the existing contract loader.

**Change addressing or lifecycle:** update the manifest, daemon bind/takeover path, and health/status consumer together.

**Change HTTP/security:** follow the API skill and owning router/model; preserve accepted/rejected caller cases and process/path validation in their source tests.

## Invariants

- Configured app identifiers resolve through the typed app configuration and never become shell fragments.
- Preserve checkout path and branch validation before clone/refresh; keep generated destinations under the configured temporary root.
- HTTP caller checks do not replace checkout validation; their precise policy belongs to the router referenced by the API skill.
- Required tools are bundled or their absence becomes an explicit actionable error, consistent with `qol-mission`.
- Health, checkout, and app-launch failures remain visible, including a checkout that succeeded before app launch failed.

## Verification

Run the scoped Rust and shared contract suites plus packaging checks through the repository gate. Endpoint/security changes require router and real-daemon contract evidence; platform lifecycle claims require the manifest-declared targets. Verification is performed by the owning architect in a Sessions implementation round.
