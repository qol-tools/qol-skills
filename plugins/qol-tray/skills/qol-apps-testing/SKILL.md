---
name: qol-apps-testing
description: Use when adding, updating, or reviewing tests for qol apps and plugins in this workspace. Covers when to prefer property tests, when to use parameterized tests with dense case sets, and how to avoid low-value tests.
---

# qol-apps-testing

## When to use

Use this skill when the user asks to:
- add tests
- improve or expand test coverage
- review whether tests are meaningful
- convert weak example tests into stronger property or parameterized tests
- design tests for a bug fix or regression guard

## Defaults

- When the task changes code or tests, run the relevant tests by default unless the user explicitly says not to.
- Prefer repo-native validation commands first when the project defines them.
- Prefer testing pure helpers, reducers, validators, parsers, and planners over UI shells or thin wrappers.
- For bug fixes, write the test for the expected behavior before changing implementation when practical.
- A test must fail on a plausible regression. If it would keep passing after the bug comes back, it is not good enough.

## Before claiming a seam is missing

Verdicts like "this isn't testable without a refactor", "we'd need to inject the path", "the seam doesn't exist" must be backed by `path:line` evidence from a survey of the relevant modules. Without that, the verdict is a guess. qol-tools modules already carry test seams that are not obvious from the function signature, so the guess is wrong often enough that you cannot trust it.

**Mandatory grep before declaring a seam absent:**

```
grep -rn "test_path_root\|TestPathRootGuard\|push_test_path_root\|TEST_.*ENV\|cfg(test)" src/
grep -rn "QOL_.*TEST\|_TEST_PATH" src/
```

Also: read `paths.rs` (or whatever owns config/data path resolution) end-to-end. Functions with no path parameter often resolve through a `cfg`-gated override and look hardcoded only at first glance.

**Two-tier path-override pattern in qol-tray (verify, do not trust this table blindly, code may have moved):**

| Tier | Mechanism | Visible to | File / Line |
| --- | --- | --- | --- |
| Unit tests (`#[cfg(test)]`) | `paths::push_test_path_root(&Path) -> TestPathRootGuard` (thread_local) | tests inside `src/` | `src/paths.rs:33-38` |
| Integration tests (`tests/*.rs`) | `QOL_TRAY_TEST_PATH_ROOT` env var | external test crate, debug builds | `src/paths.rs:10, 47-55` |

Both routes redirect every `paths::*` call (`legacy_config_dir`, `base_data_dir`, etc.) under the override. So a service whose I/O goes through `crate::paths::*` is e2e-testable from `tests/<feature>_e2e.rs` today, no signature change required, even when the function appears to take "no path parameter".

**Recorded miss (2026-05, profile sync survey):** Claimed `SyncService` needed a `config_root` injection refactor before it could be e2e-tested because `ensure_sync_dirs`/`save_state_file`/`load_state_file` take no path arg. Wrong. The env-var override had been wired the whole time (`paths.rs:47-50`) and the unit tests at `src/features/profile/sync/service.rs:861` already used the thread_local twin. The "wall" was a survey shortfall, not an architectural gap. Lesson: a no-arg signature is not evidence of global coupling.

**Rule:** if you cannot quote `path:line` for the missing seam, you have not finished the survey. Keep grepping. Do not generalise from "this function takes no path parameter" to "this code is coupled to global paths". Architecture verdicts without `path:line` citations are inadmissible.

## Test Triage Template (apply every time)

Run this template at every "should I test this, and how" decision. It pairs the established workspace style with Right-BICEP and Test-Trophy framing into one repeatable flow.

### Step 1 - classify the thing under test

```
WHAT IS IT?
├─ pure function (input -> output, no I/O)
│   -> property test for invariants + table test for the branches
├─ stateful decision / dispatcher (state in -> outcome out)
│   -> extract a pure decision fn, table-test all branches
├─ I/O orchestrator (reads/writes disk, network, daemon)
│   -> integration test with TempDir + fake provider
└─ thin wrapper (just delegates)
    -> no test (the inner thing is tested)
```

