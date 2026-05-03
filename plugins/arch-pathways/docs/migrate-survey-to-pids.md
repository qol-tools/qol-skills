# Migrating an existing HTML survey to GitHub-issue PIDs

The legacy HTML survey at `/tmp/qol-tray-pathways.html` uses `AREA-N` style PIDs
(`BOOT-1`, `PATH-3`, `SYNC-2`, …) that were minted before the GitHub-issue
convention. The new convention is `<REPO_PREFIX>-<issue_number>` per area, with
sub-IDs `<PID>.M` per smell row inside the area.

This doc describes how to promote each area, one PR at a time. **Do not run
this in bulk** — each promotion creates a real GitHub issue, opens a real PR,
and is meant to be acted on. Ship the implementation alongside, or close the PR
and leave the issue open as the canonical address.

## Prerequisites

- `gh auth status` shows you are authenticated for the target repo (write access).
- `$QOL_WORKSPACE_ROOT` is set, or you run from inside the workspace.
- `lib/prefixes.json` includes the target repo (e.g. `qol-tray` → `TRAY`).

## Per-area migration

For each area in the HTML survey:

```bash
# 1. Promote the area: mint issue + worktree + draft PR seeded with the ADR
node ${CLAUDE_PLUGIN_ROOT}/bin/pathway-pr.cjs <area-id> <repo>

# Examples:
node $PLUGIN_ROOT/bin/pathway-pr.cjs boot     qol-tray
node $PLUGIN_ROOT/bin/pathway-pr.cjs paths    qol-tray
node $PLUGIN_ROOT/bin/pathway-pr.cjs sync     qol-tray
node $PLUGIN_ROOT/bin/pathway-pr.cjs devprod  qol-tray
node $PLUGIN_ROOT/bin/pathway-pr.cjs plugins  qol-tray
```

Each call:
- Reads the area's `<h2>` title and creates a GitHub issue with that title.
- Computes the PID, e.g. `TRAY-42`.
- Rewrites in-area sub-IDs as `TRAY-42.1, TRAY-42.2, …` (in row order).
- Generates the markdown ADR for the area (problem mermaid + smell table +
  proposals + closes lines).
- Creates worktree at `<workspace>/worktrees/<repo>/<branch>` with branch
  `<prefix>-<n>-<slug>`.
- Commits the ADR and pushes.
- Opens a draft PR titled `<PID> <Title>` with body `Closes #N` + link to ADR.

## Recommended order

The cross-area page in the HTML survey shows dependencies. Promote leaves
first. For `qol-tray`, the recommended order based on the survey was:

1. `paths` — foundation; everything else depends on stable path resolution.
2. `boot` — startup determinism is a precondition for daemon supervision.
3. `plugins` — plugin lifecycle depends on boot and paths.
4. `sync` — profile sync depends on stable plugin layout.
5. `devprod` — dev/prod separation is a polish layer on top.

## Idempotency

`pathway-pr` is **not** idempotent — a second invocation creates a second
issue. If a promotion is interrupted between steps, finish it manually:

- If the issue exists but no branch: run `pid-new <repo> "<Title>" --issue <N>`.
- If the branch + worktree exist but no PR: open the PR manually with
  `gh pr create --draft --title "<PID> <Title>" --body-file docs/adr/<file>.md`.

## After all areas are promoted

The HTML survey at `/tmp/qol-tray-pathways.html` becomes a historical document.
The canonical address space is now GitHub Issues + the per-PR ADR files in
`<repo>/docs/adr/`. The workspace-level overview is `gh issue list` filtered by
the repo's prefix.

You can keep the HTML around for reference, or commit a snapshot to
`<repo>/docs/initial-survey.html` if it's useful to record the original
brainstorming state. Don't keep it as the source of truth — it goes stale and
will diverge from the GitHub state without warning.
