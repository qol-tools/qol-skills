---
name: qol-cicd-infra
description: >
  Use when discussing, designing, or modifying CI workflows, git hooks, or repo
  bootstrap across qol-tools. Routes each change to the automation owned by the
  current repository, with extra architecture guidance for qol-monorepo product
  CI. Loaded automatically by a UserPromptSubmit hook for CI and workflow
  prompts rooted in qol repositories.
---

# Route automation to its repository owner

Use this skill as a routing layer. First locate the current repository with
`git rev-parse --show-toplevel`, then inspect that repository's automation. Do
not treat a separate `qol-cicd` repository as the owner of current workflows.

## qol-monorepo product workflows

1. Confirm the repository root is `qol-monorepo`.
2. Read `qol-project:qol-cicd` for product workflow ownership and local
   verification.
3. Read `qol-project:qol-arch-cicd` for platform coverage and warning-parity
   constraints.
4. Inspect the owning file under `.github/workflows/` and any helper under
   `.github/scripts/` before designing a change.

Those monorepo-local files are the source of truth. There is no separate
reusable-workflow layer to edit or call. Extend the existing owning workflow or
helper instead of creating parallel automation.

## qol-skills automation

When the repository root is `qol-skills`, its own `.github/workflows/`,
`scripts/`, plugin hooks, and tests own skill validation and manifest-sync
automation. Inspect those files directly. Do not redirect a qol-skills CI change
to qol-monorepo, and do not describe qol-skills workflows as product CI.

## Other qol repositories

Inspect the current repository's `.github/`, hooks, setup commands, and
repository instructions before choosing an owner. If a workflow delegates to a
canonical external owner, follow the reference found in the file instead of
assuming one from historical architecture.

## Git hooks and bootstrap

Treat these as repository-local concerns unless the current implementation
delegates them explicitly. In qol-monorepo, inspect `.githooks/` for Git hook
behavior and the `qol` CLI implementation for setup behavior. Historical
references to sibling tooling are not ownership evidence.

## Refuse

- Editing or introducing a separate `qol-cicd` workflow repository.
- Redirecting qol-skills automation into qol-monorepo product CI.
- Adding a reusable-workflow caller for logic already owned by the current
  repository.
- Duplicating a job or release rule without checking its current owning file.
- Proposing a new hook manager before inspecting `.githooks/` and `qol setup`.
