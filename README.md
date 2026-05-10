# qol-skills

[![test](https://github.com/qol-tools/qol-skills/actions/workflows/test.yml/badge.svg)](https://github.com/qol-tools/qol-skills/actions/workflows/test.yml)

Claude Code and Codex skills marketplace for the [qol-tools](https://github.com/qol-tools) org.

## Quick start

### Claude Code

```
/plugin marketplace add qol-tools/qol-skills
```

Then `/plugin install <name>` for the scope you want, or pick from the UI.

### Codex

```bash
codex plugin marketplace add qol-tools/qol-skills
```

Invoke a skill with `$<skill-name>` inside `codex`.

## About

One plugin per logical area (host app, each plugin repo, languages, workflow, project-wide conventions). Skills live at `plugins/<plugin>/skills/<skill>/SKILL.md`; hooks and tests sit beside them under `bin/` and `test/`.

## License

PolyForm Noncommercial 1.0.0
