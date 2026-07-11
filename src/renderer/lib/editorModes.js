export const EDITOR_MODE_WYSIWYG = "wysiwyg";
export const EDITOR_MODE_SOURCE = "source";
export const EDITOR_MODE_READING = "reading";

export function normalizeEditorMode(value) {
  if (value === EDITOR_MODE_SOURCE) return EDITOR_MODE_SOURCE;
  if (value === EDITOR_MODE_READING) return EDITOR_MODE_READING;
  return EDITOR_MODE_WYSIWYG;
}

export function editorModeLabel(value) {
  const mode = normalizeEditorMode(value);
  if (mode === EDITOR_MODE_SOURCE) return "Markdown source";
  if (mode === EDITOR_MODE_READING) return "Reading view";
  return "Inline editor";
}
