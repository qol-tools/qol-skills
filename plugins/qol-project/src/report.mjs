import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

export function reportPath(root, env = process.env) {
  const name = path.basename(root).replace(/[^\w.-]/g, "_") || "repo";
  return path.join(env.XDG_RUNTIME_DIR || tmpdir(), "qac", `${name}.html`);
}

function embed(value) {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

export function reportData(result, hooks) {
  return {
    repo: path.basename(result.root),
    root: result.root,
    at: result.at,
    files: result.files,
    hooks,
    sources: result.sources ?? {},
    findings: result.findings.map(({ file, hook, rule, detail, lines, message }) => ({
      file, hook, rule, detail, lines: lines ?? [], message,
    })),
  };
}

const STYLE = `
:root {
  --ground: #0c0b09; --pane: #12110d; --panel: #17150f; --hover: #1d1a13; --line: #27231a;
  --text: #ece6d8; --dim: #938b7a; --faint: #5e584b;
  --amber: #e5a72e; --amber-soft: rgba(229,167,46,.12);
  --ok: #7fbf7a; --kw: #d49a6a; --str: #a9c47f; --com: #6a6456; --num: #d9b36c; --attr: #b39ddb; --mac: #7fb8c9;
  --mono: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
  --sans: "Inter", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  color-scheme: dark;
}
@media (prefers-color-scheme: light) {
  :root:not([data-theme="dark"]) {
    --ground: #f3efe6; --pane: #f8f5ee; --panel: #fffdf8; --hover: #f1ecdf; --line: #e2dac8;
    --text: #1f1c16; --dim: #6b6456; --faint: #a39a88;
    --amber: #a86e00; --amber-soft: rgba(168,110,0,.10);
    --ok: #3f8a3a; --kw: #9a4f16; --str: #4d7a1f; --com: #9b9384; --num: #8a6400; --attr: #6a4fb0; --mac: #1f6f86;
    color-scheme: light;
  }
}
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; background: var(--ground); color: var(--text); font: 13px/1.5 var(--sans); -webkit-font-smoothing: antialiased; }
body { display: flex; flex-direction: column; overflow: hidden; }
.top { display: flex; align-items: center; gap: 16px; padding: 12px 18px; border-bottom: 1px solid var(--line); background: var(--pane); flex: none; flex-wrap: wrap; }
.brand { display: flex; align-items: baseline; gap: 10px; min-width: 0; }
.brand .mark { font: 600 11px var(--mono); letter-spacing: .14em; text-transform: uppercase; color: var(--amber); }
.brand h1 { margin: 0; font-size: 16px; font-weight: 650; letter-spacing: -.01em; white-space: nowrap; }
.brand .meta { color: var(--faint); font-size: 12px; white-space: nowrap; }
.chips { display: flex; gap: 6px; flex-wrap: wrap; }
.chip { all: unset; cursor: pointer; display: inline-flex; align-items: center; gap: 7px; font: 500 12px var(--mono); color: var(--dim); padding: 5px 10px; border: 1px solid var(--line); border-radius: 999px; }
.chip b { color: var(--text); font-weight: 600; }
.chip:hover { background: var(--hover); }
.chip.on { border-color: var(--amber); color: var(--text); background: var(--amber-soft); }
.chip.zero { opacity: .4; cursor: default; }
.spacer { flex: 1; }
.total { font: 700 22px var(--sans); letter-spacing: -.02em; color: var(--amber); font-variant-numeric: tabular-nums; }
.total small { font: 500 12px var(--sans); color: var(--dim); margin-left: 6px; letter-spacing: 0; }
.total.clean { color: var(--ok); }
.split { flex: 1; display: grid; grid-template-columns: 340px minmax(0, 1fr); min-height: 0; }
aside { border-right: 1px solid var(--line); background: var(--pane); display: flex; flex-direction: column; min-height: 0; }
.search { position: relative; padding: 12px; border-bottom: 1px solid var(--line); flex: none; }
.search input { width: 100%; background: var(--panel); border: 1px solid var(--line); border-radius: 8px; color: var(--text); font: 13px var(--sans); padding: 8px 34px 8px 30px; outline: none; }
.search input:focus { border-color: var(--amber); }
.search svg { position: absolute; left: 22px; top: 50%; transform: translateY(-50%); color: var(--faint); }
.search kbd { position: absolute; right: 20px; top: 50%; transform: translateY(-50%); }
kbd { font: 500 10px var(--mono); color: var(--dim); border: 1px solid var(--line); border-radius: 4px; padding: 1px 5px; }
.list { overflow: auto; flex: 1; padding: 4px 0 24px; }
.dir-head { position: sticky; top: 0; z-index: 1; background: var(--pane); font: 600 10.5px var(--mono); letter-spacing: .12em; text-transform: uppercase; color: var(--faint); padding: 12px 16px 6px; }
.item { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 2px 10px; padding: 7px 16px 7px 14px; border-left: 2px solid transparent; cursor: pointer; }
.item:hover { background: var(--hover); }
.item.on { background: var(--amber-soft); border-left-color: var(--amber); }
.item .base { font: 500 12.5px var(--mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.item .dir { grid-column: 1; font: 11px var(--mono); color: var(--faint); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; direction: rtl; text-align: left; }
.item .count { grid-row: 1 / span 2; grid-column: 2; align-self: center; font: 600 11px var(--mono); color: var(--amber); background: var(--amber-soft); border-radius: 999px; padding: 2px 8px; }
.viewer { overflow: auto; min-height: 0; }
.file-head { position: sticky; top: 0; z-index: 2; display: flex; align-items: center; gap: 12px; padding: 12px 20px; background: var(--ground); border-bottom: 1px solid var(--line); }
.file-head .path { font: 500 13px var(--mono); flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.file-head .path .d { color: var(--faint); }
.btn { all: unset; cursor: pointer; font: 500 12px var(--sans); color: var(--dim); padding: 5px 10px; border: 1px solid var(--line); border-radius: 7px; white-space: nowrap; }
.btn:hover { color: var(--text); background: var(--hover); }
.btn.on { color: var(--text); border-color: var(--amber); }
.btn.fix { color: var(--amber); border-color: var(--amber-soft); background: var(--amber-soft); }
.btn.fix:hover { color: var(--text); border-color: var(--amber); }
.body { padding: 16px 20px 64px; }
.note { border: 1px solid var(--line); border-left: 3px solid var(--amber); background: var(--panel); border-radius: 8px; padding: 10px 14px; margin: 0 0 12px; font-family: var(--sans); }
.note .head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.pill { font: 500 10.5px var(--mono); color: var(--amber); background: var(--amber-soft); padding: 2px 7px; border-radius: 999px; }
.note .rule { font-weight: 600; font-size: 13px; }
.note .detail { color: var(--dim); margin-top: 3px; font: 12px var(--mono); overflow-wrap: anywhere; }
.note details { margin-top: 6px; }
.note summary { cursor: pointer; color: var(--faint); font-size: 12px; list-style: none; }
.note summary::-webkit-details-marker { display: none; }
.note summary:hover { color: var(--dim); }
.note pre { margin: 8px 0 2px; font: 11.5px/1.6 var(--mono); color: var(--dim); white-space: pre-wrap; overflow-wrap: anywhere; }
.note a { color: var(--dim); font-size: 12px; margin-left: auto; text-decoration: none; }
.note a:hover { color: var(--amber); }
.code { border: 1px solid var(--line); border-radius: 10px; background: var(--panel); overflow: hidden; font: 12.5px/1.65 var(--mono); }
.ln { display: grid; grid-template-columns: 56px minmax(0, 1fr); }
.ln .no { color: var(--faint); text-align: right; padding: 0 14px 0 0; user-select: none; border-right: 1px solid var(--line); }
.ln .src { padding: 0 16px; white-space: pre; overflow-x: auto; }
.ln.hit { background: var(--amber-soft); }
.ln.hit .no { color: var(--amber); box-shadow: inset 3px 0 0 var(--amber); }
.note.inline { margin: 6px 12px 8px 68px; }
.gap { all: unset; display: block; width: 100%; cursor: pointer; text-align: center; color: var(--faint); font: 11.5px var(--mono); padding: 4px 0; background: var(--ground); border-top: 1px solid var(--line); border-bottom: 1px solid var(--line); }
.gap:hover { color: var(--amber); }
.code > .gap:first-child { border-top: 0; }
.code > .gap:last-child { border-bottom: 0; }
.k { color: var(--kw); } .s { color: var(--str); } .c { color: var(--com); font-style: italic; } .n { color: var(--num); } .a { color: var(--attr); } .m { color: var(--mac); }
.empty { display: grid; place-items: center; min-height: 60%; color: var(--dim); text-align: center; padding: 40px; }
.empty b { display: block; font-size: 22px; color: var(--text); margin-bottom: 6px; }
.toast { position: fixed; bottom: 22px; left: 50%; transform: translateX(-50%); background: var(--text); color: var(--ground); padding: 7px 14px; border-radius: 999px; font-size: 12px; opacity: 0; transition: opacity .2s; pointer-events: none; }
.toast.on { opacity: 1; }
@media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
@media (max-width: 760px) { .split { grid-template-columns: 1fr; grid-template-rows: 40% 60%; } aside { border-right: 0; border-bottom: 1px solid var(--line); } .note.inline { margin-left: 12px; } }
`;

const SCRIPT = String.raw`
const data = JSON.parse(document.getElementById("data").textContent);
const CONTEXT = 5;
const state = { hook: null, query: "", file: null, full: false, opened: new Map() };
const $ = id => document.getElementById(id);
const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
const esc = t => t.replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
const byFile = new Map();
for (const f of data.findings) { if (!byFile.has(f.file)) byFile.set(f.file, []); byFile.get(f.file).push(f); }

const KEYWORDS = new Set("as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while function var new class export import from default of null undefined typeof instanceof".split(" "));
const TOKEN = /(\/\/.*$|#(?![\[!]).*$)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)'|\x60(?:[^\x60\\]|\\.)*\x60)|(#!?\[[^\]]*\]?)|\b([A-Za-z_]\w*!)|\b(\d[\d_.]*[a-z0-9]*)\b|\b([A-Za-z_]\w*)\b/g;
function highlight(text, ext) {
  const hashComment = ["toml", "yml", "yaml", "sh", "py"].includes(ext);
  let out = "", last = 0;
  for (const m of text.matchAll(TOKEN)) {
    out += esc(text.slice(last, m.index));
    last = m.index + m[0].length;
    const [all, com, str, attr, mac, num, word] = m;
    const wrap = cls => '<span class="' + cls + '">' + esc(all) + "</span>";
    if (com) out += com.startsWith("//") || hashComment ? wrap("c") : esc(all);
    else if (str) out += wrap("s");
    else if (attr) out += wrap("a");
    else if (mac) out += wrap("m");
    else if (num) out += wrap("n");
    else if (word && KEYWORDS.has(word)) out += wrap("k");
    else out += esc(all);
  }
  return out + esc(text.slice(last));
}

function visibleFiles() {
  const q = state.query.toLowerCase();
  return [...byFile.keys()].filter(file => byFile.get(file).some(f =>
    (!state.hook || f.hook === state.hook) &&
    (!q || (file + " " + f.rule + " " + f.detail).toLowerCase().includes(q))));
}
const shownFindings = file => byFile.get(file).filter(f => !state.hook || f.hook === state.hook);

function renderTop() {
  $("repo").textContent = data.repo;
  $("meta").textContent = data.files.toLocaleString() + " files · " + new Date(data.at).toLocaleString();
  const total = $("total");
  total.className = "total" + (data.findings.length ? "" : " clean");
  total.replaceChildren(document.createTextNode(data.findings.length.toLocaleString()), el("small", null, data.findings.length === 1 ? "finding" : "findings"));
  const chips = $("chips");
  chips.replaceChildren();
  for (const hook of data.hooks) {
    const n = data.findings.filter(f => f.hook === hook).length;
    const chip = el("button", "chip" + (n ? "" : " zero") + (state.hook === hook ? " on" : ""));
    chip.append(document.createTextNode(hook), el("b", null, n));
    if (n) chip.onclick = () => { state.hook = state.hook === hook ? null : hook; renderAll(); };
    chips.append(chip);
  }
}

function renderList() {
  const list = $("list");
  list.replaceChildren();
  const files = visibleFiles();
  if (!files.includes(state.file)) state.file = files[0] ?? null;
  let group = null;
  for (const file of files) {
    const top = file.includes("/") ? file.split("/")[0] : ".";
    if (top !== group) { group = top; list.append(el("div", "dir-head", top)); }
    const item = el("div", "item" + (file === state.file ? " on" : ""));
    const at = file.lastIndexOf("/");
    item.append(el("div", "base", file.slice(at + 1)), el("span", "count", shownFindings(file).length), el("div", "dir", "\u200e" + (at > 0 ? file.slice(0, at) : ".")));
    item.onclick = () => { state.file = file; renderList(); renderViewer(); };
    list.append(item);
  }
  list.querySelector(".item.on")?.scrollIntoView({ block: "nearest" });
}

function note(f, inline) {
  const box = el("div", "note" + (inline ? " inline" : ""));
  const head = el("div", "head");
  head.append(el("span", "pill", f.hook), el("span", "rule", f.rule));
  const link = el("a", null, "Open in VS Code");
  link.href = "vscode://file" + encodeURI(data.root + "/" + f.file) + ":" + (f.lines[0] ?? 1);
  head.append(link);
  box.append(head);
  const detail = f.detail.replace(/line \d+: [^;]*;?/g, "").replace(/(^|\s)-{2,}(?=\s|$)/g, " ").replace(/^[\s;]+|[\s;]+$/g, "");
  if (detail) box.append(el("div", "detail", detail));
  const more = el("details");
  more.append(el("summary", null, "Full hook message"), el("pre", null, f.message.trim()));
  box.append(more);
  return box;
}

function renderViewer() {
  const viewer = $("viewer");
  viewer.replaceChildren();
  if (!data.findings.length) { const e = el("div", "empty"); const inner = el("div"); inner.append(el("b", null, "Clean."), document.createTextNode("No hook would block any of these " + data.files.toLocaleString() + " files.")); e.append(inner); viewer.append(e); return; }
  const file = state.file;
  if (!file) { viewer.append(el("div", "empty", "Nothing matches.")); return; }
  const findings = shownFindings(file);
  const head = el("div", "file-head");
  const p = el("div", "path"); const at = file.lastIndexOf("/");
  p.append(el("span", "d", file.slice(0, at + 1)), document.createTextNode(file.slice(at + 1)));
  const copy = el("button", "btn", "Copy path");
  copy.onclick = () => { navigator.clipboard?.writeText(file); toast("Path copied"); };
  const full = el("button", "btn" + (state.full ? " on" : ""), state.full ? "Focus" : "Full file");
  full.onclick = () => { state.full = !state.full; renderViewer(); };
  const fix = el("button", "btn fix", "Copy fix command");
  fix.onclick = () => { navigator.clipboard?.writeText("qac fix " + file); toast("Copied qac fix " + file.split("/").pop() + " - paste it into Claude"); };
  head.append(p, fix, copy, full);
  viewer.append(head);
  const body = el("div", "body");
  viewer.append(body);
  for (const f of findings.filter(f => !f.lines.length)) body.append(note(f, false));
  const source = data.sources[file];
  if (source == null) { body.append(el("div", "empty", "File too large to embed.")); return; }
  const lines = source.split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  const hits = new Set();
  const anchors = new Map();
  for (const f of findings) {
    for (const line of f.lines) hits.add(line);
    if (f.lines.length) {
      let anchor = f.lines[0];
      while (f.lines.includes(anchor + 1)) anchor++;
      if (!anchors.has(anchor)) anchors.set(anchor, []);
      anchors.get(anchor).push(f);
    }
  }
  const show = new Set(state.opened.get(file) ?? []);
  if (state.full || !hits.size) { const upto = state.full ? lines.length : Math.min(lines.length, 40); for (let i = 1; i <= upto; i++) show.add(i); }
  for (const line of hits) for (let i = line - CONTEXT; i <= line + CONTEXT; i++) if (i >= 1 && i <= lines.length) show.add(i);
  const ext = file.split(".").pop();
  const code = el("div", "code");
  let i = 1;
  while (i <= lines.length) {
    if (!show.has(i)) {
      const start = i; while (i <= lines.length && !show.has(i)) i++;
      const end = i - 1;
      const gap = el("button", "gap", "\u22ef " + (end - start + 1) + " hidden line" + (end > start ? "s" : "") + " \u22ef");
      gap.onclick = () => { const set = state.opened.get(file) ?? new Set(); for (let j = start; j <= end; j++) set.add(j); state.opened.set(file, set); const top = viewer.scrollTop; renderViewer(); viewer.scrollTop = top; };
      code.append(gap);
      continue;
    }
    const row = el("div", "ln" + (hits.has(i) ? " hit" : ""));
    const src = el("div", "src");
    src.innerHTML = highlight(lines[i - 1], ext) || " ";
    row.append(el("div", "no", i), src);
    code.append(row);
    for (const f of anchors.get(i) ?? []) code.append(note(f, true));
    i++;
  }
  body.append(code);
}

let toastTimer;
function toast(text) { const t = $("toast"); t.textContent = text; t.classList.add("on"); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove("on"), 1100); }
function renderAll() { renderTop(); renderList(); renderViewer(); }
function step(delta) { const files = visibleFiles(); if (!files.length) return; const at = Math.max(0, files.indexOf(state.file)); state.file = files[(at + delta + files.length) % files.length]; renderList(); renderViewer(); $("viewer").scrollTop = 0; }
const q = $("q");
q.oninput = () => { state.query = q.value; renderList(); renderViewer(); };
document.addEventListener("keydown", event => {
  if (event.target === q) {
    if (event.key === "Escape") { q.value = ""; state.query = ""; q.blur(); renderList(); renderViewer(); }
    else if (event.key === "Enter") { event.preventDefault(); q.blur(); }
    return;
  }
  if (event.key === "/") { event.preventDefault(); q.focus(); }
  else if (event.key === "j" || event.key === "ArrowDown") { event.preventDefault(); step(1); }
  else if (event.key === "k" || event.key === "ArrowUp") { event.preventDefault(); step(-1); }
  else if (event.key === "f") { state.full = !state.full; renderViewer(); }
  else if (event.key === "Escape") { state.hook = null; renderAll(); }
});
renderAll();
`;

export function renderReport(result, hooks) {
  const data = reportData(result, hooks);
  const title = data.repo.replace(/[<&>"]/g, "");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>qac lint - ${title}</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='8' fill='%23e5a72e'/%3E%3Cpath d='M9 16.5l4.5 4.5L23 11.5' fill='none' stroke='%230c0b09' stroke-width='3.2' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<style>${STYLE}</style>
</head>
<body>
<header class="top">
  <div class="brand"><span class="mark">qac lint</span><h1 id="repo"></h1><span class="meta" id="meta"></span></div>
  <div class="chips" id="chips"></div>
  <div class="spacer"></div>
  <div class="total" id="total"></div>
</header>
<div class="split">
  <aside>
    <label class="search">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
      <input id="q" placeholder="Filter files or rules" autocomplete="off" spellcheck="false">
      <kbd>/</kbd>
    </label>
    <div class="list" id="list"></div>
  </aside>
  <main class="viewer" id="viewer"></main>
</div>
<div class="toast" id="toast"></div>
<script id="data" type="application/json">${embed(data)}</script>
<script>${SCRIPT}</script>
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

export function browserCommand(file, { platform = process.platform, exec = execFileSync } = {}) {
  const url = pathToFileURL(file).href;
  if (platform === "darwin") return ["open", [url]];
  if (platform === "win32") return ["cmd", ["/c", "start", "", url]];
  try {
    const desktop = exec("xdg-settings", ["get", "default-web-browser"], { encoding: "utf8" }).trim();
    if (desktop.endsWith(".desktop")) return ["gtk-launch", [desktop, url]];
  } catch {}
  return ["xdg-open", [url]];
}

export function openReport(file, { platform = process.platform, exec = execFileSync, launch = spawn } = {}) {
  const [command, args] = browserCommand(file, { platform, exec });
  const child = launch(command, args, { detached: true, stdio: "ignore" });
  child.on?.("error", () => {});
  child.unref?.();
}
