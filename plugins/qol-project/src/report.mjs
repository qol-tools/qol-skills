import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

export function reportPath(root, env = process.env) {
  const name = path.basename(root).replace(/[^\w.-]/g, "_") || "repo";
  return path.join(env.XDG_RUNTIME_DIR || tmpdir(), "qac", `${name}.html`);
}

function embed(value) {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

export function renderReport(result, hooks) {
  const data = {
    repo: path.basename(result.root),
    root: result.root,
    at: result.at,
    files: result.files,
    hooks,
    findings: result.findings.map(({ file, hook, rule, detail, message }) => ({ file, hook, rule, detail, message })),
  };
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>qac lint - ${data.repo.replace(/[<&>"]/g, "")}</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='8' fill='%23e5a72e'/%3E%3Cpath d='M9 16.5l4.5 4.5L23 11.5' fill='none' stroke='%230e0d0b' stroke-width='3.2' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
:root {
  --ground: #0e0d0b;
  --panel: #16140f;
  --panel-hover: #1c1a14;
  --line: #2a261d;
  --text: #ece6d8;
  --dim: #8d8676;
  --faint: #5c5649;
  --amber: #e5a72e;
  --amber-soft: rgba(229, 167, 46, 0.14);
  --ok: #7fbf7a;
  --radius: 14px;
  --mono: "JetBrains Mono", ui-monospace, "SFMono-Regular", Menlo, monospace;
  --sans: "Inter", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  color-scheme: dark;
}
@media (prefers-color-scheme: light) {
  :root:not([data-theme="dark"]) {
    --ground: #f6f3ec;
    --panel: #fffdf8;
    --panel-hover: #f9f5ea;
    --line: #e4ddcc;
    --text: #1f1c16;
    --dim: #6e675a;
    --faint: #a39b8a;
    --amber: #b87900;
    --amber-soft: rgba(184, 121, 0, 0.12);
    --ok: #3f8a3a;
    color-scheme: light;
  }
}
* { box-sizing: border-box; }
html, body { margin: 0; background: var(--ground); color: var(--text); font: 14px/1.5 var(--sans); -webkit-font-smoothing: antialiased; }
main { max-width: 1120px; margin: 0 auto; padding: 48px 24px 96px; }
header { display: flex; align-items: flex-end; justify-content: space-between; gap: 24px; flex-wrap: wrap; }
.eyebrow { font: 500 12px/1 var(--mono); letter-spacing: .14em; text-transform: uppercase; color: var(--amber); }
h1 { margin: 10px 0 6px; font-size: 34px; font-weight: 700; letter-spacing: -.02em; }
.meta { color: var(--dim); font-size: 13px; }
.total { text-align: right; }
.total b { display: block; font-size: 64px; line-height: 1; font-weight: 700; letter-spacing: -.04em; color: var(--amber); font-variant-numeric: tabular-nums; }
.total span { color: var(--dim); font-size: 13px; }
.total.clean b { color: var(--ok); }
.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 12px; margin: 36px 0 20px; }
.tile { all: unset; cursor: pointer; background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); padding: 16px 18px; transition: border-color .15s, background .15s; }
.tile:hover { background: var(--panel-hover); }
.tile:focus-visible, .tile.on { border-color: var(--amber); }
.tile.zero { opacity: .45; cursor: default; }
.tile .name { font: 500 12px var(--mono); color: var(--dim); }
.tile .count { font-size: 26px; font-weight: 600; margin-top: 4px; font-variant-numeric: tabular-nums; }
.bar { height: 3px; background: var(--line); border-radius: 3px; margin-top: 12px; overflow: hidden; }
.bar i { display: block; height: 100%; background: var(--amber); border-radius: 3px; }
.tools { display: flex; gap: 10px; align-items: center; margin-bottom: 18px; }
.search { flex: 1; position: relative; }
.search input { width: 100%; background: var(--panel); border: 1px solid var(--line); border-radius: 10px; color: var(--text); font: 14px var(--sans); padding: 11px 14px 11px 38px; outline: none; }
.search input:focus { border-color: var(--amber); }
.search svg { position: absolute; left: 13px; top: 50%; transform: translateY(-50%); color: var(--faint); }
.search kbd { position: absolute; right: 10px; top: 50%; transform: translateY(-50%); }
kbd { font: 500 11px var(--mono); color: var(--dim); border: 1px solid var(--line); border-radius: 5px; padding: 2px 6px; }
.ghost { all: unset; cursor: pointer; font-size: 13px; color: var(--dim); padding: 9px 12px; border-radius: 10px; border: 1px solid var(--line); }
.ghost:hover { color: var(--text); }
.group { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); margin-bottom: 12px; overflow: hidden; animation: rise .25s ease both; }
.group > summary { list-style: none; cursor: pointer; display: flex; align-items: center; gap: 12px; padding: 16px 18px; }
.group > summary::-webkit-details-marker { display: none; }
.group > summary:hover { background: var(--panel-hover); }
.chev { color: var(--faint); transition: transform .15s; flex: none; }
.group[open] .chev { transform: rotate(90deg); }
.pill { font: 500 11px var(--mono); color: var(--amber); background: var(--amber-soft); padding: 3px 8px; border-radius: 999px; flex: none; }
.rule { font-weight: 600; flex: 1; min-width: 0; }
.n { font: 600 13px var(--mono); color: var(--dim); font-variant-numeric: tabular-nums; }
.rows { border-top: 1px solid var(--line); }
.row { display: grid; grid-template-columns: minmax(0, 1fr); padding: 10px 18px 10px 46px; border-top: 1px solid var(--line); cursor: pointer; }
.row:first-child { border-top: 0; }
.row:hover { background: var(--panel-hover); }
.path { font: 13px var(--mono); overflow-wrap: anywhere; }
.path .dir { color: var(--faint); }
.detail { color: var(--dim); font-size: 13px; margin-top: 2px; }
.row pre { display: none; margin: 10px 0 4px; padding: 14px; background: var(--ground); border: 1px solid var(--line); border-radius: 10px; font: 12px/1.6 var(--mono); color: var(--dim); white-space: pre-wrap; overflow-wrap: anywhere; }
.row.open pre { display: block; }
.empty { text-align: center; padding: 80px 0; color: var(--dim); }
.empty b { display: block; font-size: 22px; color: var(--text); margin-bottom: 6px; }
.copied { position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%); background: var(--text); color: var(--ground); padding: 8px 14px; border-radius: 999px; font-size: 13px; opacity: 0; transition: opacity .2s; pointer-events: none; }
.copied.on { opacity: 1; }
@keyframes rise { from { opacity: 0; transform: translateY(4px); } }
@media (prefers-reduced-motion: reduce) { * { animation: none !important; transition: none !important; } }
@media (max-width: 640px) { main { padding: 28px 16px 64px; } .total b { font-size: 44px; } .row { padding-left: 18px; } }
</style>
</head>
<body>
<main>
  <header>
    <div>
      <div class="eyebrow">qac lint</div>
      <h1 id="repo"></h1>
      <div class="meta" id="meta"></div>
    </div>
    <div class="total" id="total"></div>
  </header>
  <section class="tiles" id="tiles"></section>
  <div class="tools">
    <label class="search">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
      <input id="q" placeholder="Filter by path or rule" autocomplete="off" spellcheck="false">
      <kbd>/</kbd>
    </label>
    <button class="ghost" id="toggle">Expand all</button>
  </div>
  <section id="groups"></section>
</main>
<div class="copied" id="copied">Path copied</div>
<script id="data" type="application/json">${embed(data)}</script>
<script>
const data = JSON.parse(document.getElementById("data").textContent);
const state = { hook: null, query: "" };
const el = (tag, cls, text) => { const node = document.createElement(tag); if (cls) node.className = cls; if (text != null) node.textContent = text; return node; };
const chev = () => { const s = document.createElementNS("http://www.w3.org/2000/svg", "svg"); s.setAttribute("width", "14"); s.setAttribute("height", "14"); s.setAttribute("viewBox", "0 0 24 24"); s.setAttribute("class", "chev"); s.innerHTML = '<path d="m9 6 6 6-6 6" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>'; return s; };

document.getElementById("repo").textContent = data.repo;
document.getElementById("meta").textContent = data.files.toLocaleString() + " files scanned · " + new Date(data.at).toLocaleString() + " · " + data.root;
const total = document.getElementById("total");
const count = data.findings.length;
total.className = "total" + (count ? "" : " clean");
total.append(el("b", null, count.toLocaleString()), el("span", null, count === 1 ? "finding" : "findings"));

const tiles = document.getElementById("tiles");
const max = Math.max(1, ...data.hooks.map(h => data.findings.filter(f => f.hook === h).length));
for (const hook of data.hooks) {
  const n = data.findings.filter(f => f.hook === hook).length;
  const tile = el("button", "tile" + (n ? "" : " zero"));
  tile.append(el("div", "name", hook), el("div", "count", n.toLocaleString()));
  const bar = el("div", "bar"); const fill = el("i"); fill.style.width = (n / max * 100) + "%"; bar.append(fill); tile.append(bar);
  if (n) tile.onclick = () => { state.hook = state.hook === hook ? null : hook; render(); };
  tile.dataset.hook = hook;
  tiles.append(tile);
}

const pathNode = file => { const node = el("div", "path"); const at = file.lastIndexOf("/"); node.append(el("span", "dir", file.slice(0, at + 1)), document.createTextNode(file.slice(at + 1))); return node; };

function render() {
  for (const tile of tiles.children) tile.classList.toggle("on", tile.dataset.hook === state.hook);
  const q = state.query.toLowerCase();
  const shown = data.findings.filter(f => (!state.hook || f.hook === state.hook) && (!q || (f.file + " " + f.rule + " " + f.detail).toLowerCase().includes(q)));
  const groups = new Map();
  for (const f of shown) { const key = f.hook + "\\u0000" + f.rule; if (!groups.has(key)) groups.set(key, []); groups.get(key).push(f); }
  const root = document.getElementById("groups");
  root.replaceChildren();
  if (!data.findings.length) { const e = el("div", "empty"); e.append(el("b", null, "Clean."), document.createTextNode("No hook would block any of these " + data.files.toLocaleString() + " files.")); root.append(e); return; }
  if (!shown.length) { root.append(el("div", "empty", "Nothing matches.")); return; }
  const sorted = [...groups.values()].sort((a, b) => b.length - a.length);
  sorted.forEach((items, index) => {
    const group = el("details", "group");
    group.style.animationDelay = Math.min(index * 18, 240) + "ms";
    if (q || sorted.length === 1) group.open = true;
    const summary = el("summary");
    summary.append(chev(), el("span", "pill", items[0].hook), el("span", "rule", items[0].rule), el("span", "n", items.length));
    const rows = el("div", "rows");
    for (const f of items) {
      const row = el("div", "row");
      row.append(pathNode(f.file));
      if (f.detail) row.append(el("div", "detail", f.detail));
      row.append(el("pre", null, f.message.trim()));
      row.onclick = event => {
        if (event.target.closest(".path") && (event.metaKey || event.ctrlKey)) { navigator.clipboard?.writeText(f.file); flash(); return; }
        row.classList.toggle("open");
      };
      rows.append(row);
    }
    group.append(summary, rows);
    root.append(group);
  });
  syncToggle();
}

const toggle = document.getElementById("toggle");
const allOpen = () => [...document.querySelectorAll(".group")].every(g => g.open);
const syncToggle = () => { toggle.textContent = allOpen() ? "Collapse all" : "Expand all"; };
toggle.onclick = () => { const open = !allOpen(); document.querySelectorAll(".group").forEach(g => g.open = open); syncToggle(); };
document.addEventListener("toggle", syncToggle, true);

const flash = () => { const c = document.getElementById("copied"); c.classList.add("on"); setTimeout(() => c.classList.remove("on"), 1100); };
const q = document.getElementById("q");
q.oninput = () => { state.query = q.value; render(); };
document.addEventListener("keydown", event => {
  if (event.key === "/" && document.activeElement !== q) { event.preventDefault(); q.focus(); }
  else if (event.key === "Escape") { q.value = ""; state.query = ""; state.hook = null; q.blur(); render(); }
});
render();
</script>
</body>
</html>
`;
}

export function writeReport(result, hooks, env = process.env) {
  const file = reportPath(result.root, env);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, renderReport(result, hooks));
  return file;
}

const OPENERS = {
  darwin: file => ["open", [file]],
  win32: file => ["cmd", ["/c", "start", "", file]],
};

export function openReport(file, { platform = process.platform, launch = spawn } = {}) {
  const [command, args] = (OPENERS[platform] ?? (target => ["xdg-open", [target]]))(file);
  const child = launch(command, args, { detached: true, stdio: "ignore" });
  child.on?.("error", () => {});
  child.unref?.();
}