### Step 2 - risk check (override "no test" if any answer is yes)

- Would silent failure lose user data, settings, or time?
- Is this a published API surface or wire format?
- Did this just break in production / for the user?
- Does it gate cross-platform CI under `RUSTFLAGS=-D warnings`?

If yes to any of the above, the change ships with a test even when Step 1 said "skip".

### Step 3 - pick the test SHAPE

Re-uses the picker in "Modern Rust testing toolkit" below. Quick recap:

| Assertion shape | Pick |
| --- | --- |
| Single invariant, wide input space | `proptest` (commit regressions/) |
| 2-10 exact-output rows | inline `let cases = [...]` table |
| 10+ rows, need named cases / fixtures | `rstest` |
| Rich/structured output that evolves | `insta` snapshot |
| End-to-end behavioural contract | integration test (TempDir + fake) |
| Large external corpus | `tests/fixtures/*` + `include_str!` |

### Step 4 - grade the suite, then lift to STATIC where possible

- After tests are green, run `cargo mutants --in-diff git.diff` (PR-scoped) to grade. A surviving mutation is a missing test.
- The most powerful test is the one you delete because a type made the bad state unrepresentable. If you find yourself table-testing the edge cases of a free-string field (case-sensitivity, trailing whitespace, unknown values), the field probably wants to be an enum. Lift to static, delete the runtime test, ship.

### Test-Trophy lens (Kent C. Dodds)

The trophy hierarchy is, biggest to smallest investment:

1. **Static** - types, exhaustive matches, lints, `-D warnings`. Cheapest, hardest to bypass.
2. **Unit** - pure helpers, decision fns, validators.
3. **Integration** - multiple units interacting on real disk / in-memory fakes.
4. **E2E** - full system. Use only when nothing below the view layer can validate the behaviour.

The right shape for THIS workspace is heavier on integration than the classic pyramid. Most qol-tools bugs are wiring bugs across the daemon / sync / config / UI boundary. Push tests to the integration tier where reasonable; never let "static" stay weak when a stronger type would make tests unnecessary.

## Test selection

### Prefer property tests when the behavior is defined by invariants

Good fits:
- parsing and normalization
- filtering and matching
- sorting and ranking invariants
- bounds and clamping behavior
- reversible operations
- escaping and sanitization rules
- validation logic
- path and command safety constraints

Standard Rust pattern:

```rust
proptest! {
    #![proptest_config(ProptestConfig::with_cases(200))]

    #[test]
    fn prop_invariant(...) {
        ...
    }
}
```

Use enough generated cases to make the test worth having. `200` is the default expectation in this workspace unless there is a reason to use more or less.

### Use parameterized tests when exact outputs matter

Good fits:
- exact serialized output
- generated shell scripts or command args
- MIME/content-type mapping
- OS-specific path handling
- exact error classification
- fallback order and precedence rules
- known regression matrices

Use dense case tables, not one-off examples. Each row should cover a distinct branch, edge, or encoding concern.

## What good tests look like here

- Assert behavior, not just that code runs.
- Use abundant edge data: empty values, duplicates, unicode, quotes, spaces, control characters, boundaries, disabled flags, invalid inputs.
- Check exact contracts when output format is user-facing or shell-facing.
- Prefer one strong property test over many repetitive examples.
- If using example tests, make them table-driven unless there is only one truly unique case.

## What to avoid

- smoke tests that only assert `is_ok()`
- tests that mirror implementation line by line
- tests for trivial getters, constructors, or pass-through wrappers
- a single happy-path example when a table or property would cover the real risk
- large integration tests when the logic can be extracted into a pure helper

## Never weaken tests to make them pass

When a previously-green test starts failing after a code change, the default
assumption is that the implementation is wrong, not the test. Do not loosen
assertions, change expected values, or remove cases just to get green again.

