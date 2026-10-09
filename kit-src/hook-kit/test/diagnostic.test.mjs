import assert from "node:assert/strict";
import test from "node:test";

import { closest, renderDiagnostic } from "../diagnostic.mjs";

test("renderDiagnostic matches the qols typo'd flag diagnostic", () => {
  assert.equal(
    renderDiagnostic({
      title: "unknown flag `--efort`",
      source: "qols bridge look into these --model opus --efort high",
      start: 41,
      end: 48,
      label: "not a flag qols knows",
      notes: [
        "help: did you mean `--effort`?",
        "note: flags are --harness, --model, --effort, --surface",
        "usage: qols bridge <task> [--harness H] [--model M] [--effort E] [--surface S]",
      ],
    }),
    [
      "error: unknown flag `--efort`",
      " --> prompt:1:42",
      "  |",
      "1 | qols bridge look into these --model opus --efort high",
      "  |                                          ^^^^^^^ not a flag qols knows",
      "  |",
      "  = help: did you mean `--effort`?",
      "  = note: flags are --harness, --model, --effort, --surface",
      "  = usage: qols bridge <task> [--harness H] [--model M] [--effort E] [--surface S]",
    ].join("\n"),
  );
});

test("renderDiagnostic keeps the line number of a later line and needs no notes", () => {
  assert.equal(
    renderDiagnostic({ title: "t", source: "qols fork a\nb --modle x", start: 14, end: 21, label: "l" }),
    ["error: t", " --> prompt:2:3", "  |", "2 | b --modle x", "  |   ^^^^^^^ l", "  |"].join("\n"),
  );
});

test("closest suggests a near option and nothing for a far one", () => {
  assert.equal(closest("brige", ["fork", "bridge", "test"]), "bridge");
  assert.equal(closest("efort", ["harness", "model", "effort", "surface"]), "effort");
  assert.equal(closest("xyz", ["harness", "model", "effort", "surface"]), null);
  assert.equal(closest("x", []), null);
});
