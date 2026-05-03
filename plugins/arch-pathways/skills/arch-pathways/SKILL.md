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

## Output shape

ONE self-contained HTML file at `/tmp/<project>-pathways.html` (or repo `docs/` if the user wants it tracked). It is a sidebar-SPA: left nav links, right content pane swaps via `display:none/block` on hash change. No build step. Mermaid loaded from CDN.

The user MUST be able to open it in any browser without an extension, and refresh-iterate without rebuilding anything.

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
| `.swatch.bad` / `.swatch.warn` / `.swatch.good` | colored chip linking a smell row to its diagram node |
| `tr.bad` / `tr.warn` / `tr.good` | smell-table row class matching its swatch |
| `.legend` | one per doc; explains the swatch colors |

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

## Workflow

1. Gather facts (Explore agent) — current code state per area.
2. Add industry-standard patterns from your own knowledge per area.
3. Draft the HTML using the template.
4. Render in a browser (`xdg-open /tmp/<project>-pathways.html`).
5. Iterate per page. The user reads ONE page at a time; never dump all of them in chat.
6. After each page is agreed, the proposals on that page become the brief for downstream agents.

## Determinism guard

A PreToolUse hook in this plugin (`bin/check-pathway-doc.cjs`) blocks Writes/Edits to any `*pathways*.html` file that:

- Lacks `<nav class="sidebar">`.
- Has a non-overview/non-cross `<section class="page">` missing `<h3>Problem</h3>` or `<h3>Proposals</h3>`.
- Contains a `<div class="proposal">` without all of: a `<pre class="mermaid">`, a `<div class="tradeoffs">` with both `pros` and `cons`, and a `.badge` of class `cheap`/`medium`/`heavy`.
- Contains a smell table (any `<table>` with a `<th>Smell</th>` column) where any body row is missing `class="bad|warn|good"` or a `<span class="swatch bad|warn|good">` matching the row class.
- Contains any smell table but lacks a `<div class="legend">` somewhere in the doc.

Bypass for one-off exceptions (e.g. partial drafts):

```
touch .claude/bypass-arch-pathways          # next 1 edit passes
echo N > .claude/bypass-arch-pathways       # next N edits pass
```

## Anti-patterns

- Multiple HTML files per project — one canonical doc per project.
- Diagrams in the Proposal that don't share visual vocabulary with the Problem (e.g. Problem is a sequence diagram, Proposal is a table). Mismatched mediums break comparison.
- Proposals without tradeoffs — every option must declare what it gives up.
- "Just do it" proposals without a cost badge.
- Long prose in tradeoffs cells — keep each cell to one sentence.
