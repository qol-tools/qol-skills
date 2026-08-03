---
name: coding-general
description: Use when writing or reviewing any code in this workspace, regardless of language. Universal coding guidelines and the default response-brevity contract for every agent in qol-skills.
---

# General Coding Guidelines

The qol-monorepo carries no `CLAUDE.md` or `AGENTS.md`; the repository stays
code. Every rule that used to live in those files now lives in a skill here, so
that agents other than Claude Code get them too. Unconditional delivery rules
are injected by hook: `qol-workflow:qol-monorepo-rules`.

Rust type-safety rules (newtypes, unrepresentable states, exhaustive matching)
live in `qol-langs:rust-conventions`. Artifact identity lives in
`qol-project:qol-artifact-identity`.

## Response Style

See `writing` skill (KMRH47 personal style). It owns concision rules, banned words, em-dash ban, and the end-of-turn word cap.

## Implementation Questionnaire (Mandatory)

Before writing ANY implementation code, ask the user these questions:

1. **Does this pattern already exist?** Search the codebase for existing components, hooks, or utilities that do the same thing. If something similar exists, extend it — do not create a parallel system.
2. **Will this introduce boilerplate?** If the implementation requires every consumer to repeat the same setup (attributes, state, event handlers, wrapper markup), it is NOT a component — it is a template. Abstract it into a real component first.
3. **Is the design identical to existing pages?** If a new page or section uses tabs, forms, status indicators, or any existing UI pattern, it MUST use the same shared component. Ask: "Should this look and behave identically to [existing page]?"
4. **Does keyboard navigation work automatically?** Any new interactive element must work with the global surface navigation system (`data-selected-surface`). If the answer is "I need to add keyboard handling," the architecture is wrong — it should be automatic.

If uncertain about any answer, ASK the user before implementing. Do not guess.

## Code Style

- No comments — code must be self-explanatory. This is a hard rule, not a default.
  - No banner comments, no section dividers (`// --- xxx ---`), no docstrings, no "what this does" narration, no rationale paragraphs above functions, no inline "why we picked this constant" notes.
  - When an explanation is genuinely needed (non-obvious WHY, hidden invariant, theme-token sync risk, etc.), write it in the relevant qol-skills SKILL.md, not in code. The skill is the authoritative reference; code stays terse.
  - If a comment already exists and the surrounding code changes, treat the comment as suspect. Either delete it or move its content into the matching skill.
  - The fix for "this code is unclear" is renaming, splitting, or simplifying — never adding a comment.
- Library / framework / API docs: always consult context7 for the latest reference (resolve-library-id then query-docs) instead of relying on training data, which drifts.
- No emojis unless explicitly requested
- Early-return, flatten if statements — max depth is one scope
- **Control flow**: never use `else` — use early returns and guard clauses
- **Value expressions**: `if/else` as ternary is acceptable (Rust has no ternary operator). Do NOT use `match bool { true =>, false => }` for simple binary conditions.
- Prefer declarative and functional patterns over imperative control flow
- Delegate logic to functions to keep scopes shallow and readable
- No dead code — remove unused code or gate with feature flags
- No inline SVGs — SVG markup is opaque noise. Extract into dedicated asset files (e.g., `ui/assets/icon-cog.js`). Components should reference icons by name, not embed raw path data.
- Warning-free baseline — new changes must not introduce warnings

## Single Responsibility

- Describe without AND — if you need "and" to describe a function, split it
- Extract by abstraction level — orchestration shouldn't contain low-level details
- Input → Transform → Output — functions should be one of: gather input, transform data, produce output. Don't mix I/O with business logic.
- Command/Query separation — functions either change state OR return data, not both
- One concern per function — don't mix state management, navigation, and action dispatch

## Deep Modules Philosophy (Ousterhout)

- Deep modules over shallow - hide complexity behind simple, clean APIs. A function should do meaningful work, not just delegate.
- Max 50 lines per function (matches workspace `CLAUDE.md`) - split beyond this only if it creates a genuinely reusable abstraction. The hard rule is "do one thing", not a line count.
- No shallow files (10-30 lines) - think about where the code belongs and colocate with related logic
- No deep files (200+ lines) unless it's a library/utility with a cohesive purpose - split by concern otherwise
- Nesting is acceptable — for+if, match in loop, early returns are fine. Extract helpers only when it genuinely clarifies intent or creates reusable logic.
- Avoid shallow extractions — don't create single-use helpers where inline is equally clear. Three similar lines is better than a premature abstraction.
- Never over-split — a single-use function referenced once that just wraps 3-5 lines adds indirection without value. Inline it. Splitting should reduce complexity, not scatter it.
- Clean interfaces — public APIs should be obvious and hard to misuse. Internal complexity is fine if the interface is clean.

