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
| `qol-tray` | `qol-tray-core`, `qol-tray-rust`, `qol-tray-ui-systems`, `qol-tray-dev-logging`, `qol-tray-dev-recompile`, `qol-tray-feature-profile`, `qol-tray-release-flow`, `qol-world-canvas`, `qol-apps-testing` |
| `qol-workflow` | `commit`, `git-push`, `git-trees`, `coding-general` |
| `qol-langs` | `rust-conventions`, `gpui-conventions`, `preact-conventions` |
| `qol-project` | `qol-mission`, `qol-tools`, `qol-cicd`, `qol-arch-code`, `qol-arch-cross-platform`, `qol-arch-cicd`, `qol-shared-libs`, `qol-plugin-template` |
| `arch-pathways` | `arch-pathways` |

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
| `qol-dev-conventions` | language and cross-repo engineering skills (rust, gpui, preact, commit, git-*, qol-arch-code, qol-arch-cross-platform, qol-arch-cicd, qol-shared-libs, qol-plugin-template, coding-general) |
| `qol-ecosystem` | workspace- and org-level conventions (qol-tools, qol-cicd) |

When adding a new plugin skill, the skill name follows: `qol-plugin-<plugin-id-without-the-plugin-prefix>` — e.g. `plugin-alt-tab` becomes `qol-plugin-alt-tab`.

## Contributing

### The three-layer model

Every change in this repo lands in one or more of three layers. Knowing which layer you're touching makes the workflow obvious.

| Layer | What it is | What it does |
|---|---|---|
| **Skills** | `plugins/<plugin>/skills/<skill>/SKILL.md` | Encodes the rule. Plain prose. Loaded by the agent on demand. Tells the agent *what* to do or avoid. |
| **Hooks** | `plugins/<plugin>/bin/<name>.cjs` + `plugins/<plugin>/hooks/hooks.json` | Enforces the rule deterministically. Fires on tool use, blocks the action when the rule is violated. Tells the runtime *to actually stop the agent* when prose alone wouldn't be enough. |
| **Tests** | `plugins/<plugin>/test/<name>.test.cjs` | Guarantees the hook still enforces what the skill says. Makes the hook safe to iterate. |

Order of escalation when adding a rule:

1. **Start with a skill.** If the rule is straightforward and an agent will reliably follow well-written prose, that's enough.
2. **Add a hook** when the rule must be deterministic, i.e. when a single slip causes hard-to-recover damage (broken main, stale clone, AI attribution in a commit, etc.). Hooks block the bash command before it runs.
3. **Always ship tests with the hook.** A hook nobody trusts to change is a hook that rots. Tests make it safe to extend later.

### When to push direct vs open an issue + PR

Updating skills is **usually not complicated**. Don't ceremony every typo into a PR.

| Change | Workflow |
|---|---|
| Edit a skill, fix a hook bug, add a test, tweak the README | **Push direct to main** from a worktree. No issue, no PR. |
| New plugin, new hook, schema change, anything cross-cutting, anything risky | **Open an issue first**, iterate on it, then a PR with the implementation. See `arch-pathways` for the full ping-pong flow. |

If you're unsure which side a change falls on, ask: "If I push this to main and it's wrong, can someone revert and move on in under a minute?" If yes, push direct. If no, issue + PR.

Either way, **always work in a worktree, never in a main clone** (the `qol-workflow:branch-deny-checkout-in-main-clone` hook will block you if you forget). See `qol-workflow:git-trees`.

### Updating skills (the simple path)

Skills are plain markdown. Make a worktree, edit, push direct to main:

```bash
FEAT=docs-clarify-daemon-lifecycle
git worktree add ../worktrees/$FEAT/qol-skills-marketplace -b $FEAT
cd ../worktrees/$FEAT/qol-skills-marketplace
# edit plugins/qol-tray/skills/qol-tray-core/SKILL.md
git add plugins/qol-tray/skills/qol-tray-core/SKILL.md
git commit -m "docs(qol-tray-core): clarify daemon lifecycle"
git push origin $FEAT:main
git push origin --delete $FEAT
cd - && git worktree remove ../worktrees/$FEAT/qol-skills-marketplace
```

Installed plugins pick up changes via `/plugin marketplace update qol-skills` (or `/plugin` followed by `/reload-plugins` in Claude Code).

### Hooks and bundled scripts

Plugins that ship hooks put scripts under `plugins/<plugin>/bin/` and tests under `plugins/<plugin>/test/`:

```
plugins/<plugin>/
├── hooks/hooks.json            # registers the hook with Claude Code
├── bin/<name>.cjs              # the script
└── test/<name>.test.cjs        # tests for the script
```

**Write scripts in Node** (`.cjs`). Claude Code already requires Node, so it runs on every machine that runs Claude Code: Linux, macOS, Windows. Bash + `jq` looks portable but silently no-ops anywhere `jq` isn't installed (which is most macOS and Windows boxes by default).

Reference the script in `hooks.json` with an explicit `node` prefix so Windows doesn't need to know about shebangs:

```json
{
    "type": "command",
    "command": "node ${CLAUDE_PLUGIN_ROOT}/bin/<name>.cjs"
}
```

**Always ship a test next to the script.** Use Node's built-in test runner, no dependencies:

```bash
node --test plugins/<plugin>/test/*.test.cjs
# or all plugins at once:
node --test plugins/*/test/*.test.cjs
```

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
