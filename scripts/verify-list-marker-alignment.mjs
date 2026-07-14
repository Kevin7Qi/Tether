import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow } from "electron";

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

const markerRows = [
  ["bullet", "bullet", bullet, "Bullet item"],
  ["ordered-1", "ordered", "1.", "Ordered item"],
  ["ordered-2", "ordered", "10.", "Two-digit item", 2],
  ["ordered-3", "ordered", "100.", "Three-digit item", 3],
  ["ordered-4", "ordered", "1000.", "Four-digit item", 4],
  ["ordered-5", "ordered", "10000.", "Five-digit item", 5],
  ["ordered-6", "ordered", "100000.", "Six-digit item", 6],
  ["ordered-7", "ordered", "1000000.", "Seven-digit item", 7],
  ["ordered-8", "ordered", "10000000.", "Eight-digit item", 8],
  ["ordered-9", "ordered", "100000000.", "Nine-digit item", 9],
  ["unchecked", "unchecked", unchecked, "Unchecked task"],
  ["checked", "checked", checked, "Checked task"]
];

function row([kind, markerClass, marker, text, digits]) {
  const digitAttribute = digits ? ` data-marker-digits="${digits}"` : "";
  return `<div class="milkdown-list-item-block" data-kind="${kind}">
    <li class="list-item">
      <div class="label-wrapper"><span class="milkdown-icon label ${markerClass}"${digitAttribute}>${marker}</span></div>
      <div class="children"><div class="content-dom"><p>${text}</p></div></div>
    </li>
  </div>`;
}

const html = `<!doctype html>
<html><head><meta charset="utf-8"><style>
${milkdownListStyles}
${appStyles}
html, body { width: 800px; height: auto; overflow: visible; }
body { padding: 40px; }
</style></head><body>
  <div class="tether-wysiwyg"><div class="milkdown"><div class="ProseMirror">
    ${markerRows.map(row).join("\n")}
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
    width: 800,
    height: 600,
    webPreferences: { sandbox: true }
  });
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  const measurements = await window.webContents.executeJavaScript(`(() => {
    const center = (rect) => ({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
    const visualRect = (label) => {
      const svg = label.querySelector("svg");
      if (svg) return svg.getBoundingClientRect();
      const range = document.createRange();
      range.selectNodeContents(label);
      return range.getBoundingClientRect();
    };
    return [...document.querySelectorAll("[data-kind]")].map((row) => {
      const marker = center(visualRect(row.querySelector(".label")));
      const rowRect = row.getBoundingClientRect();
      const contentRect = row.querySelector(".content-dom > p").getBoundingClientRect();
      return {
        kind: row.dataset.kind,
        markerX: marker.x,
        markerYFromRow: marker.y - rowRect.top,
        markerToText: contentRect.left - marker.x,
        contentIndent: contentRect.left - rowRect.left,
        markerWidth: visualRect(row.querySelector(".label")).width
      };
    });
  })()`);

  const markerXs = measurements.map(({ markerX }) => markerX);
  const markerYs = measurements.map(({ markerYFromRow }) => markerYFromRow);
  const contentIndents = measurements.map(({ contentIndent }) => contentIndent);
  const markerToText = measurements.map(({ markerToText: value }) => value);
  if (spread(markerXs) > 0.25) throw new Error(`marker horizontal centers diverge by ${spread(markerXs)}px`);
  if (spread(markerYs) > 0.25) throw new Error(`marker vertical centers diverge by ${spread(markerYs)}px`);
  if (spread(contentIndents) > 0.25) throw new Error(`text indents diverge by ${spread(contentIndents)}px`);
  if (spread(markerToText) > 0.25) throw new Error(`marker-to-text offsets diverge by ${spread(markerToText)}px`);
  near(contentIndents[0], 20, 0.25, "list content indent");
  near(markerToText[0], 11, 0.25, "marker center to text offset");
  if (Math.max(...measurements.map(({ markerWidth }) => markerWidth)) > 16.25) {
    throw new Error("a marker exceeds the shared 16px visual slot");
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
