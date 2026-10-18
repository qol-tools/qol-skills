'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { prTitle, hint, nearestScopes } = require('../bin/pr-deny-unconventional-title.cjs');

const HOOK = path.join(__dirname, '..', 'bin', 'pr-deny-unconventional-title.cjs');
const TAG = '[pr-deny-unconventional-title]';

const GATE = `#!/usr/bin/env bash
subject="$(head -n1 "$1")"
scopes="$(cat "$(dirname "$0")/../scopes")"
reject() {
  printf '\\n  commit-msg rejected: %s\\n  subject: %s\\n\\n  format : <type>(scope?): imperative summary\\n' "$1" "$subject" >&2
  [ -n "\${2:-}" ] && printf '  scopes : %s\\n' "$2" >&2
  exit 1
}
printf '%s\\n' "$subject" | grep -qE '^(feat|fix|refactor)(\\([a-z-]+\\))?: .+' || reject "not a conventional commit (<type>(scope)?: summary)"
[ "\${#subject}" -le 72 ] || reject "subject too long (\${#subject} > 72 chars)"
scope="$(printf '%s' "$subject" | sed -nE 's/^[a-z]+\\(([^)]*)\\).*/\\1/p')"
[ -z "$scope" ] || printf '%s\\n' $scopes | grep -qxF "$scope" || reject "unknown scope '$scope' (first token must be a workspace member or umbrella)" "$scopes"
exit 0
`;

function repo({ gate, scopes = 'cli-sessions plugins sessions-engine tray' }) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qol-pr-title-test-'));
    spawnSync('git', ['init', '--quiet', root]);
    if (gate) {
        fs.mkdirSync(path.join(root, '.githooks'));
        fs.writeFileSync(path.join(root, '.githooks', 'commit-msg'), GATE);
        fs.writeFileSync(path.join(root, 'scopes'), scopes);
    }
    return root;
}

function run(command, cwd) {
    const result = spawnSync('node', [HOOK], {
        input: JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd }),
        encoding: 'utf8',
    });
    assert.equal(result.status, 0);
    if (!result.stdout.trim()) return null;
    return JSON.parse(result.stdout).hookSpecificOutput;
}

function denyLines(denied) {
    assert.equal(denied.permissionDecision, 'deny');
    const lines = denied.permissionDecisionReason.split('\n');
    assert.equal(lines.length, 2, denied.permissionDecisionReason);
    assert.ok(lines[1].startsWith(`${TAG} `), lines[1]);
    return lines;
}

test('reads the title from every flag form', () => {
    assert.deepEqual(prTitle('gh pr create --title "feat: a b" --body x'), { verb: 'create', title: 'feat: a b', dir: null });
    assert.deepEqual(prTitle("gh pr edit 41 -t 'fix(peers): c'"), { verb: 'edit', title: 'fix(peers): c', dir: null });
    assert.deepEqual(prTitle('cd x && gh pr create --title=refactor:\\ d'), { verb: 'create', title: 'refactor: d', dir: 'x' });
    assert.deepEqual(prTitle('gh pr create --fill'), { verb: 'create', title: null, dir: null });
    assert.equal(prTitle('gh pr view 41'), null);
});

test('reads a title that follows a multi-line body', () => {
    const command = `gh pr create --body "$(cat <<'EOF'\nfirst line\n\nsecond line\nEOF\n)" --title "fix(tray): keep it"`;
    assert.equal(prTitle(command).title, 'fix(tray): keep it');
});

test('ignores gh pr create written inside a heredoc body or a quoted string', () => {
    assert.equal(prTitle(`python3 - <<'PY'\ns = """\ngh pr create --fill\n"""\nPY`), null);
    assert.equal(prTitle(`cat > notes.md <<EOF\nopen it with \`gh pr create --draft\`\nEOF`), null);
    assert.equal(prTitle(`rg -n "gh pr create --fill" skills`), null);
    assert.equal(prTitle(`cat <<'EOF'\nx\nEOF\ngh pr create --title "fix(tray): a"`).title, 'fix(tray): a');
});