Steps:
1. Re-read the test. What invariant did the original author encode?
2. Decide whether that invariant is still desired. If yes, fix the code. If
   no, change the test only after stating in plain words why the contract
   itself moved.
3. Never silently flip an expected value to match observed output.

This is a repeat-offender rule. The user has called it out explicitly.

## Property tests must exercise production parameters

A property test that uses default / zeroed parameters will not catch bugs
that only trigger at production values. Examples:

- A floor-redistribution bug only triggers when `minSlotPx > 0`. A property
  test with `minSlotPx: 0` will pass while the real bug ships.
- A scaling bug only triggers when zoom ≠ 1. A property test pinned to
  `zoom: 1` will pass while wide ranges break.

When writing a property test:
- Generate over the full realistic range of every parameter that affects the
  invariant being tested, not just the easy ones.
- If a parameter has a meaningful production default (e.g. `MINIMAP_MIN_SLOT_PX`),
  include that exact value in the case set.
- A property test that holds a key parameter constant is really an example
  test in disguise — say so or expand the generation.

## UI and app guidance

- For GPUI or Preact flows, extract decision logic into pure functions and test those.
- Avoid expensive UI integration tests unless the behavior cannot be validated below the view layer.
- For platform-specific bugs, add tests to the platform module rather than broad shared-code tests.

## Review checklist

Before finishing test work, check:
- Would this fail if the bug returned?
- Does it cover the real boundary conditions?
- Is the data set dense enough?
- Does it test the contract rather than the current implementation shape?
- Could this be a property test instead?
- If not a property test, should it be a parameterized table?

## Output expectation

When adding tests in this workspace, default to:
1. property tests for invariants
2. parameterized tests with abundant cases for exact-output behavior
3. minimal integration tests only when unavoidable

Before declaring test work complete:
- Run the narrow test slice you changed first.
- Then run the project-required verification stack if the repo skill defines one.
- Do not claim a Rust repo is green from `cargo test` alone when clippy or repo-native build commands are part of the normal workflow.

## Modern Rust testing toolkit

Use the right tool for the assertion shape, not just the old habit. The crates below are verified state-of-the-art (context7, source reputation High) and supersede ad-hoc patterns:

### `insta` for snapshot tests

Use when expected output is rich/structured and likely to evolve: serialized JSON / YAML, formatted strings, error messages, ASTs, generated code, multi-line debug output. Replaces brittle `assert_eq!(actual, "{ ... }")` with reviewable diffs.

```rust
insta::assert_snapshot!(rendered_diff);            // Display
insta::assert_json_snapshot!(state);                // serde_json
insta::assert_snapshot!(tag, value, @"inline");     // inline snapshot in source
```

Workflow: edit code, run tests (snapshots written as `.snap.new`), `cargo insta review` to interactively accept/reject diffs, commit accepted `.snap`. For inline snapshots the `@"..."` literal is updated in-place by `cargo insta accept`. Use snapshots for `SyncStateFile` round-trips, profile-bundle exports, error-message contracts.

### `proptest` regression files for shrunk failures

When a property test fails, `proptest` writes the minimal counterexample to `proptest-regressions/<module>.txt`. Commit that file. Future runs replay regressions before fresh inputs - so a once-found bug stays caught even if the strategy stops generating it.

### `cargo-mutants` for grading the test suite

Periodically (or in CI on PR diffs via `cargo mutants --in-diff git.diff`) run mutation testing. It rewrites operators / return values in your code and reports which mutations no test catches. The output names *exactly* which untested branches need a case. Cheap on PR diffs, expensive whole-repo - run incremental on every PR, full sweep on a schedule.

### `rstest` for attribute-style parameterized tests

Reach for `rstest` when an inline `let cases = [...]; for ...` table grows past ~10 rows or needs fixtures. Each case becomes its own named test, so a failure points to the exact row by name without a `cases` index lookup. Inline tables remain the right default for short grids - use `rstest` when the grid earns it.

