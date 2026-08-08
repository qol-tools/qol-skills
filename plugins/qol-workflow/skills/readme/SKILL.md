---
name: readme
description: Use when writing or editing any README.md inside a qol-tools repo. Defines three timelessness rules and a single canonical structure (a centered header of title, badges and tagline, then Quick start, optional About, License). Badges live only at a repo root, never on a monorepo subpackage, because a GitHub badge cannot scope below a workflow file. Cross-package links are relative. The intent is that every qol-tools README looks the same and never goes stale, because all current-state info lives on GitHub's dynamic surfaces (CI matrix, badge, repo topics, issues), not in prose.
---

# README — qol-tools shape

Every qol-tools README has the same skeleton, and it never says anything that goes stale. Current-state lives on GitHub's dynamic surfaces (CI matrix, badge, repo topics, issues), not in the README's prose. Apply this skill on every README touch — even a one-line edit.

## Rules

1. **Timeless content only.** No `currently does X`, no `planned for vNext`, no roadmap, no status sections. If a sentence will need editing as the project evolves, it does not belong in the README.
2. **No duplication of canonical content.** Folder layout (GitHub already shows it), `Cargo.toml` deps, release notes, changelog, issue tracker, blog. Link out instead.
3. **Current-state info goes to GitHub's dynamic surfaces, not the prose.** Platform support → workflow matrix + repo topics. Build health → `tests` and `lint` badges under the H1. Open work → issue tracker. The README never says "supported on X" or "Windows is tracked"; the GitHub UI around the README handles it dynamically.

### Badge rule

One badge per workflow that gates merge or ships a release, stacked directly under the H1. The minimum is a `tests` badge; add a `lint` badge when fmt/clippy run as a separate gate, and a release badge when a workflow publishes artifacts users install. The label on the badge image is set by the workflow's `name:` field, so the workflow file itself must be named `tests` or `lint` (never `CI` - opaque, doesn't tell the reader what failed).

Drop a badge whose recent runs are mostly `skipped`. A skipped run renders grey, so the badge reads as broken or blank instead of reporting anything. Check the last handful of runs on the default branch before adding one.

No version, license, downloads, or coverage badges - they're either decorative or duplicate canonical sources (`Cargo.toml`, `LICENSE`, GitHub Releases).

## Canonical structure

```markdown
<div align="center">

# Title

[![tests](https://github.com/<org>/<repo>/actions/workflows/tests.yml/badge.svg)](https://github.com/<org>/<repo>/actions/workflows/tests.yml)
[![lint](https://github.com/<org>/<repo>/actions/workflows/lint.yml/badge.svg)](https://github.com/<org>/<repo>/actions/workflows/lint.yml)

Tagline (one sentence, platform-agnostic).

</div>

## Quick start

​```bash
<runnable command>
​```

<one-line follow-up explaining what to do after the command, if needed>

## About

<one short paragraph elaborating identity, when the tagline alone isn't enough>

## License

PolyForm Noncommercial 1.0.0
```

`## About` is **optional** — include only when the tagline isn't enough. Everything else is mandatory.

### The centered header

Title, badges and tagline sit inside a `<div align="center">` that closes before `## Quick start`. GitHub renders the H1, the badge row and the one-line tagline as a centered header block; everything below it stays left-aligned prose.

Nothing else goes inside the div. Not the Quick start, not About, not the License. A README where the whole body is centered is unreadable.

## Section rules

### Title

H1, the project's canonical display name, capitalised. Read it from the artifact that already declares it rather than inventing one: for a plugin that is `plugin.toml`'s `name` field, which is also the string the plugin store shows. Never the bare folder or crate name (`qol-color` is a crate id, `QoL Color` is the title).

One exception: a scaffold whose `name` is a placeholder a copier is told to replace. There the manifest name describes the copy, not the thing the README documents, so title it for the scaffold's purpose. The template manifest keeps `name = "My Plugin"` and a `# Plugin Template` heading.

### Badges

One status badge per workflow that gates merge or ships a release, stacked under the H1, each linked to its workflow page so a click goes to the live run view. The standard set in qol-tools is `tests` and `lint`, plus the release workflow where one exists; add others only when a new workflow file represents a distinct gate. Never use `CI` as a workflow name or alt text - it doesn't say what passed. Alt text repeats the workflow's `name:` verbatim, because that name is what the rendered image says.

### Monorepo subpackages

In a monorepo, only the root README carries badges. Subpackage READMEs (`apps/*`, `libs/*`, `plugins/*`) have a centered header with no badge row at all.

A GitHub badge resolves per workflow file. It cannot scope to a job, a path filter, or a crate. So a badge on `plugins/*/README.md` shows the whole repo's result while appearing to report on the plugin, which is the one thing a status badge must never do. The alternatives both cost more than they return: one workflow file per package abandons the shared affected-crates plan, and a shields.io endpoint badge fed by a CI-published JSON adds a publishing surface that goes stale exactly when a package is skipped as unaffected.

