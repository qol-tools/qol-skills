#!/usr/bin/env node
'use strict';

const { spawnSync } = require('node:child_process');

function currentQolHelp() {
    const result = spawnSync('qol', ['--help'], {
        encoding: 'utf8',
        timeout: 1500,
        windowsHide: true,
    });

    if (result.status === 0 && result.stdout.trim()) {
        return result.stdout.trim();
    }

    const detail = (result.stderr || result.error?.message || '').trim();
    return [
        'qol --help was not available at session start.',
        detail ? `Reason: ${detail}` : null,
        'Source of truth when inside the repo:',
        '- tools/qol-cli/src/cli.rs',
        '- tools/qol-cli/src/main.rs',
        '- tools/qol-cli/src/commands',
    ].filter(Boolean).join('\n');
}

const context = `qol CLI live command context:

Treat this session-start output as the current command surface. Do not rely on
hardcoded command lists in skills when answering qol CLI questions.

\`\`\`text
${currentQolHelp()}
\`\`\`

Stable ownership model:
- qol is the terminal CLI.
- qol dev is a CLI workflow/dashboard that starts qol-tray as a child process.
- qol-tray exported launcher commands are separate from qol CLI commands.`;

process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: context,
    },
}) + '\n');
