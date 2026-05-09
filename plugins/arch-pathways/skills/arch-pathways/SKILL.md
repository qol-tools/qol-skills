---
name: arch-pathways
description: >
  Architecture-analysis pipeline for GIGANTIC, retrospect-worthy tasks ONLY. Never the default for "we found a bug" or "this needs a small fix" - those go straight to a worktree+PR (or commit-direct if trivial), no issue. (1) SINGLE-ISSUE PING-PONG: only when the user explicitly asks to "open an issue", "track this as an issue", "investigate as an issue", "iterate on this in an issue", or names a multi-week initiative worth retrospecting on. Mints a GitHub Issue, iterates via comments through research / user-test / agent-test loop with Mermaid charts, then dispatches kickoff to add branch + worktree + seeded ADR + draft PR. (2) CROSS-AREA SURVEY: produce a single-file HTML pathways doc when the user asks to "visualize architecture", "compare fix proposals", "map current state vs target", "draw pathways", or any deep-dive spanning 3+ subsystems. (3) DIRECT KICKOFF: rare one-shot path for tightly-scoped mechanical fixes that the user asks to "kickoff" by PID.
when_to_use: ONLY when the user explicitly asks for an issue, a survey, a kickoff by PID, an ADR, or a pathways doc. Do NOT trigger on "we found a bug", "let's fix this", "we should investigate", or any phrasing where the user has not explicitly asked for the artifact. The default for ad-hoc bugs is fix-now-direct-or-PR, not an issue.
---

# Architecture pathways skill

## When NOT to use this skill (read first)

This skill is **only for gigantic, retrospect-worthy tasks** that genuinely benefit from a long-lived issue thread, an HTML survey, or an ADR. The qol-tools workspace is solo - there is no async team to coordinate via issues. An issue here is a doc the user will skim once and never reread.

**Do NOT mint an issue / ADR / draft when:**

- The user found a bug and is deciding whether to fix it. The choice is **fix-now vs don't-fix**, not "fix vs file an issue". Issues are not a polite "later" deferral.
- The work fits in one PR (most fixes, refactors, features). Use `qol-workflow:git-trees` worktree+PR flow.
- The change is trivial (config, tests-only, doc tweak). Commit direct to `main`. See workspace `CLAUDE.md` "PR ceremony".
- You want to "capture findings for later". The right home is a skill update or `CLAUDE.md` note, not an issue. See `qol-workflow:standards-evolution`.

**Mint an issue ONLY when:**

- The user explicitly says "open an issue", "track this as an issue", "investigate this as an issue", or similar.
- The task is gigantic enough that the iterative research / user-test / agent-test loop with Mermaid charts is genuinely useful AND the user will retrospect on the issue thread later.
- Multi-week or multi-PR initiatives where the issue acts as the index across PRs.

If you are about to volunteer "or open an issue / ADR" as a fallback option in a `Want me to fix or X?` prompt - **drop the X**. Default to fix-now-or-not-now.

## Glossary (canonical vocabulary — refer to this when in doubt)

### The thing we track

| Term | Definition | Example |
|---|---|---|
| **Problem** | A real-world thing that needs work — bug, feature, refactor target. | "Daemon supervisor crashes on cold boot" |
| **PID** | Problem ID. Format: `<REPO_PREFIX>-<N>` where `N` is the GitHub Issue number. The address every artifact shares. | `TRAY-42` |
| **Sub-ID** | Address for one *smell row* within an ADR. Format: `<PID>.<M>`. | `TRAY-42.1` |

### The artifacts (one per problem, except survey)

| Artifact | Lives at | Role | Carries diagrams? |
|---|---|---|---|
| **Issue** | github.com/.../issues/N | The story. Where humans first land. Body has the problem statement + first diagram. | ✅ |
| **ADR** | `<feature_dir>/docs/adr/<PID>-<slug>.md` (default) or `<repo>/docs/adr/<PID>-<slug>.md` (cross-cutting) | Decision record (problem + proposals + tradeoffs). Lives forever, never deleted. | ✅ |
| **PR** | github.com/.../pull/M | Implementation. Body is short, links to Issue + ADR. PR diff includes the seeded ADR file. | ❌ (in body) ✅ (in committed ADR file) |
| **Survey** | `/tmp/<proj>-pathways.html` (or `<repo>/docs/pathways.html` if tracked) | Workspace-level cross-area overview. Workshop artifact. | ✅ |
| **Branch** | git ref `<prefix-lowercase>-<N>-<slug>` | The dev line. | n/a |
| **Worktree** | `<workspace>/worktrees/<repo>/<branch>` | Isolated checkout for the branch. | n/a |

