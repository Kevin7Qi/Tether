// Shared reading-width constants and clamp helper, used by both the App shell
// and the PageWidthControl component.

export const PAGE_WIDTH_MIN = 560;
export const PAGE_WIDTH_MAX = 1180;
export const PAGE_WIDTH_DEFAULT = 820;
export const PAGE_WIDTH_STEP = 20;

export function clampPageWidth(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return PAGE_WIDTH_DEFAULT;
  return Math.min(PAGE_WIDTH_MAX, Math.max(PAGE_WIDTH_MIN, Math.round(number)));
}

// Platform-detected modifier labels, resolved once. macOS shows ⌘/⇧ glyphs;
// every other platform shows Ctrl/Shift, matching the design's hotkey hints.
export const IS_MAC =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent || "");

export function isPrimaryShortcutModifier(event, isMac = IS_MAC) {
  if (!event) return false;
  return isMac
    ? Boolean(event.metaKey) && !event.ctrlKey
    : Boolean(event.ctrlKey) && !event.metaKey;
}

export function hotkey(key, { shift = false } = {}) {
  const label = String(key).toUpperCase();
  if (IS_MAC) return `${shift ? "⌘⇧" : "⌘"}${label}`;
  return `Ctrl+${shift ? "Shift+" : ""}${label}`;
}
