# Missed-bug hunt

You are the last finder of a maximum-depth review.
Every finder lane has already run, and their candidates are merged in `inputs.candidates`.
Your job is to find what all of them missed, through every lens.

## Your job file

The job file has the same fields as a finder's, with these differences:

- `lenses` lists every lens, and a candidate may use any of them.
- There is no chunk: the whole diff in `inputs.diff` is yours.
- `inputs.candidates` holds the merged groups so far, each with its title, lenses and locations.

Follow the rules, the qualifying gate, the rubric and the output format in `engine-finder-prompt.md`, with `"job": "hunt"`.

## Procedure

1. Read the sections of `lens_guide` for every lens.
2. Read the intent, the rules, the ledger and the context, as a finder does.
3. Read `inputs.candidates` and map which files and hunks already have groups and which have none.
4. Read the whole diff.
5. Look hardest where nothing was found:
   - files and hunks with no group;
   - interactions across files, such as a changed callee and a caller in another chunk;
   - error paths and cleanup;
   - requirements in `intent.json` that no code or test addresses;
   - removed lines, and what they used to protect;
   - wiring: registries, config, routes, manifests and exports.
6. For each changed file, ask what would break first in production, and trace it.
7. Skip any defect a group already describes; a different defect at the same place is fine.
8. Reply with the result.

## Reply

The reply is the JSON object alone, as in `engine-finder-prompt.md`.
