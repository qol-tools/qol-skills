const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const git = args => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const split = text => text.split('\0').filter(Boolean);
const lines = text => text === null || text === '' ? 0 : text.split('\n').length - Number(text.endsWith('\n'));
const inside = (root, file) => file === root || file.startsWith(root + path.sep);

function run(mode, manifestPath, reportPath) {
  const report = { name: 'component-extraction', started_at: new Date().toISOString(), status: 'failed', inputs: {}, next: [] };
  const root = fs.realpathSync(git(['rev-parse', '--show-toplevel']).trim());
  process.chdir(root);
  const output = path.resolve(reportPath);
  const outputParent = fs.realpathSync(path.dirname(output));
  if (inside(root, outputParent) || fs.existsSync(output)) throw new Error('Use a fresh report path outside the repository');
  try {
    if (!['plan', 'audit'].includes(mode)) throw new Error('Mode must be plan or audit');
    const raw = fs.readFileSync(manifestPath, 'utf8');
    const manifest = JSON.parse(raw);
    if (!/^[a-f0-9]{40}$/.test(manifest.base)) throw new Error('base must be a full commit SHA');
    const base = git(['rev-parse', '--verify', `${manifest.base}^{commit}`]).trim();
    if (!Array.isArray(manifest.sources) || !manifest.sources.length || !Array.isArray(manifest.lanes) || !manifest.lanes.length) throw new Error('sources and lanes must be nonempty arrays');
    const owners = new Map();
    const names = new Set();
    function validate(file) {
      if (typeof file !== 'string' || !file || file.includes('\\') || /[\0\r\n*?\[\]]/.test(file) || file.split('/').some(part => ['', '.', '..', '.git'].includes(part)) || path.isAbsolute(file)) throw new Error(`Invalid literal file path: ${file}`);
      let current = root;
      for (const part of file.split('/')) {
        current = path.join(current, part);
        if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error(`Symlink path: ${file}`);
      }
    }
    for (const lane of manifest.lanes) {
      if (typeof lane.name !== 'string' || !lane.name.trim() || names.has(lane.name) || !Array.isArray(lane.files) || !lane.files.length) throw new Error('Each lane needs a unique name and nonempty files');
      names.add(lane.name);
      for (const file of lane.files) {
        validate(file);
        if (owners.has(file)) throw new Error(`Overlapping ownership: ${file}`);
        owners.set(file, lane.name);
      }
    }
    const baselineFiles = new Map(split(git(['ls-tree', '-rz', base])).map(entry => {
      const [metadata, file] = entry.split('\t');
      return [file, metadata.split(' ')[0]];
    }));
    for (const file of manifest.sources) {
      validate(file);
      if (!owners.has(file) || !baselineFiles.has(file)) throw new Error(`Source must exist at base and have an owner: ${file}`);
    }
    const changed = [...new Set([...split(git(['diff', '--name-only', '--no-renames', '-z', base, '--'])), ...split(git(['ls-files', '--others', '--exclude-standard', '-z']))])].sort();
    report.inputs = { mode, root, base, head: git(['rev-parse', 'HEAD']).trim(), manifest_sha256: hash(raw) };
    report.changed = changed;
    report.unowned = changed.filter(file => !owners.has(file));
    report.files = [...owners].sort().map(([file, owner]) => {
      const fileMode = baselineFiles.get(file);
      if (fileMode && !['100644', '100755'].includes(fileMode)) throw new Error(`Not a regular baseline file: ${file}`);
      const before = fileMode ? git(['show', `${base}:${file}`]) : null;
      const after = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
      if (before?.includes('\0') || after?.includes('\0')) throw new Error(`Binary file: ${file}`);
      return { path: file, owner, before: lines(before), after: lines(after), before_sha256: before === null ? null : hash(before), after_sha256: after === null ? null : hash(after) };
    });
    const before = report.files.reduce((sum, file) => sum + file.before, 0);
    const after = report.files.reduce((sum, file) => sum + file.after, 0);
    report.loc = { before, after, delta: after - before };
    if (report.unowned.length) throw new Error(`Unowned changes: ${report.unowned.join(', ')}`);
    if (mode === 'plan' && (changed.length || report.inputs.head !== base)) throw new Error('Plan requires a clean worktree at base');
    report.status = 'pass';
    report.next = mode === 'plan' ? ['Dispatch the agreed disjoint lanes'] : ['Review preserved declarations and public API', 'Run the repository verification gate on this tree'];
  } catch (error) {
    report.error = error.message;
  }
  report.finished_at = new Date().toISOString();
  fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log(`${report.status}: ${output}`);
  if (report.error) console.error(report.error);
  process.exitCode = report.status === 'pass' ? 0 : 1;
}

try {
  if (process.argv.length !== 5) throw new Error('Usage: node extraction.cjs plan|audit manifest.json report.json');
  run(process.argv[2], path.resolve(process.argv[3]), process.argv[4]);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
