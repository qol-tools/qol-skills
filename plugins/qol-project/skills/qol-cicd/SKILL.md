---
name: qol-cicd
description: Use when authoring or modifying CI, versioning, or release workflows in the qol-monorepo (.github/workflows/*.yml, .github/scripts/*), or when a release or version bump does not behave as expected.
---

# qol-cicd

## Scope

All CI/CD lives in the monorepo under `.github/workflows/` and `.github/scripts/`.
There are no shared or reusable workflows in a separate repo; each workflow file is the source of truth for its own behavior.

## Workflow inventory, by role

- `ci.yml` - lint + test on push, pull request and merge group. One plan job runs every gate that needs no compiler (the repository hooks, the script tests, qac lint, the affected-crate plan via `.github/scripts/affected_crates.py`), and only its success starts the ubuntu, macos and windows matrix of fmt, clippy `-D warnings` and tests. The plan compiles nothing for a diff of only Markdown or `.github` files, except Markdown that Rust source embeds with `include_str!` or `include_bytes!` (planned as source) and `ci.yml`, `affected_crates.py` and `cleanup_cgroup_journal.py` (planned as the full workspace). The merge group's matrix is fail-fast; a pull request's keeps every OS result. No job waits for the review or watches the others: the review runs beside the workflow, and the queue admits a pull request only once both required checks pass. Skips itself on version-bump commits.
- `plugin-version.yml` - versioning. Runs on push to main (or dispatch); computes a bump per release unit from conventional-commit history, commits `chore(plugins): bump plugin versions`, builds and packages every release candidate, all plugins of one target in one `Candidate plugins (<target>)` job (targets from each plugin's `plugin.toml` `platforms` via `.github/scripts/plugin_matrix.py`; more plugins on one target than the 32 upload slots in `release_candidate.py` fails the job), uploads the release files as `dist-<tag>-<target>` artifacts kept 90 days, and pushes `<id>-vX.Y.Z` tags.
- `release.yml` - plugin releases. Fires on a `<id>-vX.Y.Z` tag; verifies the tag's candidate attestation, downloads the release files from the Versioning run the attestation names, requires one per target, and pushes them to the registry. It builds nothing.
- `qol-tray-release.yml` - host release. Fires on a `qol-tray-vX.Y.Z` tag and publishes the candidate's Linux, macOS and Windows packages as a GitHub Release, the same way.
- `release-prune.yml` - scheduled cleanup of old releases.

Release units and tagging rules live in the `qol-tray-release-flow` skill; read it before cutting any release.

## Editing guidance

- The Python release scripts under `.github/scripts/` have tests in `.github/scripts/tests/`; `ci.yml` runs them on every push, and any script change needs a matching test change.
- A `workflow_run` consumer must pass `github.event.workflow_run.id` into its verifier and validate that exact run's workflow, event, SHA, conclusion, and required jobs. Do not rediscover the triggering run through a filtered workflow-list query; manual dispatch may retain SHA-based lookup. [GitHub's documented pattern](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_run) uses the event's run ID directly.
- Pin third-party actions to a commit SHA (the existing workflows all do).
- Keep `RUSTFLAGS`/clippy at `-D warnings` parity with local checks; a workflow that is more lenient than the local gate hides breakage until release time.
- Platform coverage derives from `plugin.toml` `platforms` - never hardcode a runner list for plugin builds.
- Every publish job builds the registry tool (`qol-plugin-registry`) after merge, with `system-dependencies: "false"`. The `registry tool build` job in `ci.yml` builds it the same way and the merge gate needs it, so a dependency that pulls a system library into the tool fails the pull request instead of every release. `test_release_workflow_contract.py` holds that job and the publish jobs to one contract; change them together.
- Run release pruning sub-daily at a non-zero minute and keep manual dispatch available; weekly cleanup allows bursty versioning to accumulate stale releases for too long.

## Shared build setup and cache contract

`.github/actions/rust-setup/action.yml` owns the toolchain, dependency cache,
and Linux apt dependency steps. Every workflow job that compiles the workspace
calls it with its `cache-key` input; never copy setup steps into a
workflow. Setup only: build commands and verify gates stay in the workflows
and scripts. RUSTFLAGS stays declared per job so warning parity remains
visible in each workflow file.

Cache namespaces are one per (build family, platform). Release workflows
build nothing; they publish the candidate's files:

| Workflow / job | cache-key |
|---|---|
| ci.yml check (ubuntu, macos) | `ci-${{ matrix.os }}` |
| ci.yml process-windows | `ci-windows-sandbox` |
| plugin-version.yml plugin_candidate | `plugin-release-${{ matrix.target }}` |
| plugin-version.yml qol_tray candidates | `qol-tray-linux`, `qol-tray-macos`, `qol-tray-windows` |
| ci.yml registry-tool, and the registry jobs of release.yml / plugin-index.yml / plugin-registry-backfill.yml / qol-tray-host-publish.yml / release-prune.yml | `plugin-registry` |

Every rust-cache use runs with `save-if: ${{ github.ref == 'refs/heads/main' }}`
so only main-fed jobs save caches, plus `cache-on-failure: true` so a red
main job (a flaky test) still refreshes its namespace instead of leaving every
later run cold. Cache keys embed the shared key, runner,
RUSTFLAGS env hash, and lockfile hash; changing a namespace or RUSTFLAGS
invalidates keys, so batch such changes into one deliberate cold wave.

`.github/scripts/cache_prune.py` owns the total byte ceiling. Pruning groups by
ref and namespace, expires unused entries, and removes superseded entries
before current ones. Keep headroom below the hosting quota.

A job that compiles the workspace never holds an `actions: write` token: every
build script, procedural macro and test it runs can read the checkout's stored
credentials, and that scope can delete caches and dispatch workflows. Cache
deletion runs only in the scheduled prune job, which compiles nothing.
Never delete by key or prefix: a concurrent save must not cause removal of the
replacement or a newer entry. Cache deletion uses
[GitHub's ID endpoint](https://docs.github.com/en/rest/actions/cache#delete-a-github-actions-cache-for-a-repository-using-a-cache-id).
Test overlapping saves, foreign refs, CLI budget wiring, and that no build job
holds a deletion token.

### What a build cache entry holds

A cache key is immutable, and the key only changes when a third-party
dependency changes: rust-cache hashes the lockfile's registry and git packages
and ignores workspace versions, so version bumps reuse the same entry. An entry
therefore holds exactly what the main run that saved it compiled, until the
next dependency change.

A release check and a release build compile different units, so a build never
warms a check. The setup action exports `build-cache-hit`; the main run that
misses the exact key, and so saves a new entry, also runs the release check.
Pull requests then restore third-party check artifacts instead of recompiling
every third-party crate on each run. To put a new kind of artifact into an
existing entry, delete that entry by id and let the next full main run save it
again: one deliberate cold run for that namespace.

rust-cache never keeps workspace members or path dependencies, so the vendored
crates under `vendor/` (gpui, ravif, global-hotkey) and every registry crate
that depends on them compile again in every job.

### No compiler cache

CI ran a 512 MB sccache archive beside the dependency cache until October 2026.
Across ten sampled jobs it hit 0 to 3 percent of Rust compilations: a full main
run writes several times the capacity, eviction keeps the last crates compiled,
and those are the top of the workspace graph that changes with every commit.
It was removed and its space went to the release check artifacts. Before adding
a compiler cache again, measure hits on hosted runs first, and scope it to
crates whose inputs are stable between commits.

## Merge queue

main merges pull requests through a merge queue (ruleset "main merge queue").
PR runs of ci.yml do `cargo check --release`; the `merge_group` run and main
pushes do the full `cargo build --release`, so a release-only link error sends
the PR back instead of landing, and main keeps the release cache warm for the
queue. A push that lands a commit the queue already passed skips lint, test and
build, so it saves no cache; only a direct push runs the full workflow on main. Org and repo admins bypass the queue for direct pushes. The Versioning
prepare job pushes its bump commit with the `VERSIONING_DEPLOY_KEY` deploy key,
because the Actions token cannot bypass a ruleset; tags stay on the Actions
token so tag pushes never trigger the release workflows beside the dispatch.

A pull request run uploads the base it tested as a `tested-base` artifact.
The `merge_group` plan runs `.github/scripts/queue_trust.py` instead of planning afresh: when the pull request run of the entry's head passed the merge gate and nothing that landed since its tested base reaches a crate it tested, the entry is trusted.
A trusted entry skips check, process-windows, the registry tool build and, when every OS plan skips, the release build, and the queue gate accepts it; otherwise the entry runs every affected job and the step logs why.
`release_candidate.py` refuses a reused, batched queue run whose plan lacks the trust step.
A head pushed and re-armed with `gh pr merge --auto` within seconds can enter the queue before its pull request run exists, so that entry gets no reuse.

The squash commit's subject is the pull request title, and `plugin_version.py`
picks the bump from it and from the `* type(scope): ...` lines of the squash
body (`feat` is minor, never patch). Only the subject's scope picks which
units release; qol-tray:qol-tray-release-flow, section 1, owns that rule. The plan job's "Squash subject is
conventional" step runs `.githooks/commit-msg` on that subject: it fails the
`merge_group` run and only warns on pull request runs, because a title edit does
not rerun them. See the qol-workflow:commit skill, "Pull request titles".

## Local verification

```bash
ruby -e 'require "yaml"; YAML.load_file(".github/workflows/release.yml"); puts "ok"'
python3 -m unittest discover -s .github/scripts/tests -p 'test_*.py'
```
