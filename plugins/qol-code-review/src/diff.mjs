const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?([\s\S]*)$/;

export function parseNameStatus(text) {
  const fields = String(text ?? "").split("\0");
  const entries = [];
  for (let at = 0; at < fields.length; ) {
    const status = fields[at++];
    if (!status) continue;
    const code = status[0];
    if (code === "R" || code === "C") {
      entries.push({ status: code, score: Number(status.slice(1)) || 0, old_path: fields[at++], path: fields[at++] });
    } else {
      const path = fields[at++];
      entries.push({ status: code, score: null, old_path: code === "A" ? null : path, path });
    }
  }
  return entries;
}

export function splitPatch(text) {
  const sections = [];
  let current = null;
  for (const line of String(text ?? "").split("\n")) {
    if (line.startsWith("diff --git ")) {
      current = [line];
      sections.push(current);
    } else if (current) current.push(line);
  }
  for (const section of sections) {
    while (section.length > 1 && section.at(-1) === "") section.pop();
  }
  return sections;
}

export function parseSection(lines) {
  const header = [];
  let at = 0;
  while (at < lines.length && !lines[at].startsWith("@@ ")) header.push(lines[at++]);
  const hunks = [];
  while (at < lines.length) {
    const match = HUNK_HEADER.exec(lines[at]);
    if (!match) {
      at++;
      continue;
    }
    const hunk = {
      header: lines[at],
      old_start: Number(match[1]),
      old_count: match[2] === undefined ? 1 : Number(match[2]),
      new_start: Number(match[3]),
      new_count: match[4] === undefined ? 1 : Number(match[4]),
      context: match[5] ?? "",
      lines: [],
      added: 0,
      removed: 0,
    };
    at++;
    let oldLeft = hunk.old_count;
    let newLeft = hunk.new_count;
    while (at < lines.length && (oldLeft > 0 || newLeft > 0 || lines[at].startsWith("\\"))) {
      const line = lines[at];
      if (line.startsWith("+")) {
        newLeft--;
        hunk.added++;
      } else if (line.startsWith("-")) {
        oldLeft--;
        hunk.removed++;
      } else if (line.startsWith(" ") || line === "") {
        oldLeft--;
        newLeft--;
      } else if (!line.startsWith("\\")) break;
      hunk.lines.push(line);
      at++;
    }
    hunks.push(hunk);
  }
  const binary = header.some((line) => line.startsWith("Binary files ") || line === "GIT binary patch");
  const mode = {
    old: header.find((line) => line.startsWith("old mode "))?.slice(9) ?? null,
    new: header.find((line) => line.startsWith("new mode "))?.slice(9) ?? null,
  };
  return { header, hunks, binary, mode_change: Boolean(mode.old && mode.new && mode.old !== mode.new), mode };
}

export function pairSections(entries, patchText) {
  const sections = splitPatch(patchText).map(parseSection);
  const files = [];
  let at = 0;
  for (const entry of entries) {
    const width = entry.status === "T" ? 2 : 1;
    const parts = sections.slice(at, (at += width));
    if (parts.length < width) return null;
    files.push({ ...entry, ...parts[0], header: parts.flatMap((part) => part.header), hunks: parts.flatMap((part) => part.hunks), binary: parts.some((part) => part.binary) });
  }
  return at === sections.length ? files : null;
}

export function sectionText(file, hunkIndexes = null) {
  const picked = hunkIndexes === null ? file.hunks : hunkIndexes.map((index) => file.hunks[index]);
  return [...file.header, ...picked.flatMap((hunk) => [hunk.header, ...hunk.lines])].join("\n");
}

export function changedLines(hunk) {
  const added = [];
  const removed = [];
  let oldLine = hunk.old_start;
  let newLine = hunk.new_start;
  for (const line of hunk.lines) {
    if (line.startsWith("+")) added.push({ line: newLine++, text: line.slice(1) });
    else if (line.startsWith("-")) removed.push({ line: oldLine++, text: line.slice(1) });
    else if (!line.startsWith("\\")) {
      oldLine++;
      newLine++;
    }
  }
  return { added, removed };
}

export function headRange(hunk) {
  return hunk.new_count > 0 ? [hunk.new_start, hunk.new_start + hunk.new_count - 1] : null;
}

export function baseRange(hunk) {
  return hunk.old_count > 0 ? [hunk.old_start, hunk.old_start + hunk.old_count - 1] : null;
}

export function runs(numbers) {
  const sorted = [...new Set(numbers)].sort((left, right) => left - right);
  const result = [];
  for (const value of sorted) {
    const last = result.at(-1);
    if (last && value === last[1] + 1) last[1] = value;
    else result.push([value, value]);
  }
  return result;
}