### Naming rules (deterministic, parseable via `lib/pid.cjs`)

| Field | Format | Example |
|---|---|---|
| Repo | as listed in `lib/prefixes.json` keys | `qol-tray` |
| Repo prefix | uppercase, no separators, in `lib/prefixes.json` values | `TRAY` |
| Title | Title Case, spaces, no punctuation other than `-` | `Fix Auth Race In Startup` |
| Slug | lowercase kebab, ASCII-only, no leading/trailing/double dashes | `fix-auth-race-in-startup` |
| Branch | `<prefix-lowercase>-<N>-<slug>` | `tray-42-fix-auth-race-in-startup` |
| PR title | `<PID> <Title>` | `TRAY-42 Fix Auth Race In Startup` |
| ADR filename | `<PID>-<slug>.md` | `TRAY-42-fix-auth-race-in-startup.md` |
| Worktree path | `<workspace>/worktrees/<repo>/<branch>` | `qol-tools/worktrees/qol-tray/tray-42-fix-auth-race-in-startup` |

All transformations are 1:1 and round-trip via `lib/pid.cjs`.

### ADR placement rule

| Scope | Path | When to use |
|---|---|---|
| Feature-scoped (default) | `<feature_dir>/docs/adr/<PID>-<slug>.md` | Problem belongs to one identifiable feature folder |
| Cross-cutting | `<repo>/docs/adr/<PID>-<slug>.md` | Problem touches many features (e.g. dependency swap, repo-wide convention change) |

A "feature folder" is any direct subdirectory of `<repo>/src/` that owns cohesive responsibility (e.g. `src/sync/`, `src/features/profile/`, `src/daemon/supervisor/`). When in doubt: feature-scoped is the default; only fall back to repo-root for genuinely repo-wide decisions.

### Survey-only terms

| Term | Definition | Example |
|---|---|---|
| **Area** | A `<section id="X">` in the survey HTML — one problem area before promotion. | `boot`, `paths`, `sync` |
| **Smell** | A row in an area's smell table. Becomes a sub-ID once promoted. | "blocks main thread" |
| **Proposal** | A `.proposal` card in an area or ADR — one option for fixing the problem. | "Move to background tokio task" |

### The relationship graph

```
        Survey                              (workspace level — many problems)
          │  promote area
          ▼
        Problem ────►  PID = TRAY-42        (the address)
          │
   ┌──────┼──────┐
   ▼      ▼      ▼
 Issue   ADR    PR
 #42     file   #77
   │      │      │
   └──────┼──────┘
       Branch
       Worktree
```

Issue body has the problem + diagram. ADR has the problem + proposals + tradeoffs (with the same diagram, plus more for proposed shapes). PR body links to both. ADR is committed in the PR's diff and lives in `<feature>/docs/adr/` forever.

## Audit on demand (find features missing ADRs)

When the user asks "what's undocumented?" / "show me unknown features" / "audit ADR coverage", run:

```bash
# List feature folders (depth 1-2 under src/) that have no docs/adr/ directory
find <repo>/src -mindepth 1 -maxdepth 2 -type d \
  -not -name target -not -name node_modules \
  | while read d; do
      [ -d "$d/docs/adr" ] && continue
      loc=$(find "$d" -type f \( -name '*.rs' -o -name '*.ts' -o -name '*.js' -o -name '*.py' \) -exec cat {} + 2>/dev/null | wc -l)
      last=$(git -C <repo> log -1 --format='%cr' -- "$d" 2>/dev/null)
      echo "$d | 0 ADRs | ${loc} LOC | last edited ${last}"
    done | sort -t'|' -k3 -n -r
```

