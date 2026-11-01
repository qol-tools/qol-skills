# Codex Adapter

Use this when the `qol-code-review` skill runs in Codex and the user explicitly asks for reviewer agents, a review board, delegated reviewers, parallel reviewers, one agent per point, or invokes `$qol-code-review` / `$qol-code-review:qol-code-review` without explicitly requesting a solo review.

## Contract

- Actually spawn subagents. Do not simulate reviewer agents in the parent thread.
- In Codex, review-board mode is invalid unless at least one real `multi_agent_v1.spawn_agent` call succeeds.
- Use `multi_agent_v1.spawn_agent`, `multi_agent_v1.wait_agent`, and `multi_agent_v1.close_agent`.
- If `multi_agent_v1` tools are not visible, use `tool_search` with `multi-agent spawn_agent Codex`, then retry.
- If `tool_search` finds the tools, retry with `multi_agent_v1` before producing any review findings.
- Use `agent_type: "explorer"` for read-only reviewers.
- Use `agent_type: "worker"` only when the user explicitly asks a reviewer to edit files.
- Keep `fork_context: false` by default. Pass only the repo path, scope, focus files, and reviewer-specific checklist.
- Do not set `model`, `reasoning_effort`, or `service_tier` unless the user asked or there is a concrete task-specific reason.
- Spawn all independent reviewers before waiting.
- Close agents after synthesizing results.
- Include a visible `agent_board` section in the final answer with reviewer name, agent id, and completion status.

## Engine lanes

A review of a git change runs through the review engine, and every job it lists is one lane.

1. Run `next <run-dir>` and read `jobs` from its JSON.
2. Spawn every job before you wait on any: one `spawn_agent` call per job, with `agent_type` set to `explorer`, `fork_context` set to `false`, and the job's `prompt` as the message. A lane replies with one JSON object and writes nothing.
3. Call `wait_agent` until every lane has replied.
4. Pipe each reply, with only a surrounding code fence removed, to `submit <run-dir> <job-id> --agent-id <the agent id spawn_agent returned>`.
5. Run `next <run-dir>` again. A reply that `submit` rejected is a lane to spawn again.
6. After the review is saved, call `close_agent` for every lane.

## Sequence

1. Capture the review scope with the smallest useful read-only command.
2. Select 2-5 independent reviewers from the shared catalog.
3. Spawn each reviewer with `multi_agent_v1.spawn_agent`.
4. Record each reviewer name and returned agent id immediately.
5. Wait once with all reviewer ids when their results are needed.
6. Synthesize in the parent thread using the shared severity rubric.
7. Close completed agents.
8. Report the `agent_board` list in the final answer.

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

If subagent tooling is unavailable after `tool_search`, do not run a substitute parent-thread review unless the user explicitly asks for fallback. Start the final answer with:

```text
AGENT BOARD NOT RUN: <reason>
```

Set verdict to `invalid`, include the attempted tool-discovery step, and stop. Do not pretend a review board ran.
