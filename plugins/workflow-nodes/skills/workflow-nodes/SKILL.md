---
name: workflow-nodes
description: Personal workflow-automation discipline for KMRH47. Use when a task has repeated commands, multi-step tool chains, fragile manual instructions, build/export/test loops, human verdict loops, or any chance to convert agentic tool calls into deterministic scripts with explicit inputs, outputs, reports, and composable workflow nodes. Also use when the user asks for a one-command lane, scriptification, orchestration, reproducibility, token reduction, or making a workflow easier for humans and AI.
---

# Workflow Nodes

KMRH47 prefers repeated work to become deterministic scripts. The goal is not abstraction for its own sake. The goal is less human memory burden, fewer repeated agent tool calls, faster iterations, and artifacts that prove what happened.

## Default posture

When work starts looking like a workflow, stop and ask:

1. What is the smallest human input?
2. What concrete output should exist after the run?
3. Which steps are deterministic enough to script?
4. Which steps still require human judgment?
5. What report would let the next human or agent continue without rediscovery?

If the answer is clear, create or extend a workflow node instead of retyping the chain manually.

## When to script

Script the workflow when at least one is true:

- The same command chain is run more than once.
- The workflow crosses tools, languages, VMs, games, devices, external CLIs, or generated artifacts.
- A human has to remember flags, paths, order, cleanup, or scoring rules.
- The agent would otherwise spend many tool calls discovering state each time.
- The output can be validated by file existence, hashes, logs, exit codes, screenshots, reports, or structured data.
- A later script could consume the result.

Do not script a process that is still mostly unknown. Observe it once, identify the real inputs and outputs, then extract the repeatable core.

## Shape

Use this layering:

- **Leaf script**: one fragile domain operation. Examples: Blender export, asset conversion, table extraction, log parse.
- **Workflow node**: one named input -> output step. It calls leaves and writes a report.
- **Orchestrator**: chains workflow nodes into the fast human lane.
- **Thin wrapper**: optional executable with the name the human remembers.

Prefer Node.js for orchestration when the repo has no stronger native convention. Use `execFile` or equivalent argv arrays, never shell strings for dynamic arguments. Keep Python, Blender Python, Rust, or shell where the domain already demands it. Shell scripts should mostly be thin wrappers.

## CLI grammar

Prefer positional verbs for the workflow domain and flags for run-wide modifiers:

```text
./flow <domain> <workflow> <node> [label words...] [--flag]
```

Good examples:

```text
./flow m4 hold scene
./flow m4 hold build
./flow m4 hold score good "hands align, stock high"
./flow repo release prep --push
```

The human fast lane should be shorter than the full expert surface. Expert args can exist, but the default command should do the useful thing.

## Node contract

Every workflow node should make these explicit:

```text
input: args, config files, source artifacts, environment assumptions
work: commands called, tools required, state touched
output: primary artifact paths, report path, validation status
```

Write a machine-readable report whenever the node does meaningful work:

```json
{
  "name": "workflow-node-name",
  "started_at": "ISO-8601",
  "finished_at": "ISO-8601",
  "status": "pass|failed|skipped",
  "inputs": {},
  "artifacts": {},
  "commands": [],
  "next": []
}
```

Use stable paths such as `reports/<workflow>/<run-id>/report.json`. Include hashes for important artifacts when cheap.

## Human verdict loops

If a workflow needs human eyeballing, make that explicit instead of pretending it is automated:

1. Build/install/launch or prepare the artifact.
2. Wait for the human action or process exit if practical.
3. Prompt for a small verdict vocabulary.
4. Store the verdict in the same report family.

Good verdicts are short and comparable: `good`, `mixed`, `bad`, `unknown`, or a domain-specific controlled set.

## Design rules

- Search for existing scripts before adding new ones.
- Extend a current orchestrator before creating a parallel one.
- Keep node names boring and stable.
- Make reruns safe where practical.
- Fail early when required inputs are missing.
- Print the next useful command at the end.
- Do not hide irreversible or destructive operations behind friendly names.
- Do not create 20 flags before the default path works.
- Do not make the user remember what the script can infer.

## Done criteria

A workflow-node improvement is done when:

- One command replaces a repeated manual chain.
- The command has a small input surface.
- The desired artifact exists or the failure explains the missing prerequisite.
- A report records what happened.
- Another human or agent can run the next command from the output alone.