Output: a list of feature folders ranked by LOC (a rough proxy for "how much undocumented surface area"). Re-sort by churn if useful: replace the sort with `git log --since='30 days ago' --pretty=format: --name-only` aggregation.

The user picks a high-priority entry and says *"backfill `<feature>`"* — the kickoff agent then runs in retrofit mode.

## When to use

Two flows; pick by problem shape.

**Single-issue ping-pong** — the default for most reported bugs and feature requests worth tracking. Use whenever the user wants iterative analysis with a paper trail before any implementation starts. Triggers: "let's investigate", "open an issue and iterate", "we should track this", "dig into this bug", any non-trivial reported problem.

**Cross-area survey** — workshop mode for problems touching 3+ subsystems where side-by-side comparison is the point. Use before any GitHub object exists. Triggers: "map architecture", "compare fix proposals across areas", "draw pathways", "I want to see all conflicts before we pick".

Do NOT use either for trivial single-file bugs or "just fix it" requests. The artifacts are heavy by design — for shared decision-making with a paper trail, not solo iteration.

**Specifically NOT for**: skill edits, hook tweaks, doc/typo fixes, README updates, or any change in the `qol-skills` marketplace where a wrong push can be reverted in under a minute. Those follow the simple-path workflow in `qol-skills/README.md`'s "Contributing" section: worktree, commit, `git push origin <branch>:main`. No issue, no PR.

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

Three paths. Pick by problem shape.

### 1. Single-issue ping-pong (default for ad-hoc problems)

The Issue IS the workshop. Create first, iterate with charts, then kickoff to add implementation artifacts. Two sub-modes; pick by user's review bandwidth.

#### 1a. Manual ping-pong (interactive)

Use when the user wants to drive the iteration personally — they read each comment as it lands and reply.

1. **Create the Issue.** `gh issue create -R qol-tools/<repo> --title "<Title Case>" --body-file <path>`. Body must include: short problem statement, repro steps, affected files (`<path>:<line>`), at least one Mermaid diagram of the current shape (renders natively in GitHub Issue bodies and comments). PID is `<REPO_PREFIX>-<N>` per `lib/prefixes.json` — note it down.
2. **Ping-pong loop.** The Issue is the canonical workspace. Each round = one comment via `gh issue comment <N> -R qol-tools/<repo> --body-file <path>`. Three role tags rotate freely until the problem statement is stable:
   - `### Research <N>` — agent posts code traces, additional hypotheses, alternate Mermaid diagrams, file:line references.
   - `### User test <N>` — user reports a real-world repro / verification on their machine; confirms, refutes, or extends the hypothesis.
   - `### Agent test <N>` — agent posts log search, code grep, theory-check (counter-example, dep-version comparison, etc.) without leaving Claude Code.
   Update the Issue *body* (not just comments) only when the canonical problem-of-record changes (clearer root cause, narrowed scope, added invariant). Charts in the body are the source of truth; charts in comments are working notes.
3. **Settle signal.** The user explicitly says one of: `kickoff <PID>`, `ship <PID>`, `promote <PID>`. That is the ONLY green-light to dispatch the kickoff agent. Do NOT dispatch kickoff while iteration is still active — even if you think the analysis is done.
4. **Kickoff.** Dispatch `arch-pathways:kickoff` with `<EXISTING-PID> <Title>\n\n<body>` (body = the final agreed problem statement + recommended proposal copied from the Issue). Kickoff runs `pid-new.cjs <repo> "<Title>" --issue <N>` → branch + worktree + seeded ADR + draft PR linked to the existing Issue.
5. **Implement.** Inside the worktree, finalize the ADR (proposals + tradeoffs + Closes:), commit the implementation against the branch, mark the PR ready, merge. PostToolUse hook removes the worktree. The ADR stays in `docs/adr/` permanently.

#### 1b. Auto-iterate (agents converge, user reviews only the result)

