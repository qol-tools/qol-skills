# Codex Adapter

Use this when the `code-review` skill runs in Codex and the user explicitly asks for reviewer agents, a review board, delegated reviewers, parallel reviewers, or one agent per point.

## Contract

- Actually spawn subagents. Do not simulate reviewer agents in the parent thread.
- Use `multi_agent_v1.spawn_agent`, `multi_agent_v1.wait_agent`, and `multi_agent_v1.close_agent`.
- If `multi_agent_v1` tools are not visible, use `tool_search` with `multi-agent spawn_agent Codex`, then retry.
- Use `agent_type: "explorer"` for read-only reviewers.
- Use `agent_type: "worker"` only when the user explicitly asks a reviewer to edit files.
- Keep `fork_context: false` by default. Pass only the repo path, scope, focus files, and reviewer-specific checklist.
- Do not set `model`, `reasoning_effort`, or `service_tier` unless the user asked or there is a concrete task-specific reason.
- Spawn all independent reviewers before waiting.
- Close agents after synthesizing results.

## Sequence

1. Capture the review scope with the smallest useful read-only command.
2. Select 2-5 independent reviewers from the shared catalog.
3. Spawn each reviewer with `multi_agent_v1.spawn_agent`.
4. Wait once with all reviewer ids when their results are needed.
5. Synthesize in the parent thread using the shared severity rubric.
6. Close completed agents.

## Spawn prompt template

```text
Review the current patch in <repo path> for <reviewer-name> only. Do not edit files.

Scope: <changed files, commit range, branch pair, or CI run>
Focus files: <paths>

Use read-only commands only. Produce findings first, ordered by severity, with concrete file/line evidence and required actions.

Specifically check:
- <domain concern 1>
- <domain concern 2>
- <domain concern 3>

Return:
Findings
Open questions
Residual risk
```

## Fallback

If subagent tooling is unavailable after `tool_search`, state that clearly and run a single-thread review. Do not pretend a review board ran.
