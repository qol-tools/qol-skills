---
name: readme
description: Use when writing or editing any README.md inside a qol-tools repo. Defines three timelessness rules and a single canonical structure (title, CI badge, tagline, Quick start, optional About, License). The intent is that every qol-tools README looks the same and never goes stale, because all current-state info lives on GitHub's dynamic surfaces (CI matrix, badge, repo topics, issues), not in prose.
---

# README — qol-tools shape

Every qol-tools README has the same skeleton, and it never says anything that goes stale. Current-state lives on GitHub's dynamic surfaces (CI matrix, badge, repo topics, issues), not in the README's prose. Apply this skill on every README touch — even a one-line edit.

## Rules

1. **Timeless content only.** No "currently does X", no "planned for vNext", no roadmap, no status sections. If a sentence will need editing as the project evolves, it does not belong in the README.
2. **No duplication of canonical content.** Folder layout (GitHub already shows it), `Cargo.toml` deps, release notes, changelog, issue tracker, blog. Link out instead.
3. **Current-state info goes to GitHub's dynamic surfaces, not the prose.** Platform support → CI matrix + repo topics. Build health → CI badge under the H1. Open work → issue tracker. The README never says "supported on X" or "Windows is tracked"; the GitHub UI around the README handles it dynamically.

### One-badge rule

Exactly one badge, placed under the H1: a CI status badge linked to the workflow. No version, license, downloads, or coverage badges — they're either decorative or duplicate canonical (`Cargo.toml`, `LICENSE`).

## Canonical structure

```markdown
# Title

[![CI](https://github.com/<org>/<repo>/actions/workflows/ci.yml/badge.svg)](https://github.com/<org>/<repo>/actions/workflows/ci.yml)

Tagline (one sentence, platform-agnostic).

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

## Section rules

### Title

H1, the project's marketing name. Capitalised (`QoL Tray`, `Plugin Lights`), not the bare repo name.

### Badge

CI workflow badge. One. Linked to the workflow page so a click goes to the live matrix view.

### Tagline

**One sentence, hard cap.** Plain language, present tense. Names what the thing IS — not what it does for you, not the platforms it runs on, not the stack it's built with. Platforms and stack live on GitHub dynamic surfaces (rule 3).

Bad:
```
Blazingly fast, feature-rich window switcher with awesome thumbnails!
```

Good:
```
A window switcher with live previews for [QoL Tray](https://github.com/qol-tools/qol-tray).
```

### Quick start

Always a `bash` code block, runnable as-is. **Heading is required** — don't drop it even when the only content is a single code block.

The command picks one path:

- **Consumer path** (`make install`) — for repos that have a real end-user (`qol-tray`, plugins distributed via the store).
- **Dev path** (`make dev` or a Cargo dependency block) — for repos whose only readers are devs (libraries, `qol-cicd`, internal tooling).

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
| Platform support | CI matrix + repo topics (`linux`, `macos`, `rust`, …) |
| Build health | CI badge under the H1 |
| Open work / vision / roadmap | GitHub issues with labels (`platform:windows`, `vision:*`) |
| Release notes / changelog | GitHub Releases tab |
| Authors / contributors | `git log`, repo Insights tab |
| Architecture, internals, deep design | Feature folders' own docs, ADRs |
| API reference | `cargo doc`, the source itself |
| Repo layout | GitHub's file tree |

If a section in the README is about any of these, it's almost certainly duplicating canonical content (rule 2) or reflecting current state (rule 3). Cut it.

## Anti-patterns (delete on sight)

- "Features" lists describing what the project does today — current-state, churns. Fold the relevant identity bits into the tagline.
- `## Roadmap` / "What is planned" — explicit rule 1 violation.
- `## Platform support` table with per-OS status rows — rule 3, replaced by CI matrix + topics.
- `## Status` / `Project status` describing the project as `experimental` / `WIP` / `early days` — version number, last commit date, and CI badge already say this.
- `## Built with` / `## Stack` — `Cargo.toml` is canonical (rule 2).
- "Why I built this" / motivation paragraphs — keep this in a blog post.
- `## Acknowledgements` — git log + Insights tab.
- Multiple badges (version, downloads, license, coverage) — one-badge rule.
- "Repo layout" tree — GitHub's file tree is canonical (rule 2). Will rot when files move (rule 1).
- Footer screenshots, contributor avatars, "made with love" lines.

## Migrating an existing README

Don't rewrite the prose. Reshape:

1. **Title** — fix capitalisation.
2. **Badge** — add exactly one CI badge under the H1, drop any others.
3. **Tagline** — collapse to one sentence. Cut emojis, marketing verbs, platform names, stack names.
4. **Reorder + rename** sections to canonical names (`## Quick start`, `## About`, `## License`).
5. **Delete** anything in the anti-patterns list above.
6. **Move** long-form content into feature folders / docs / qol-skills.
7. **Verify** License section is `## License` plus exactly `PolyForm Noncommercial 1.0.0`.
8. **Update repo settings** (one time): set repo topics that previously sat in the README's prose — `linux`, `macos`, `rust`, plus topical tags. CI matrix already reflects what's tested.

If you're touching a README at all, fix the parts that conflict with this skill — even the parts you didn't come to edit. README drift compounds.
