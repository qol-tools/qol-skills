import test from "node:test";
import assert from "node:assert/strict";
import { parse as cargoJson } from "../src/gate/parsers/cargo-json.mjs";
import { parse as eslintJson } from "../src/gate/parsers/eslint-json.mjs";
import { parse as exitCode, repoPath, tailLines } from "../src/gate/parsers/exit-code.mjs";
import { PARSERS, parse } from "../src/gate/parsers/index.mjs";
import { decodeXml, parse as junit } from "../src/gate/parsers/junit.mjs";
import { parse as sarif } from "../src/gate/parsers/sarif.mjs";
import { parse as tap } from "../src/gate/parsers/tap.mjs";

test("the parser registry names every format and defaults to exit-code", () => {
  assert.deepEqual([...PARSERS], ["exit-code", "cargo-json", "eslint-json", "junit", "sarif", "tap"]);
  assert.deepEqual(parse("boom", { exit: 2 }).map(finding => finding.rule), ["exit"]);
  assert.deepEqual(parse("boom", { judge: { parser: "exit-code" }, exit: 0 }), []);
  assert.throws(() => parse("x", { judge: { parser: "nope" } }), /unknown parser "nope"/);
});

test("exit-code reports the output tail of a failing command and nothing for a pass", () => {
  assert.deepEqual(exitCode("a\n\nb\n", { exit: 3 }), [{ rule: "exit", file: null, line: null, message: "exited 3\na\nb" }]);
  assert.deepEqual(exitCode("", { exit: 7 }), [{ rule: "exit", file: null, line: null, message: "exited 7" }]);
  assert.deepEqual(exitCode("fine", { exit: 0 }), []);
  assert.equal(tailLines(Array.from({ length: 30 }, (_, at) => `l${at}`).join("\n"), 3), "l27\nl28\nl29");
});

test("repoPath makes paths relative to the repo and keeps outside paths", () => {
  assert.equal(repoPath("/w/src/a.rs", "/w"), "src/a.rs");
  assert.equal(repoPath("file:///w/src/a.rs", "/w"), "src/a.rs");
  assert.equal(repoPath("/elsewhere/a.rs", "/w"), "/elsewhere/a.rs");
  assert.equal(repoPath("src\\a.rs", "/w"), "src/a.rs");
  assert.equal(repoPath("", "/w"), null);
  assert.equal(repoPath(undefined, "/w"), null);
});

function compilerMessage(level, code, message, span) {
  return JSON.stringify({
    reason: "compiler-message",
    message: {
      level,
      code: code && { code },
      message,
      spans: span ? [{ file_name: span[0], line_start: span[1], is_primary: true }] : [],
    },
  });
}

test("cargo-json keeps error diagnostics once and ignores warnings and noise", () => {
  const output = [
    compilerMessage("error", "E0308", "mismatched types", ["src/a.rs", 3]),
    compilerMessage("error", "E0308", "mismatched types", ["src/a.rs", 3]),
    compilerMessage("error", "E0308", "mismatched types", ["src/a.rs", 9]),
    compilerMessage("warning", "unused", "unused variable", ["src/b.rs", 1]),
    compilerMessage("error", null, "could not compile", null),
    "not json",
    "{broken",
    JSON.stringify({ reason: "build-finished", success: false }),
  ].join("\n");
  assert.deepEqual(cargoJson(output, { cwd: "/w" }), [
    { rule: "E0308", file: "src/a.rs", line: 3, message: "mismatched types" },
    { rule: "E0308", file: "src/a.rs", line: 9, message: "mismatched types" },
  ]);
});

test("eslint-json reads the array out of noisy output and keeps errors only", () => {
  const report = [{
    filePath: "/w/src/a.js",
    messages: [
      { ruleId: "no-undef", severity: 2, line: 4, message: "x is not defined" },
      { ruleId: "semi", severity: 1, line: 1, message: "Missing semicolon" },
      { fatal: true, severity: 2, line: 1, message: "Parsing error" },
    ],
  }];
  assert.deepEqual(eslintJson(`npm warn something\n${JSON.stringify(report)}\n`, { cwd: "/w" }), [
    { rule: "no-undef", file: "src/a.js", line: 4, message: "x is not defined" },
    { rule: "fatal", file: "src/a.js", line: 1, message: "Parsing error" },
  ]);
  assert.throws(() => eslintJson("no json here", { cwd: "/w" }), /no JSON \[/);
});

test("junit reports failed and errored test cases with decoded text", () => {
  const xml = [
    "<testsuite>",
    "<testcase classname=\"a.B\" name=\"works\" file=\"t.js\" line=\"3\"/>",
    "<testcase classname=\"a.B\" name=\"bad\" file=\"t.js\" line=\"9\"><failure message=\"expected &quot;x&quot; &amp; y\">trace</failure></testcase>",
    "<testcase name=\"boom\"><error>Boom &lt;here&gt;\nsecond</error></testcase>",
    "</testsuite>",
  ].join("\n");
  assert.deepEqual(junit(xml, { cwd: "/w" }), [
    { rule: "a.B.bad", file: "t.js", line: 9, message: "expected \"x\" & y" },
    { rule: "boom", file: null, line: null, message: "Boom <here>" },
  ]);
  assert.equal(decodeXml("&#65;&#x42;&lt;&unknown;"), "AB<&unknown;");
});

test("sarif keeps error and warning results, resolves rule levels and skips suppressed ones", () => {
  const document = {
    runs: [{
      tool: { driver: { rules: [{ id: "R1", defaultConfiguration: { level: "error" } }] } },
      results: [
        { ruleId: "R0", level: "warning", message: { text: "w" }, locations: [{ physicalLocation: { artifactLocation: { uri: "file:///w/src/a.rs" }, region: { startLine: 7 } } }] },
        { ruleIndex: 0, message: { text: "from definition" } },
        { ruleId: "R2", level: "note", message: { text: "n" } },
        { ruleId: "R3", level: "error", message: { text: "s" }, suppressions: [{ kind: "inSource" }] },
      ],
    }],
  };
  assert.deepEqual(sarif(JSON.stringify(document), { cwd: "/w" }), [
    { rule: "R0", file: "src/a.rs", line: 7, message: "w" },
    { rule: "R1", file: null, line: null, message: "from definition" },
  ]);
});

test("tap reports failed tests with their diagnostics and skips todo, skip and parent failures", () => {
  const output = [
    "TAP version 13",
    "ok 1 - fine",
    "not ok 2 - adds numbers",
    "  ---",
    "  message: 'expected 3 got 4'",
    "  location: 'file:///w/test/a.test.mjs:12:5'",
    "  ...",
    "not ok 3 - later # TODO not yet",
    "not ok 4 - parent",
    "  ---",
    "  failureType: 'subtestsFailed'",
    "  ...",
    "not ok 5",
    "Bail out! disk full",
  ].join("\n");
  assert.deepEqual(tap(output, { cwd: "/w" }), [
    { rule: "adds numbers", file: "test/a.test.mjs", line: 12, message: "expected 3 got 4" },
    { rule: "test", file: null, line: null, message: "test" },
    { rule: "bail-out", file: null, line: null, message: "disk full" },
  ]);
  assert.deepEqual(tap("ok 1\nok 2\n", { cwd: "/w" }), []);
});
