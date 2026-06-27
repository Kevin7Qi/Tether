// Extracts a heading outline from Markdown source. Pure + unit-testable.
// Each heading's `line` (1-based) matches react-markdown's node.position.start.line,
// so the renderer can tag headings with `tether-h-${line}` anchors to jump to.

export function parseOutline(markdown) {
  if (!markdown) return [];
  const lines = String(markdown).split(/\r\n|\r|\n/);
  const headings = [];
  let inFence = false;
  let fenceMarker = "";
  let fenceLength = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const fence = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (fence) {
      const run = fence[1];
      const marker = run[0];
      if (!inFence) {
        inFence = true;
        fenceMarker = marker;
        fenceLength = run.length;
      } else if (marker === fenceMarker && run.length >= fenceLength) {
        // CommonMark: the closing fence must use the same character and be at
        // least as long as the opener, so a ``` line can't close a ```` block.
        inFence = false;
        fenceMarker = "";
        fenceLength = 0;
      }
      continue;
    }
    if (inFence) continue;

    const match = line.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (!match) continue;
    const text = cleanHeadingText(match[2]);
    if (!text) continue;

    headings.push({
      level: match[1].length,
      text,
      line: index + 1,
      id: `tether-h-${index + 1}`
    });
  }

  return headings;
}

export function cleanHeadingText(raw) {
  return String(raw || "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/\b_([^_]+)_\b/g, "$1")
    .replace(/\$([^$]+)\$/g, "$1")
    // Strip only things that look like real HTML tags (`<tag…>` / `</tag>`), the
    // same spans react-markdown drops when rendering. A bare `<` followed by a
    // space or non-letter — e.g. `a < b`, `i <= 5` — is left as literal text.
    .replace(/<\/?[a-zA-Z][^>]*>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
