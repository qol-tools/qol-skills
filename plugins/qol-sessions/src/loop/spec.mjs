const FENCE_OPEN = /^\s{0,3}(`{3,}|~{3,})(.*)$/;
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const KEYS = ["lane", "owned", "accept", "implementers", "budget_usd"];
const ACCEPT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "";
}

function isClosingFence(line, marker) {
  const trimmed = line.trim();
  return trimmed.length >= marker.length && trimmed === marker[0].repeat(trimmed.length);
}

function fencedBlocks(lines) {
  const blocks = [];
  let open = null;
  lines.forEach((line, index) => {
    if (open) {
      if (isClosingFence(line, open.marker)) {
        blocks.push({ info: open.info, body: open.body.join("\n"), start: open.start, end: index, closed: true });
        open = null;
      } else {
        open.body.push(line);
      }
      return;
    }
    const match = FENCE_OPEN.exec(line);
    if (match) open = { marker: match[1], info: match[2].trim(), body: [], start: index };
  });
  if (open) blocks.push({ info: open.info, body: open.body.join("\n"), start: open.start, end: lines.length - 1, closed: false });
  return blocks;
}

function isLoopInfo(info) {
  const words = info.split(/\s+/).filter(Boolean);
  return words.length === 2 && words[0] === "json" && words[1] === "loop";
}

function laneErrors(lane) {
  if (!isObject(lane)) return ["lane must be an object with tool and model"];
  const errors = [];
  if (!nonEmptyString(lane.tool)) errors.push("lane.tool is required");
  if (!nonEmptyString(lane.model)) errors.push("lane.model is required: a missing model is a usage error, never a default");
  if (lane.effort !== undefined && !EFFORTS.includes(lane.effort)) errors.push(`lane.effort must be one of ${EFFORTS.join(", ")}`);
  return errors;
}

function acceptErrors(accept) {
  if (!Array.isArray(accept)) return ["accept must be an array"];
  const errors = [];
  accept.forEach((entry, index) => {
    const label = `accept[${index}]`;
    if (!isObject(entry)) {
      errors.push(`${label} must be an object`);
      return;
    }
    if (!nonEmptyString(entry.id) || !ACCEPT_ID.test(entry.id)) errors.push(`${label}.id must be a non-empty identifier`);
    if (!Array.isArray(entry.argv) || entry.argv.length === 0 || !entry.argv.every(nonEmptyString)) {
      errors.push(`${label}.argv must be a non-empty argv array of strings`);
    }
  });
  const ids = accept.filter(isObject).map((entry) => entry.id);
  for (const id of new Set(ids.filter((id, index) => ids.indexOf(id) !== index))) errors.push(`accept id ${id} is used more than once`);
  return errors;
}

export function validateFront(front) {
  if (!isObject(front)) return ["the loop block must be a JSON object"];
  const errors = [];
  for (const key of Object.keys(front)) {
    if (!KEYS.includes(key)) errors.push(`unknown key ${key}`);
  }
  errors.push(...laneErrors(front.lane));
  if (!Array.isArray(front.owned) || front.owned.length === 0 || !front.owned.every(nonEmptyString)) {
    errors.push("owned must be a non-empty array of path globs");
  }
  if (front.accept !== undefined) errors.push(...acceptErrors(front.accept));
  if (front.implementers !== undefined && front.implementers !== 1 && front.implementers !== 2) errors.push("implementers must be 1 or 2");
  if (front.budget_usd !== undefined && !(typeof front.budget_usd === "number" && Number.isFinite(front.budget_usd) && front.budget_usd > 0)) {
    errors.push("budget_usd must be a positive number");
  }
  return errors;
}

export function parseSpec(text) {
  const lines = String(text ?? "").split(/\r?\n/);
  const blocks = fencedBlocks(lines).filter((block) => isLoopInfo(block.info));
  if (blocks.length !== 1) {
    return { front: null, body: String(text ?? ""), errors: [`expected exactly one \`json loop\` fenced block, found ${blocks.length}`] };
  }
  const [block] = blocks;
  const body = [...lines.slice(0, block.start), ...lines.slice(block.end + 1)].join("\n").replace(/\n{3,}/g, "\n\n").trim();
  if (!block.closed) return { front: null, body, errors: ["the `json loop` fenced block is never closed"] };
  let front;
  try {
    front = JSON.parse(block.body);
  } catch (error) {
    return { front: null, body, errors: [`invalid JSON in the loop block: ${error.message}`] };
  }
  const errors = validateFront(front);
  if (errors.length > 0) return { front: isObject(front) ? front : null, body, errors };
  return { front: { ...front, accept: front.accept ?? [], implementers: front.implementers ?? 1 }, body, errors: [] };
}
