---
name: readme
description: Use when writing or editing any README.md inside a qol-tools repo (plugin, library, host app, CI/infra). Defines canonical section order, tagline rules, and per-category templates so every repo presents itself the same way. Apply on every README touch — even a one-line edit.
---

# README writing — the qol-tools shape

Every repo in the qol-tools org presents itself the same way: same section order, same tagline tone, same license footer. A reader landing on `plugin-alt-tab` should know exactly where to find install, controls, config, license — without re-learning a new layout.

This skill is the canonical structure. Apply it on every README edit. If a section in the file conflicts with this skill, the skill wins.

## Repo categories

The skeleton is universal; the type-specific section in the middle differs:

| Category | Examples | Type-specific section |
|---|---|---|
| **Plugin** (qol-tray plugin binary) | `plugin-alt-tab`, `plugin-lights`, `plugin-template` | Controls or Usage |
| **Library** (shared crate) | `qol-plugin-api`, `qol-color`, `qol-config` | Usage as dependency |
| **Host app** | `qol-tray` | Plugin store, Roadmap |
| **CI/Infra** | `qol-cicd` | Workflows, Hooks, Dev tooling |
| **Marketplace** | `qol-skills` | Plugins index, Contributing |

## Section order (universal)

Every README, every category:

1. **H1 title**
2. **Tagline paragraph**
3. *(optional)* Asset / screenshot
4. **Install** *("Getting started" only for the host app)*
5. **Type-specific section** (Controls / Usage / Workflows / …)
6. **Configuration**
7. **Platform support** *(table — skip only if truly platform-agnostic)*
8. *(optional)* Development / Roadmap / Repo layout
9. **License**

Don't reorder. Don't merge. Don't sprout `## Why X?` between tagline and install.

## Title

H1, exactly the project's marketing name.

