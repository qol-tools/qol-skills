# Component extraction

Input: an existing module, confirmed component names, and an agreed destination
tree. Output: the same components behind stable imports, an ownership/LOC report,
and the repository's verification evidence. This is a bounded structural pass,
not a mandate to split every large file or reduce total LOC.

## Scope before lanes

1. Inventory concrete types, renderers, state and helpers that already exist.
   Keep uncertain responsibilities out of this pass. Name modules after concepts
   callers recognize; keep composite components together where they share a
   lifecycle. Existing standalone modules need no extraction.
2. Show the proposed file tree to the user when they want input on structure.
   Record the accepted tree, public paths to preserve, and explicit non-goals.
3. Create an isolated worktree at a pinned full commit SHA. Record the starting
   source files and exact writable files per lane in `extraction.json` below.
   Use literal files, never directories or globs. Assign the original source,
   module declarations, imports and reexports to one wiring lane.
4. Search every removed path and changed public name across the repository with
   `rg -F`. Include source-scanning tests and build scripts in ownership. Record
   the hits in the task spec; the checker does not discover semantic consumers.
5. Run `plan` before dispatch. It rejects overlapping ownership, missing baseline
   sources, and a dirty baseline. All lanes read the pinned baseline, not another
   lane's changing source. One lane owns each output file. If dependencies prevent
   parallel work, finish extraction lanes before dispatching wiring.

```json
{
  "base": "FULL_COMMIT_SHA",
  "sources": ["src/components.rs"],
  "lanes": [
    {"name": "toggle", "files": ["src/components/toggle.rs"]},
    {"name": "wiring", "files": ["src/components.rs", "src/components/mod.rs"]}
  ]
}
```

Keep the manifest and reports outside the target worktree. Run from the target
repository; resolve the script relative to this skill's installation directory:

```text
node <skill-dir>/scripts/extraction.cjs plan /absolute/extraction.json /absolute/plan-report.json
node <skill-dir>/scripts/extraction.cjs audit /absolute/extraction.json /absolute/audit-report.json
```

## Parallel implementation

Choose ownership by actual consumers, not generic-looking names. Keep a
composite's interaction, callbacks, private helpers and relevant existing tests
together; retain genuinely shared models and panel orchestration at their
existing owners. A child implementation module can access parent-private state:
expose only the entry points and signature types its parent calls, rather than
widening fields or adding forwarding wrappers. Existing tests follow the code
they exercise, not whichever contiguous source block is easiest to move.

For parallel extraction and wiring, specify exact immutable baseline items,
attributes, signatures and path rebases before dispatch. Neither lane should
derive its work from the other's changing file. Source-scanning tests need exact
per-file count transfers, not broader exemptions. Use normalized move diffs to
isolate wiring changes; retain strings and assertions in the comparison so
normalization cannot hide a behavioral change.

Use the active sessions workflow for spawning, configured models, wake handling,
and loop closure; do not create a second scheduler here. Fan out by disjoint
ownership, not by a desired agent count. Each brief names its component, pinned
baseline, exact files, spec, preserved public API, and permitted wiring changes.
For a pure move, preserve declarations, attributes, existing tests and behavior.
Do not mix renaming, redesign, new abstractions or new tests into the extraction.
Apply the sessions workflow's edit-only lane contract and single central gate.

## Review and acceptance

1. Run `audit` once all lanes settle. It checks the complete tracked and untracked
   delta against ownership, and reports original/current physical LOC over all
   owned paths. A passing audit means scope passed, not behavior passed.
2. Review every moved declaration against the baseline, including private helpers,
   attributes, cfg gates and tests. Check public reexports and import visibility.
   A language parser or exact declaration comparison can support this review.
   A regex-based block count is only a heuristic; do not call it semantic proof.
3. Run the repository's existing full gate once for the combined tree. In
   qol-monorepo use `qol check` with the pinned base, a report, and explicit
   `--format-owned` files. Formatting precedes the final audit/review. Follow the
   repository's runtime/platform verification requirements where applicable.
4. If review or checks fail, send only the concrete defect to the owning lane.
   Preserve the original scope. Rerun affected evidence after corrections;
   never expand exemptions or alter tests just to obtain a green result.
5. Accept only when scope, preservation review and repository gate all pass on
   the same final tree. Commit/integrate through the existing git workflow.
   These scripts do not spawn agents, format, commit, merge, or push.

Report the original file size, residual parent size, and total owned-path LOC
delta separately. Moving 700 lines out of a file is not removing 700 lines from
the repository. Disclose import/wiring growth. For a LOC-reduction objective,
agree a separate deduplication pass and measure its net reduction.

## Checker contract

Requires Node and Git. `plan` and `audit` read the repository and manifest, write
only the requested JSON report, and exit nonzero on invalid inputs or scope
violations. Reports include the resolved base, HEAD, manifest hash, per-file
content hashes, LOC totals, changed paths, and remaining human review gates.
The output directory must exist and be outside the repository. Keep generated
build artifacts ignored. Binary files and symlink inputs are rejected.
The report is a snapshot: rerun after any edit. It cannot prove runtime behavior,
API compatibility, actual agent authorship, or correct architectural boundaries.
