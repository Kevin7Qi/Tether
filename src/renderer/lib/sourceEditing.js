export function sourceTabEdit(value, selectionStart, selectionEnd, outdent = false) {
  const source = String(value ?? "");
  const start = Math.max(0, Math.min(source.length, Number(selectionStart) || 0));
  const end = Math.max(start, Math.min(source.length, Number(selectionEnd) || start));

  if (!outdent && start === end) {
    return {
      value: `${source.slice(0, start)}\t${source.slice(end)}`,
      selectionStart: start + 1,
      selectionEnd: start + 1
    };
  }

  const firstLineStart = source.lastIndexOf("\n", Math.max(0, start - 1)) + 1;
  const selectedEnd = end > start && source[end - 1] === "\n" ? end - 1 : end;
  const lineStarts = [firstLineStart];
  for (let offset = firstLineStart; offset < selectedEnd;) {
    const newline = source.indexOf("\n", offset);
    if (newline < 0 || newline + 1 > selectedEnd) break;
    lineStarts.push(newline + 1);
    offset = newline + 1;
  }

  if (!outdent) {
    let nextValue = source;
    for (let index = lineStarts.length - 1; index >= 0; index -= 1) {
      const lineStart = lineStarts[index];
      nextValue = `${nextValue.slice(0, lineStart)}\t${nextValue.slice(lineStart)}`;
    }
    const mapOffset = (offset) => offset
      + lineStarts.filter((lineStart) => lineStart <= offset).length;
    return {
      value: nextValue,
      selectionStart: mapOffset(start),
      selectionEnd: mapOffset(end)
    };
  }

  const removals = lineStarts.map((lineStart) => {
    if (source[lineStart] === "\t") return { lineStart, length: 1 };
    const spaces = source.slice(lineStart).match(/^ {1,4}/)?.[0].length || 0;
    return { lineStart, length: spaces };
  }).filter(({ length }) => length > 0);
  if (!removals.length) {
    return { value: source, selectionStart: start, selectionEnd: end };
  }

  let nextValue = source;
  for (let index = removals.length - 1; index >= 0; index -= 1) {
    const { lineStart, length } = removals[index];
    nextValue = `${nextValue.slice(0, lineStart)}${nextValue.slice(lineStart + length)}`;
  }
  const mapOffset = (offset) => offset - removals.reduce((removed, removal) => {
    if (offset <= removal.lineStart) return removed;
    return removed + Math.min(removal.length, offset - removal.lineStart);
  }, 0);
  return {
    value: nextValue,
    selectionStart: mapOffset(start),
    selectionEnd: mapOffset(end)
  };
}
