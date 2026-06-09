# Result Report Contract

Every environment or flow run should leave enough evidence for a human or agent to continue without rediscovering what happened.

## Directory shape

```text
<run-root>/<run-id>/
  report.json
  host-preflight.txt
  effective-env.json
  steps/
  logs/
  artifacts/
```

Use stable names. A failed run should still write `report.json` whenever possible.

## Report schema

```json
{
  "name": "vm/startup-reboot-smoke",
  "kind": "flow",
  "environment": "linux/mint",
  "backend": "qemu",
  "started_at": "ISO-8601",
  "finished_at": "ISO-8601",
  "status": "pass",
  "inputs": {},
  "resolver": {
    "state": "ready",
    "messages": []
  },
  "steps": [
    {
      "name": "preflight",
      "status": "pass",
      "duration_ms": 0,
      "artifacts": []
    }
  ],
  "artifacts": {},
  "next": []
}
```

Allowed statuses:

- `pass`
- `failed`
- `skipped`
- `blocked`

Use `blocked` when a prerequisite prevents the scenario from running. Use `failed` when the scenario ran and an assertion did not hold.

## Step contract

Each step should record:

- name
- status
- start/finish or duration
- command/action identity
- short failure reason, if any
- artifact paths relevant to that step

## UI and agent summaries

`qol dev` and agents should summarize from `report.json`, not scrape logs for status.

The summary should answer:

- which environment ran
- which scenario ran
- whether resolution was `ready`, `missing`, or `unsupported`
- which step failed or blocked progress
- where the report lives
- the next useful command

