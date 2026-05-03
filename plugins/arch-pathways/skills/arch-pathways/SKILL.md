---
name: arch-pathways
description: Use when analyzing multi-area codebase problems before any code change, when the user wants to compare proposals visually, or when dispatching agents needs an agreed problem-and-proposal map. Produces a single sidebar-SPA HTML doc with one page per problem area, each carrying a Problem section (current state diagrams + smell tables) and one or more Proposal cards (each with its own diagram + pros/cons grid + cheap/medium/heavy effort badge). Triggers on requests to "visualize architecture", "compare fix proposals", "map current state vs target", or any deep-dive that spans 3+ subsystems.
---

# Architecture pathways skill

## When to use

Whenever a problem touches three or more subsystems and the user asks for understanding before action. Typical triggers:

- "Why is X broken across all these places?"
- "Map what we have vs industry standard"
- "I want to see all the conflicts before we fix anything"
- "Compare the proposals"

Do NOT use for single-file bugs or "just fix it" requests. The artifact is heavy by design — it's for shared decision-making, not solo iteration.

## Two output modes

This skill produces two distinct artifacts, each with its own template and its own audience:

| Mode | File | When | Audience |
|---|---|---|---|
| **HTML survey** | `/tmp/<project>-pathways.html` (or `docs/pathways.html`) | Initial multi-area brainstorming, before any PR exists. Compare 5+ problems side by side. | You + reviewing agents during planning. Throwaway. |
| **Markdown ADR** | `<repo>/docs/adr/<PID>-<slug>.md` | One per minted PR. Permanent decision record. | Anyone reading the repo six months later asking "why?" |

The HTML is the **workshop**. The Markdown ADR is the **artifact**. Each PR description LINKS to its ADR — it never embeds the analysis. This follows the industry split between PRs ("what changed") and ADRs ("why we decided").

The HTML survey is a single self-contained file: sidebar-SPA, left nav links, right content pane swaps via `display:none/block` on hash change. No build step. Mermaid loaded from CDN. Refresh-iterate without rebuilding.

The Markdown ADR is a single GitHub-renderable markdown file: native Mermaid blocks, native tables for smell rows and tradeoffs. Works without any tool — just open the file on github.com.

## Required structure

Every pathway doc must have:

1. **Sidebar nav** with one link per page.
2. **Overview page** (`#overview`) — recommended fix order based on the cross-area dependency graph.
3. **One page per problem area** (`#<area>`):
   - `<h3>Problem</h3>` subsection with at least one Mermaid diagram (sequence / state / graph) and a smell table.
   - `<h3>Proposals</h3>` subsection with one or more `<div class="proposal">` cards.
4. **Cross-area page** (`#cross`) — the dependency graph showing which problems depend on which.

Every proposal card must contain:

- `<h4>` title with a `<span class="badge cheap|medium|heavy">` cost badge.
- A short description.
- At least one `<pre class="mermaid">` showing the proposed shape (problem and proposal must use the SAME visual medium).
- A `<div class="tradeoffs">` two-column grid with `<h5>pros</h5>` and `<h5>cons</h5>`.
- A "**Closes:**" or "**Verdict:**" line.

If you have multiple proposals per area, end the section with a one-line "**Recommended:**" call.

## Mermaid v10 gotchas (the doc must be Mermaid v10-clean)

- `stateDiagram-v2` transition labels: NO `::`, NO semicolons, NO unbalanced parens. Keep label text short and prose-like.
- `graph` node labels with special chars must be quoted: `["my (label)"]` not `[my (label)]`.
- Use `<br/>` not `\n` for multi-line node labels.
- Keep edges to one verb each. Stack multiple edges instead of compressing.

## Style + behavior contract

The HTML uses these CSS classes — the hook checks for them:

