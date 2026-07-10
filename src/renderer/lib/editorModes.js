export const EDITOR_MODE_WYSIWYG = "wysiwyg";
export const EDITOR_MODE_SOURCE = "source";

export function normalizeEditorMode(value) {
  return value === EDITOR_MODE_SOURCE ? EDITOR_MODE_SOURCE : EDITOR_MODE_WYSIWYG;
}

export function editorModeLabel(value) {
  return normalizeEditorMode(value) === EDITOR_MODE_SOURCE ? "Markdown source" : "Inline editor";
}