Use when the user signals review-bandwidth limits: "automated flow", "auto-iterate", "I can't keep up with this volume", "just dig and surface the result", "agents talk among themselves and tell me when ready". The dispatched agents iterate INTERNALLY (multiple research/test rounds within their own scope) and post **exactly one comment per issue** in the Ship-readiness format below — instead of N visible Research/Agent-test comments. The user reads only the TL;DR + [DECIDE] + Verified summary; the full body is collapsed inside `<details>` for audit.

Replaces step 2 of manual mode. Steps 1, 3, 4, 5 are unchanged.

**Ship-readiness comment format (mandatory; the hook checks for it):**

```markdown
### Ship-readiness assessment

**TL;DR.** <one or two sentences max — what's the situation, what's the recommendation>

**Confidence:** root cause <H|M|L> · proposed fix <H|M|L> · verification <H|M|L>

**Recommend:** ship | dig deeper | block

#### [DECIDE] questions for the user

- <decision the user must make>

#### Verified

- ✅ <claim> — <one-line evidence with file:line>

#### Unverified / risks

- ⚠️ <risk> — <one-line reason>

<details><summary>Full research notes (click to expand)</summary>

<deep technical body — Mermaid where it clarifies, code snippets, alternate hypotheses>

</details>
```

Hard rules for auto-iterate:
- Verified / Unverified / [DECIDE] sections must be **one-line each**. Body goes inside `<details>`.
- Each ship-readiness comment supersedes prior Research/Agent-test comments; no need to read those.
- Audio brief: after the comment lands, suggest `node ${CLAUDE_PLUGIN_ROOT}/bin/say-issue.cjs <repo> <N>` so the user can listen instead of read (operations table below).
- Settle signal is identical to manual mode (`kickoff <PID>` / `ship <PID>` / `promote <PID>`). Recommendation does NOT auto-trigger kickoff — the user is still the final decision-maker.
- **Compaction is mandatory** (see next subsection). Every Ship-readiness comment is followed by an Issue-body edit that folds verified findings INTO the body, so the next round reads the body instead of re-ingesting every prior comment.

#### Compaction (mandatory after every Ship-readiness comment)

**Why.** Without compaction, every research round adds 5–10 KB of dense findings as comments. Round N's agent has to re-read N-1 prior comments to reach the same understanding. Token cost grows linearly per round and stays expensive forever — even after questions are settled. Compaction makes the issue body the canonical "what we know now" so agents read body + latest comment only.

**The discipline.** The Issue body is the **current state**. Comments are the **history**. After every Ship-readiness comment lands, the agent runs:

```sh
gh issue view <N> -R <repo> --json body --jq .body > /tmp/old-body.md
# Edit /tmp/new-body.md by folding the latest comment's verified findings
# into the body, following the canonical body shape below.
gh issue edit <N> -R <repo> --body-file /tmp/new-body.md
```

**Canonical body shape after compaction.** Every issue body that has been through ≥1 round looks like this:

```markdown
## Problem
<unchanged unless root cause was clarified by research; rewrite if so>

## Constraints
<unchanged unless research surfaced a new constraint that's now load-bearing>

## Proposed solution
<the LATEST converged proposal — replace earlier versions, do not append>

## Verified facts
<every ✅ from prior Ship-readiness comments, deduplicated, one-line each>
- ✅ <fact> — <evidence: file:line or doc URL>

## Open questions
<every [DECIDE] not yet resolved by the user, plus every ⚠️ that's still unverified>
- [ ] <question or risk>

## Research log
<one line per Ship-readiness comment, in chronological order, linking to the comment URL>
- [Ship-readiness 1](#issuecomment-...) — <one-line summary>
- [Ship-readiness 2](#issuecomment-...) — <one-line summary>
```

**What goes WHERE during compaction:**

| In the latest Ship-readiness comment | Where it lands during compaction |
|---|---|
| New `✅ Verified` line | Append to body's `## Verified facts` (dedupe with prior facts) |
| New `[DECIDE]` question | Append to body's `## Open questions` (drop when user resolves it in a later round) |
| New `⚠️ Unverified / risk` | Append to `## Open questions` if still unverified; promote to `## Verified facts` once a later round verifies it |
| Refined proposal in the comment's body | REPLACE `## Proposed solution` (do not stack proposals) |
| New constraint surfaced | Append to `## Constraints` if load-bearing for the design |
| Everything else (raw research notes, alternate hypotheses, dead ends) | Stays in the comment under `<details>` — never folded into body |

