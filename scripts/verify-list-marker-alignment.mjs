import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow } from "electron";

// This verifier never needs to become a foreground macOS application. Using
// accessory activation avoids Dock/menu-bar flashes while retaining an
// offscreen BrowserWindow for real Chromium layout measurements.
if (process.platform === "darwin") app.setActivationPolicy("accessory");

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [appStyles, milkdownListStyles] = await Promise.all([
  readFile(resolve(root, "src/renderer/styles.css"), "utf8"),
  readFile(resolve(root, "node_modules/@milkdown/crepe/lib/theme/common/list-item.css"), "utf8")
]);

const bullet = `
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <circle cx="12" cy="12" r="3"></circle>
  </svg>`;
const unchecked = `
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M18 19H6C5.45 19 5 18.55 5 18V6C5 5.45 5.45 5 6 5H18C18.55 5 19 5.45 19 6V18C19 18.55 18.55 19 18 19ZM19 3H5C3.9 3 3 3.9 3 5V19C3 20.1 3.9 21 5 21H19C20.1 21 21 20.1 21 19V5C21 3.9 3.9 3 5 3Z"></path>
  </svg>`;
const checked = `
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M19 3H5C3.9 3 3 3.9 3 5V19C3 20.1 3.9 21 5 21H19C20.1 21 21 20.1 21 19V5C21 3.9 20.1 3 19 3ZM10.71 16.29C10.32 16.68 9.69 16.68 9.3 16.29L5.71 12.7C5.32 12.31 5.32 11.68 5.71 11.29C6.1 10.9 6.73 10.9 7.12 11.29L10 14.17L16.88 7.29C17.27 6.9 17.9 6.9 18.29 7.29C18.68 7.68 18.68 8.31 18.29 8.7L10.71 16.29Z"></path>
  </svg>`;

const baseRows = [
  ["bullet", "bullet", bullet, "Bullet item"],
  ["ordered-base", "ordered", "1.", "Ordered item"],
  ["unchecked", "unchecked", unchecked, "Unchecked task"],
  ["checked", "checked", checked, "Checked task"]
];
const orderedRows = [
  ["ordered-1", "ordered", "1.", "One-digit item"],
  ["ordered-2", "ordered", "10.", "Two-digit item", 2],
  ["ordered-3", "ordered", "100.", "Three-digit item", 3],
  ["ordered-4", "ordered", "1000.", "Four-digit item", 4],
  ["ordered-5", "ordered", "10000.", "Five-digit item", 5],
  ["ordered-6", "ordered", "100000.", "Six-digit item", 6],
  ["ordered-7", "ordered", "1000000.", "Seven-digit item", 7],
  ["ordered-8", "ordered", "10000000.", "Eight-digit item", 8],
  ["ordered-9", "ordered", "100000000.", "Nine-digit item", 9]
];

function row([kind, markerClass, marker, text, digits], group) {
  const digitAttribute = digits ? ` data-marker-digits="${digits}"` : "";
  return `<div class="milkdown-list-item-block" data-kind="${kind}" data-group="${group}">
    <li class="list-item">
      <div class="label-wrapper"><span class="milkdown-icon label ${markerClass}"${digitAttribute}>${marker}</span></div>
      <div class="children"><div class="content-dom"><p>${text}</p></div></div>
    </li>
  </div>`;
}

const nestedTaskFixture = `<div class="milkdown-list-item-block">
  <li class="list-item">
    <div class="label-wrapper"><span class="milkdown-icon label bullet">${bullet}</span></div>
    <div class="children"><div class="content-dom">
      <p data-task-text="parent">Parent item</p>
      <ul>
        <div class="milkdown-list-item-block"><li class="list-item">
          <div class="label-wrapper"><span class="milkdown-icon label unchecked">${unchecked}</span></div>
          <div class="children"><div class="content-dom"><p data-task-text="unchecked">Unchecked child</p></div></div>
        </li></div>
        <div class="milkdown-list-item-block"><li class="list-item">
          <div class="label-wrapper"><span class="milkdown-icon label checked">${checked}</span></div>
          <div class="children"><div class="content-dom"><p data-task-text="checked">Checked child</p></div></div>
        </li></div>
      </ul>
    </div></div>
  </li>
</div>`;

const html = `<!doctype html>
<html><head><meta charset="utf-8"><style>
${milkdownListStyles}
${appStyles}
html, body { width: 800px; height: auto; overflow: visible; }
body { padding: 40px; }
</style></head><body>
  <div class="tether-wysiwyg"><div class="milkdown"><div class="ProseMirror">
    <div data-list="base">${baseRows.map((item) => row(item, "base")).join("\n")}</div>
    <ol data-list="wide">${orderedRows.map((item) => row(item, "wide")).join("\n")}</ol>
    ${nestedTaskFixture}
  </div></div></div>
</body></html>`;

function spread(values) {
  return Math.max(...values) - Math.min(...values);
}

function near(actual, expected, tolerance, message) {
  if (Math.abs(actual - expected) > tolerance) {
    throw new Error(`${message}: expected ${expected} +/- ${tolerance}, received ${actual}`);
  }
}

