import { changedLines } from "./diff.mjs";

const LOCKFILES = new Set([
  "package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml", "bun.lock", "bun.lockb", "deno.lock",
  "Cargo.lock", "Gemfile.lock", "poetry.lock", "Pipfile.lock", "uv.lock", "composer.lock", "go.sum", "flake.lock",
  "mix.lock", "pubspec.lock", "packages.lock.json", "gradle.lockfile", "Podfile.lock", "Package.resolved",
]);
const MANIFESTS = new Set([
  "package.json", "Cargo.toml", "go.mod", "pyproject.toml", "setup.py", "setup.cfg", "Pipfile", "Gemfile",
  "composer.json", "pom.xml", "build.gradle", "build.gradle.kts", "pubspec.yaml", "mix.exs", "Package.swift",
  "Podfile", "deno.json", "deno.jsonc", "vcpkg.json", "conanfile.txt", "conanfile.py",
]);
const VENDOR_DIRS = new Set(["vendor", "third_party", "third-party", "node_modules", "bower_components"]);
const PROMPT_NAMES = new Set(["SKILL.md", "CLAUDE.md", "AGENTS.md", "REVIEW.md", "GEMINI.md"]);
const PROMPT_DIRS = new Set(["skills", "prompts", "commands", "agents"]);
const GENERATED_PATHS = [
  /\.min\.(js|css)$/, /\.(js|css)\.map$/, /\.pb\.go$/, /_pb2(_grpc)?\.pyi?$/, /\.g\.dart$/, /\.freezed\.dart$/,
  /\.generated\.[^/]+$/, /(^|\/)__generated__\//, /\.designer\.cs$/,
];
const GENERATED_MARKERS = /@generated|DO NOT EDIT|Code generated .* DO NOT EDIT|auto-?generated (file|code)/i;
const DOC_EXTENSIONS = /\.(md|mdx|markdown|rst|adoc|asciidoc|txt)$/i;
const ASSET_EXTENSIONS = /\.(svg|png|jpe?g|gif|webp|avif|ico|bmp|tiff?|woff2?|ttf|otf|eot|mp3|mp4|webm|wav|ogg|pdf)$/i;
const CONFIG_EXTENSIONS = /\.(ya?ml|toml|ini|cfg|conf|json5?|jsonc|properties|env|plist|xml)$/i;
const CI_PATHS = [/^\.github\/workflows\//, /^\.github\/actions\//, /(^|\/)\.gitlab-ci\.ya?ml$/, /^\.circleci\//, /(^|\/)Jenkinsfile$/, /(^|\/)azure-pipelines\.ya?ml$/, /(^|\/)\.travis\.ya?ml$/, /^\.buildkite\//, /(^|\/)bitbucket-pipelines\.ya?ml$/, /^\.woodpecker/, /^\.drone\.ya?ml$/];
const BUILD_PATHS = [/(^|\/)Dockerfile[^/]*$/, /(^|\/)docker-compose[^/]*\.ya?ml$/, /(^|\/)compose\.ya?ml$/, /(^|\/)(GNU)?[Mm]akefile$/, /\.mk$/, /(^|\/)CMakeLists\.txt$/, /\.cmake$/, /(^|\/)(webpack|vite|rollup|esbuild|tsup|babel|jest|vitest|eslint|prettier)\.config\.[^/]+$/, /(^|\/)tsconfig[^/]*\.json$/, /(^|\/)\.goreleaser[^/]*$/, /(^|\/)build\.rs$/, /(^|\/)justfile$/i, /\.bazel$|(^|\/)(BUILD|WORKSPACE)(\.bazel)?$/];
const MIGRATION_PATHS = [/(^|\/)migrations?\//, /(^|\/)db\/migrate\//, /(^|\/)alembic\/versions\//, /\.sql$/i, /(^|\/)schema\.prisma$/, /\.migration\.[^/]+$/, /(^|\/)(liquibase|flyway)\//];
const TEST_PATHS = [/(^|\/)(tests?|__tests__|spec|specs|testing|e2e)\//, /\.(test|spec)\.[^/]+$/, /_test\.(go|py|rb|exs?)$/, /(^|\/)test_[^/]+\.py$/, /(Test|Tests|Spec|IT)\.(java|kt|cs|scala|swift)$/, /(^|\/)conftest\.py$/];
const SECURITY_TOKENS = new Set([
  "auth", "authn", "authz", "authenticate", "authentication", "authorize", "authorization", "login", "logout", "signin", "signup",
  "session", "sessions", "token", "tokens", "jwt", "oauth", "oauth2", "oidc", "saml", "sso", "password", "passwords", "passwd",
  "credential", "credentials", "secret", "secrets", "crypto", "cipher", "encrypt", "encryption", "decrypt", "signature",
  "signing", "permission", "permissions", "acl", "rbac", "policy", "policies", "sanitize", "sanitizer", "escape", "csrf",
  "xss", "cors", "security", "payment", "payments", "billing", "wallet", "keychain", "keystore", "cert", "certs",
  "certificate", "certificates", "tls", "ssl", "privilege", "privileges", "sudo", "admin", "firewall",
]);
const LANGUAGES = {
  js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript", ts: "typescript", tsx: "typescript", mts: "typescript",
  cts: "typescript", py: "python", pyi: "python", rs: "rust", go: "go", java: "java", kt: "kotlin", kts: "kotlin", swift: "swift",
  rb: "ruby", php: "php", cs: "csharp", fs: "fsharp", c: "c", h: "c", cc: "cpp", cpp: "cpp", cxx: "cpp", hpp: "cpp", hh: "cpp",
  m: "objective-c", mm: "objective-c", scala: "scala", sh: "shell", bash: "shell", zsh: "shell", fish: "shell", ps1: "powershell",
  sql: "sql", html: "html", htm: "html", css: "css", scss: "css", sass: "css", less: "css", vue: "vue", svelte: "svelte",
  lua: "lua", dart: "dart", ex: "elixir", exs: "elixir", erl: "erlang", hs: "haskell", ml: "ocaml", clj: "clojure", r: "r",
  jl: "julia", tf: "terraform", nix: "nix", zig: "zig", proto: "protobuf", graphql: "graphql", gql: "graphql", yaml: "yaml",
  yml: "yaml", json: "json", toml: "toml", md: "markdown", mdx: "markdown", xml: "xml", gradle: "groovy", groovy: "groovy",
};

const CONTENT_SIGNALS = {
  concurrency: /\b(mutex|Mutex|RwLock|RWMutex|Condvar|semaphore|Semaphore|synchronized|volatile|atomic|Atomic\w*|Atomics|threading|multiprocessing|ThreadPool|ExecutorService|ConcurrentHashMap|WaitGroup|goroutine|crossbeam|rayon|parking_lot|SharedArrayBuffer|Worker)\b|\bgo\s+func\b|\bchan\s+\w|\bselect\s*\{|Promise\.(all|race|any|allSettled)\b|tokio::(spawn|select|sync)|asyncio\.(gather|create_task|Lock)|\bspawn\s*\(|\.lock\(\)|\bArc</,
  "error-handling": /\b(try|catch|except|finally|rescue|recover|panic|unwrap|expect|throws?|raise|reject|Err|Error|errors\.New|fmt\.Errorf|bail|anyhow)\b|\?\s*;|\.catch\(/,
  perf: /\b(SELECT|INSERT|UPDATE|DELETE|JOIN)\b|\.(query|execute|findAll|findMany|findOne|findBy\w*|aggregate)\(|\b(fetch|axios|requests\.(get|post)|http\.(Get|Post)|urlopen)\b|\b(readFileSync|writeFileSync|execSync|spawnSync|execFileSync)\b|\b(sleep|usleep|Thread\.sleep|time\.sleep)\s*\(|\b(cache|Cache|memoize|lru_cache)\b/,
  serialization: /\b(serialize|deserialize|Serialize|Deserialize|serde|JSON\.parse|JSON\.stringify|json\.(loads|dumps)|pickle|marshal|unmarshal|Marshal|Unmarshal|protobuf|msgpack|yaml\.(load|dump)|ALTER\s+TABLE|CREATE\s+TABLE|DROP\s+(TABLE|COLUMN|INDEX))\b/,
};
const VALIDATION = /\b(if\s*\(?\s*!|unless|throw|raise|assert\w*|validate\w*|validator|sanitize\w*|guard|require\s*\(|requireNonNull|precondition|invariant|return\s+err\b|bail!|ensure!|Unauthorized|Forbidden|authorize\w*|authenticate\w*|checkPermission\w*|hasPermission\w*|isAllowed|verify\w*)\b/;
const EXPORTS = /^\s*(export\s|pub(\([^)]*\))?\s+(fn|struct|enum|trait|type|const|static|mod|use)\b|public\s+(static\s+)?[\w<>[\],\s]+\s+\w+\s*\(|module\.exports|exports\.\w+\s*=|func\s+(\([^)]*\)\s*)?[A-Z]\w*\s*\()/;
const SECRETS = /AKIA[0-9A-Z]{16}|-----BEGIN (RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----|\bgh[pousr]_[A-Za-z0-9]{36,}\b|\bxox[abprs]-[A-Za-z0-9-]{10,}|\bsk-[A-Za-z0-9_-]{20,}\b|\bAIza[0-9A-Za-z_-]{35}\b|(password|passwd|secret|api[_-]?key|token)\s*[:=]\s*["'][^"'\s]{8,}["']/i;

export const HIGH_SIGNALS = ["security-path", "migration", "possible-secret", "removed-validation", "api-removal", "refactor", "ci-config", "concurrency", "text-to-binary"];

const baseName = (path) => path.slice(path.lastIndexOf("/") + 1);

function pathTokens(path) {
  return path
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

export function language(path) {
  const name = baseName(path);
  if (/^Dockerfile/.test(name)) return "docker";
  if (/^(GNU)?[Mm]akefile$/.test(name)) return "make";
  const dot = name.lastIndexOf(".");
  return dot > 0 ? LANGUAGES[name.slice(dot + 1).toLowerCase()] ?? null : null;
}

function matchesBoth(file, test) {
  return test(file.path) && (!file.old_path || test(file.old_path));
}

function kindOf(path, file) {
  const name = baseName(path);
  const known = file.status !== "A";
  if (file.binary) {
    if (ASSET_EXTENSIONS.test(name)) return "binary";
    return known && file.base_binary !== false ? "binary" : "binary-content";
  }
  if (LOCKFILES.has(name)) return "lockfile";
  if (file.vendored || (known && matchesBoth(file, (value) => value.split("/").some((segment) => VENDOR_DIRS.has(segment))))) return "vendored";
  if (file.generated || (known && matchesBoth(file, (value) => GENERATED_PATHS.some((pattern) => pattern.test(value))))) return "generated";
  if (CI_PATHS.some((pattern) => pattern.test(path))) return "ci";
  if (MIGRATION_PATHS.some((pattern) => pattern.test(path))) return "migration";
  if (TEST_PATHS.some((pattern) => pattern.test(path))) return "test";
  if (PROMPT_NAMES.has(name) || (DOC_EXTENSIONS.test(name) && path.split("/").slice(0, -1).some((segment) => PROMPT_DIRS.has(segment)))) return "prompt";
  if (DOC_EXTENSIONS.test(name) || /^(README|LICENSE|NOTICE|AUTHORS|CONTRIBUTING|CODEOWNERS)(\.|$)/.test(name)) return "docs";
  if (ASSET_EXTENSIONS.test(name)) return "asset";
  if (MANIFESTS.has(name)) return "manifest";
  if (BUILD_PATHS.some((pattern) => pattern.test(path))) return "build";
  if (CONFIG_EXTENSIONS.test(name) || /^\.[\w.-]+rc$/.test(name)) return "config";
  return "source";
}

const EXCLUDED_KINDS = { binary: "binary file", lockfile: "lockfile", vendored: "vendored code", generated: "generated file" };

function countMatches(items, pattern) {
  return items.reduce((count, item) => count + (pattern.test(item.text) ? 1 : 0), 0);
}

export function contentSignals(file) {
  const added = [];
  const removed = [];
  for (const hunk of file.hunks) {
    const lines = changedLines(hunk);
    added.push(...lines.added);
    removed.push(...lines.removed);
  }
  const signals = new Set();
  const all = [...added, ...removed];
  for (const [name, pattern] of Object.entries(CONTENT_SIGNALS)) {
    if (all.some((item) => pattern.test(item.text))) signals.add(name);
  }
  if (countMatches(removed, VALIDATION) > countMatches(added, VALIDATION)) signals.add("removed-validation");
  if (countMatches(removed, EXPORTS) > countMatches(added, EXPORTS)) signals.add("api-removal");
  else if (added.some((item) => EXPORTS.test(item.text)) || removed.some((item) => EXPORTS.test(item.text))) signals.add("api-change");
  if (added.some((item) => SECRETS.test(item.text))) signals.add("possible-secret");
  return signals;
}

export function classifyFile(file) {
  const kind = kindOf(file.path, file);
  const added = file.hunks.reduce((sum, hunk) => sum + hunk.added, 0);
  const removed = file.hunks.reduce((sum, hunk) => sum + hunk.removed, 0);
  const signals = new Set();
  if (file.status === "A") signals.add("new-file");
  if (file.status === "D") signals.add("deleted");
  if (file.status === "R") signals.add("rename");
  if (file.status === "C") signals.add("copy");
  if (file.status === "T") signals.add("type-change");
  if (file.mode_change) signals.add("mode-change");
  if (kind === "binary-content") signals.add(file.status !== "A" && file.base_binary === false ? "text-to-binary" : "binary-content");
  const excluded = EXCLUDED_KINDS[kind] ?? null;
  if (!excluded && kind !== "asset") {
    for (const signal of contentSignals(file)) signals.add(signal);
    if (kind === "ci") signals.add("ci-config");
    if (kind === "build") signals.add("build-config");
    if (kind === "manifest") signals.add("dependency-manifest");
    if (kind === "migration") signals.add("migration");
    if (!["docs", "prompt", "test"].includes(kind) && pathTokens(file.path).some((token) => SECURITY_TOKENS.has(token))) signals.add("security-path");
    if (file.status === "R" && file.hunks.length > 0) signals.add("refactor");
    if (file.status === "M" && added >= 20 && removed >= 20 && Math.min(added, removed) / Math.max(added, removed) >= 0.6) signals.add("refactor");
    if (kind === "test" && (file.status === "D" || removed > added)) signals.add("test-removal");
  }
  if (["docs", "prompt", "test"].includes(kind)) {
    for (const signal of ["concurrency", "perf", "serialization", "error-handling", "api-change", "api-removal", "removed-validation", "refactor"]) {
      signals.delete(signal);
    }
  }
  return {
    path: file.path,
    old_path: file.old_path && file.old_path !== file.path ? file.old_path : null,
    status: file.status,
    kind,
    language: language(file.path),
    added,
    removed,
    binary: Boolean(file.binary),
    excluded: Boolean(excluded),
    exclude_reason: excluded,
    signals: [...signals].sort(),
    tier: tierOf(kind, file, signals, excluded),
  };
}

function tierOf(kind, file, signals, excluded) {
  if (signals.has("possible-secret")) return "high";
  if (excluded || kind === "asset" || kind === "docs") return "low";
  if (file.status === "R" && file.hunks.length === 0 && !file.mode_change) return "low";
  if (kind === "test") return signals.has("test-removal") ? "medium" : "low";
  if (kind === "prompt") return "medium";
  return HIGH_SIGNALS.some((signal) => signals.has(signal)) ? "high" : "medium";
}

export function generatedMarker(preview) {
  return GENERATED_MARKERS.test(String(preview ?? "").split("\n").slice(0, 5).join("\n"));
}
