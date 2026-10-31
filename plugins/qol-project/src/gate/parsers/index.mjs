import { parse as cargoJson } from "./cargo-json.mjs";
import { parse as eslintJson } from "./eslint-json.mjs";
import { parse as exitCode } from "./exit-code.mjs";
import { parse as junit } from "./junit.mjs";
import { parse as sarif } from "./sarif.mjs";
import { parse as tap } from "./tap.mjs";

const TABLE = {
  "exit-code": exitCode,
  "cargo-json": cargoJson,
  "eslint-json": eslintJson,
  junit,
  sarif,
  tap,
};

export const PARSERS = Object.freeze(Object.keys(TABLE));

export function parse(output, { cwd, judge, exit } = {}) {
  const name = judge?.parser ?? "exit-code";
  const parser = TABLE[name];
  if (!parser) throw new Error(`unknown parser "${name}"`);
  return parser(output, { cwd, judge, exit });
}
