# qol-skills

Claude Code skills for everything in the [qol-tools](https://github.com/qol-tools) GitHub org: the [qol-tray](https://github.com/qol-tools/qol-tray) host app, every plugin, the shared libraries, the workspace conventions, the CI/CD pipeline, and the language patterns the codebase relies on.

This is a **plain skills repository** — every top-level directory is a skill, each containing a single `SKILL.md`. There is no `.claude-plugin/plugin.json`; the repo is a knowledge hub, not a coherent feature plugin. Drop the directory wherever Claude Code looks for skills (typically a `.claude/skills/` symlink in your workspace, or `~/.claude/skills/` for user-global) and every skill auto-discovers.

## Pointing Claude Code at this repo

Clone once, then surface the skills into whichever workspace you want them active in.

### Option A: workspace symlink (recommended)

```bash
git clone https://github.com/qol-tools/qol-skills ~/repos/private/qol-tools/qol-skills

cd /path/to/your/workspace
mkdir -p .claude
ln -s ~/repos/private/qol-tools/qol-skills .claude/skills
```

Claude Code reads `<workspace>/.claude/skills/*/SKILL.md` automatically. Updates are a `git pull` away.

### Option B: user-global

If you want every Claude Code session everywhere to see these skills, symlink at the user level instead:

```bash
git clone https://github.com/qol-tools/qol-skills ~/repos/private/qol-tools/qol-skills

ln -s ~/repos/private/qol-tools/qol-skills ~/.claude/skills/qol-skills-bundle
```

Note: `~/.claude/skills/` expects each child to be a skill folder with its own `SKILL.md`, not a parent directory of skills. Option A (per-workspace symlink to the qol-skills root) keeps each skill addressable as a top-level entry and is what this repo is designed for.

### Option C: per-skill cherry-pick

If you want only a subset, symlink individual skill directories:

```bash
ln -s ~/repos/private/qol-tools/qol-skills/rust /path/to/workspace/.claude/skills/rust
ln -s ~/repos/private/qol-tools/qol-skills/coding-general /path/to/workspace/.claude/skills/coding-general
```

## What's in here

32 skills organized by what they describe.

### Org + workspace
- `qol-tools` — org-level conventions, repo layout, dependency model, branch policy
- `qol-cicd` — shared CI workflows and release/versioning standards
- `git-push` — pre-push verification and rebase-before-push policy
- `git-trees` — coordinated multi-repo worktrees by feature lane
- `commit` — conventional commit message conventions

### Language + framework
- `coding-general` — universal coding guidelines (questionnaire, style, architecture, testing)
- `rust` — Rust plugin patterns: cross-platform, error handling, process management, local CI verification
- `gpui` — gpui 0.2 + gpui-component verified patterns and gotchas
- `preact` — qol-tray Preact + htm patterns: hooks, icons, toasts, focus, surface trait architecture
- `qol-architecture` — cross-platform strategy pattern (replaces `#[cfg(target_os)]` sprawl)
- `qol-apps-testing` — when to use property tests, parameterized tests, what to avoid

### qol-tray host app
- `qol-tray` — core qol-tray: plugin system, tray platform modules, feature architecture
- `qol-tray-ui-systems` — UI components, modals, keyboard nav, dropdowns, toggles, focus, selection wedge
- `qol-tray-dev-logging` — frontend `createDebug` namespace + message-style rules
- `qol-tray-feature-profile` — Profile feature: export/import, sync, backups, lock reconciliation
- `qol-tray-task-runner-ide-checkout` — Task Runner HTTP API contract (browser-extension surface)
- `qol-tray-release-flow` — qol-tray release tagging, commit format, CI triggers
- `qol-world-canvas` — divable elements, dive traits, world navigation, plugin spatial layout
- `qol-shared-libs` — shared library catalog (qol-plugin-api, qol-config, qol-platform, etc.)

### Plugins (host-app concerns)
- `qol-plugin-alt-tab` — alt-tab plugin: GPUI window list, X11 preview capture, settings UI
- `qol-plugin-launcher` — launcher plugin: GPUI launcher behavior and architecture
- `qol-plugin-screen-recorder` — screen recorder: ffmpeg flow, Linux display capture
- `qol-plugin-window-actions` — window minimize/restore/snap/move-monitor
- `qol-plugin-pointz` — pointz desktop server: UDP discovery, command transport, status HTTP
- `qol-plugin-lights` — lights plugin: backend adapters, daemon, action stability
- `qol-plugin-os-themes` — OS theming: shake-to-grow cursor, future GTK/Qt/icon work
- `qol-plugin-keyremap` — macOS key/mouse/scroll remapping daemon
- `qol-plugin-ide-checkout` — Task Runner plugin (Rust supervisor + Python daemon)
- `qol-plugin-template` — bootstrapping new plugins from `plugin-template`

### Plugin release flows
- `plugin-alt-tab-release-flow` — alt-tab tag/release ritual
- `plugin-launcher-release-flow` — launcher tag/release ritual

### Adjacent client apps
- `pointz-client` — PointZ Flutter mobile client (the other half of qol-plugin-pointz)

## Naming convention

| Prefix | Scope |
|---|---|
| `qol-tools` | the GitHub org as a whole |
| `qol-tray-*` | the qol-tray host app and its features (UI, profile, dev-logging, release flow, task-runner integration) |
| `qol-plugin-*` | individual plugins under the qol-tools/plugin-* repos |
| `qol-<topic>` | shared concerns that span multiple repos (architecture, cicd, shared-libs, world-canvas, apps-testing) |
| `plugin-<id>-release-flow` | per-plugin tag/release ritual |
| `pointz-client`, etc. | adjacent apps (mobile, web) that aren't tray-hosted |
| `coding-general`, `commit`, `git-push`, `git-trees`, `rust`, `gpui`, `preact` | language and tooling skills with no qol-specific scope |

When adding a new plugin, the skill name follows: `qol-plugin-<plugin-id-without-the-plugin-prefix>` — e.g. `plugin-alt-tab` becomes `qol-plugin-alt-tab`. The `qol-` brand prefix disambiguates from the host-app `qol-tray-*` namespace.

## Updating skills

Skills are plain markdown. Edit, commit, push:

```bash
cd qol-skills
# edit foo/SKILL.md
git add foo/SKILL.md
git commit -m "docs(foo): clarify daemon lifecycle"
git push
```

Other machines pick up changes via `git pull`. Symlinked workspaces see the update immediately — no re-link.

## Frontmatter

Every skill is a Markdown file with YAML frontmatter at the top:

```yaml
---
name: skill-name-in-kebab-case
description: One paragraph including what it does AND when to use it. Under 1024 characters. No XML tags.
---
```

The `name` must match the directory name. Avoid `claude` or `anthropic` prefixes (reserved). For deeper guidance see Anthropic's [Complete Guide to Building Skills for Claude](https://resources.anthropic.com/hubfs/The-Complete-Guide-to-Building-Skill-for-Claude.pdf).

## License

PolyForm Noncommercial 1.0.0 — same as the rest of the qol-tools org. See `LICENSE`.
