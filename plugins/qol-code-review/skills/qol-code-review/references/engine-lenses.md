# Lenses

A lens is one question asked of every changed line.
Each lane applies only the lenses its job file names.
The severity of a candidate follows the rubric in `rubric` (the Severity and Confidence Rubric of the qol-code-review skill), never a rubric of its own.
Read the section for each of your lenses before you read the patch.

Every section has three parts.
"Look for" lists what to check, in the order that finds the most real defects.
"Do not flag" lists what never becomes a candidate under this lens, even when it is true.
"Decline when" lists when to record a topic under `declined` instead of judging it.

A suspicion that belongs to another lens is not your candidate.
Record it under `declined` with the other lens named in the topic, so the session can pick it up.

## correctness

Does the changed code do what the intent says, on every input it will actually see?
This lens runs at every level.

### Look for

- Requirements in `intent.json` that the change does not meet, or meets only in part.
- Inverted conditions, wrong comparison operators, wrong variables and shadowed names.
- Off-by-one errors at loop bounds, slice ends, ranges and pagination.
- Edge inputs the callers can produce: empty, zero, negative, null, missing keys, duplicates, very large values and non-ASCII text.
- A value read before it is set, a stale cache, or shared or caller-owned data mutated in place.
- Early returns, `continue` or `break` that skip cleanup or a required step.
- Mismatched types and units: strings compared as numbers, integer division, seconds against milliseconds, time zones and text encodings.
- A refactor that changes behavior for some class of input; compare the old and new code input class by input class.
- A rename or signature change that missed a call site.
- A step that applies twice when the operation is retried or re-run.

### Do not flag

- Style, naming, formatting or how the code is organized.
- Inputs no caller can produce; show the caller that can, or drop it.
- Behavior the intent asks for.
- Features the intent does not mention.

### Decline when

- The answer depends on runtime state you cannot read, such as a database row or a remote service.
- The suspicion is about failure handling, concurrency, stored data, interfaces, shipping, tests or speed; name the lens that owns it.

## errors

What happens when something fails?
Signals that route this lens: `error-handling`, `removed-validation`.

### Look for

- Swallowed errors: an empty catch, a catch that logs and carries on, an ignored return code, a discarded result or a promise without a handler.
- A broad catch around several calls; name the failures it could hide.
- Validation that was removed or weakened, and defaults that now hide bad input.
- Work left half done when a later step fails, with no rollback or cleanup.
- Files, locks, handles or processes leaked on the error path.
- The wrong error surface: internals leaked into a user-facing message, the wrong exit code, or a failure reported as success.
- Retries of a failure that cannot succeed, or retries without a bound or a backoff.
- A fallback that silently returns a default where the caller needs to know about the failure.

### Do not flag

- Missing log lines, when the error still reaches the caller.
- A catch that adds context and rethrows.
- Error handling in tests, unless a test can pass while hiding a failure.

### Decline when

- The failure only shows in a real environment you cannot reproduce or read, such as a full disk or a dropped connection, and the code does not settle it.

## concurrency

Does the changed code stay correct when other code runs at the same time?
Signals that route this lens: `concurrency`.

### Look for

- A data race on shared state, and check-then-act sequences on files, maps or rows.
- Missing locks, locks taken in an order that can deadlock, and locks held across an await or blocking I/O.
- A missing await, a fire-and-forget promise, an unhandled rejection, or an ordering assumed between independent tasks.
- Cancellation or a timeout that leaves state half updated.
- Callbacks, signals or handlers that re-enter code that is not reentrant.
- Workers or scheduled jobs that misbehave while old and new versions run side by side during a deploy.

### Do not flag

- Code that runs on one thread with no shared state.
- A race without an interleaving that triggers it; write the interleaving as the trigger, or drop it.

### Decline when

- The answer depends on scheduler or memory-model guarantees of a runtime the repository does not pin down.

## security

Does the change open, widen or move a trust boundary?
This lens runs at every level.

### Look for

- Untrusted data traced from its entry point to its sink before any checklist: SQL, shell commands, file paths, templates, HTML, regular expressions, deserializers and headers.
- An authentication or authorization check that was moved, removed or skipped on a new path, including access to another user's objects by id.
- Credentials, tokens or keys added to code, logs, error messages or URLs.
- Weak or home-made cryptography, fixed salts or nonces, non-constant-time comparison of secrets, and disabled certificate checks.
- User input in file paths, symlink handling, archive extraction and temporary files.
- Server-side request forgery, open redirects, and changes to CORS, CSRF protection or cookie flags.
- A boundary that moved: a new input source, a new listener, a wider permission or a dependency that runs install scripts.
- Unbounded input that exhausts the process: catastrophic regex backtracking, unbounded allocation or missing size limits.

### Do not flag

- An attack that needs the access it would grant.
- Missing hardening that is not a vulnerability here, such as rate limiting on a local command-line tool.
- A weakness without an exploit scenario; every security candidate states the attacker, the input and the outcome as its trigger.
- Fake credentials in test fixtures.

### Decline when

- Exploitability depends on deployment settings that are not in the repository; record what would decide it.

## data

Does the change keep stored and serialized data correct and readable?
Signals that route this lens: `migration`, `serialization`.

### Look for