| Class | Purpose |
|---|---|
| `nav.sidebar` | left nav |
| `section.page` / `.page.active` | one page per area, JS-toggled |
| `pre.mermaid` | every diagram |
| `.proposal` | proposal card |
| `.badge.cheap` / `.badge.medium` / `.badge.heavy` | cost indicator |
| `.tradeoffs` | grid wrapper for `<h5>pros</h5>` / `<h5>cons</h5>` |
| `.callout` | optional yellow note |
| `.problem` / `.proposals` | wrapper sections that visually separate diagnostic content from solution content (red-tinted vs green-tinted) |
| `.swatch.bad` / `.swatch.warn` / `.swatch.good` | colored chip linking a smell row to its diagram node |
| `tr.bad` / `tr.warn` / `tr.good` | smell-table row class matching its swatch |
| `.legend` | one per doc; explains the swatch colors |
| `td.pid` | first cell of each smell-table row; carries the stable problem ID |
| `.closes` | paragraph in each proposal listing the problem IDs it closes |

Use the canonical template at `template.html` in this skill's folder as the starting point. Don't invent new class names — the hook will reject the doc.

## Visual linking rule (smell tables)

A "smell table" is any `<table>` whose header row contains a column named `Smell`. Whenever a Problem section pairs a Mermaid diagram with a smell table, the diagram and the table MUST be color-linked:

1. Each smell-table body row carries `class="bad|warn|good"` matching the severity.
2. The first cell of that row contains `<span class="swatch bad|warn|good">` of the same severity, so the reader sees a colored chip next to the row identifier.
3. The Mermaid diagram colors the matching node(s) with `classDef` and `class`:
   ```
   classDef bad fill:#f5c2c7,stroke:#842029,color:#000
   classDef warn fill:#ffeeba,stroke:#856404,color:#000
   classDef good fill:#cfe8d6,stroke:#0f5132,color:#000
   class NodeA,NodeB bad
   ```
4. The doc contains exactly ONE `<div class="legend">` (place it on the Overview page) explaining the three swatch colors. Without the legend the colors are mystery semaphore.

The hook enforces 1, 2, and 4. Step 3 (mermaid `classDef`) is not text-grep enforceable — manually verify when iterating.

Severity guide:
- `bad` (red) — broken, silent failure, data loss, user can't recover.
- `warn` (amber) — leaky, race window, brittle, masked.
- `good` (green) — used in Proposal diagrams to highlight what's now safe.

## Problem IDs and `Closes:` references

PID conventions differ between the HTML survey and the Markdown ADR:

### Markdown ADR — `<REPO_PREFIX>-<issue>` is the PID

Each ADR corresponds to one GitHub issue. The PID is the YouTrack-style alias `<REPO_PREFIX>-<issue_number>` (e.g. `TRAY-42`, `LIGHTS-7`), where the repo→prefix mapping is in `lib/prefixes.json`. Because each ADR is exactly one problem, smell rows within an ADR get sub-IDs of the form `<PID>.N`:

```markdown
| ID | State | Smell |
|----|-------|-------|
| TRAY-42.1 | 🔴 Broken | data loss when X |
| TRAY-42.2 | 🟡 Leaky  | race window when Y |
```

Proposal `Closes:` lines reference the same sub-IDs:

```markdown
**Closes:** TRAY-42.1, TRAY-42.2
```

### HTML survey — `<AREA>-N` is the PID (legacy / per-page)

The HTML survey predates the ADR convention. Each area page uses `AREA-N` (`BOOT-1`, `PATH-3`) where `AREA` is an uppercase short prefix per page and `N` is monotonic within that page. IDs never renumber on reorder — append only. When a survey row is promoted to its own GitHub issue, the survey row gets annotated with the resulting PID (e.g. `BOOT-1 → TRAY-42`) and the ADR for `TRAY-42` becomes the canonical document.

This dual convention follows the per-prefix-plus-number address space used by AWS Well-Architected (`PERF-01`), NIST 800-53 (`AC-2`), OWASP Top 10 (`A01`), IETF (`REQ-1`), JIRA/Linear (`BOOT-12`), and ATT&CK techniques (`T1078.001`).

### What the hook enforces

For HTML survey docs (`*pathways*.html`):
- Every smell-table body row has `<td class="pid">[A-Z][A-Z0-9_]*-\d+</td>` as its first cell.
- Every proposal has a `<p class="closes">` element.
- Every PID referenced in `Closes:` exists as a smell-table row PID **in the same section**.