## Abstraction-First Architecture (Mandatory)

- Every module/layer must be replaceable through an explicit interface boundary
- New features: plug into existing abstraction seam; if none exists, create/refactor seam first
- Avoid direct coupling across concerns (UI, domain logic, data access, platform)
- Keep platform-specific behavior behind adapters/providers
- Core logic must be testable with in-memory inputs without platform/runtime deps
- Verify: introducing a new implementation should only require wiring changes, not core rewrites

## Architectural Judgment

- Architecture is change management, not file management. Optimize for the most likely future changes, not for the prettiest local extraction.
- Separate by axis of change, not by sentence structure. The right split is where code will evolve independently: domain rules, transport/protocol, storage, platform, rendering, orchestration.
- A boundary must buy something concrete: replaceability, independent testing, lower cognitive load, or isolation of unstable details. If it buys none of those, it is probably fake structure.
- Do not confuse indirection with decoupling. A single-use wrapper, pass-through component, or helper that just forwards arguments is usually not an abstraction.
- Prefer deep modules with sharp interfaces over many shallow seams. Hide real complexity behind small surfaces; do not export the complexity graph to the caller.
- Treat every new boundary as a long-term maintenance cost. Every interface adds naming burden, navigation overhead, drift risk, and one more place for concepts to split apart.
- Extract only at stable seams. Good seams usually sit around platform-specific behavior, I/O, persistence, protocols, shared domain rules, or expensive side effects. Bad seams usually mirror the current call stack.
- Orchestrators may stay broad if they own one cohesive job. Do not gut an orchestrator into fragments just because it has several branches. Split when branches represent different reasons to change, not just different cases.
- Do not push every rendering case into a central renderer either. If a module is becoming a dumping ground for unrelated field kinds or widget behavior, move cohesive clusters out.
- Shared logic should be shared at the deepest common level. If two UIs share rules but not rendering, extract the rules, not a fake shared renderer.
- Prefer deleting seams over moving seams around. The best refactor often makes a whole wrapper, component, or file disappear.
- Optimize for reversibility. Avoid abstractions that force callers to pass half the implementation back in, or that require hidden mutable side channels to work.

## Architectural Review Heuristics

- Ask "what would change this code?" If two pieces would change for different reasons, separate them. If they always change together, keep them together.
- Ask "would a second implementation naturally plug in here?" If not, an interface boundary may be premature theater.
- Ask "does this helper remove complexity from the reader, or just move it?" If the answer is "move it," inline it.
- Ask "is this module cohesive enough to describe without 'and'?" If the "and" reflects closely related variants of one job, that is fine. If it reflects separate concerns, split it.
- Ask "does this extraction make future deletion easier?" If not, it may be architecture that only grows.
- Be suspicious of single-use helpers that only:
  - wrap one call
  - translate names without changing meaning
  - bounce props/state through another layer
  - exist only to keep a line count down
- Be suspicious of abstractions that require:
  - injected callbacks for core behavior
  - hidden mutable fields on context/state objects
  - static function properties on components
  - duplicated decision logic across two renderers or flows
- Accept small local duplication when it preserves a cleaner architecture. Do not centralize code if doing so creates a worse ownership boundary.
- Prefer one obvious place for business rules. Duplication of rules is usually worse than duplication of presentation.
- When unsure, bias toward the shape that keeps the system understandable to a new engineer six months later.

## Frontend Architecture

- Functional and declarative — pure render functions, no imperative DOM manipulation
- Data-driven — UI derived from state, not manually synchronized
- Single responsibility — split logical chunks into focused modules
- Separate domain rules from rendering, but do not explode every control or branch into tiny wrapper components
- Renderer-specific code may stay together when it forms one readable surface; share pure rules/models across surfaces before trying to share UI machinery
- Avoid hidden UI contracts such as mutable statics, DOM-global side channels, or context bags with renderer-private scratch fields
- Scalability — design for N items, not hardcoded assumptions
- Keyboard-first — all interactions via keyboard first, mouse/hover secondary
- Reuse existing CSS tokens and component classes before creating new styles
- Prefer style variants (modifier classes) over new visual systems
- Keep control placement consistent with existing layout grammar

## Component Integration Requirements

Every interactive UI component MUST:
- Be navigable via keyboard (Tab, arrows, Enter, Escape)
- Integrate with the host app's selection/focus system (e.g., qol-tray's wedge selection)
- Live inside the framework's render tree — never use DOM bridges for interactive elements
- Own its structural CSS (layout, spacing) — consumers provide only theme tokens

