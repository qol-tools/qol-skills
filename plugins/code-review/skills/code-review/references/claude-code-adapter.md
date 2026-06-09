# Claude Code Adapter

Use this when the `code-review` skill runs in Claude Code and the user asks for reviewer agents, a review board, delegated reviewers, parallel reviewers, or one agent per point.

## Contract

- Use Claude Code subagents instead of Codex `multi_agent_v1` tools.
- Prefer real Claude Code agent definitions from plugin `agents/` when present.
- Claude Code subagents are Markdown files with YAML frontmatter and a Markdown system prompt body.
- For read-only reviewers, use read-only tools only.
- If a named reviewer agent file is missing, invoke an available built-in/read-only subagent with the reviewer role expressed in the prompt.
- Do not rely on Codex `.codex/agents/*.toml` files or `multi_agent_v1` tools.

## Agent file shape

```markdown
---
name: correctness-reviewer
description: Reviews patches for regressions, edge cases, idempotency, release semantics, and contract drift.
tools: Read, Glob, Grep, Bash
model: inherit
---

Review code like an owner. Produce findings first with file/line evidence, severity, confidence, impact, and required action.
```

## Plugin-agent constraints

Claude Code plugin subagents can be distributed through a plugin `agents/` directory, but plugin subagents do not support every frontmatter field. Do not depend on plugin-level `hooks`, `mcpServers`, or `permissionMode` for reviewer correctness. If those are required, the agent belongs in `.claude/agents/` or `~/.claude/agents/`.

## Sequence

1. Capture the review scope.
2. Select 2-5 independent reviewers from the shared catalog.
3. Invoke the matching Claude Code subagents.
4. Keep reviewers independent and read-only unless edits were explicitly requested.
5. Synthesize in the parent thread using the shared severity rubric.

## Fallback

If Claude Code subagents are unavailable, state that clearly and run a single-thread review. Do not pretend a review board ran.
