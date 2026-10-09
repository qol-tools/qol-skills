function distance(a, b) {
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) {
      next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    row = next;
  }
  return row[b.length];
}

export function closest(word, options) {
  const [best] = options.map((option) => [option, distance(word, option)]).sort((a, b) => a[1] - b[1]);
  return best && best[1] <= Math.max(2, Math.floor(word.length / 3)) ? best[0] : null;
}

export function renderDiagnostic({ title, source, start, end, label, notes = [] }) {
  const lineStart = source.lastIndexOf("\n", start - 1) + 1;
  const lineEnd = source.indexOf("\n", start) === -1 ? source.length : source.indexOf("\n", start);
  const line = source.slice(lineStart, lineEnd);
  const lineNumber = source.slice(0, lineStart).split("\n").length;
  const column = start - lineStart;
  const width = Math.max(1, Math.min(end, lineEnd + 1) - start);
  const gutter = " ".repeat(String(lineNumber).length);
  return [
    `error: ${title}`,
    `${gutter}--> prompt:${lineNumber}:${column + 1}`,
    `${gutter} |`,
    `${lineNumber} | ${line}`,
    `${gutter} | ${" ".repeat(column)}${"^".repeat(width)} ${label}`,
    `${gutter} |`,
    ...notes.map((note) => `${gutter} = ${note}`),
  ].join("\n");
}