- **Plugin**: `Alt Tab Plugin for QoL Tray`, `Plugin Lights`, `Window Actions for QoL Tray` — pick one of the two patterns and stay there. Avoid the bare repo name (`plugin-alt-tab`) as the title.
- **Library**: the crate name, capitalised (`QoL Plugin API`, `QoL Color`).
- **Host app**: `QoL Tray`.
- **CI/Infra**: `qol-cicd` (lowercase repo name is fine — it's an org tool, not user-facing).

## Tagline

One sentence. Present tense. Plain language.

- States what the thing **is**, not what it can **do** for you.
- For plugins/libs, names the host or scope explicitly: `for [QoL Tray](https://github.com/qol-tools/qol-tray)`.
- At most one short supporting paragraph below — usually for the host relationship or the first backend target.

Bad:

```
Blazingly fast, feature-rich window switcher with awesome thumbnails!
```

Good:

```
A window switcher with live previews for [QoL Tray](https://github.com/qol-tools/qol-tray). Shows a grid of open windows with thumbnails and app icons, activated via global hotkey.
```

## Install

Always a `bash` code block — runnable as-is, no placeholders.

**Plugin** — point at the qol-tray store as the user path; the README's job is the dev path:

````
## Install

From the qol-tray UI: open the plugin store and install `<plugin-name>`.

From source:

```bash
git clone https://github.com/qol-tools/<plugin-name>
cd <plugin-name>
make build
```
````

**Host app** — `make install` is the contract:

````
## Getting started

```bash
git clone https://github.com/qol-tools/qol-tray
cd qol-tray
make install
```

Run `qol-tray`. Click the tray icon to open the UI at `http://127.0.0.1:42700`, then install plugins from the store.
````

**Library** — no Install section. The Usage section carries the Cargo dependency block.

## Type-specific section

Pick exactly one. Don't ship both Controls and Usage; if you need both, name it Usage and include a Controls subsection.

### Plugin: Controls (or Usage)

If hotkey-driven, ship a Controls table:

```
| Key | Action |
|-----|--------|
| Arrow keys | Navigate the grid |
| Enter | Activate selected window |
| Escape | Dismiss without switching |
```

If menu/launcher-driven, ship a Usage section that names the action IDs.

### Library: Usage

Cargo dependency block + feature flags, in that order:

````
## Usage

```toml
[dependencies]
qol-plugin-api = { git = "https://github.com/qol-tools/qol-plugin-api" }
```

Optional features:

- `app-icons` — enable app icon retrieval
- `gpui` (default) — GPUI integration helpers
````

### CI/Infra: Workflows / Hooks / Dev tooling

One H3 per workflow, each with: a one-line summary, what it does, then a `yaml` caller example if reusable. Tables for hooks and dev tooling commands.

### Host app: Plugin store, Roadmap

Roadmap is split into **What exists today** and **What is planned** — flat bullets, no dates, no priorities. The host owns the cross-repo narrative; plugins do not get roadmaps.

## Configuration

Always a section. Always concrete.

If config is a single file, name the file plus the keys with the type:

```
## Configuration

Configured via `config.json` or the QoL Tray settings UI.

- `display.max_columns` — Grid column count (2-12)
- `action_mode` — `sticky` or `hold_to_switch`
```

If config is environment variables, list them with default values.

If there genuinely is no config, omit the section. Do **not** write "No configuration required" — the absence speaks for itself.

## Platform support

Two-column table, exact phrasing:

```
| Platform | Status |
|----------|--------|
| macOS | Supported |
| Linux (X11) | Supported |
| Linux (Wayland) | Partial (tray works, window capture needs X11) |
| Windows | Planned |
```

Status vocabulary — use these, don't invent new ones:

- `Supported` — works end-to-end, tested on the platform.
- `Partial (...)` — works in some configurations, with the caveat in parens.
- `Planned` — designed for, not implemented.
- `Not planned` — explicitly out of scope.

Skip the table only if the repo is truly platform-agnostic (a logic-only library with no platform calls). When in doubt, ship the table.

## License

Always an H2 section, never a one-line footer:

```
## License

PolyForm Noncommercial 1.0.0
```

Don't add a tagline, don't link to the LICENSE file (it sits next to the README — readers can find it), don't add a "Contributing" section under it. The license is the last line of the README.

## Style rules (apply everywhere)

- **Sentence-case headings**: `## Getting started`, not `## Getting Started`. Exception: `## License` (proper noun).
- **No emojis**, ever — including in headings, taglines, table cells.
- **No badges**. They date instantly and bloat the head of the file. CI status is one click away on GitHub.
- **No "Why X?" sections.** The tagline is the why. If you can't fit the why in one sentence, the project description is wrong.
- **No "Built with" / "Stack" sections.** `Cargo.toml` is the source of truth.
- **No "Currently …" hedges in the tagline.** Version 0.x is already the WIP signal.
- **No collapsible `<details>` blocks.** They render awkwardly on mobile.
- **Code blocks specify a language** (`bash`, `toml`, `rust`, `yaml`). No bare triple-backtick fences.
- **Internal links** are relative (`see [LICENSE](LICENSE)`). **Cross-repo links** are full https URLs (`https://github.com/qol-tools/qol-tray`).
- **One H1 per file.** Only the title.
- **No "AND" headings**: `## Install` not `## Install and configure`. Per `coding-general`: if you need "and" to describe a section, split it.

## Length budget

- Plugin / library: 30–80 lines.
- Host app / CI/infra: up to 150 lines.
- Marketplace (`qol-skills`): up to 200 lines because it has to explain the layout.

If a README is growing past these, it's becoming docs. Move long-form content into `docs/`, ADRs, or a skill in `qol-skills`. The README's job is to orient a first-time reader in 30 seconds.

## Anti-patterns (delete on sight)

- "Features" lists — convert to a Controls or Configuration table, or fold into the tagline paragraph.
- "Status" sections describing the project as `experimental` / `WIP` / `early days` — version number, last commit date, and CI badge already say this.
- "Acknowledgements" sections — git log handles this.
- "Why I built this" sections — keep this in a blog post.
- Footer screenshots, contributor avatars, "made with love" lines.
- "Roadmap" sections in plugins — only the host app keeps a roadmap. A plugin documents what it does today.
- Engineer-jargon section names (`## Plumbing`, `## Wiring`, `## Scaffolding`). Use plain words (`## Architecture`, `## Internals`).

## Migrating an existing README

Don't rewrite the prose. Reshape the skeleton:

1. **Title** — fix capitalisation, add the host link if it's a plugin.
2. **Tagline** — collapse to one sentence + at most one paragraph. Cut emojis, "blazingly", "feature-rich", marketing verbs.
3. **Reorder** sections to match the canonical order. Rename to canonical names (`## Install`, `## Configuration`, `## Platform support`, `## License`).
4. **Delete** ad-hoc "Built with" / "Stack" / "Why" sections.
5. **Convert** "Features" lists into a Controls table, a Configuration table, or fold into the tagline.
6. **Move** long-form ("Architecture", "Internals", "Design notes") into `docs/` or a relevant skill in qol-skills, then link.
7. **Verify** the License section is `## License` plus the line `PolyForm Noncommercial 1.0.0` and nothing else.

If you're touching a README at all, fix the parts of the structure that conflict with this skill — even the parts you didn't come to edit. README drift compounds.

## Templates (copy-paste starting points)

### Plugin

```markdown
# <Plugin Name> for QoL Tray

<One sentence — what this plugin does for [QoL Tray](https://github.com/qol-tools/qol-tray). One short supporting paragraph, optional.>

## Install

From the qol-tray UI: open the plugin store and install `<plugin-name>`.

From source:

​```bash
git clone https://github.com/qol-tools/<plugin-name>
cd <plugin-name>
make build
​```

## Controls

| Key | Action |
|-----|--------|
| ... | ... |

## Configuration

Configured via `config.json` or the QoL Tray settings UI.

- `<key>` — <description with type/range>

## Platform support

| Platform | Status |
|----------|--------|
| macOS | Supported |
| Linux (X11) | Supported |

## License

PolyForm Noncommercial 1.0.0
```

### Library

```markdown
# <Crate Name>

<One sentence — what plugins/host components use this for, and where it sits in the qol-tools graph.>

## Usage

​```toml
[dependencies]
<crate-name> = { git = "https://github.com/qol-tools/<crate-name>" }
​```

Optional features:

- `<feature>` — <what it enables>

## Platform support

| Platform | Status |
|----------|--------|
| macOS | Supported |
| Linux | Supported |

## License

PolyForm Noncommercial 1.0.0
```
