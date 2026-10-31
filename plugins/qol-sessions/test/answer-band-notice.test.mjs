import assert from "node:assert/strict";
import { test as nodeTest } from "node:test";

const TYPE_STRIPPING = Boolean(process.features?.typescript);
const SKIP = TYPE_STRIPPING ? false : `the band mod is TypeScript and needs Node 22.18 or newer with type stripping on, this is Node ${process.versions.node}`;
const test = (name, fn) => nodeTest(name, { skip: SKIP }, fn);
const { register } = TYPE_STRIPPING ? await import("../hooks/answer-band.ts") : {};

const BLOCKED = "UserPromptSubmit operation blocked by hook:";

function mount() {
  const hooks = new Map();
  register((event, matcher, hook) => {
    hooks.set(event, hook === undefined ? { matcher: undefined, hook: matcher } : { matcher, hook });
  });
  const $ = { ui: { invalidate: () => {}, resolve: () => ({}) }, prompt: { fill: async () => {} } };
  return { hooks, fire: (event, e, next) => hooks.get(event).hook($, e, next) };
}

const notice = (text) => ({ door: "notice", message: { type: "system", content: [{ type: "text", text }] } });

async function appendNotice(mod, text) {
  let passed;
  await mod.fire("session.append", notice(text), async (e) => {
    passed = e;
    return {};
  });
  return passed;
}

async function answer(mod, prompt, result) {
  await mod.fire("classic.UserPromptSubmit", { prompt }, async () => result);
}

test("the mod registers the notice door on session.append", () => {
  const { hooks } = mount();
  assert.deepEqual(hooks.get("session.append").matcher, { door: "notice" });
});

test("a notice that carries an answered verb is rewritten to the typed line", async () => {
  const mod = mount();
  await answer(mod, "qols loop  ", { block: "2 runs", suppressOriginalPrompt: true });
  const passed = await appendNotice(mod, `${BLOCKED}\n2 runs`);
  assert.deepEqual(passed.message.content, [{ type: "text", text: "qols loop" }]);
});

test("only the first notice after an answer is rewritten", async () => {
  const mod = mount();
  await answer(mod, "qols loop", { block: "2 runs", suppressOriginalPrompt: true });
  await appendNotice(mod, `${BLOCKED}\n2 runs`);
  const second = await appendNotice(mod, `${BLOCKED}\n2 runs`);
  assert.equal(second.message.content[0].text, `${BLOCKED}\n2 runs`);
});

test("a failed or usage block keeps its notice row", async () => {
  const mod = mount();
  await answer(mod, "qols bogus", { block: "unknown command" });
  const passed = await appendNotice(mod, `${BLOCKED}\nunknown command`);
  assert.equal(passed.message.content[0].text, `${BLOCKED}\nunknown command`);
});

test("a notice that is not a hook block, or arrives with no answer, is left alone", async () => {
  const mod = mount();
  const none = await appendNotice(mod, `${BLOCKED}\nanything`);
  assert.equal(none.message.content[0].text, `${BLOCKED}\nanything`);
  await answer(mod, "qols loop", { block: "2 runs", suppressOriginalPrompt: true });
  const other = await appendNotice(mod, "Compacting conversation");
  assert.equal(other.message.content[0].text, "Compacting conversation");
});
