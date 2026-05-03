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
