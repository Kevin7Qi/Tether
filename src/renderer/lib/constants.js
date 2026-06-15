// Shared reading-width constants and clamp helper, used by both the App shell
// and the PageWidthControl component.

export const PAGE_WIDTH_MIN = 560;
export const PAGE_WIDTH_MAX = 1320;
export const PAGE_WIDTH_DEFAULT = 980;
export const PAGE_WIDTH_STEP = 20;

export function clampPageWidth(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return PAGE_WIDTH_DEFAULT;
  return Math.min(PAGE_WIDTH_MAX, Math.max(PAGE_WIDTH_MIN, Math.round(number)));
}
