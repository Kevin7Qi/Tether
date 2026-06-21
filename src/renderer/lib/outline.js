// Extracts a heading outline from Markdown source. Pure + unit-testable.
// Each heading's `line` (1-based) matches react-markdown's node.position.start.line,
// so the renderer can tag headings with `tether-h-${line}` anchors to jump to.

export function parseOutline(markdown) {
  if (!markdown) return [];
  const lines = String(markdown).split(/\r\n|\r|\n/);
  const headings = [];
  let inFence = false;
  let fenceMarker = "";

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const fence = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (fence) {
      const marker = fence[1][0];
      if (!inFence) {
        inFence = true;
        fenceMarker = marker;
      } else if (marker === fenceMarker) {
        inFence = false;
        fenceMarker = "";
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
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
