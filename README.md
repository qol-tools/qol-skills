<div align="center">

# QoL Skills

[![tests](https://github.com/qol-tools/qol-skills/actions/workflows/tests.yml/badge.svg)](https://github.com/qol-tools/qol-skills/actions/workflows/tests.yml)
[![release plugins](https://github.com/qol-tools/qol-skills/actions/workflows/release-plugins.yml/badge.svg)](https://github.com/qol-tools/qol-skills/actions/workflows/release-plugins.yml)

Claude Code, Codex, and Kimi Code skills marketplace for the [qol-tools](https://github.com/qol-tools) org.

</div>

## Quick start

### Claude Code

```bash
/plugin marketplace add qol-tools/qol-skills
```

Then `/plugin install <name>` for the scope you want, or pick from the UI.

### Codex

```bash
codex plugin marketplace add qol-tools/qol-skills
```

Invoke a skill with `$<skill-name>` inside `codex`.

### Kimi Code

```bash
/plugins marketplace /path/to/qol-skills/.kimi-plugin/marketplace.json
```

Then install plugins from the Third-party tab, or install a single plugin from a local checkout:

```bash
/plugins install /path/to/qol-skills/plugins/qol-workflow
```

Without a checkout, install one plugin from its release asset:

```bash
/plugins install https://github.com/qol-tools/qol-skills/releases/download/qol-workflow-v0.3.0/qol-workflow-0.3.0.zip
```

The bare repository URL does not work: Kimi resolves a GitHub source to a whole
repository and looks for a plugin manifest at its root, and this repository is a
marketplace of many plugins rather than one plugin.

Plugin changes apply after `/reload` or a new session.

## About

Installable packages group guidance and automation by stable ownership boundary, so consumers can load only the context relevant to their task.

## License

PolyForm Noncommercial 1.0.0
