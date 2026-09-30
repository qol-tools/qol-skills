const MAX_LINES = 60;
const FACADE_LINE = /^\s*#\[cfg\(|^\s*(?:pub(?:\([^)]*\))?\s+)?(?:mod|use)\s+(?:linux|macos|windows)\b/;

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function single(re) {
  return new RegExp(re.source, re.flags.replace("g", ""));
}

export function explicitLines(message, file) {
  const lines = new Set();
  for (const match of message.matchAll(/\bline (\d+)\b/g)) lines.add(Number(match[1]));
  for (const match of message.matchAll(new RegExp(`${escapeRegex(file)}:(\\d+)`, "g"))) lines.add(Number(match[1]));
  return lines;
}

export function linePatterns(message, locators) {
  const patterns = locators
    .filter(locator => message.includes(locator.label))
    .map(locator => single(locator.re));
  for (const match of message.matchAll(/^\s*-\s+([A-Za-z_]\w*): consumed only by/gm)) {
    patterns.push(new RegExp(`\\bfn\\s+${match[1]}\\b`));
  }
  if (message.includes("platform facade is incomplete")) patterns.push(FACADE_LINE);
  return patterns;
}

export function locate(message, content, file, locators = []) {
  const lines = explicitLines(message, file);
  if (lines.size === 0) {
    const patterns = linePatterns(message, locators);
    if (patterns.length > 0) {
      content.split(/\r?\n/).forEach((text, index) => {
        if (patterns.some(pattern => pattern.test(text))) lines.add(index + 1);
      });
    }
  }
  return [...lines].filter(line => line > 0).sort((a, b) => a - b).slice(0, MAX_LINES);
}
