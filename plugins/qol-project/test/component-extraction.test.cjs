const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const script = path.resolve(__dirname, '../skills/qol-arch-code/scripts/extraction.cjs');

test('extraction plans, audits relocation, and rejects scope violations', t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'extraction-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const repo = path.join(temp, 'repo with spaces');
  fs.mkdirSync(repo);
  const git = args => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git(['init']);
  git(['config', 'user.email', 'test@example.test']);
  git(['config', 'user.name', 'Test']);
  git(['config', 'core.autocrlf', 'false']);
  fs.writeFileSync(path.join(repo, 'components.rs'), 'fn toggle() {}\nfn field() {}\n');
  git(['add', '.']);
  git(['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '-m', 'baseline']);
  const manifest = {
    base: git(['rev-parse', 'HEAD']).trim(),
    sources: ['components.rs'],
    lanes: [{ name: 'wiring', files: ['components.rs'] }, { name: 'toggle', files: ['toggle.rs'] }]
  };
  let number = 0;
  const run = (mode, input = manifest) => {
    const manifestPath = path.join(temp, 'manifest.json');
    const output = path.join(temp, `report-${number++}.json`);
    fs.writeFileSync(manifestPath, JSON.stringify(input));
    const result = spawnSync(process.execPath, [script, mode, manifestPath, output], { cwd: repo, encoding: 'utf8' });
    return { result, report: JSON.parse(fs.readFileSync(output, 'utf8')) };
  };
  assert.equal(run('plan').result.status, 0);
  const duplicate = structuredClone(manifest);
  duplicate.lanes[1].files.push('components.rs');
  assert.match(run('plan', duplicate).report.error, /Overlapping ownership/);
  const missing = structuredClone(manifest);
  missing.sources = ['missing.rs'];
  assert.match(run('plan', missing).report.error, /Source must exist/);
  const escape = structuredClone(manifest);
  escape.lanes[1].files = ['../outside.rs'];
  assert.match(run('plan', escape).report.error, /Invalid literal/);
  fs.writeFileSync(path.join(repo, 'components.rs'), 'fn field() {}\n');
  fs.writeFileSync(path.join(repo, 'toggle.rs'), 'fn toggle() {}\n');
  const moved = run('audit');
  assert.equal(moved.result.status, 0);
  assert.deepEqual(moved.report.loc, { before: 2, after: 2, delta: 0 });
  assert.deepEqual(moved.report.changed, ['components.rs', 'toggle.rs']);
  assert.match(run('plan').report.error, /clean worktree/);
  fs.writeFileSync(path.join(repo, 'unexpected.rs'), 'fn extra() {}\n');
  const outside = run('audit');
  assert.equal(outside.result.status, 1);
  assert.deepEqual(outside.report.unowned, ['unexpected.rs']);
  fs.unlinkSync(path.join(repo, 'unexpected.rs'));
  git(['add', '.']);
  assert.equal(run('audit').result.status, 0);
  fs.unlinkSync(path.join(repo, 'components.rs'));
  assert.deepEqual(run('audit').report.loc, { before: 2, after: 1, delta: -1 });
  fs.writeFileSync(path.join(repo, 'toggle.rs'), '\0binary');
  assert.match(run('audit').report.error, /Binary file/);
});
