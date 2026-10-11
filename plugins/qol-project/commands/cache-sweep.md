---
description: Prune this cargo workspace's build caches that no build used in three days, or preview with --dry-run
argument-hint: "[--dry-run]"
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/cache-sweep.mjs" --pretty $ARGUMENTS`

Print the output above exactly as it is, in a code block, with nothing added.
