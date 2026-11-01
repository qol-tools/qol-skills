# Sources

The procedure combines rules from published review skills, AI reviewer prompts, human review guides and accuracy benchmarks.
This file says where each rule comes from, so a rule can be checked against its source or dropped when the evidence changes.
Figures are what each source reported when it was read in October 2026; most are self-reported by the team that built the reviewer.

## Evidence

| Rule in this skill | Evidence |
|---|---|
| Several decorrelated passes per lens at deep and max, merged. | SWR-Bench (arXiv 2509.01494) raised F1 from 15.25 to 20.48 by merging five runs, with gains flattening after five, and Cursor Bugbot runs eight passes over reordered diffs and merges them. |
| A separate verifier that drops a finding only with a cited refutation. | Kodus reported that a verifier treating uncertainty as evidence against a finding discarded real bugs, and that allowing a discard only with a concrete refutation roughly doubled delivered recall. |
| Every finding carries a trigger, a path and observed against expected behavior. | Anthropic ties a rise in substantive review comments to making agents prove each finding; the Codex rubric makes each comment state its trigger. |
| Style and taste are off by default. | Uber's uReview dropped readability, logging and minor performance comments after users rated them poorly. |
| Depth scales with risk instead of running on every diff. | DoorDash reported a scout plus deep reviewer at about five times the cost of a single pass, for a large gain in recall. |
| Intent is written before any finder starts. | ContextCRBench (arXiv 2511.07017) found the pull request description or linked issue helps review more than extra code context. |
| No raw static-analysis output in lane prompts. | SWR-Bench measured a lower F1 with static-analysis output in the prompt than without it. |

## Skills and prompts

| Source | What this skill takes from it |
|---|---|
| [trailofbits/skills](https://github.com/trailofbits/skills): differential-review, fp-check | Risk-tiered triage with refactors as high risk, a counted blast radius, blame on removed lines and the list of rationalizations to refuse. |
| trailofbits/skills: audit-context-building | The ledger of assumptions nothing enforces; a claim without a line reference becomes a question; conflicting records quoted side by side. |
| [anthropics/claude-code code-review plugin](https://github.com/anthropics/claude-code/tree/main/plugins/code-review) | One verifier per finding, told the class of claim; an explicit false-positive list; a short path for trivial changes. |
| [anthropics/claude-code-security-review](https://github.com/anthropics/claude-code-security-review) | The exploit scenario as a required field; a deterministic exclusion filter with counts per reason; a finding kept as unverified when verification fails. |
| [Claude Code Review and REVIEW.md](https://code.claude.com/docs/en/code-review) | Rules read from the base branch, never from the patch; a separate pre-existing bucket; a count of findings not posted. |
| anthropics/claude-code pr-review-toolkit | Asking which errors a handler could hide. |
| [openai/codex review rubric](https://raw.githubusercontent.com/openai/codex/main/codex-rs/prompts/templates/review/rubric.md) | The eight-test qualifying gate and the stated trigger per finding. |
| [Cursor Bugbot](https://cursor.com/blog/building-bugbot) | An aggressive finder with the verifier as the precision gate, and passes decorrelated by reordering the diff. |
| [qodo-ai/pr-agent](https://github.com/qodo-ai/pr-agent) | Pull request text declared untrusted, and never claiming a test ran when it did not. |
| [getsentry/skills](https://github.com/getsentry/skills): find-bugs, security-review | The coverage audit before concluding, the needs-verification bucket and a do-not-flag list per domain. |
| [obra/superpowers](https://github.com/obra/superpowers): requesting and receiving code review | Lanes get the commit range and the requirements, never the session transcript; each lists what it declined to judge; findings are verified before they are fixed. |
| [mattpocock/skills](https://github.com/mattpocock/skills): code-review | A preflight that the refs resolve and the diff is not empty, three-dot diffs and a word cap per lane. |
| [Gemini CLI code-review extension](https://github.com/gemini-cli-extensions/code-review) | The banned vague verbs in required actions, and one report per issue with all its locations. |

## Human review guides

| Source | What this skill takes from it |
|---|---|
| [Google engineering practices](https://google.github.io/eng-practices/review/reviewer/) | Read the description, then the central file, then the rest; say which parts were not reviewed. |
| [GitLab code review guidelines](https://docs.gitlab.com/development/code_review/) | A short path for trivial diffs, and an operational-risk lens for migrations, caches and background jobs. |
| [Conventional Comments](https://conventionalcomments.org/) | Labels kept apart from blocking status, and `question` as the honest form of an unverified concern. |
| [OWASP Secure Code Review cheat sheet](https://cheatsheetseries.owasp.org/cheatsheets/Secure_Code_Review_Cheat_Sheet.html) | Trace untrusted data from its entry point to its sink, and ask whether a trust boundary moved. |
| SmartBear and Cisco review study | Review passes of 200 to 400 lines, which sets the chunk size of about 400 changed lines. |
| Linux kernel and LLVM review docs | A pass states exactly what it claims and what it does not warrant. |