For markdown ADRs (`docs/adr/*.md`) — see `bin/check-pathway-md.cjs`:
- Filename matches `<PID>-<slug>.md` where `<PID>` is `<REPO_PREFIX>-<N>`.
- Body has `## Problem` and `## Proposals` sections.
- Smell-table rows use `<PID>.N` sub-IDs.
- Each proposal has a `**Closes:**` line referencing only sub-IDs declared in the same ADR.

## Workflow

### Survey phase (HTML)

1. Gather facts (Explore agent) — current code state per area.
2. Add industry-standard patterns from your own knowledge per area.
3. Draft the HTML using `template.html`.
4. Render in a browser (`xdg-open /tmp/<project>-pathways.html`).
5. Iterate per page. The user reads ONE page at a time; never dump all of them in chat.
6. Once the survey is agreed, each problem becomes a candidate PR.

### Promote-to-PR phase (Markdown ADR + GitHub)

7. For each problem the user wants to act on, run `bin/pid-new <repo> "<Title>"` (or invoke the wider promote pipeline). This:
   - Creates a GitHub issue → captures the issue number `N`.
   - Computes `PID = <REPO_PREFIX>-N` (via `lib/pid.cjs`).
   - Mints `<repo>/docs/adr/<PID>-<slug>.md` from `template.adr.md`, pre-populated with the survey row text.
   - Creates branch `<prefix>-<N>-<slug>` linked to the issue (`gh issue develop`).
   - Adds a worktree at `<workspace>/worktrees/<repo>/<prefix>-<N>-<slug>`.
   - Opens a draft PR titled `<PID> <Title>` whose body is short and links to the ADR.
8. Edit the ADR inside the worktree until proposals + tradeoffs are settled.
9. Implement the chosen proposal in commits on the branch.
10. Merge the PR — a PostToolUse hook removes the worktree. The ADR stays in `docs/adr/` as the permanent decision record.

## Determinism guard

A PreToolUse hook in this plugin (`bin/check-pathway-doc.cjs`) blocks Writes/Edits to any `*pathways*.html` file that:

- Lacks `<nav class="sidebar">`.
- Has a non-overview/non-cross `<section class="page">` missing `<h3>Problem</h3>` or `<h3>Proposals</h3>`.
- Contains a `<div class="proposal">` without all of: a `<pre class="mermaid">`, a `<div class="tradeoffs">` with both `pros` and `cons`, and a `.badge` of class `cheap`/`medium`/`heavy`.
- Contains a smell table (any `<table>` with a `<th>Smell</th>` column) where any body row is missing `class="bad|warn|good"`, a `<span class="swatch bad|warn|good">` matching the row class, or a `<td class="pid">AREA-N</td>` first cell.
- Contains any smell table but lacks a `<div class="legend">` somewhere in the doc.
- Contains a proposal without a `<p class="closes">` line, or whose `Closes:` references a PID not present in the same section's smell tables.

Bypass for one-off exceptions (e.g. partial drafts):

```
touch .claude/bypass-arch-pathways          # next 1 edit passes
echo N > .claude/bypass-arch-pathways       # next N edits pass
```

## Anti-patterns

- Multiple HTML files per project — one canonical survey per project.
- Embedding the design analysis in the PR body instead of an ADR file. The PR body links to `docs/adr/<PID>-<slug>.md`; the analysis lives in the repo so it survives merge and stays greppable.
- Diagrams in the Proposal that don't share visual vocabulary with the Problem (e.g. Problem is a sequence diagram, Proposal is a table). Mismatched mediums break comparison.
- Proposals without tradeoffs — every option must declare what it gives up.
- "Just do it" proposals without a cost badge.
- Long prose in tradeoffs cells — keep each cell to one sentence.
- Inventing a new repo prefix without adding it to `lib/prefixes.json`. Every PID must round-trip through the central parser.
- Renaming `lib/prefixes.json` mappings after PIDs already exist — old branches/PRs/ADRs would silently mis-resolve. Append new repos; never rename.