### When to pick which

| Assertion shape | Pick |
| --- | --- |
| Single invariant, wide input space | `proptest` (commit regressions) |
| 2-10 small exact-output rows | inline `let cases = [...]` table |
| 10+ rows, need named cases or fixtures | `rstest` |
| Rich/structured output that evolves | `insta` snapshot |
| Grading "do my tests catch real bugs?" | `cargo-mutants --in-diff` |
| Large external corpus (RFC suite, recorded payloads) | `tests/fixtures/*` + `include_str!` |

When upgrading older example-tests, follow the picker above. Do not migrate working tests just to use a newer crate - upgrade when the existing test is brittle, opaque, or insufficient.

## Recipes (concrete patterns from the workspace)

### Recipe: testing command-execution wrappers (tokio::process)

Use real shell commands instead of mocking the process layer. POSIX coreutils give you a stable, fast vocabulary for every behaviour you need to assert:

- `true` - exit 0, no output
- `false` - exit 1
- `exit N` - exact non-zero exit code
- `echo X` / `echo X 1>&2` - stdout vs stderr
- `sleep N` - timeout firing
- `pwd` - current working directory

Gate the integration block with `#[cfg(unix)]` and put it in a `mod unix_integration` inside `mod tests`. Pure-helper tests (spec construction, error formatters) sit at the top level and run cross-platform. Pattern:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    // pure-helper tests here, run everywhere

    #[cfg(unix)]
    mod unix_integration {
        use super::*;
        #[tokio::test]
        async fn execute_succeeds_for_trivial_command() { ... }
        #[tokio::test]
        async fn execute_times_out_when_command_outlasts_timeout() { ... }
    }
}
```

When a wrapper interpolates user params into a shell line, write at least one **shell-injection guard test**: feed a param value containing `; rm -rf /tmp/canary-name` and assert it arrives at `echo` as one literal arg. This pins the escaping contract; otherwise a regression reintroducing unquoted interpolation passes silently.

If you call `.unwrap()` on a result type in tests, the type must `#[derive(Debug)]`. Add the derive on the production type rather than working around it in tests.

### Recipe: pinning HTTP / IPC contract shape

When a Rust struct serializes to JSON consumed by an external client (browser extension, UI, mobile app, CLI), test the exact serialized shape with `serde_json::to_value` against `serde_json::json!({...})`. The test catches accidental contract drift (renames, default-vs-omitted fields, casing changes) before the external client breaks.

```rust
let value = serde_json::to_value(&response).unwrap();
assert_eq!(
    value,
    serde_json::json!({
        "success": false,
        "exitCode": 42,  // camelCase rename pinned
    }),
    "exitCode is the contract the browser extension reads",
);
```

For request bodies, the symmetric test: feed canonical JSON via `serde_json::from_str` and assert each field, including default-on-omitted ones (`#[serde(default)]`).

### Recipe: testing axum handler error helpers

axum's `Json<T>` is a `pub struct Json<T>(pub T)`, so handler tests can destructure with `let (status, Json(body)) = bad_request(...);`. Don't spin up a Router for what is just a tuple constructor under test.

### Recipe: testing decision/dispatcher logic without mocking I/O

Extract the gating decision into a pure function that takes state by reference and returns an enum (`Skip(&'static str) | Proceed`, etc.). The orchestrator stays one-line. Table-test the pure function across all enum variants. Same shape worked for `launch_pull_decision` in qol-tray's sync service.

### Recipe: integration tests that need real config dirs

For services that resolve paths via `crate::paths::*`, look for an existing test-path-root override (`paths::push_test_path_root` in qol-tray) before reaching for a mock. The override pushes a `TempDir` into a thread_local, so every `paths::*` call inside the test resolves under the temp root. Pair with a fake provider (Folder provider for sync, real FS for installers) and you get end-to-end behaviour tests without networking.