test('takes the directory from the last cd before the call', () => {
    assert.equal(prTitle('cd /a && git push && cd "/b c" && gh pr create --fill').dir, '/b c');
    assert.equal(prTitle('cd /a; gh pr create --fill').dir, '/a');
});

test('denies a sentence title with a plain line and the shape hint', () => {
    const [line1, line2] = denyLines(run('gh pr create --title "Launcher and settings marks" --body x', repo({ gate: true })));
    assert.match(line1, /^Pull request title "Launcher and settings marks" was refused by \.githooks\/commit-msg \(not a conventional commit/);
    assert.match(line1, /versioning reads it/);
    assert.match(line2, /title it <type>\(scope\): imperative summary, at most 72 characters/);
});

test('names the length and the cap for a long title', () => {
    const title = 'fix(sessions-engine): stop switchboard forks inheriting its control-chat model';
    const [, line2] = denyLines(run(`gh pr create --title "${title}" --body x`, repo({ gate: true })));
    assert.match(line2, new RegExp(`the title is ${title.length} characters and the cap is 72`));
});

test('lists the nearest and all scopes for an unknown scope', () => {
    const [line1, line2] = denyLines(run('gh pr create --title "fix(sessions): stop forks" --body x', repo({ gate: true })));
    assert.match(line1, /unknown scope 'sessions'/);
    assert.match(line2, /nearest: cli-sessions, sessions-engine\. All scopes: cli-sessions plugins sessions-engine tray$/);
});

test('omits the nearest list when nothing shares a word', () => {
    const [, line2] = denyLines(run('gh pr create --title "fix(lights): pair" --body x', repo({ gate: true })));
    assert.match(line2, /scope 'lights' is not a workspace member or umbrella; All scopes: /);
});

test('hint falls back to the shape when the gate prints an unknown reason', () => {
    assert.match(hint('something else broke'), /^title it <type>\(scope\)/);
    assert.match(hint("commit-msg rejected: unknown scope 'x'"), /^title it /);
    assert.deepEqual(nearestScopes('alt-tab', ['alt-tab', 'tab-x', 'tray']), ['alt-tab', 'tab-x']);
});

test('denies a renamed title on gh pr edit', () => {
    denyLines(run('gh pr edit 41 --title "WORKSPACE-41 Consolidate state"', repo({ gate: true })));
});

test('allows a conventional title', () => {
    assert.equal(run('gh pr create --title "feat(tray): draw marks" --body x', repo({ gate: true })), null);
});

test('checks the title against the repository a cd names', () => {
    const main = repo({ gate: true, scopes: 'tray' });
    const branch = repo({ gate: true, scopes: 'tray update-manager' });
    assert.equal(run(`cd ${branch} && gh pr create --title "feat(update-manager): add it" --body x`, main), null);
    denyLines(run('gh pr create --title "feat(update-manager): add it" --body x', main));
    denyLines(run('cd /no/such/dir && gh pr create --title "feat(update-manager): add it"', main));
});

test('denies gh pr create without a title and allows an edit without one', () => {
    const root = repo({ gate: true });
    const [line1, line2] = denyLines(run('gh pr create --fill', root));
    assert.match(line1, /^gh pr create needs an explicit --title here/);
    assert.match(line2, /pass --title "<type>\(scope\): imperative summary" \(at most 72 characters.*--fill is refused/);
    assert.equal(run('gh pr edit 41 --add-label x', root), null);
});

test('stays silent on text that only mentions gh pr create', () => {
    assert.equal(run(`python3 - <<'PY'\nnote = "open it with gh pr create --fill"\nPY`, repo({ gate: true })), null);
});

test('lets shell-built titles through for the merge queue to check', () => {
    assert.equal(run('gh pr create --title "$(git log -1 --format=%s)"', repo({ gate: true })), null);
});

test('ignores repositories without a commit-msg gate', () => {
    assert.equal(run('gh pr create --title "Anything goes"', repo({ gate: false })), null);
});