- A migration that cannot be reversed, rewrites data in a way that is not idempotent, locks a large table, or adds a non-null column without a default.
- Old code running against the new schema, or new code against the old one, during a deploy or a rollback.
- Renamed, retyped or removed fields that readers still use, and new enum values that old readers reject.
- Truncation, lost precision, changed encodings and writes that overwrite instead of merging.
- Cache keys that collide across versions and entries that go stale after a format change.
- Files or messages written by earlier versions that the new code can no longer read.

### Do not flag

- Schema naming or style.
- Migration speed on data sizes the project does not have.

### Decline when

- The risk depends on the shape or size of production data that the repository does not show.

## contracts

Does the change keep every promise other code depends on?
This lens runs at every level.

### Look for

- Removed or renamed exports, changed signatures, defaults, return shapes and error types; find every caller with `git grep` and say whether callers outside the repository can exist.
- Command-line flags, config keys, environment variables, file formats, wire protocols, event names and exit codes that changed.
- Documentation that is now wrong: the README, help text, docstrings, type hints and schemas.
- A breaking change shipped without the version bump or migration note the project's own rules require.
- Ordering, uniqueness, nullability, thread-safety or idempotency that callers rely on and the change no longer keeps.
- Registries, manifests, routing tables and indexes that must change in step with the code and did not.

### Do not flag

- Internal helpers whose callers all changed in the same patch.
- Additive changes that keep the old behavior.

### Decline when

- Whether outside consumers exist is unknown; record the question.

## release

Will the change build, ship and run safely?
Signals that route this lens: `ci-config`, `build-config`, `dependency-manifest`, `mode-change`.

### Look for

- Removed or weakened CI checks, secrets exposed to untrusted forks, widened workflow permissions and unpinned third-party actions.
- Build changes to targets, flags, output paths or platform conditions.
- New dependencies, their maintainers and install scripts, loosened version ranges, a lockfile out of step with its manifest, and license changes.
- Executable bits added to or dropped from scripts.
- Config defaults or feature flags that change behavior at deploy time, and whether the change can be rolled back.
- A commit in a series that does not build on its own, when the project bisects.

### Do not flag

- Version bumps the project automates.
- Formatting in config files.

### Decline when

- The deploy pipeline lives outside the repository.

## tests

Do the tests prove the change works and keep it working?
This lens runs at every level.

### Look for

- Changed behavior with no test that would fail if the change were reverted.
- Tests that cannot fail: assertions only on mocks, assertions that match anything, and tests that are skipped or focused.
- Removed or weakened tests and assertions; a deleted test needs a stated reason.
- Tests that pass for the wrong reason, such as the wrong fixture or an assertion of the buggy behavior.
- Flaky patterns: real time, randomness, ordering, network access and state shared between tests.
- High-risk edge cases from the correctness lens that no test covers.

### Do not flag

- Coverage percentages for their own sake.
- Missing tests for trivial code, docs or plain config.
- Test naming and style.

### Decline when

- The project has no tests for this area at all; say so once, as a single topic.

## performance

Does the change add cost on a path that matters?
Signals that route this lens: `perf`.

### Look for

- Work that grows faster than the input on inputs that can be large: nested loops over collections, quadratic string building and repeated work inside loops.
- I/O inside loops: a query, a process spawn or a network call per item, and unbatched writes.
- Unbounded growth: caches without eviction, buffers, listeners and retained references.
- Blocking calls on a hot path or an async path.
- Startup cost added to every run of a command, hook or request.

### Do not flag

- Micro-optimizations without a measured or obviously large effect.
- Cold paths that run once.

### Decline when

- The cost depends on input sizes the repository does not show; record the question.

## redundancy

Does the change add what the codebase already has, or leave dead weight behind?
Signals that route this lens: `refactor`, `new-file`.

### Look for

- A new helper, type, constant or table that an existing one already provides; search with `rg` before accepting it as new.
- Shallow wrappers: a function whose body is one call to another function, with at most unwrapping, trimming, cloning or renaming around it. `inputs.shallow_wrappers`, when not null, lists what the detector found; every entry is a candidate unless the trait or boundary is foreign to this repository.
- After a migration onto a shared owner, local functions that now only forward, and their duplicate test tables.
- Duplicate logic, state or checks: the same rule written in two places that will drift.
- A second mechanism beside the first: a parallel parser, cache, queue, poster or registry for the same job.
- Dead code the change leaves behind: unused exports, branches no caller reaches and flags nothing sets.

### Do not flag

- Duplication of two or three lines that a shared helper would only obscure.
- A wrapper that adapts a foreign trait, an FFI boundary or a public API kept for compatibility.
- Test setup that repeats on purpose to keep each test readable.

### Decline when

- Whether the existing owner can take the new behavior depends on a design decision the intent does not state; record the question.

## architecture

Does the change put logic, data and ownership in the right place?
Signals that route this lens: `api-change`, `api-removal`, `refactor`, `migration`.

### Look for

- Logic in a thin exposure layer (a command, tool or hook shell) that belongs in an importable building block both could call.
- Ownership drift: a module reaching into another module's data, or two modules each owning one fact.
- Coupling that grows: a new import direction between layers, a cycle, or a shared global.
- A data flow whose source of truth is unclear, or state copied instead of derived.
- A change with no rollback or migration path where one is needed.
- A deterministic step written as prose for the agent to perform again each turn, where a script already owns that input and output.

### Do not flag

- Taste in file layout or naming when the structure still works.
- A rewrite the intent asks for.

### Decline when

- The judgment needs the project's roadmap or ownership map, which is not in the repository.
