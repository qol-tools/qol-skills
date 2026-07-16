# Environment Registry

## Ownership

Keep the registry data-driven. Add or change an OS through its definition and capability model, not through UI conditionals.

- Store repo-owned definitions under `flows/envs/*.toml`.
- Read the local config path from `qol env doctor` rather than hard-coding it.
- Resolve the merged view through the shared registry under `libs/qol-dev-env/`.
- Render CLI or UI state from resolver output instead of rediscovering paths independently.

## Definition and local configuration

Use a definition for portable meaning:

- stable environment id and display name
- OS family
- backend id
- image kind, base name, architecture, firmware, and sizing guidance
- boot defaults
- mount policy
- capability and adapter declarations

Use local configuration for host-specific placement:

- image root
- run root
- per-environment image overrides

Never let a local override silently change what an environment means.

## Definition shape

Treat the Rust definition types as authoritative. A representative shape is:

```toml
id = "linux/example"
name = "Example Linux"
family = "linux"
backend = "qemu"

[image]
kind = "qcow2"
base = "example.qcow2"
recommended_size_gb = 8
arch = "x86_64"
firmware = "bios"

[boot]
memory_mb = 1024
cpus = 1
display = "headless"

[mounts]
workspace = false

[capabilities]
acceleration = "hardware"
flow_adapter = "example-adapter"
default_workflow = "example-workflow"
image_revision = "example-prepared-image-1"
```

Use capability strings to select behavior. Do not turn environment ids into code branches.

Use `default_workflow` to declare the action exposed by `qol dev`; do not hard-code workflow ids in the panel. A desktop automation adapter must also declare the exact prepared `image_revision` expected by the guest-control handshake.

An environment may intentionally omit `flow_adapter`. Keep it available for manual `qol env up` sessions and reject automated flows with a visible capability error.

## Verified prepared-image import

Treat `qol dev` `a` as a verification workflow, not raw path registration. Match the selected missing environment to a qcow2 candidate by its exact declared base filename and refuse zero or multiple matches. Keep `qol env image import` as a thin direct veneer over the same typed worker.

The importer must:

1. Canonicalize the source and exact worktree, then persist an `image-import` report before bulk work.
2. Sparse-convert into owned staging, detect source changes, re-inspect the staged qcow2, and hash the staged bytes.
3. Boot the staged image headlessly and offline, verify the exact QEMU and prepared-guest identity, and run the manifest-declared live probes.
4. Stop the owned process tree and prove cleanup before releasing its resource lease.
5. Promote the verified image read-only to `<image_root>/verified/images/<sha256>.qcow2`, register it atomically, and finalize `<image_root>/verified/imports/<run-id>/report.json`.

Publish the registration before the terminal pass report so config failure cannot leave a falsely successful import. If interrupted between those writes, keep the environment missing until reconciliation validates the already-durable registration and terminalizes the exact report. Treat published-but-unregistered content as abandoned. Resolve a managed registration only when its environment revision, digest, size, read-only image, exact read-only report, successful probes, and cleanup proof agree. Never infer readiness from filename placement alone.

## Resolver states

Resolve every discovered definition to one explicit state:

- `ready`: the definition, backend, host capabilities, and image are sufficient to launch.
- `missing`: the definition is valid but a user-provided prerequisite such as the image is unavailable.
- `unsupported`: this host or implementation cannot satisfy the backend/capability tuple.

Attach actionable messages. Do not silently fall back to another image, accelerator, architecture, firmware, or backend.

Show missing and unsupported definitions in discovery output. Hidden failures make configuration arbitrary and prevent the next action from being inferred.

## Adding an environment

1. Inspect the current definition types and existing manifests.
2. Add one definition with a stable id and explicit backend requirements.
3. Keep the image base immutable and outside disposable case directories.
4. Run `qol env list` and `qol env doctor` to verify resolver state and messages.
5. Verify and import the exact prepared image before enabling automated flow use.
6. Boot one detached lane before enabling automated flow use.
7. Add `flow_adapter` only after guest control and teardown are deterministic.
8. Exercise the adapter with one case before increasing `--jobs`.

Do not enumerate a distro matrix in prose. Discover the available set from `flows/envs/*.toml` or `qol env list` at execution time.

## Conflict and trust rules

- Reject ambiguous definitions unless an explicit override layer owns the conflict.
- Validate ids before using them in directory, machine, journal, or lease names.
- Canonicalize report and run relationships before reconciliation.
- Treat paths read from reports as evidence to validate, not authority to delete.