async function verifyAlignment() {
  let window;
  let exitCode = 0;
  try {
  console.log("Starting list-marker layout verification...");
  console.log("Electron is ready; measuring marker geometry...");
  window = new BrowserWindow({
    show: false,
    focusable: false,
    skipTaskbar: true,
    width: 800,
    height: 600,
    webPreferences: { sandbox: true, backgroundThrottling: false }
  });
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  const geometry = await window.webContents.executeJavaScript(`(() => {
    const center = (rect) => ({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
    const visualRect = (label) => {
      const svg = label.querySelector("svg");
      if (svg) return svg.getBoundingClientRect();
      const range = document.createRange();
      range.selectNodeContents(label);
      return range.getBoundingClientRect();
    };
    const measurements = [...document.querySelectorAll("[data-kind]")].map((row) => {
      const label = row.querySelector(".label");
      const markerRect = visualRect(label);
      const marker = center(markerRect);
      const rowRect = row.getBoundingClientRect();
      const content = row.querySelector(".content-dom > p");
      const contentRect = content.getBoundingClientRect();
      const textRange = document.createRange();
      textRange.selectNodeContents(content);
      const text = center(textRange.getBoundingClientRect());
      return {
        kind: row.dataset.kind,
        group: row.dataset.group,
        markerX: marker.x,
        markerYFromRow: marker.y - rowRect.top,
        textYFromRow: text.y - rowRect.top,
        markerToTextY: marker.y - text.y,
        markerToText: contentRect.left - marker.x,
        markerClearance: contentRect.left - markerRect.right,
        contentIndent: contentRect.left - rowRect.left,
        markerWidth: markerRect.width,
        markerScaleX: new DOMMatrix(getComputedStyle(label).transform).a
      };
    });
    const taskDecorations = Object.fromEntries(
      [...document.querySelectorAll("[data-task-text]")].map((element) => [
        element.dataset.taskText,
        getComputedStyle(element).textDecorationLine
      ])
    );
    return { measurements, taskDecorations };
  })()`);
  const { measurements, taskDecorations } = geometry;

  const markerXs = measurements.map(({ markerX }) => markerX);
  const markerYs = measurements.map(({ markerYFromRow }) => markerYFromRow);
  const markerToTextY = measurements.map(({ markerToTextY: value }) => value);
  const base = measurements.filter(({ group }) => group === "base");
  const wide = measurements.filter(({ group }) => group === "wide");
  const baseContentIndents = base.map(({ contentIndent }) => contentIndent);
  const wideContentIndents = wide.map(({ contentIndent }) => contentIndent);
  const baseMarkerToText = base.map(({ markerToText: value }) => value);
  if (spread(markerXs) > 0.25) throw new Error(`marker horizontal centers diverge by ${spread(markerXs)}px`);
  if (spread(markerYs) > 0.25) throw new Error(`marker vertical centers diverge by ${spread(markerYs)}px`);
  if (spread(markerToTextY) > 0.25) throw new Error(`marker-to-text vertical offsets diverge by ${spread(markerToTextY)}px`);
  if (spread(baseContentIndents) > 0.25) throw new Error(`base text indents diverge by ${spread(baseContentIndents)}px`);
  if (spread(wideContentIndents) > 0.25) throw new Error(`wide-list text indents diverge by ${spread(wideContentIndents)}px`);
  if (spread(baseMarkerToText) > 0.25) throw new Error(`base marker-to-text offsets diverge by ${spread(baseMarkerToText)}px`);
  // Range geometry follows the font's ink box rather than the CSS line box.
  // Keep every marker at, or just below, that optical center: a negative value
  // is the visibly high-marker regression this harness is meant to catch.
  if (Math.min(...markerToTextY) < -0.25) {
    throw new Error("a marker center sits visibly above its first-line text");
  }
  if (Math.max(...markerToTextY) > 3) {
    throw new Error("a marker center sits visibly below its first-line text");
  }
  near(baseContentIndents[0], 20, 0.25, "base list content indent");
  near(wideContentIndents[0], 46, 0.25, "wide ordered-list content indent");
  near(baseMarkerToText[0], 11, 0.25, "base marker center to text offset");
  if (Math.min(...measurements.map(({ markerClearance }) => markerClearance)) < 1) {
    throw new Error("a natural-width ordered marker overlaps its item text");
  }
  if (measurements.some(({ markerScaleX }) => Math.abs(markerScaleX - 1) > 0.001)) {
    throw new Error("an ordered marker is horizontally distorted");
  }
  const widest = measurements.find(({ kind }) => kind === "ordered-9");
  if (!widest || widest.markerWidth < 60) {
    throw new Error("the nine-digit ordered marker is still compressed");
  }
  if (taskDecorations.parent !== "none" || taskDecorations.unchecked !== "none") {
    throw new Error("a checked nested task strikes an ancestor or unchecked sibling");
  }
  if (!taskDecorations.checked.includes("line-through")) {
    throw new Error("the checked task no longer strikes its own content");
  }
    console.log(JSON.stringify({ ok: true, measurements }, null, 2));
  } catch (error) {
    exitCode = 1;
    console.error(error instanceof Error ? error.stack : error);
  } finally {
    if (window && !window.isDestroyed()) window.destroy();
    app.exit(exitCode);
  }
}

app.whenReady().then(verifyAlignment, (error) => {
  console.error(error instanceof Error ? error.stack : error);
  app.exit(1);
});
