# Storm Report Contract

Read this file when creating or reviewing a reusable storm workflow. Prefer the repository's native report format; add equivalent fields rather than inventing a second report family.

## Required semantics

A report must make these facts machine-readable:

- workflow name, run ID, start/end time, and final status;
- source revision and dirty/clean state when available;
- target component and real entrypoint;
- environment, platform, build/install mode, and isolation identity;
- inputs including repeat count, fanout, seed, and selected attacks;
- invariants and their individual verdicts;
- per-lane attempted, acknowledged, persisted, unique, recovered, and cleaned counts where relevant;
- bugs with reproduction evidence, regression test, fix reference, and post-fix live verdict;
- traces, logs, screenshots, configs, and other artifacts;
- cleanup verdict and remaining live resources;
- invalid/inconclusive runs and concrete reasons;
- unsupported or untested platforms and other limitations.

## Example shape

```json
{
  "name": "feature-storm",
  "run_id": "opaque-run-id",
  "started_at": "ISO-8601",
  "finished_at": "ISO-8601",
  "status": "pass",
  "source": {
    "revision": "git-revision",
    "worktree": "clean"
  },
  "target": {
    "component": "feature",
    "entrypoint": "real user or production path"
  },
  "environment": {
    "platform": "platform-id",
    "build_mode": "production-like",
    "isolation": "disposable-vm"
  },
  "inputs": {
    "fanout": 3,
    "repeat_count": 40,
    "seed": null
  },
  "invariants": [
    {
      "id": "concurrent-persistence",
      "verdict": "pass",
      "evidence": "artifacts/lane-1/result.json"
    }
  ],
  "lanes": [
    {
      "id": "lane-1",
      "status": "pass",
      "attempted": 40,
      "acknowledged": 40,
      "persisted": 40,
      "unique": 40,
      "recovered": 40,
      "cleaned": 40
    }
  ],
  "bugs": [],
  "artifacts": {},
  "cleanup": {
    "status": "pass",
    "remaining_resources": []
  },
  "invalid_runs": [],
  "limitations": [],
  "next": []
}
```

## Status rules

Set `status` to:

- `pass` only when all required invariants and cleanup pass;
- `failed` when the product or harness violates a required invariant;
- `inconclusive` when external state prevents a trustworthy verdict;
- `skipped` only when a declared prerequisite or capability is absent.

Do not erase failed attempts after a later pass. Retain them as lane attempts or linked artifacts so another agent can reconstruct what changed.

## Artifact rules

- Use stable run directories and relative artifact links where the native runner supports them.
- Preserve raw evidence; add summaries without replacing raw data.
- Redact secrets, tokens, personal paths, window titles, and user content.
- Hash important immutable payloads when cheap.
- Write the report on failure paths and cleanup failures, not only on success.
