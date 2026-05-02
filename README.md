# qol-skills

Claude Code and Codex skills for everything in the [qol-tools](https://github.com/qol-tools) GitHub org: the [qol-tray](https://github.com/qol-tools/qol-tray) host app, every plugin, the shared libraries, the workspace conventions, the CI/CD pipeline, and the language patterns the codebase relies on.

This repo is a **Claude Code and Codex marketplace** — 12 fine-grained plugins, one per logical area, so you can toggle the scope you want on any given machine.

## Install

### Claude Code

Install the marketplace once, then enable only the plugins you need:

```
/plugin marketplace add qol-tools/qol-skills
/plugin install qol-host
/plugin install qol-plugin-launcher
# ...etc
```

Or install everything via `/plugin` in the Claude Code UI and toggle plugins on/off per project.

### Codex

Install the marketplace once to install all plugins by default:

```bash
codex plugin marketplace add qol-tools/qol-skills
codex
```

Invoke skills with `$`, for example:

```text
$qol-tray explain the daemon lifecycle and check this repo for mismatches
```

## Plugins

| Plugin | Skills bundled |
|---|---|
| `qol-plugin-alt-tab` | `qol-plugin-alt-tab`, `plugin-alt-tab-release-flow` |
| `qol-plugin-launcher` | `qol-plugin-launcher`, `plugin-launcher-release-flow` |
| `qol-plugin-pointz` | `qol-plugin-pointz`, `pointz-client` |
| `qol-plugin-ide-checkout` | `qol-plugin-ide-checkout`, `qol-tray-task-runner-ide-checkout` |
| `qol-plugin-keyremap` | `qol-plugin-keyremap` |
| `qol-plugin-lights` | `qol-plugin-lights` |
| `qol-plugin-os-themes` | `qol-plugin-os-themes` |
| `qol-plugin-screen-recorder` | `qol-plugin-screen-recorder` |
| `qol-plugin-window-actions` | `qol-plugin-window-actions` |
| `qol-host` | `qol-tray`, `qol-tray-dev-logging`, `qol-tray-feature-profile`, `qol-tray-release-flow`, `qol-tray-ui-systems`, `qol-world-canvas`, `qol-apps-testing` |
| `qol-dev-conventions` | `rust`, `gpui`, `preact`, `commit`, `git-push`, `git-trees`, `coding-general`, `qol-architecture`, `qol-shared-libs`, `qol-plugin-template` |
| `qol-ecosystem` | `qol-tools`, `qol-cicd` |

Each plugin has its own `.claude-plugin/plugin.json` and `.codex-plugin/plugin.json`; every skill lives at `plugins/<plugin-name>/skills/<skill-name>/SKILL.md`.

## Repo layout

```
qol-skills/
├── .claude-plugin/
│   └── marketplace.json         # lists all 12 plugins
├── .agents/
│   └── plugins/
│       └── marketplace.json     # Codex marketplace
├── plugins/
│   ├── qol-plugin-alt-tab/
│   │   ├── .claude-plugin/plugin.json
│   │   ├── .codex-plugin/plugin.json
│   │   └── skills/
│   │       ├── qol-plugin-alt-tab/SKILL.md
│   │       └── plugin-alt-tab-release-flow/SKILL.md
│   └── ...
├── LICENSE
└── README.md
```

## Naming convention

| Prefix | Scope |
|---|---|
| `qol-plugin-*` | individual plugins under the qol-tools/plugin-* repos |
| `qol-host` | qol-tray host app internals (core, UI systems, Profile, world canvas, release flow) |
| `qol-dev-conventions` | language and cross-repo engineering skills (rust, gpui, preact, commit, git-*, qol-architecture, qol-shared-libs, qol-plugin-template, coding-general) |
| `qol-ecosystem` | workspace- and org-level conventions (qol-tools, qol-cicd) |

When adding a new plugin skill, the skill name follows: `qol-plugin-<plugin-id-without-the-plugin-prefix>` — e.g. `plugin-alt-tab` becomes `qol-plugin-alt-tab`.

## Updating skills

Skills are plain markdown. Edit, commit, push:

```bash
cd qol-skills
# edit plugins/qol-host/skills/qol-tray/SKILL.md
git add plugins/qol-host/skills/qol-tray/SKILL.md
git commit -m "docs(qol-tray): clarify daemon lifecycle"
git push
```

Installed plugins pick up changes via `/plugin marketplace update qol-skills`.

## Hooks and bundled scripts

Plugins that ship hooks put scripts under `plugins/<plugin>/bin/` and tests under `plugins/<plugin>/test/`. Layout:

```
plugins/<plugin>/
├── hooks/hooks.json            # registers the hook with Claude Code
├── bin/<name>.cjs              # the script
└── test/<name>.test.cjs        # tests for the script
```

**Write scripts in Node** (`.cjs`). Claude Code already requires Node, so it runs on every machine that runs Claude Code — Linux, macOS, Windows. Bash + `jq` looks portable but silently no-ops anywhere `jq` isn't installed (which is most macOS and Windows boxes by default).

Reference the script in `hooks.json` with an explicit `node` prefix so Windows doesn't need to know about shebangs:

```json
{
    "type": "command",
    "command": "node ${CLAUDE_PLUGIN_ROOT}/bin/<name>.cjs"
}
```

**Always ship a test next to the script.** Use Node's built-in test runner — no dependencies. Run them with:

```bash
node --test plugins/<plugin>/test/*.test.cjs
# or all plugins at once:
node --test plugins/*/test/*.test.cjs
```

A hook script without tests is a hook script no one will dare change. Tests make it safe to iterate.

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