**Never use imperative DOM rendering (createElement, appendChild) for interactive components in a framework app.** If a shared library provides DOM-based renderers, rewrite them as native framework components before integrating. DOM bridges bypass the framework's focus management, state tracking, and accessibility systems.

**Shared config UI components** (qol-config renderers) must be framework-agnostic at the data/logic layer but rendered as native components in each consumer framework. The pattern: shared logic module (pure functions) + per-framework component that calls the logic.

## Git Commits

See `qol-workflow:commit` (commit message conventions, no co-authors, atomic-commit rules), `qol-workflow:git-trees` (worktree-only flow + trivial-changes carve-out), and `qol-workflow:git-push` (pull-rebase-push contract). Don't restate those rules here.

## Testing

See `qol-tray:qol-apps-testing` (property tests, parameterized tables, modern toolkit: `insta` / `proptest` regressions / `cargo-mutants` / `rstest`). Don't restate test selection rules here.

## Performance: idle cost is a feature

Background work must be free-when-idle, not just cheap. Event-driven by default; never `try_recv + sleep`. The Rust-specific patterns (crossbeam `select!`, tokio `select!`, signalfd, etc.) live in `qol-langs:rust-conventions` under "Idle cost is a feature". Apply the same principle in any language.

## No band-aids in hot paths

When something runs in a frequent path (shell `chpwd` hook, render frame, keystroke handler, supervisor tick, daemon poll) and it stalls, the right fix is to **remove the slow work from the hot path** — not to add a timeout, retry, fallback, or abort.

A timeout that "bounds" a stall is hiding an architectural mistake. The slow call doesn't belong in the hot path at all.

### Concrete pattern (qol-cicd activate.sh, 2026-05-06)

The zsh `chpwd` hook called `gh auth token --user <name>` to scope `GH_TOKEN` per directory. On macOS, `gh`'s Keychain lookup can stall behind a Touch ID prompt, freezing every terminal. An 800 ms hard timeout was added (`_qol_gh_fetch_token` with background+sleep+kill). It "papered over short stalls; long ones still surfaced as missing GH_TOKEN with no signal."

The structural fix (commit `1c22f5f`) ripped `gh` out of the hook entirely:

- `qol-gh-account set <user>` resolves the token via `gh` once, at configure time.
- The token is written to `~/.config/qol-tools/gh-token` (mode 0600).
- The `chpwd` hook becomes `IFS= read -r tok < $cfg` — a pure file read.
- `qol-gh-account refresh` regenerates the token file when the gh token rotates.

Tests were rewritten to assert the new contract: *"the hook never invokes `gh`, regardless of pwd state, config presence, or symlink resolution."* Pin down the new invariant; don't retest the old path.

### Before adding a timeout, ask

- Why is this call here at all? Can the work move to a one-shot configure step that writes a file the hot path reads?
- Is the input genuinely dynamic, or could it be cached at startup / registration time?
- If the call must stay, can the result of a previous successful call be re-used while the next one is in flight (lazy refresh)?

### Shell-specific trap: zsh `chpwd` recurses through subshells

`chpwd` fires in subshells too. `qol_root=$(cd "$x" && pwd -P)` inside the hook recurses exponentially — 200 cd events took >18 s in one repro (commit `b6619d2`). After fix: 35 ms.

In a zsh `chpwd` hook:

- **No** `$(...)` command substitutions.
- **No** `(...)` subshells.
- **No** `cd ...` chains.
- Use parameter expansion (`${PWD:A}`, `${var:A}`) and builtins.
- Resolve once at sourcing where you can subshell freely (the hook isn't registered yet); cache.

### Measure before you "fix"

Both fixes above included a concrete metric (`200 cd events: 18 s → 35 ms`). Without the measurement the bug looked like a flap. Whenever you suspect a hot path is the problem, get a number first, then change the code.

## Do NOT

- Push unless explicitly asked
- Skip hooks (--no-verify) or bypass signing
- Repeat boilerplate — if two files have the same structural markup, extract a shared component
- Create parallel systems — if an existing component does something similar, extend it
- Implement without asking — when the user describes a UI/UX requirement, ask clarifying questions about scope, reuse, and design consistency BEFORE writing code
- Hardcode per-view logic for things that should be global (keyboard nav, surface system, tab management)
- Remove or hide UI elements when asked to fix them — "misplaced" or "not navigable" means fix placement/navigation, not delete. If genuinely unsure whether something should exist, ask.
