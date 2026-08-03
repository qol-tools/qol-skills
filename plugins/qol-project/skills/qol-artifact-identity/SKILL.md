---
name: qol-artifact-identity
description: Use when building, installing, updating, staging, or executing a deployable qol native binary, or when a consumer needs to locate an artifact it did not build. Defines the identity contract, which crate owns which layer, why a filesystem path is never identity, and how opaque non-Rust payloads stay covered. Triggers on qol-conventions, qol-build-identity, qol-artifact, build-script emission, artifact resolution from a target/ or profile directory, install/update/staging handoffs, and content digests for scripts and assets.
---

# Artifact identity

## Identity is a verified contract

Deployable native binaries carry the identity contract owned by
`qol-conventions`. Every build, install, update, staging, and execution handoff
verifies it. A handoff that skips verification is the bug, even when the binary
happens to be correct that run.

## One owner per identity layer

| Layer | Owner |
|---|---|
| Schema and registration contract | `qol-conventions` |
| Source resolution, build-script emission | `qol-build-identity` |
| Native inspection, intent policy | `qol-artifact` |

Consumers must not mirror any of them. A consumer that re-derives what a build
script already emitted has forked the contract, and the fork drifts silently.

## Paths are not identity

Use the exact executable reported by the build, and preserve its verified
artifact reference through every downstream step.

Never rediscover an artifact from a profile directory or from a filename. A path
under `target/debug/` is a location, not a claim about what the file is. The
common failure: a plugin binary left in the plugin root shadows the one in
`target/debug/`, and resolution order silently serves the wrong binary.

## Opaque payloads use detached integrity

Scripts, assets, and non-Rust helpers cannot carry the native binary contract.
They stay covered by their owning manifest plus a content digest instead. Do not
duplicate or approximate the native contract for them.