**What NEVER goes into the body:**
- Raw research narrative — that's what the comment's `<details>` block is for.
- Refuted hypotheses — they live in their original comment as a record of "why we ruled this out", but don't pollute the canonical statement.
- TL;DR / Recommend / Confidence — those are per-round status, only in the comment.

**Compaction order of operations (every round):**

1. Agent posts the new Ship-readiness comment.
2. Agent fetches the current Issue body.
3. Agent merges in the new findings per the table above.
4. Agent edits the Issue body via `gh issue edit`.
5. Agent appends the new Ship-readiness comment URL to the body's `## Research log` section.

The merge MUST be additive for verified facts (don't lose history), replacement for the proposed solution (one canonical answer), and subtractive for open questions (drop ones that are now resolved).

**For the next round's agent reading the issue:**

> Read the Issue **body** for current state. Read **only the latest Ship-readiness comment** for the most-recent round's full reasoning. Do NOT walk the entire comment history unless explicitly asked to dig into how a specific decision was reached.

### 2. Cross-area survey → bulk promotion (workshop for 3+ problems)

Use when the problem set spans many subsystems and side-by-side comparison is the point.

1. Gather facts (Explore agent) — current code state per area.
2. Add industry-standard patterns from your own knowledge per area.
3. Draft `/tmp/<project>-pathways.html` from `template.html`.
4. Render in a browser (`xdg-open /tmp/<project>-pathways.html`).
5. Iterate per page. The user reads ONE page at a time; never dump all of them in chat.
6. Promote: `pathway-pr.cjs <area> <repo>` (full bundle: issue + worktree + ADR + draft PR seeded from the area) or `pid-mint.cjs <area> <repo>` (issue only) → continue with the ping-pong loop above before kickoff.

### 3. Direct kickoff (one-shot, no iteration)

Rare. Use only for tightly-scoped mechanical fixes with no research depth. Dispatch `arch-pathways:kickoff` with `<repo> "<Title>"\n\n<body>`; the agent runs `pid-new.cjs <repo> "<Title>"` and mints all five artifacts in one shot, no Issue iteration. If you find yourself wanting to iterate after kickoff, you should have used flow 1 instead.

## Operations — what to run for which intent

The user does NOT type bash. When you (the agent) recognize one of these intents, run the matching script via the Bash tool. Never narrate the script invocation as a question; just execute it. The scripts are self-contained Node CLIs at `${CLAUDE_PLUGIN_ROOT}/bin/`.

| User intent (paraphrased) | Run | Resolves |
|---|---|---|
| "open an issue for this bug so we can iterate" / "track this as an issue" / "let's investigate this on GitHub" (ad-hoc, not tied to a survey area) | `gh issue create -R qol-tools/<repo> --title "<Title Case>" --body-file <path>` (body = problem + repro + ≥1 Mermaid diagram) | creates one GitHub Issue for the ping-pong loop; no worktree/ADR/PR yet |
| "auto-iterate on `<PID>`" / "dig and tell me when ready" / "I can't review every comment, just give me the result" | dispatch a research subagent with the Ship-readiness comment format (manual mode 1b above); agent self-iterates 2-3 internal rounds and posts ONE converged comment **AND compacts the issue body per the Compaction subsection** | one ship-readiness comment per issue; body always reflects current state; user reads TL;DR + [DECIDE] + Verified only |
| "compact `<PID>`" / "fold the comments into the issue body" / "update the issue with what we know" | run the Compaction order of operations (auto-iterate sub-mode 1b > Compaction subsection): fetch body, merge in latest Ship-readiness findings, `gh issue edit <N> --body-file <path>` | issue body is now the canonical current state; comments stay as history; future research rounds read body + latest comment only |
| "say `<PID>`" / "read me the issue" / "audio brief for `<PID>`" | `node ${CLAUDE_PLUGIN_ROOT}/bin/say-issue.cjs <repo> <N>` | extracts TL;DR from the latest ship-readiness comment + issue title and pipes through macOS `say` (or `--out <path>.aiff` for a saved file) |
| "post a research / user-test / agent-test note on `<PID>`" / "comment on the issue" | `gh issue comment <N> -R qol-tools/<repo> --body-file <path>` | adds one ping-pong round to the Issue thread; tag the body with `### Research N`, `### User test N`, or `### Agent test N` |
| "update the issue body for `<PID>`" (canonical problem-of-record changed) | `gh issue edit <N> -R qol-tools/<repo> --body-file <path>` | replaces the Issue body — use only when the root cause / scope shifts, not for working notes |
| "kickoff `<PID>`" / "ship `<PID>`" / "promote `<PID>` to a PR" (Issue already exists) | dispatch `arch-pathways:kickoff` with `<PID> <Title>\n\n<body>` | runs `pid-new.cjs <repo> "<Title>" --issue <N>` → branch + worktree + seeded ADR + draft PR linked to the existing Issue |
| "promote `<area>` to a PR" / "open PR for `<area>` in `<repo>`" / "turn `<area>` into a PR" (survey-area path) | `node ${CLAUDE_PLUGIN_ROOT}/bin/pathway-pr.cjs <area> <repo>` | mint issue + worktree + ADR + draft PR seeded from the survey area |
| Same intent but the user wants to preview first / says "dry run" / "what would this do" | append `--dry-run` to the command above | prints planned PID, branch, worktree, PR title; no GitHub side effects |
| "extract `<area>` as markdown" / "show me `<area>` as an ADR" / "give me the markdown for `<area>`" | `node ${CLAUDE_PLUGIN_ROOT}/bin/pathway-extract.cjs <area> [--pid <PID>]` | prints the markdown ADR for that area; read-only, no GitHub calls |
| "mint an issue for `<area>` in `<repo>`" / "create the GitHub issue for this area" (survey-area path) | `node ${CLAUDE_PLUGIN_ROOT}/bin/pid-mint.cjs <area> <repo>` | creates one GitHub issue, prints the resulting PID — then continue with the ping-pong loop |
| "open a PR for this problem: <Title>" (NOT tied to a survey area, mechanical fix only — direct kickoff path) | `node ${CLAUDE_PLUGIN_ROOT}/bin/pid-new.cjs <repo> "<Title>"` | mint issue + worktree + ADR (from blank template) + draft PR; skips the ping-pong loop — use only for trivial mechanical fixes |
| "set up the GitHub branch-name ruleset for `<owner/repo>`" | `bash ${CLAUDE_PLUGIN_ROOT}/bin/setup-rulesets.sh <owner/repo>` | creates the server-side ruleset (asks the user before running — this mutates GitHub) |

### Resolving the area name

Areas are the `id` attributes on `<section class="page" id="...">` in the HTML survey. Default survey path is `/tmp/qol-tray-pathways.html`. To list areas without picking, just `grep -oE 'id="[a-z-]+"' /tmp/qol-tray-pathways.html | sort -u`. Skip `overview` and `cross` — they aren't promotable.

If the user names a problem ambiguously ("the boot stuff", "the path mess"), match against the survey's `<h2>` titles to find the area id, then proceed.

### Resolving the repo name

Repos must be in `${CLAUDE_PLUGIN_ROOT}/lib/prefixes.json`. If the user says a colloquial name ("tray", "lights"), map to the canonical repo: `qol-tray`, `plugin-lights`, etc. If unsure, read `lib/prefixes.json` and ask only when there are multiple plausible matches.

### Confirmation policy

`pathway-pr`, `pid-new`, `pid-mint`, and direct `gh issue create` / `gh issue edit` / `gh issue comment` all mutate GitHub. Default to **show the body first** (cat the body file you'd send) and confirm before invoking, UNLESS the user already said something explicitly committal like "do it", "post it", "open it for real", or "no dry run".

For `pathway-pr` and `pid-new`, also default to **`--dry-run` first** to surface the planned PID/branch/worktree/PR title.

`pathway-extract`, `--dry-run` invocations, and `gh issue view` are side-effect-free and can be run without asking.

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