Cross-links between packages are relative paths, not `github.com` URLs. `[QoL Tray](../../apps/qol-tray)` resolves on GitHub, in a local editor, and after an org or repo rename. An absolute URL to a package that used to be its own repo is the first thing to rot when repos consolidate.

### Tagline

**One sentence, hard cap.** Plain language, present tense. Names what the thing IS — not what it does for you, not the platforms it runs on, not the stack it's built with. Platforms and stack live on GitHub dynamic surfaces (rule 3).

Bad:
```
Blazingly fast, feature-rich window switcher with awesome thumbnails!
```

Good:
```
A window switcher with live previews for [QoL Tray](https://github.com/qol-tools/qol-monorepo).
```

### Quick start

Always a `bash` code block, runnable as-is. **Heading is required** — don't drop it even when the only content is a single code block.

The command picks one path:

- **Consumer path** (`qol install`): for repos that have a real end-user (`qol-tray`, plugins distributed via the store).
- **Dev path** (`qol dev` or a Cargo dependency block): for repos whose only readers are devs (libraries, `qol-cicd`, internal tooling).

If the project genuinely has both audiences and one path doesn't subsume the other, ship two subsections (`### Install`, `### Develop`). Avoid this when one path is enough.

After the code block, one optional follow-up line — what the reader sees / does next ("Run `qol-tray`, click the tray icon …"). Keep it to a single line.

### About (optional)

One short paragraph. Elaborates identity when the tagline alone leaves the reader confused about what this is or where it sits. Skip if the tagline is self-sufficient.

Don't use About for personal closing notes ("built for fun!"), acknowledgements (git log handles that), or motivation ("I built this because…"). Identity only.

### License

H2 section, exactly:

```markdown
## License

PolyForm Noncommercial 1.0.0
```

No tagline, no link to LICENSE, no contributing section under it.

## What lives outside the README

| Concern | Lives in |
|---|---|
| Platform support | workflow matrix + repo topics (`linux`, `macos`, `rust`, …) |
| Build health | `tests` and `lint` badges under the H1 |
| Open work / vision / roadmap | GitHub issues with labels (`platform:windows`, `vision:*`) |
| Release notes / changelog | GitHub Releases tab |
| Authors / contributors | `git log`, repo Insights tab |
| Architecture, internals, deep design | Feature folders' own docs, ADRs |
| API reference | `cargo doc`, the source itself |
| Repo layout | GitHub's file tree |

If a section in the README is about any of these, it's almost certainly duplicating canonical content (rule 2) or reflecting current state (rule 3). Cut it.

## Anti-patterns (delete on sight)

- "Features" lists describing a time-bound project inventory — they churn. Fold the relevant identity bits into the tagline.
- `## Roadmap` / "What is planned" — explicit rule 1 violation.
- `## Platform support` table with per-OS status rows — rule 3, replaced by CI matrix + topics.
- `## Status` / `Project status` describing the project as `experimental` / `WIP` / `early days` — version number, last commit date, and CI badge already say this.
- `## Built with` / `## Stack` — `Cargo.toml` is canonical (rule 2).
- "Why I built this" / motivation paragraphs — keep this in a blog post.
- `## Acknowledgements` — git log + Insights tab.
- Decorative badges (version, downloads, license, coverage) - badges only for workflows that gate merge.
- A badge labelled `CI` - the label has to say what failed, e.g. `tests` or `lint`.
- "Repo layout" tree — GitHub's file tree is canonical (rule 2). Will rot when files move (rule 1).
- Footer screenshots, contributor avatars, "made with love" lines.

## Migrating an existing README

Don't rewrite the prose. Reshape:

1. **Title** — take the canonical display name, fix capitalisation.
2. **Badges** - at a repo root, add one status badge per merge-gating or release-shipping workflow under the H1 (minimum: `tests`; add `lint` and the release workflow when present, skipping any whose recent runs are mostly `skipped`) and drop everything else. In a monorepo subpackage, remove the badge row entirely.
3. **Tagline** — collapse to one sentence. Cut emojis, marketing verbs, platform names, stack names.
4. **Center the header**: wrap title, badges and tagline in `<div align="center">`, closing it before `## Quick start`.
5. **Relative-link** every cross-package reference; an absolute URL to a sibling package is dead the day the repos merge.
6. **Reorder + rename** sections to canonical names (`## Quick start`, `## About`, `## License`).
7. **Delete** anything in the anti-patterns list above.
8. **Move** long-form content into feature folders / docs / qol-skills.
9. **Verify** License section is `## License` plus exactly `PolyForm Noncommercial 1.0.0`.
10. **Update repo settings** (one time): set repo topics that previously sat in the README's prose — `linux`, `macos`, `rust`, plus topical tags. CI matrix already reflects what's tested.

If you're touching a README at all, fix the parts that conflict with this skill — even the parts you didn't come to edit. README drift compounds.
