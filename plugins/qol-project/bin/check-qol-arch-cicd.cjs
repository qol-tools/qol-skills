#!/usr/bin/env node
/*
 * qol-arch-cicd PreToolUse hook.
 *
 * Lints CI/release workflow YAML and Cargo.toml files in qol-tools repos for
 * the patterns that have historically broken cross-platform builds at
 * release time. Heuristic — workflow YAML can be arbitrarily complex, so the
 * checks favor false-negatives over false-positives. The deterministic
 * backstop is the matrix build itself; this hook just shortens the feedback
 * loop.
 *
 * Active on Edit/Write/MultiEdit/NotebookEdit of:
 *
 *   1. .github/workflows/*.yml under any /qol-tools/ path — flags:
 *      a. cargo (build|test|clippy|deb|run) runs that lack
 *         RUSTFLAGS=-D warnings in the step or job env.
 *      b. Hardcoded `runs-on: ubuntu-latest` in any reusable plugin
 *         workflow that consumes plugin.toml (matrix should derive from
 *         plugin.toml platforms).
 *      c. cargo invocations in workflows whose repo root has
 *         qol-config = { path = "../qol-config" } in Cargo.toml but where
 *         the workflow does not check out qol-tools/qol-config as a sibling.
 *   2. Cargo.toml under any /qol-tools/ path — flags top-level [dependencies] entries for crates
 *      that are known platform-specific. These belong in
 *      [target.'cfg(target_os = "...")'.dependencies].
 *
 * Bypass:
 *   touch .claude/bypass-qol-arch-cicd          # next 1 edit passes
 *   echo N > .claude/bypass-qol-arch-cicd       # next N edits pass
 *
 * Runs on Node — Claude Code requires Node, dependency is free across OSes.
 * Silent on errors — a failing hook must never block Claude irreversibly.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const INSPECTED_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

const QOL_TOOLS_PATH_RE = /[\\/]qol-tools[\\/]/;
const WORKFLOW_PATH_RE = /[\\/]\.github[\\/]workflows[\\/][^\\/]+\.ya?ml$/;
const CARGO_TOML_BASENAME = 'Cargo.toml';

function crossPlatformBasename(p) {
    const parts = p.split(/[\\/]/);
    return parts[parts.length - 1] || p;
}

const PLATFORM_CRATES = new Set([
    'x11rb', 'xkbcommon', 'wayland-client', 'wayland-protocols', 'wayland-sys', 'wayland-backend',
    'objc2', 'core-foundation', 'core-graphics', 'cocoa', 'appkit',
    'windows', 'windows-sys', 'windows-targets',
]);

function readStdin() {
    try {
        return fs.readFileSync(0, 'utf8');
    } catch {
        return '';
    }
}

function log(msg) {
    process.stderr.write(`[qol-arch-cicd] ${msg}\n`);
}

function extractNewContent(tool, input) {
    if (!input) return '';
    if (tool === 'Write') return input.content || '';
    if (tool === 'Edit') return input.new_string || '';
    if (tool === 'MultiEdit') {
        return (input.edits || [])
            .map(e => e.new_string || '')
            .join('\n\n');
    }
    if (tool === 'NotebookEdit') return input.new_source || '';
    return '';
}

function findCargoRunWithoutRustflags(content) {
    const lines = content.split(/\r?\n/);
    const cargoCmdRe = /\bcargo\s+(?:build|test|clippy|deb|run)\b/;
    const inlineRustflagsRe = /RUSTFLAGS\s*=\s*['"]?-D\s+warnings/;
    const envRustflagsRe = /^\s*RUSTFLAGS\s*:\s*[^#\n]*-D\s+warnings/m;

    const cargoLines = [];
    for (let i = 0; i < lines.length; i++) {
        if (cargoCmdRe.test(lines[i])) cargoLines.push(i);
    }
    if (cargoLines.length === 0) return [];

    const violations = [];
    for (const idx of cargoLines) {
        const line = lines[idx];
        if (inlineRustflagsRe.test(line)) continue;
        const stepStart = findEnclosingStepStart(lines, idx);
        const stepEnd = findEnclosingStepEnd(lines, idx);
        const stepBlock = lines.slice(stepStart, stepEnd + 1).join('\n');
        if (envRustflagsRe.test(stepBlock)) continue;
        const jobBlock = findEnclosingJobBlock(lines, idx);
        if (envRustflagsRe.test(jobBlock)) continue;
        if (envRustflagsRe.test(content)) {
            const before = lines.slice(0, idx).join('\n');
            if (envRustflagsRe.test(before)) continue;
        }
        violations.push({ lineno: idx + 1, text: line });
    }
    return violations;
}

function findEnclosingStepStart(lines, idx) {
    for (let i = idx; i >= 0; i--) {
        if (/^\s*-\s+/.test(lines[i])) return i;
    }
    return Math.max(0, idx - 20);
}

function findEnclosingStepEnd(lines, idx) {
    for (let i = idx + 1; i < lines.length; i++) {
        if (/^\s*-\s+/.test(lines[i])) return i - 1;
    }
    return Math.min(lines.length - 1, idx + 20);
}

function findEnclosingJobBlock(lines, idx) {
    let jobStart = 0;
    for (let i = idx; i >= 0; i--) {
        const m = /^(\s*)([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*$/.exec(lines[i]);
        if (m && m[1].length === 2) {
            jobStart = i;
            break;
        }
    }
    let jobEnd = lines.length - 1;
    for (let i = idx + 1; i < lines.length; i++) {
        const m = /^(\s*)([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*$/.exec(lines[i]);
        if (m && m[1].length <= 2) {
            jobEnd = i - 1;
            break;
        }
    }
    return lines.slice(jobStart, jobEnd + 1).join('\n');
}

function findHardcodedUbuntu(content) {
    const lines = content.split(/\r?\n/);
    const usesPluginManifest = /plugin\.toml|inputs\.plugin_manifest/.test(content);
    if (!usesPluginManifest) return [];
    const violations = [];
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const m = /^\s*runs-on\s*:\s*ubuntu-latest\s*$/.exec(line);
        if (m) {
            const blockStart = Math.max(0, i - 8);
            const blockEnd = Math.min(lines.length, i + 12);
            const block = lines.slice(blockStart, blockEnd).join('\n');
            if (/strategy:\s*\n[\s\S]*matrix:|\$\{\{\s*matrix\.os\s*\}\}|matrix_setup/.test(block)) continue;
            violations.push({ lineno: i + 1, text: line });
        }
    }
    return violations;
}

function findMissingQolConfigCheckout(filePath, content) {
    const repoRoot = filePath.replace(/[\\/]\.github[\\/]workflows[\\/].*$/, '');
    const cargoPath = path.join(repoRoot, 'Cargo.toml');
    let cargoText = '';
    try {
        cargoText = fs.readFileSync(cargoPath, 'utf8');
    } catch {
        return [];
    }
    if (!/qol-config\s*=\s*\{[^}]*path\s*=\s*"\.\.\/qol-config"/.test(cargoText)) return [];

    const cargoSteps = /\bcargo\s+(?:build|test|clippy|deb|run)\b/.test(content);
    if (!cargoSteps) return [];
    const checksOutQolConfig = /repository:\s*qol-tools\/qol-config/.test(content);
    if (checksOutQolConfig) return [];
    return [{ workflow: crossPlatformBasename(filePath), cargoTomlHasPathDep: true }];
}

function findUnconditionalPlatformCrates(content) {
    const lines = content.split(/\r?\n/);
    const violations = [];
    let inDeps = false;
    let inTargetDeps = false;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trim();
        if (/^\[/.test(trimmed)) {
            inDeps = /^\[(dependencies|dev-dependencies|build-dependencies)\]\s*$/.test(trimmed);
            inTargetDeps = /^\[target\./.test(trimmed);
            continue;
        }
        if (!inDeps || inTargetDeps) continue;
        const m = /^([a-z0-9_-]+)\s*=/i.exec(trimmed);
        if (!m) continue;
        const crate = m[1].toLowerCase();
        const isPlatformCrate = PLATFORM_CRATES.has(crate) || /^wayland-/.test(crate);
        if (isPlatformCrate) {
            violations.push({ lineno: i + 1, crate, text: line });
        }
    }
    return violations;
}

function blockRustflags(filePath, violations) {
    const detail = violations
        .map(v => `  line ${v.lineno}: ${v.text.trim()}`)
        .join('\n');
    process.stderr.write(`qol-arch-cicd violation in ${filePath}.

Found cargo invocation(s) without RUSTFLAGS=-D warnings in env:

${detail}

Without RUSTFLAGS=-D warnings, dead_code / unused_imports / unused_mut and
the rest of the cross-platform-leakage warnings are warnings — and warnings
are silently ignored on a CI dashboard. With it, they become hard errors
that fail the build and surface the leak.

Add to the step (or to job-level env):

  env:
    RUSTFLAGS: -D warnings

Note: clippy's "-- -D warnings" only handles clippy lints. dead_code lives
in rustc and needs the env var. You typically want both.

Reference: qol-arch-cicd skill.

Bypass for this edit only:
  touch .claude/bypass-qol-arch-cicd
`);
}

function blockHardcodedUbuntu(filePath, violations) {
    const detail = violations
        .map(v => `  line ${v.lineno}: ${v.text.trim()}`)
        .join('\n');
    process.stderr.write(`qol-arch-cicd violation in ${filePath}.

Found hardcoded "runs-on: ubuntu-latest" in a workflow that consumes
plugin.toml:

${detail}

Plugin CI must matrix on the platforms declared in plugin.toml. Otherwise
plugins that claim macOS or Windows support never see CI builds on those
OSes — and the dead_code / link / cfg failures only surface in production.

Pattern (matrix derived from plugin.toml at workflow start):

  jobs:
    matrix_setup:
      runs-on: ubuntu-latest
      outputs:
        runners: \${{ steps.detect.outputs.runners }}
      steps:
        - uses: actions/checkout@v4
        - id: detect
          run: |
            python3 - <<'PY'
            import json, os, tomllib
            p = tomllib.load(open(os.environ["PLUGIN_MANIFEST"], "rb"))
            platforms = p.get("plugin", {}).get("platforms", ["linux"])
            mapping = {"linux": "ubuntu-latest", "macos": "macos-latest", "windows": "windows-latest"}
            runners = [mapping[x] for x in platforms if x in mapping] or ["ubuntu-latest"]
            open(os.environ["GITHUB_OUTPUT"], "a").write(f"runners={json.dumps(runners)}\\n")
            PY

    test:
      needs: matrix_setup
      strategy:
        fail-fast: false
        matrix:
          os: \${{ fromJSON(needs.matrix_setup.outputs.runners) }}
      runs-on: \${{ matrix.os }}

Reference: qol-arch-cicd skill.

Bypass for this edit only:
  touch .claude/bypass-qol-arch-cicd
`);
}

function blockMissingQolConfig(filePath) {
    process.stderr.write(`qol-arch-cicd violation in ${filePath}.

This workflow runs cargo, and the repo's Cargo.toml has
qol-config = { path = "../qol-config" }, but the workflow does not check
out qol-tools/qol-config as a sibling.

This is exactly the asymmetry that broke qol-tray v3.10.0 — ci.yml had the
sibling-checkout-and-rewrite, release.yml didn't. cargo deb failed at
release time on a green main.

Add to every cargo-running job in this workflow:

  - name: Checkout qol-config sibling
    uses: actions/checkout@v4
    with:
      repository: qol-tools/qol-config
      path: qol-config

  - name: Rewrite qol-config path dependency for CI checkout layout
    shell: bash
    run: |
      python3 - <<'PY'
      from pathlib import Path
      m = Path("Cargo.toml")
      t = m.read_text()
      m.write_text(t.replace(
          'qol-config = { path = "../qol-config" }',
          'qol-config = { path = "qol-config" }',
      ))
      PY

Reference: qol-arch-cicd skill.

Bypass for this edit only:
  touch .claude/bypass-qol-arch-cicd
`);
}

function blockPlatformCrates(filePath, violations) {
    const detail = violations
        .map(v => `  line ${v.lineno}: ${v.crate} — ${v.text.trim()}`)
        .join('\n');
    process.stderr.write(`qol-arch-cicd violation in ${filePath}.

Found platform-specific crate(s) in unconditional [dependencies]:

${detail}

These crates only build on a specific OS. Declaring them at the top of
[dependencies] makes Cargo try to fetch and compile them on every OS,
wasting build time and (often) failing to link on the wrong platform.

Move them under a target gate:

  [target.'cfg(target_os = "linux")'.dependencies]
  x11rb = "0.13"
  xkbcommon = "0.7"

  [target.'cfg(target_os = "macos")'.dependencies]
  objc2 = "0.5"
  core-foundation = "0.10"

  [target.'cfg(target_os = "windows")'.dependencies]
  windows = { version = "0.58", features = ["Win32_UI_WindowsAndMessaging"] }

Then "use" the crate unconditionally in src/<feature>/platform/<os>.rs —
the manifest-level cfg guarantees it's only present when relevant.

Reference: qol-arch-cicd skill.

Bypass for this edit only:
  touch .claude/bypass-qol-arch-cicd
`);
}

function main() {
    const raw = readStdin().trim();
    if (!raw) return 0;

    let payload;
    try {
        payload = JSON.parse(raw);
    } catch {
        return 0;
    }

    const tool = payload.tool_name || payload.tool || '';
    if (!INSPECTED_TOOLS.has(tool)) return 0;

    const input = payload.tool_input || {};
    const filePath = input.file_path || input.notebook_path || '';
    if (!filePath) return 0;
    if (!QOL_TOOLS_PATH_RE.test(filePath)) return 0;

    const isWorkflow = WORKFLOW_PATH_RE.test(filePath);
    const isCargo = crossPlatformBasename(filePath) === CARGO_TOML_BASENAME;
    if (!isWorkflow && !isCargo) return 0;

    const cwd = payload.cwd || process.cwd();
    const marker = path.join(cwd, '.claude', 'bypass-qol-arch-cicd');
    if (fs.existsSync(marker) && fs.statSync(marker).isFile()) {
        try {
            const raw = fs.readFileSync(marker, 'utf8').trim();
            const count = /^\d+$/.test(raw) ? Number(raw) : 1;
            if (count > 1) {
                fs.writeFileSync(marker, String(count - 1));
                log(`bypass consumed (${count - 1} remaining) — ${crossPlatformBasename(filePath)}`);
            } else {
                fs.unlinkSync(marker);
                log(`bypass consumed (marker removed) — ${crossPlatformBasename(filePath)}`);
            }
        } catch {
            // ignore
        }
        return 0;
    }

    const newContent = extractNewContent(tool, input);
    if (!newContent) return 0;

    if (isWorkflow) {
        const cargoNoRustflags = findCargoRunWithoutRustflags(newContent);
        if (cargoNoRustflags.length > 0) {
            blockRustflags(filePath, cargoNoRustflags);
            return 2;
        }
        const hardcoded = findHardcodedUbuntu(newContent);
        if (hardcoded.length > 0) {
            blockHardcodedUbuntu(filePath, hardcoded);
            return 2;
        }
        const missingQolConfig = findMissingQolConfigCheckout(filePath, newContent);
        if (missingQolConfig.length > 0) {
            blockMissingQolConfig(filePath);
            return 2;
        }
    }

    if (isCargo) {
        const platformCrates = findUnconditionalPlatformCrates(newContent);
        if (platformCrates.length > 0) {
            blockPlatformCrates(filePath, platformCrates);
            return 2;
        }
    }

    return 0;
}

process.exit(main());
