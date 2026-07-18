import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import electronPath from "electron";
import { prepareBackgroundElectron } from "./background-electron.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const backgroundElectron = await prepareBackgroundElectron(electronPath);
const inlineFixture = "Before **bold** after.\n";
const editedInlineFixture = "Before **boXld** after.\n";
const deletedInlineMarkerFixture = "Before *bold** after.\n";
const literalSourceFixture = "Before \\*literal\\* and &copy; after.\n";
const codeFixture = "Before.\n\n```js\nconst value = 1;\n```\n\nAfter.\n";
const listFixture = "Before.\n\n- Alpha\n- Beta\n\nAfter.\n";
const taskFixture = "- [ ] Alpha\n- [X] Beta\n";
const tableBlockSource = [
  "| Alpha | Beta |",
  "| :---- | ----: |",
  "| One   | Two  |"
].join("\n");
const tableFixture = `${tableBlockSource}\n\nAfter.\n`;
const editedCodeFixture = "Before.\n\n```js\nconst value = 12;\n```\n\nAfter.\n";
const codeBlockSource = "```js\nconst value = 1;\n```";
const codeContent = "const value = 1;";
const selectAllCodeFixture = `\n${codeFixture}\n`;
const proseSelectAllLines = [
  "",
  "# Head &copy; #",
  "",
  "Intro **bold** and \\*literal\\*.",
  "",
  "- [ ] Task",
  "",
  "```js title=demo",
  "const value = 1;",
  "```",
  "",
  "| Left | Right |",
  "| :--- | ----: |",
  "| A | B |",
  "",
  "> Quote",
  ""
];
const proseSelectAllFixture = proseSelectAllLines.join("\r\n");
const indentedProseSelectAllFixture = proseSelectAllLines
  .map((line, index) => index === proseSelectAllLines.length - 1 ? line : `\t${line}`)
  .join("\r\n");
const indentedSelectAllCodeFixture = [
  "\t",
  "\tBefore.",
  "\t",
  "\t```js",
  "\tconst value = 1;",
  "\t```",
  "\t",
  "\tAfter.",
  "\t",
  ""
].join("\n");
const firstCodeContent = "const first = 1;";
const secondCodeContent = "second = 2";
const twoCodeFixture = [
  "Before.",
  "",
  "```js",
  firstCodeContent,
  "```",
  "",
  "Between.",
  "",
  "```python",
  secondCodeContent,
  "```",
  "",
  "After.",
  ""
].join("\n");
const variantCodeBlockSource = "~~~~js title=demo\r\nconst answer = 42;\r\n~~~~~";
const variantCodeFixture = `Before.\r\n\r\n${variantCodeBlockSource}\r\n\r\nAfter.\r\n`;
const editedVariantCodeFixture = variantCodeFixture.replace("const answer = 42;", "const answer = 43;");
const emptyCodeBlockSource = "```js\n```";
const emptyCodeFixture = `Before.\n\n${emptyCodeBlockSource}\n\nAfter.\n`;
const inlineBoundaryFixtures = [
  { name: "emphasis", source: "*italic*" },
  { name: "inline code", source: "`code`" },
  { name: "link", source: "[guide](https://example.com)" },
  { name: "strikethrough", source: "~~strike~~" },
  { name: "image", source: "![Alt](https://example.com/image.png)" },
  { name: "inline math", source: "$x + y$" },
  { name: "footnote reference", source: "[^note]", suffix: "\n[^note]: Footnote\n" },
  { name: "inline HTML", source: "<em>html</em>" }
];
let child = null;
let cdp = null;
let profilePath = null;
let samplePath = null;
let remoteDebugPort = null;
let cdpTargetId = null;
let electronOutput = "";
let sessionWindowCount = 0;
const requestedWindowsPerProcess = Number.parseInt(
  process.env.TETHER_PARITY_WINDOWS_PER_PROCESS || "0",
  10
);
// A fixture reset destroys the old renderer and creates a fresh offscreen
// BrowserWindow, which is enough isolation for the normal suite. Keeping the
// background-only Electron host alive avoids asking macOS to launch an app 95
// times during one verification run. Set TETHER_PARITY_WINDOWS_PER_PROCESS=1
// when diagnosing state that may genuinely be process-global.
const maxWindowsPerElectronSession = requestedWindowsPerProcess > 0
  ? requestedWindowsPerProcess
  : Number.POSITIVE_INFINITY;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function availablePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

async function waitFor(check, message, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(80);
  }
  throw new Error(`${message}${lastError ? `: ${lastError.message}` : ""}`);
}

async function waitForProcessExit(process, timeoutMs) {
  if (!process || process.exitCode !== null || process.signalCode !== null) return true;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      process.off("exit", onExit);
      resolve(false);
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    process.once("exit", onExit);
  });
}

class CdpSession {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.nextId = 1;
    this.pending = new Map();
    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (!message.id) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
    this.socket.addEventListener("close", () => {
      for (const pending of this.pending.values()) {
        pending.reject(new Error("CDP WebSocket closed"));
      }
      this.pending.clear();
    });
  }

  async open() {
    if (this.socket.readyState === WebSocket.OPEN) return;
    await new Promise((resolve, reject) => {
      this.socket.addEventListener("open", resolve, { once: true });
      this.socket.addEventListener("error", () => reject(new Error("CDP WebSocket failed to open")), {
        once: true
      });
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    this.socket.close();
  }
}

async function evaluate(expression) {
  const response = await cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true
  });
  if (response.exceptionDetails) {
    throw new Error(response.exceptionDetails.exception?.description || "Renderer evaluation failed");
  }
  return response.result.value;
}

async function captureElementsScreenshot(selectors, outputPath) {
  const rect = await evaluate(`(() => {
    const bounds = ${JSON.stringify(selectors)}
      .map((selector) => document.querySelector(selector)?.getBoundingClientRect())
      .filter(Boolean);
    if (!bounds.length) return null;
    const left = Math.min(...bounds.map(({ left }) => left));
    const top = Math.min(...bounds.map(({ top }) => top));
    const right = Math.max(...bounds.map(({ right }) => right));
    const bottom = Math.max(...bounds.map(({ bottom }) => bottom));
    return {
      x: Math.max(0, left - 8),
      y: Math.max(0, top - 8),
      width: right - left + 16,
      height: bottom - top + 16
    };
  })()`);
  if (!rect) throw new Error(`Could not capture missing elements ${selectors.join(", ")}`);
  const screenshot = await cdp.send("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: true,
    clip: { ...rect, scale: 1 }
  });
  await writeFile(outputPath, Buffer.from(screenshot.data, "base64"));
}

async function editorState() {
  return evaluate(`(() => {
    const root = document.querySelector(".ProseMirror");
    const selection = getSelection();
    return {
      activeElement: document.activeElement?.className || document.activeElement?.tagName || null,
      anchorText: selection?.anchorNode?.data || null,
      anchorOffset: selection?.anchorOffset ?? null,
      dirty: Boolean(document.querySelector(".dirty-dot")),
      saveDisabled: document.querySelector(".save-button")?.disabled ?? null,
      status: document.querySelector(".status-copy")?.textContent || null,
      exactSourceSelection: root?.tetherGetActiveSourceSelection?.() || null,
      text: root?.textContent || null,
      html: root?.innerHTML || null
    };
  })()`);
}

async function placeCaretInText(
  text,
  offset,
  rootSelector = ".ProseMirror",
  textRootSelector = null
) {
  const expected = JSON.stringify(text);
  const selector = JSON.stringify(rootSelector);
  const textSelector = JSON.stringify(textRootSelector);
  const installed = await waitFor(
    () => evaluate(`(() => {
      const root = document.querySelector(${selector});
      if (!root) return false;
      const textRoot = ${textSelector} ? root.querySelector(${textSelector}) : root;
      if (!textRoot) return false;
      const walker = document.createTreeWalker(textRoot, NodeFilter.SHOW_TEXT);
      const nodes = [];
      let node;
      while ((node = walker.nextNode())) nodes.push(node);
      const combined = nodes.map((candidate) => candidate.data).join("");
      const start = combined.indexOf(${expected});
      if (start < 0) return false;
      const target = start + ${offset};
      const preferFollowingBoundary = ${offset} === 0;
      let consumed = 0;
      for (let index = 0; index < nodes.length; index += 1) {
        const candidate = nodes[index];
        const end = consumed + candidate.data.length;
        if (target < end || (target === end && (!preferFollowingBoundary || index === nodes.length - 1))) {
          root.focus({ preventScroll: true });
          const range = document.createRange();
          range.setStart(candidate, target - consumed);
          range.collapse(true);
          const selection = getSelection();
          selection.removeAllRanges();
          selection.addRange(range);
          document.dispatchEvent(new Event("selectionchange"));
          return document.activeElement === root && selection.anchorNode === candidate &&
            selection.anchorOffset === target - consumed;
        }
        consumed = end;
      }
      return false;
    })()`),
    `Could not place the real editor caret inside rendered ${JSON.stringify(text)}`
  );
  if (!installed) return false;

  await delay(120);
  return waitFor(
    () => evaluate(`(() => {
      const root = document.querySelector(${selector});
      const textRoot = ${textSelector} ? root?.querySelector(${textSelector}) : root;
      const selection = getSelection();
      if (document.activeElement !== root || !textRoot || !selection.anchorNode) return false;
      const walker = document.createTreeWalker(textRoot, NodeFilter.SHOW_TEXT);
      let consumed = 0;
      let node;
      while ((node = walker.nextNode())) {
        if (node === selection.anchorNode) break;
        consumed += node.data.length;
      }
      const combined = textRoot.textContent || "";
      const start = combined.indexOf(${expected});
      return node === selection.anchorNode && consumed + selection.anchorOffset === start + ${offset};
    })()`),
    `The editor caret did not remain inside rendered ${JSON.stringify(text)}`
  );
}

async function clickElement(selector) {
  const point = await evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    return { x: rect.left + Math.min(12, rect.width / 2), y: rect.top + rect.height / 2 };
  })()`);
  if (!point) throw new Error(`Could not click missing element ${selector}`);
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, ...point });
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, ...point });
  await delay(120);
}

async function textBoundaryPoint(text, offset, rootSelector) {
  return waitFor(
    () => evaluate(`(() => {
      const root = document.querySelector(${JSON.stringify(rootSelector)});
      if (!root) return null;
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      const nodes = [];
      let node;
      while ((node = walker.nextNode())) nodes.push(node);
      const combined = nodes.map((candidate) => candidate.data).join("");
      const match = combined.indexOf(${JSON.stringify(text)});
      if (match < 0) return null;
      const target = match + ${offset};
      let consumed = 0;
      for (const candidate of nodes) {
        const end = consumed + candidate.data.length;
        if (target <= end) {
          const local = target - consumed;
          const range = document.createRange();
          if (local < candidate.data.length) {
            range.setStart(candidate, local);
            range.setEnd(candidate, local + 1);
            const rect = range.getBoundingClientRect();
            return { x: rect.left + Math.min(1, rect.width / 4), y: rect.top + rect.height / 2 };
          }
          if (!candidate.data.length) return null;
          range.setStart(candidate, candidate.data.length - 1);
          range.setEnd(candidate, candidate.data.length);
          const rect = range.getBoundingClientRect();
          return { x: rect.right - Math.min(1, rect.width / 4), y: rect.top + rect.height / 2 };
        }
        consumed = end;
      }
      return null;
    })()`),
    `Could not locate the ${JSON.stringify(text)} source boundary in ${rootSelector}`
  );
}

async function dragBetweenTextBoundaries(start, end) {
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...start });
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    button: "left",
    buttons: 1,
    clickCount: 1,
    ...start
  });
  const steps = 6;
  for (let index = 1; index <= steps; index += 1) {
    const ratio = index / steps;
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      button: "left",
      buttons: 1,
      x: start.x + (end.x - start.x) * ratio,
      y: start.y + (end.y - start.y) * ratio
    });
  }
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    button: "left",
    buttons: 0,
    clickCount: 1,
    ...end
  });
  await delay(250);
}

async function sourceControlState() {
  return evaluate(`(() => {
    const control = document.querySelector(".tether-continuous-source");
    return control ? {
      value: control.value,
      selectionStart: control.selectionStart,
      selectionEnd: control.selectionEnd,
      selectionDirection: control.selectionDirection,
      active: document.activeElement === control
    } : null;
  })()`);
}

async function waitForSourceControl(expected, message) {
  try {
    return await waitFor(async () => expected(await sourceControlState()), message);
  } catch (error) {
    const control = await sourceControlState().catch(() => null);
    const state = await editorState().catch(() => null);
    throw new Error(`${error.message}\nSource control: ${JSON.stringify(control)}\nEditor state: ${JSON.stringify(state)}`);
  }
}

async function assertSourceControlClosed(message) {
  await delay(120);
  const control = await sourceControlState();
  if (!control?.active) return;
  const state = await editorState().catch(() => null);
  throw new Error(`${message}\nSource control: ${JSON.stringify(control)}\nEditor state: ${JSON.stringify(state)}`);
}

async function dispatchKey({ key, code, virtualKeyCode, modifiers = 0 }) {
  const common = { key, code, modifiers, windowsVirtualKeyCode: virtualKeyCode };
  await cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...common });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...common });
}

async function dispatchPasteText(text) {
  return evaluate(`(() => {
    const transfer = new DataTransfer();
    transfer.setData("text/plain", ${JSON.stringify(text)});
    return document.activeElement?.dispatchEvent(new ClipboardEvent("paste", {
      bubbles: true,
      cancelable: true,
      clipboardData: transfer
    })) ?? null;
  })()`);
}

async function dispatchCutAndCaptureText() {
  await evaluate(`(document.activeElement || document).addEventListener("cut", (event) => {
    window.__tetherParityCutText = event.clipboardData?.getData("text/plain") ?? null;
  }, { once: true })`);
  const handled = await evaluate(`document.execCommand("cut")`);
  if (!handled) throw new Error("Chromium did not dispatch the Cut command");
  return evaluate(`(() => {
    const text = window.__tetherParityCutText;
    delete window.__tetherParityCutText;
    return text;
  })()`);
}

async function dispatchCopyAndCaptureText() {
  await evaluate(`(document.activeElement || document).addEventListener("copy", (event) => {
    window.__tetherParityCopyText = event.clipboardData?.getData("text/plain") ?? null;
  }, { once: true })`);
  const handled = await evaluate(`document.execCommand("copy")`);
  if (!handled) throw new Error("Chromium did not dispatch the Copy command");
  return evaluate(`(() => {
    const text = window.__tetherParityCopyText;
    delete window.__tetherParityCopyText;
    return text;
  })()`);
}

async function dispatchSyntheticClipboardAndCaptureText(type) {
  return evaluate(`(() => {
    const transfer = new DataTransfer();
    const target = document.activeElement || document;
    target.dispatchEvent(new ClipboardEvent(${JSON.stringify(type)}, {
      bubbles: true,
      cancelable: true,
      clipboardData: transfer
    }));
    return transfer.getData("text/plain");
  })()`);
}

async function waitForSavedSource(expected) {
  try {
    return await waitFor(
      async () => {
        try {
          return (await readFile(samplePath, "utf8")) === expected;
        } catch {
          return false;
        }
      },
      `saved Markdown did not become ${JSON.stringify(expected)}`
    );
  } catch (error) {
    const actual = await readFile(samplePath, "utf8").catch(() => null);
    const state = await editorState().catch(() => null);
    throw new Error(`${error.message}\nActual source: ${JSON.stringify(actual)}\nEditor state: ${JSON.stringify(state)}\nElectron output:\n${electronOutput}`);
  }
}

async function waitForSaveState(saved) {
  try {
    return await waitFor(
      () => evaluate(`document.querySelector(".save-button")?.disabled === ${saved}`),
      saved ? "editor did not finish saving" : "editor did not report an unsaved change"
    );
  } catch (error) {
    const actual = await readFile(samplePath, "utf8").catch(() => null);
    const state = await editorState().catch(() => null);
    throw new Error(`${error.message}\nActual source: ${JSON.stringify(actual)}\nEditor state: ${JSON.stringify(state)}`);
  }
}

async function waitForCompletedSave(expected) {
  await waitForSavedSource(expected);
  // The main process writes before the renderer receives the IPC response and
  // adopts the returned file as its new history baseline. Do not issue a
  // history command in that small in-flight window.
  await delay(400);
  await waitForSaveState(true);
}

async function connectRendererTarget(excludedTargetId = null) {
  const target = await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${remoteDebugPort}/json/list`);
    if (!response.ok) return null;
    const targets = await response.json();
    return targets.find((candidate) =>
      candidate.type === "page"
      && candidate.id !== excludedTargetId
      && candidate.url.includes("dist/index.html")
    );
  }, "Tether renderer did not expose a CDP target");

  cdpTargetId = target.id;
  cdp = new CdpSession(target.webSocketDebuggerUrl);
  await cdp.open();
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");
}

async function startSession(fixture, visibleText) {
  // Rotate the background-only Electron host only when explicitly requested.
  // Normal runs keep one macOS application process and replace just the hidden
  // BrowserWindow between fixtures, avoiding repeated launch-time flashes.
  if (child && sessionWindowCount >= maxWindowsPerElectronSession) {
    await stopSession(true);
  }
  electronOutput = "";
  if (!child) {
    profilePath = await mkdtemp(path.join(os.tmpdir(), "tether-editor-parity-"));
    samplePath = path.join(profilePath, "sample.md");
    remoteDebugPort = await availablePort();
    await writeFile(samplePath, fixture, "utf8");
    child = spawn(
      backgroundElectron.executable,
      [
        `--remote-debugging-port=${remoteDebugPort}`,
        `--user-data-dir=${profilePath}`,
        root
      ],
      {
        cwd: root,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
          TETHER_EDITOR_PARITY: "1"
        }
      }
    );
    for (const stream of [child.stdout, child.stderr]) {
      stream?.on("data", (chunk) => {
        electronOutput = `${electronOutput}${chunk}`.slice(-8000);
      });
    }

    await connectRendererTarget();
    await waitFor(
      () => evaluate(`typeof window.remoteMarkdown?.resetEditorParity === "function"`),
      "Tether native sample API did not become ready"
    );
  } else {
    const outgoingTargetId = cdpTargetId;
    await evaluate(`(() => {
      window.localStorage.clear();
      window.sessionStorage.clear();
      window.remoteMarkdown.resetEditorParity(${JSON.stringify(fixture)});
      return true;
    })()`);
    cdp.close();
    cdp = null;
    cdpTargetId = null;
    await connectRendererTarget(outgoingTargetId);
  }

  // Every fixture gets a clean offscreen BrowserWindow, renderer process, and
  // editor history even when the background host is reused.
  await waitFor(
    () => evaluate(`typeof window.remoteMarkdown?.saveLocalSample === "function"`),
    "Tether native sample API did not become ready"
  );
  await waitFor(
    () => evaluate(`Boolean(document.querySelector(".tether-wysiwyg.is-ready .ProseMirror") && !document.querySelector(".document-loading"))`),
    "Tether editor did not become ready"
  );
  try {
    await waitFor(
      () => evaluate(`document.querySelector(".tether-wysiwyg-host")?.tetherGetLoadedSource?.() === ${JSON.stringify(fixture)}`),
      "Tether editor did not adopt the exact fixture source"
    );
  } catch (error) {
    const actual = await evaluate(`document.querySelector(".tether-wysiwyg-host")?.tetherGetLoadedSource?.()`)
      .catch(() => null);
    throw new Error(`${error.message}; expected ${JSON.stringify(fixture)}, received ${JSON.stringify(actual)}`);
  }
  await waitFor(
    () => evaluate(`document.querySelector(".ProseMirror")?.textContent.includes(${JSON.stringify(visibleText)})`),
    `fixture did not render ${JSON.stringify(visibleText)}`
  );
  sessionWindowCount += 1;
  await delay(200);
}

async function stopSession(force = false) {
  // Individual checks call stopSession to document their isolation boundary.
  // startSession performs forced cleanup only for an explicit process-rotation
  // interval; the outermost teardown cleans up the normal single host process.
  if (!force) return;
  const sessionCdp = cdp;
  const sessionChild = child;
  const sessionProfilePath = profilePath;
  cdp = null;
  child = null;
  profilePath = null;
  samplePath = null;
  remoteDebugPort = null;
  cdpTargetId = null;
  sessionWindowCount = 0;

  try {
    await sessionCdp?.send("Browser.close");
  } catch {
    // The renderer can close the CDP socket before acknowledging Browser.close.
  }
  sessionCdp?.close();

  // Electron intentionally remains resident after its last macOS window closes.
  // Never launch the next isolated profile until this exact child has exited.
  if (!(await waitForProcessExit(sessionChild, 1000))) {
    sessionChild?.kill("SIGTERM");
    if (!(await waitForProcessExit(sessionChild, 3000))) {
      sessionChild?.kill("SIGKILL");
      await waitForProcessExit(sessionChild, 1000);
    }
  }
  if (sessionProfilePath) await rm(sessionProfilePath, { recursive: true, force: true });
}

async function verifyInlineEditing() {
  await startSession(inlineFixture, "Before bold after.");
  await placeCaretInText("bold", 2);

  await cdp.send("Input.insertText", { text: "X" });
  try {
    await waitFor(() => evaluate(`document.querySelector(".ProseMirror")?.textContent.includes("boXld")`), "typed text did not render");
  } catch (error) {
    const state = await editorState();
    throw new Error(`${error.message}\nEditor state: ${JSON.stringify(state)}\nElectron output:\n${electronOutput}`);
  }
  await dispatchKey({ key: "s", code: "KeyS", virtualKeyCode: 83, modifiers: 4 });
  await waitForCompletedSave(editedInlineFixture);

  await dispatchKey({ key: "z", code: "KeyZ", virtualKeyCode: 90, modifiers: 4 });
  await waitFor(
    () => evaluate(`!document.querySelector(".ProseMirror")?.textContent.includes("boXld")`),
    "Undo did not restore the rendered bold text"
  );
  await waitForSaveState(false);
  await dispatchKey({ key: "s", code: "KeyS", virtualKeyCode: 83, modifiers: 4 });
  await waitForCompletedSave(inlineFixture);

  await dispatchKey({ key: "z", code: "KeyZ", virtualKeyCode: 90, modifiers: 12 });
  await waitFor(
    () => evaluate(`document.querySelector(".ProseMirror")?.textContent.includes("boXld")`),
    "Redo did not restore the rendered bold edit"
  );
  await waitForSaveState(false);
  await dispatchKey({ key: "s", code: "KeyS", virtualKeyCode: 83, modifiers: 4 });
  await waitForCompletedSave(editedInlineFixture);
}

async function verifyInlineBoundaryNavigation() {
  await startSession(inlineFixture, "Before bold after.");
  await placeCaretInText(" after.", 0);
  await dispatchKey({ key: "ArrowLeft", code: "ArrowLeft", virtualKeyCode: 37 });
  await waitForSourceControl(
    (state) => state?.active && state.value === "**bold**" &&
      state.selectionStart === 7 && state.selectionEnd === 7,
    "ArrowLeft skipped the last physical inline Markdown delimiter"
  );

  await stopSession();
  await startSession(inlineFixture, "Before bold after.");
  await placeCaretInText("Before ", 7);
  await dispatchKey({ key: "ArrowRight", code: "ArrowRight", virtualKeyCode: 39 });
  await waitForSourceControl(
    (state) => state?.active && state.value === "**bold**" &&
      state.selectionStart === 1 && state.selectionEnd === 1,
    "ArrowRight skipped the first physical inline Markdown delimiter"
  );

  await dispatchKey({ key: "ArrowRight", code: "ArrowRight", virtualKeyCode: 39 });
  await dispatchKey({ key: "Backspace", code: "Backspace", virtualKeyCode: 8 });
  await waitForSourceControl(
    (state) => state?.active && state.value === "*bold**" &&
      state.selectionStart === 1 && state.selectionEnd === 1,
    "Backspace did not delete exactly one physical inline Markdown delimiter"
  );
  await waitForSaveState(false);
  await dispatchKey({ key: "s", code: "KeyS", virtualKeyCode: 83, modifiers: 4 });
  await waitForCompletedSave(deletedInlineMarkerFixture);
}

async function verifyInlineBoundaryExitNavigation() {
  const forwardExpected = "Before **bold** Xafter.\n";
  await startSession(inlineFixture, "Before bold after.");
  await placeCaretInText("Before ", "Before ".length);
  await dispatchKey({ key: "ArrowRight", code: "ArrowRight", virtualKeyCode: 39 });
  await waitForSourceControl(
    (state) => state?.active && state.value === "**bold**" &&
      state.selectionStart === 1 && state.selectionEnd === 1,
    "ArrowRight did not enter the first inline delimiter"
  );
  for (let index = 1; index < "**bold**".length; index += 1) {
    await dispatchKey({ key: "ArrowRight", code: "ArrowRight", virtualKeyCode: 39 });
  }
  await waitForSourceControl(
    (state) => state?.active && state.selectionStart === "**bold**".length &&
      state.selectionEnd === "**bold**".length,
    "inline source traversal did not reach the physical token end"
  );
  await dispatchKey({ key: "ArrowRight", code: "ArrowRight", virtualKeyCode: 39 });
  await assertSourceControlClosed("ArrowRight did not leave the inline source token");
  await cdp.send("Input.insertText", { text: "X" });
  await waitFor(
    () => evaluate(`document.querySelector(".ProseMirror")?.textContent.includes("bold Xafter.")`),
    "leaving inline source did not consume the following physical space"
  );
  await dispatchKey({ key: "s", code: "KeyS", virtualKeyCode: 83, modifiers: 4 });
  await waitForCompletedSave(forwardExpected);
  await stopSession();

  const backwardExpected = "BeforeX **bold** after.\n";
  await startSession(inlineFixture, "Before bold after.");
  await placeCaretInText(" after.", 0);
  await dispatchKey({ key: "ArrowLeft", code: "ArrowLeft", virtualKeyCode: 37 });
  await waitForSourceControl(
    (state) => state?.active && state.value === "**bold**" &&
      state.selectionStart === "**bold**".length - 1 &&
      state.selectionEnd === "**bold**".length - 1,
    "ArrowLeft did not enter the last inline delimiter"
  );
  for (let index = "**bold**".length - 1; index > 0; index -= 1) {
    await dispatchKey({ key: "ArrowLeft", code: "ArrowLeft", virtualKeyCode: 37 });
  }
  await waitForSourceControl(
    (state) => state?.active && state.selectionStart === 0 && state.selectionEnd === 0,
    "backward inline source traversal did not reach the physical token start"
  );
  await dispatchKey({ key: "ArrowLeft", code: "ArrowLeft", virtualKeyCode: 37 });
  await assertSourceControlClosed("ArrowLeft did not leave the inline source token");
  await cdp.send("Input.insertText", { text: "X" });
  await waitFor(
    () => evaluate(`document.querySelector(".ProseMirror")?.textContent.includes("BeforeX bold after.")`),
    "leaving inline source backward did not consume the preceding physical space"
  );
  await dispatchKey({ key: "s", code: "KeyS", virtualKeyCode: 83, modifiers: 4 });
  await waitForCompletedSave(backwardExpected);
  await stopSession();
}

async function verifyLiteralSourceTokens() {
  const editedEscapeFixture = "Before \\*lXiteral\\* and &copy; after.\n";
  await startSession(literalSourceFixture, "Before *literal* and © after.");
  await placeCaretInText("Before ", "Before ".length);
  await dispatchKey({ key: "ArrowRight", code: "ArrowRight", virtualKeyCode: 39 });
  await waitForSourceControl(
    (state) => state?.active && state.value === "\\*" &&
      state.selectionStart === 1 && state.selectionEnd === 1,
    "ArrowRight skipped the hidden escape character"
  );
  await dispatchKey({ key: "ArrowRight", code: "ArrowRight", virtualKeyCode: 39 });
  await dispatchKey({ key: "ArrowRight", code: "ArrowRight", virtualKeyCode: 39 });
  await assertSourceControlClosed("ArrowRight did not leave the escaped source token");
  await cdp.send("Input.insertText", { text: "X" });
  await waitFor(
    () => evaluate(`document.querySelector(".ProseMirror")?.textContent.includes("*lXiteral*")`),
    "escaped-token handoff did not consume the next physical character"
  );
  await dispatchKey({ key: "s", code: "KeyS", virtualKeyCode: 83, modifiers: 4 });
  await waitForCompletedSave(editedEscapeFixture);
  await stopSession();

  const editedEntityFixture = "Before \\*literal\\* and C after.\n";
  await startSession(literalSourceFixture, "©");
  await placeCaretInText("©", 0);
  await dispatchKey({ key: "ArrowRight", code: "ArrowRight", virtualKeyCode: 39 });
  await waitForSourceControl(
    (state) => state?.active && state.value === "&copy;" &&
      state.selectionStart === 1 && state.selectionEnd === 1,
    "ArrowRight skipped the hidden entity source"
  );
  await evaluate(`(() => {
    const control = document.querySelector(".tether-continuous-source");
    control?.setSelectionRange(0, control.value.length);
    return Boolean(control);
  })()`);
  await cdp.send("Input.insertText", { text: "C" });
  await waitForSaveState(false);
  await dispatchKey({ key: "s", code: "KeyS", virtualKeyCode: 83, modifiers: 4 });
  await waitForCompletedSave(editedEntityFixture);
  await stopSession();

  const deletedEscapeFixture = "Before *literal\\* and &copy; after.\n";
  await startSession(literalSourceFixture, "Before *literal* and © after.");
  await placeCaretInText("Before ", "Before ".length);
  await dispatchKey({ key: "Delete", code: "Delete", virtualKeyCode: 46 });
  await waitForSaveState(false);
  await dispatchKey({ key: "z", code: "KeyZ", virtualKeyCode: 90, modifiers: 4 });
  await waitForSaveState(true);
  await dispatchKey({ key: "z", code: "KeyZ", virtualKeyCode: 90, modifiers: 12 });
  await waitForSaveState(false);
  await dispatchKey({ key: "s", code: "KeyS", virtualKeyCode: 83, modifiers: 4 });
  await waitForCompletedSave(deletedEscapeFixture);
  await stopSession();

  const nestedFixture = [
    "+ Before \\*literal\\* and &copy; after.",
    "",
    "> Quoted \\*literal\\* and &copy; after.",
    ""
  ].join("\n");
  const editedNestedEscapeFixture = nestedFixture.replace("\\*literal", "\\*lXiteral");
  const listText = "Before *literal* and © after.";
  await startSession(nestedFixture, listText);
  await placeCaretInText(listText, listText.indexOf("*literal*"));
  await dispatchKey({ key: "ArrowRight", code: "ArrowRight", virtualKeyCode: 39 });
  await waitForSourceControl(
    (state) => state?.active && state.value === "\\*" && state.selectionStart === 1,
    "list ArrowRight skipped the hidden escape character"
  );
  await dispatchKey({ key: "ArrowRight", code: "ArrowRight", virtualKeyCode: 39 });
  await dispatchKey({ key: "ArrowRight", code: "ArrowRight", virtualKeyCode: 39 });
  await cdp.send("Input.insertText", { text: "X" });
  await dispatchKey({ key: "s", code: "KeyS", virtualKeyCode: 83, modifiers: 4 });
  await waitForCompletedSave(editedNestedEscapeFixture);
  await stopSession();

  const quoteText = "Quoted *literal* and © after.";
  const editedNestedEntityFixture = nestedFixture.replace("> Quoted \\*literal\\* and &copy;", "> Quoted \\*literal\\* and C");
  await startSession(nestedFixture, quoteText);
  await placeCaretInText(quoteText, quoteText.indexOf("©"));
  await dispatchKey({ key: "ArrowRight", code: "ArrowRight", virtualKeyCode: 39 });
  await waitForSourceControl(
    (state) => state?.active && state.value === "&copy;" && state.selectionStart === 1,
    "blockquote ArrowRight skipped the hidden entity source"
  );
  await evaluate(`(() => {
    const control = document.querySelector(".tether-continuous-source");
    control?.setSelectionRange(0, control.value.length);
    return Boolean(control);
  })()`);
  await cdp.send("Input.insertText", { text: "C" });
  await dispatchKey({ key: "s", code: "KeyS", virtualKeyCode: 83, modifiers: 4 });
  await waitForCompletedSave(editedNestedEntityFixture);
  await stopSession();

  const headingFixture = "## Head &copy; and \\*literal\\* ##\n";
  const editedHeadingFixture = "## Head &copy; and \\*lXiteral\\* ##\n";
  const headingText = "Head © and *literal*";
  await startSession(headingFixture, headingText);
  await placeCaretInText(headingText, headingText.indexOf("*literal*"));
  await dispatchKey({ key: "ArrowRight", code: "ArrowRight", virtualKeyCode: 39 });
  await waitForSourceControl(
    (state) => state?.active && state.value === "\\*" && state.selectionStart === 1,
    "heading ArrowRight skipped the hidden escape character"
  );
  await dispatchKey({ key: "ArrowRight", code: "ArrowRight", virtualKeyCode: 39 });
  await dispatchKey({ key: "ArrowRight", code: "ArrowRight", virtualKeyCode: 39 });
  await cdp.send("Input.insertText", { text: "X" });
  await dispatchKey({ key: "s", code: "KeyS", virtualKeyCode: 83, modifiers: 4 });
  await waitForCompletedSave(editedHeadingFixture);
  await stopSession();

  const mixedFixture = "Before **bold** and &copy; plus \\*literal\\* after.\n";
  const editedMixedFixture = "Before **bold** and &copy; plus \\*lXiteral\\* after.\n";
  const mixedText = "Before bold and © plus *literal* after.";
  await startSession(mixedFixture, mixedText);
  await placeCaretInText(mixedText, mixedText.indexOf("*literal*"));
  await dispatchKey({ key: "ArrowRight", code: "ArrowRight", virtualKeyCode: 39 });
  await waitForSourceControl(
    (state) => state?.active && state.value === "\\*" && state.selectionStart === 1,
    "mixed paragraph ArrowRight skipped the hidden escape character"
  );
  await dispatchKey({ key: "ArrowRight", code: "ArrowRight", virtualKeyCode: 39 });
  await dispatchKey({ key: "ArrowRight", code: "ArrowRight", virtualKeyCode: 39 });
  await cdp.send("Input.insertText", { text: "X" });
  await dispatchKey({ key: "s", code: "KeyS", virtualKeyCode: 83, modifiers: 4 });
  await waitForCompletedSave(editedMixedFixture);
  await stopSession();
}

async function verifyInlineConstructBoundaries() {
  for (const fixture of inlineBoundaryFixtures) {
    const markdown = `Before ${fixture.source} after.\n${fixture.suffix || ""}`;
    await startSession(markdown, "Before ");
    await placeCaretInText("Before ", "Before ".length - 2);
    await dispatchKey({ key: "ArrowRight", code: "ArrowRight", virtualKeyCode: 39 });
    await dispatchKey({ key: "ArrowRight", code: "ArrowRight", virtualKeyCode: 39 });
    await assertSourceControlClosed(
      `ArrowRight skipped the rendered boundary before ${fixture.name}`
    );
    await dispatchKey({ key: "ArrowRight", code: "ArrowRight", virtualKeyCode: 39 });
    await waitForSourceControl(
      (state) => state?.active && state.value === fixture.source &&
        state.selectionStart === 1 && state.selectionEnd === 1,
      `ArrowRight skipped the first physical ${fixture.name} source character`
    );
    await stopSession();

    await startSession(markdown, " after.");
    // Enter the boundary through a normal text movement. A collapsed DOM Range
    // placed directly beside a non-editable atom is ambiguous to ProseMirror's
    // virtual-cursor plugin and can be biased to the atom's other side.
    await placeCaretInText(" after.", 2);
    await dispatchKey({ key: "ArrowLeft", code: "ArrowLeft", virtualKeyCode: 37 });
    await dispatchKey({ key: "ArrowLeft", code: "ArrowLeft", virtualKeyCode: 37 });
    await assertSourceControlClosed(
      `ArrowLeft skipped the rendered boundary after ${fixture.name}`
    );
    await dispatchKey({ key: "ArrowLeft", code: "ArrowLeft", virtualKeyCode: 37 });
    await waitForSourceControl(
      (state) => state?.active && state.value === fixture.source &&
        state.selectionStart === fixture.source.length - 1 &&
        state.selectionEnd === fixture.source.length - 1,
      `ArrowLeft skipped the last physical ${fixture.name} source character`
    );
    await stopSession();
  }
}

async function verifyInlineConstructDeletion() {
  for (const fixture of inlineBoundaryFixtures) {
    const suffix = fixture.suffix || "";
    const markdown = `Before ${fixture.source} after.\n${suffix}`;
    const forwardSource = fixture.source.slice(1);
    const forwardMarkdown = `Before ${forwardSource} after.\n${suffix}`;
    await startSession(markdown, "Before ");
    await placeCaretInText("Before ", "Before ".length - 2);
    await dispatchKey({ key: "ArrowRight", code: "ArrowRight", virtualKeyCode: 39 });
    await dispatchKey({ key: "ArrowRight", code: "ArrowRight", virtualKeyCode: 39 });
    await assertSourceControlClosed(
      `Delete setup skipped the rendered boundary before ${fixture.name}`
    );
    await dispatchKey({ key: "Delete", code: "Delete", virtualKeyCode: 46 });
    await waitForSourceControl(
      (state) => state?.active && state.value === forwardSource &&
        state.selectionStart === 0 && state.selectionEnd === 0,
      `Delete did not remove exactly the first physical ${fixture.name} source character`
    );
    await waitForSaveState(false);
    if (fixture.name === "emphasis") {
      await dispatchKey({ key: "z", code: "KeyZ", virtualKeyCode: 90, modifiers: 4 });
      await waitForSourceControl(
        (state) => state?.active && state.value === fixture.source,
        "Undo did not restore an activation-time source deletion"
      );
      await waitForSaveState(true);
      await dispatchKey({ key: "z", code: "KeyZ", virtualKeyCode: 90, modifiers: 12 });
      await waitForSourceControl(
        (state) => state?.active && state.value === forwardSource,
        "Redo did not restore an activation-time source deletion"
      );
      await waitForSaveState(false);
    }
    await dispatchKey({ key: "s", code: "KeyS", virtualKeyCode: 83, modifiers: 4 });
    await waitForCompletedSave(forwardMarkdown);
    await stopSession();

    const backwardSource = fixture.source.slice(0, -1);
    const backwardMarkdown = `Before ${backwardSource} after.\n${suffix}`;
    await startSession(markdown, " after.");
    await placeCaretInText(" after.", 2);
    await dispatchKey({ key: "ArrowLeft", code: "ArrowLeft", virtualKeyCode: 37 });
    await dispatchKey({ key: "ArrowLeft", code: "ArrowLeft", virtualKeyCode: 37 });
    await assertSourceControlClosed(
      `Backspace setup skipped the rendered boundary after ${fixture.name}`
    );
    await dispatchKey({ key: "Backspace", code: "Backspace", virtualKeyCode: 8 });
    await waitForSourceControl(
      (state) => state?.active && state.value === backwardSource &&
        state.selectionStart === backwardSource.length &&
        state.selectionEnd === backwardSource.length,
      `Backspace did not remove exactly the last physical ${fixture.name} source character`
    );
    await waitForSaveState(false);
    await dispatchKey({ key: "s", code: "KeyS", virtualKeyCode: 83, modifiers: 4 });
    await waitForCompletedSave(backwardMarkdown);
    await stopSession();
  }
}

async function verifyInlineCrossBoundarySelection() {
  const source = "[guide](https://example.com)";
  const markdown = `Before ${source} after.\n`;
  await startSession(markdown, "Before ");
  await placeCaretInText("Before ", "Before ".length - 2);
  await dispatchKey({ key: "ArrowRight", code: "ArrowRight", virtualKeyCode: 39 });
  await dispatchKey({ key: "ArrowRight", code: "ArrowRight", virtualKeyCode: 39 });
  await assertSourceControlClosed("Link selection setup skipped its rendered start boundary");
  await dispatchKey({ key: "ArrowRight", code: "ArrowRight", virtualKeyCode: 39 });
  await waitForSourceControl(
    (state) => state?.active && state.selectionStart === 1 && state.selectionEnd === 1,
    "Link source did not finish forward boundary activation"
  );
  await dispatchKey({ key: "ArrowLeft", code: "ArrowLeft", virtualKeyCode: 37, modifiers: 8 });
  await waitForSourceControl(
    (state) => state?.active && state.selectionStart === 0 && state.selectionEnd === 1 &&
      state.selectionDirection === "backward",
    "Shift-ArrowLeft did not select the first hidden link source character"
  );
  await dispatchKey({ key: "ArrowLeft", code: "ArrowLeft", virtualKeyCode: 37, modifiers: 8 });
  await waitFor(
    async () => !(await sourceControlState()),
    "Link selection did not cross from hidden source into preceding rendered text"
  );
  await dispatchKey({ key: "Backspace", code: "Backspace", virtualKeyCode: 8 });
  await waitForSaveState(false);
  const backwardDeleted = `Before${source.slice(1)} after.\n`;
  await dispatchKey({ key: "s", code: "KeyS", virtualKeyCode: 83, modifiers: 4 });
  await waitForCompletedSave(backwardDeleted);
  await stopSession();

  await startSession(markdown, " after.");
  await placeCaretInText(" after.", 2);
  await dispatchKey({ key: "ArrowLeft", code: "ArrowLeft", virtualKeyCode: 37 });
  await dispatchKey({ key: "ArrowLeft", code: "ArrowLeft", virtualKeyCode: 37 });
  await assertSourceControlClosed("Link selection setup skipped its rendered end boundary");
  await dispatchKey({ key: "ArrowLeft", code: "ArrowLeft", virtualKeyCode: 37 });
  await waitForSourceControl(
    (state) => state?.active && state.selectionStart === source.length - 1 &&
      state.selectionEnd === source.length - 1,
    "Link source did not finish backward boundary activation"
  );
  await dispatchKey({ key: "ArrowRight", code: "ArrowRight", virtualKeyCode: 39, modifiers: 8 });
  await waitForSourceControl(
    (state) => state?.active && state.selectionStart === source.length - 1 &&
      state.selectionEnd === source.length && state.selectionDirection === "forward",
    "Shift-ArrowRight did not select the last hidden link source character"
  );
  await dispatchKey({ key: "ArrowRight", code: "ArrowRight", virtualKeyCode: 39, modifiers: 8 });
  await waitFor(
    async () => !(await sourceControlState()),
    "Link selection did not cross from hidden source into following rendered text"
  );
  await dispatchKey({ key: "Delete", code: "Delete", virtualKeyCode: 46 });
  await waitForSaveState(false);
  const forwardDeleted = `Before ${source.slice(0, -1)}after.\n`;
  await dispatchKey({ key: "s", code: "KeyS", virtualKeyCode: 83, modifiers: 4 });
  await waitForCompletedSave(forwardDeleted);
  await stopSession();
}

async function verifyInlineSourceEnterHistory() {
  const source = "[guide](https://example.com)";
  const markdown = `Before ${source} after.\n`;
  const splitOffset = source.indexOf("example") + "exam".length;
  const splitSource = `${source.slice(0, splitOffset)}\n${source.slice(splitOffset)}`;
  const splitMarkdown = `Before ${splitSource} after.\n`;
  const save = async (expected) => {
    await dispatchKey({ key: "s", code: "KeyS", virtualKeyCode: 83, modifiers: 4 });
    await waitForCompletedSave(expected);
  };

  await startSession(markdown, "Before ");
  await placeCaretInText("Before ", "Before ".length - 2);
  await dispatchKey({ key: "ArrowRight", code: "ArrowRight", virtualKeyCode: 39 });
  await dispatchKey({ key: "ArrowRight", code: "ArrowRight", virtualKeyCode: 39 });
  await dispatchKey({ key: "ArrowRight", code: "ArrowRight", virtualKeyCode: 39 });
  await waitForSourceControl(
    (state) => state?.active && state.value === source,
    "Link source did not activate before its hidden-destination Enter edit"
  );
  await evaluate(`(() => {
    const control = document.querySelector(".tether-continuous-source");
    control?.setSelectionRange(${splitOffset}, ${splitOffset});
    return Boolean(control);
  })()`);
  await dispatchKey({ key: "Enter", code: "Enter", virtualKeyCode: 13 });
  await assertSourceControlClosed("Enter inside a link destination left its source control open");
  await waitForSaveState(false);
  await save(splitMarkdown);

  await dispatchKey({ key: "z", code: "KeyZ", virtualKeyCode: 90, modifiers: 4 });
  await waitForSaveState(false);
  await save(markdown);
  await dispatchKey({ key: "z", code: "KeyZ", virtualKeyCode: 90, modifiers: 12 });
  await waitForSaveState(false);
  await save(splitMarkdown);
  await stopSession();

  const crlfMarkdown = `Before ${source} after.\r\n`;
  const selectionStart = source.indexOf("example");
  const selectionEnd = selectionStart + "example".length;
  const selectedReplacement = `${source.slice(0, selectionStart)}\r\n${source.slice(selectionEnd)}`;
  const crlfSplitMarkdown = `Before ${selectedReplacement} after.\r\n`;
  await startSession(crlfMarkdown, "Before ");
  await placeCaretInText("Before ", "Before ".length - 2);
  await dispatchKey({ key: "ArrowRight", code: "ArrowRight", virtualKeyCode: 39 });
  await dispatchKey({ key: "ArrowRight", code: "ArrowRight", virtualKeyCode: 39 });
  await dispatchKey({ key: "ArrowRight", code: "ArrowRight", virtualKeyCode: 39 });
  await waitForSourceControl(
    (state) => state?.active && state.value === source,
    "CRLF link source did not activate before its selected Enter edit"
  );
  await evaluate(`(() => {
    const control = document.querySelector(".tether-continuous-source");
    control?.setSelectionRange(${selectionStart}, ${selectionEnd});
    return Boolean(control);
  })()`);
  await dispatchKey({ key: "Enter", code: "Enter", virtualKeyCode: 13 });
  await assertSourceControlClosed("Enter over selected CRLF link source left its control open");
  await waitForSaveState(false);
  await save(crlfSplitMarkdown);
  await stopSession();
}

async function verifyInlineSourceMultilinePasteHistory() {
  const source = "[guide](https://example.com)";
  const markdown = `Before ${source} after.\n`;
  const selectionStart = source.indexOf("example");
  const selectionEnd = selectionStart + "example".length;
  const pastedText = "first\nsecond";
  const pastedSource = `${source.slice(0, selectionStart)}${pastedText}${source.slice(selectionEnd)}`;
  const pastedMarkdown = `Before ${pastedSource} after.\n`;
  const save = async (expected) => {
    await dispatchKey({ key: "s", code: "KeyS", virtualKeyCode: 83, modifiers: 4 });
    await waitForCompletedSave(expected);
  };

  await startSession(markdown, "Before ");
  await placeCaretInText("Before ", "Before ".length - 2);
  await dispatchKey({ key: "ArrowRight", code: "ArrowRight", virtualKeyCode: 39 });
  await dispatchKey({ key: "ArrowRight", code: "ArrowRight", virtualKeyCode: 39 });
  await dispatchKey({ key: "ArrowRight", code: "ArrowRight", virtualKeyCode: 39 });
  await waitForSourceControl(
    (state) => state?.active && state.value === source,
    "Link source did not activate before multiline Paste"
  );
  await evaluate(`(() => {
    const control = document.querySelector(".tether-continuous-source");
    control?.setSelectionRange(${selectionStart}, ${selectionEnd});
    return Boolean(control);
  })()`);
  if (await dispatchPasteText(pastedText) == null) {
    throw new Error("No hidden inline source control received multiline Paste");
  }
  await waitForSaveState(false);
  await save(pastedMarkdown);
  await dispatchKey({ key: "z", code: "KeyZ", virtualKeyCode: 90, modifiers: 4 });
  await waitForSaveState(false);
  await save(markdown);
  await dispatchKey({ key: "z", code: "KeyZ", virtualKeyCode: 90, modifiers: 12 });
  await waitForSaveState(false);
  await save(pastedMarkdown);
  await stopSession();

  const crlfMarkdown = `Before ${source} after.\r\n`;
  const crlfOffset = source.indexOf("example") + "exam".length;
  const crlfPaste = "A\r\nB";
  const crlfSource = `${source.slice(0, crlfOffset)}${crlfPaste}${source.slice(crlfOffset)}`;
  const crlfPastedMarkdown = `Before ${crlfSource} after.\r\n`;
  await startSession(crlfMarkdown, "Before ");
  await placeCaretInText("Before ", "Before ".length - 2);
  await dispatchKey({ key: "ArrowRight", code: "ArrowRight", virtualKeyCode: 39 });
  await dispatchKey({ key: "ArrowRight", code: "ArrowRight", virtualKeyCode: 39 });
  await dispatchKey({ key: "ArrowRight", code: "ArrowRight", virtualKeyCode: 39 });
  await waitForSourceControl(
    (state) => state?.active && state.value === source,
    "CRLF link source did not activate before multiline Paste"
  );
  await evaluate(`(() => {
    const control = document.querySelector(".tether-continuous-source");
    control?.setSelectionRange(${crlfOffset}, ${crlfOffset});
    return Boolean(control);
  })()`);
  if (await dispatchPasteText(crlfPaste) == null) {
    throw new Error("No hidden inline source control received CRLF Paste");
  }
  await waitForSaveState(false);
  await save(crlfPastedMarkdown);
  await stopSession();
}

async function verifyInlineSourceLineJumps() {
  const source = "[guide](https://example.com)";
  const markdown = `Before ${source} after.\n`;
  const localCaret = source.indexOf("example") + "exam".length;
  const documentCaret = "Before ".length + localCaret;
  const lineEnd = markdown.length - 1;
  const activateAtCaret = async () => {
    await startSession(markdown, "Before ");
    await placeCaretInText("Before ", "Before ".length - 2);
    await dispatchKey({ key: "ArrowRight", code: "ArrowRight", virtualKeyCode: 39 });
    await dispatchKey({ key: "ArrowRight", code: "ArrowRight", virtualKeyCode: 39 });
    await dispatchKey({ key: "ArrowRight", code: "ArrowRight", virtualKeyCode: 39 });
    await waitForSourceControl(
      (state) => state?.active && state.value === source,
      "Link source did not activate before its physical line jump"
    );
    await evaluate(`(() => {
      const control = document.querySelector(".tether-continuous-source");
      control?.setSelectionRange(${localCaret}, ${localCaret});
      return Boolean(control);
    })()`);
  };
  const save = async (expected) => {
    await dispatchKey({ key: "s", code: "KeyS", virtualKeyCode: 83, modifiers: 4 });
    await waitForCompletedSave(expected);
  };

  await activateAtCaret();
  await dispatchKey({ key: "Home", code: "Home", virtualKeyCode: 36 });
  await assertSourceControlClosed("Home stopped at the inline token instead of the Markdown line start");
  await cdp.send("Input.insertText", { text: "X" });
  await waitForSaveState(false);
  await save(`X${markdown}`);
  await stopSession();

  await activateAtCaret();
  await dispatchKey({ key: "ArrowLeft", code: "ArrowLeft", virtualKeyCode: 37, modifiers: 4 });
  await assertSourceControlClosed("Cmd-Left stopped at the inline token instead of the Markdown line start");
  await cdp.send("Input.insertText", { text: "X" });
  await waitForSaveState(false);
  await save(`X${markdown}`);
  await stopSession();

  await activateAtCaret();
  await dispatchKey({ key: "End", code: "End", virtualKeyCode: 35 });
  await assertSourceControlClosed("End stopped at the inline token instead of the Markdown line end");
  await cdp.send("Input.insertText", { text: "X" });
  await waitForSaveState(false);
  await save(`${markdown.slice(0, lineEnd)}X\n`);
  await stopSession();

  await activateAtCaret();
  await dispatchKey({ key: "Home", code: "Home", virtualKeyCode: 36, modifiers: 8 });
  await waitFor(async () => {
    const exact = (await editorState()).exactSourceSelection;
    return exact?.anchor === documentCaret && exact?.head === 0 && exact?.fullSource === markdown;
  }, "Shift-Home did not select from hidden link source to the physical line start");
  const backwardCopy = await dispatchCopyAndCaptureText();
  if (backwardCopy !== markdown.slice(0, documentCaret)) {
    throw new Error(`Shift-Home Copy emitted ${JSON.stringify(backwardCopy)}`);
  }
  await stopSession();

  await activateAtCaret();
  await dispatchKey({ key: "End", code: "End", virtualKeyCode: 35, modifiers: 8 });
  await waitFor(async () => {
    const exact = (await editorState()).exactSourceSelection;
    return exact?.anchor === documentCaret && exact?.head === lineEnd && exact?.fullSource === markdown;
  }, "Shift-End did not select from hidden link source to the physical line end");
  const forwardCopy = await dispatchCopyAndCaptureText();
  if (forwardCopy !== markdown.slice(documentCaret, lineEnd)) {
    throw new Error(`Shift-End Copy emitted ${JSON.stringify(forwardCopy)}`);
  }
  await stopSession();

  await activateAtCaret();
  await dispatchKey({
    key: "ArrowRight",
    code: "ArrowRight",
    virtualKeyCode: 39,
    modifiers: 12
  });
  await waitFor(async () => {
    const exact = (await editorState()).exactSourceSelection;
    return exact?.anchor === documentCaret && exact?.head === lineEnd && exact?.fullSource === markdown;
  }, "Shift-Cmd-Right did not select from hidden link source to the physical line end");
  const commandCopy = await dispatchCopyAndCaptureText();
  if (commandCopy !== markdown.slice(documentCaret, lineEnd)) {
    throw new Error(`Shift-Cmd-Right Copy emitted ${JSON.stringify(commandCopy)}`);
  }
  await stopSession();
}

async function verifyInlineSourceTabHistory() {
  const source = "[guide](https://example.com)";
  const markdown = `Before ${source} after.\n`;
  const localCaret = source.indexOf("example") + "exam".length;
  const tabbedSource = `${source.slice(0, localCaret)}\t${source.slice(localCaret)}`;
  const tabbedMarkdown = `Before ${tabbedSource} after.\n`;
  const activate = async (fixture = markdown, visible = "Before ") => {
    await startSession(fixture, visible);
    await placeCaretInText(visible, visible.length - 2);
    await dispatchKey({ key: "ArrowRight", code: "ArrowRight", virtualKeyCode: 39 });
    await dispatchKey({ key: "ArrowRight", code: "ArrowRight", virtualKeyCode: 39 });
    await dispatchKey({ key: "ArrowRight", code: "ArrowRight", virtualKeyCode: 39 });
    await waitForSourceControl(
      (state) => state?.active && state.value === source,
      "Link source did not activate before its source-native Tab edit"
    );
  };
  const save = async (expected) => {
    await dispatchKey({ key: "s", code: "KeyS", virtualKeyCode: 83, modifiers: 4 });
    await waitForCompletedSave(expected);
  };

  await activate();
  await evaluate(`(() => {
    const control = document.querySelector(".tether-continuous-source");
    control?.setSelectionRange(${localCaret}, ${localCaret});
    return Boolean(control);
  })()`);
  await dispatchKey({ key: "Tab", code: "Tab", virtualKeyCode: 9 });
  await waitForSaveState(false);
  await save(tabbedMarkdown);
  await dispatchKey({ key: "z", code: "KeyZ", virtualKeyCode: 90, modifiers: 4 });
  await waitForSaveState(false);
  await save(markdown);
  await dispatchKey({ key: "z", code: "KeyZ", virtualKeyCode: 90, modifiers: 12 });
  await waitForSaveState(false);
  await save(tabbedMarkdown);
  await stopSession();

  const selectionStart = source.indexOf("example");
  const selectionEnd = selectionStart + "example".length;
  await activate();
  await evaluate(`(() => {
    const control = document.querySelector(".tether-continuous-source");
    control?.setSelectionRange(${selectionStart}, ${selectionEnd});
    return Boolean(control);
  })()`);
  await dispatchKey({ key: "Tab", code: "Tab", virtualKeyCode: 9 });
  await waitForSaveState(false);
  await save(`\t${markdown}`);
  await stopSession();

  const indentedMarkdown = `   ${markdown}`;
  await activate(indentedMarkdown, "Before ");
  await evaluate(`(() => {
    const control = document.querySelector(".tether-continuous-source");
    control?.setSelectionRange(${localCaret}, ${localCaret});
    return Boolean(control);
  })()`);
  await dispatchKey({ key: "Tab", code: "Tab", virtualKeyCode: 9, modifiers: 8 });
  await waitForSaveState(false);
  await save(markdown);
  await stopSession();
}

async function verifySourceWordDeletionHistory() {
  const source = "**bold**";
  const markdown = `Before ${source} after.\n`;
  const deletedPrefix = `${source} after.\n`;
  const save = async (expected) => {
    await dispatchKey({ key: "s", code: "KeyS", virtualKeyCode: 83, modifiers: 4 });
    await waitForCompletedSave(expected);
  };
  const activateInlineStart = async () => {
    await startSession(markdown, "Before ");
    await placeCaretInText("Before ", "Before ".length - 2);
    await dispatchKey({ key: "ArrowRight", code: "ArrowRight", virtualKeyCode: 39 });
    await dispatchKey({ key: "ArrowRight", code: "ArrowRight", virtualKeyCode: 39 });
    await dispatchKey({ key: "ArrowRight", code: "ArrowRight", virtualKeyCode: 39 });
    await waitForSourceControl(
      (state) => state?.active && state.value === source,
      "Strong source did not activate before word deletion"
    );
  };

  await activateInlineStart();
  await evaluate(`(() => {
    const control = document.querySelector(".tether-continuous-source");
    control?.setSelectionRange(0, 0);
    return Boolean(control);
  })()`);
  await dispatchKey({ key: "Backspace", code: "Backspace", virtualKeyCode: 8, modifiers: 1 });
  await waitForSaveState(false);
  await save(deletedPrefix);
  await dispatchKey({ key: "z", code: "KeyZ", virtualKeyCode: 90, modifiers: 4 });
  await waitForSaveState(false);
  await save(markdown);
  await dispatchKey({ key: "z", code: "KeyZ", virtualKeyCode: 90, modifiers: 12 });
  await waitForSaveState(false);
  await save(deletedPrefix);
  await stopSession();

  await startSession(markdown, "Before ");
  await placeCaretInText("Before ", "Before ".length - 2);
  await dispatchKey({ key: "ArrowRight", code: "ArrowRight", virtualKeyCode: 39 });
  await dispatchKey({ key: "ArrowRight", code: "ArrowRight", virtualKeyCode: 39 });
  await assertSourceControlClosed("Word-delete setup skipped the rendered strong boundary");
  await dispatchKey({ key: "Delete", code: "Delete", virtualKeyCode: 46, modifiers: 1 });
  await waitForSaveState(false);
  await save("Before bold** after.\n");
  await stopSession();

  const infoStart = codeBlockSource.indexOf("js");
  const codeWithoutInfo = `${codeBlockSource.slice(0, infoStart)}${
    codeBlockSource.slice(infoStart + "js".length)
  }`;
  await startSession(codeFixture, codeContent);
  await focusCodeBoundary("start");
  await dispatchKey({ key: "ArrowLeft", code: "ArrowLeft", virtualKeyCode: 37 });
  await waitForSourceControl(
    (state) => state?.active && state.value === codeBlockSource,
    "Fenced source did not activate before word deletion"
  );
  await evaluate(`(() => {
    const control = document.querySelector(".tether-continuous-source");
    control?.setSelectionRange(${infoStart}, ${infoStart});
    return Boolean(control);
  })()`);
  await dispatchKey({ key: "Delete", code: "Delete", virtualKeyCode: 46, modifiers: 1 });
  await waitForSaveState(false);
  await save(codeFixture.replace(codeBlockSource, codeWithoutInfo));
  await stopSession();
}

async function verifySourceLineDeletionHistory() {
  const source = "**bold**";
  const markdown = `Before ${source} after.\n`;
  const save = async (expected) => {
    await dispatchKey({ key: "s", code: "KeyS", virtualKeyCode: 83, modifiers: 4 });
    await waitForCompletedSave(expected);
  };
  const activateInline = async () => {
    await startSession(markdown, "Before ");
    await placeCaretInText("Before ", "Before ".length - 2);
    await dispatchKey({ key: "ArrowRight", code: "ArrowRight", virtualKeyCode: 39 });
    await dispatchKey({ key: "ArrowRight", code: "ArrowRight", virtualKeyCode: 39 });
    await dispatchKey({ key: "ArrowRight", code: "ArrowRight", virtualKeyCode: 39 });
    await waitForSourceControl(
      (state) => state?.active && state.value === source,
      "Strong source did not activate before line deletion"
    );
  };

  await activateInline();
  await evaluate(`(() => {
    const control = document.querySelector(".tether-continuous-source");
    control?.setSelectionRange(4, 4);
    return Boolean(control);
  })()`);
  await dispatchKey({ key: "Backspace", code: "Backspace", virtualKeyCode: 8, modifiers: 4 });
  await waitForSaveState(false);
  const linePrefixDeleted = "ld** after.\n";
  await save(linePrefixDeleted);
  await dispatchKey({ key: "z", code: "KeyZ", virtualKeyCode: 90, modifiers: 4 });
  await waitForSaveState(false);
  await save(markdown);
  await dispatchKey({ key: "z", code: "KeyZ", virtualKeyCode: 90, modifiers: 12 });
  await waitForSaveState(false);
  await save(linePrefixDeleted);
  await stopSession();

  await startSession(markdown, "Before ");
  await placeCaretInText("Before ", 3);
  await dispatchKey({ key: "Delete", code: "Delete", virtualKeyCode: 46, modifiers: 4 });
  await waitForSaveState(false);
  await save("Bef\n");
  await stopSession();

  const contentStart = codeBlockSource.indexOf("\n") + 1;
  const lineCaret = contentStart + "const ".length;
  const lineDeletedBlock = `${codeBlockSource.slice(0, contentStart)}${
    codeBlockSource.slice(lineCaret)
  }`;
  await startSession(codeFixture, codeContent);
  await focusCodeBoundary("start");
  await dispatchKey({ key: "ArrowLeft", code: "ArrowLeft", virtualKeyCode: 37 });
  await waitForSourceControl(
    (state) => state?.active && state.value === codeBlockSource,
    "Fenced source did not activate before line deletion"
  );
  await evaluate(`(() => {
    const control = document.querySelector(".tether-continuous-source");
    control?.setSelectionRange(${lineCaret}, ${lineCaret});
    return Boolean(control);
  })()`);
  await dispatchKey({ key: "Backspace", code: "Backspace", virtualKeyCode: 8, modifiers: 4 });
  await waitForSaveState(false);
  await save(codeFixture.replace(codeBlockSource, lineDeletedBlock));
  await stopSession();

  const withoutOpeningNewline = `${codeBlockSource.slice(0, contentStart - 1)}${
    codeBlockSource.slice(contentStart)
  }`;
  await startSession(codeFixture, codeContent);
  await focusCodeBoundary("start");
  await dispatchKey({ key: "ArrowLeft", code: "ArrowLeft", virtualKeyCode: 37 });
  await waitForSourceControl(
    (state) => state?.active && state.value === codeBlockSource,
    "Fenced source did not reactivate before boundary word deletion"
  );
  await evaluate(`(() => {
    const control = document.querySelector(".tether-continuous-source");
    control?.setSelectionRange(${contentStart}, ${contentStart});
    return Boolean(control);
  })()`);
  await dispatchKey({ key: "Backspace", code: "Backspace", virtualKeyCode: 8, modifiers: 1 });
  await waitForSaveState(false);
  await save(codeFixture.replace(codeBlockSource, withoutOpeningNewline));
  await stopSession();
}

async function verifySourceControlSelectAllHistory() {
  const source = "**bold**";
  const markdown = `Before ${source} after.\n`;
  const editedMarkdown = "Before **boXld** after.\n";
  const replacement = "Replacement";
  const save = async (expected) => {
    await dispatchKey({ key: "s", code: "KeyS", virtualKeyCode: 83, modifiers: 4 });
    await waitForCompletedSave(expected);
  };
  const waitForFullSourceSelection = async (expected, message) => {
    await waitFor(
      () => evaluate(`(() => {
        const selection = document.querySelector(".ProseMirror")?.tetherGetActiveSourceSelection?.();
        return selection?.fullSource === ${JSON.stringify(expected)}
          && Math.min(selection.anchor, selection.head) === 0
          && Math.max(selection.anchor, selection.head) === ${expected.length};
      })()`),
      message
    );
  };

  await startSession(markdown, "Before ");
  await placeCaretInText("Before ", "Before ".length - 2);
  await dispatchKey({ key: "ArrowRight", code: "ArrowRight", virtualKeyCode: 39 });
  await dispatchKey({ key: "ArrowRight", code: "ArrowRight", virtualKeyCode: 39 });
  await dispatchKey({ key: "ArrowRight", code: "ArrowRight", virtualKeyCode: 39 });
  await waitForSourceControl(
    (state) => state?.active && state.value === source,
    "Strong source did not activate before Select All"
  );
  await evaluate(`(() => {
    const control = document.querySelector(".tether-continuous-source");
    control?.setSelectionRange(4, 4);
    return Boolean(control);
  })()`);
  await cdp.send("Input.insertText", { text: "X" });
  await waitForSourceControl(
    (state) => state?.active && state.value === "**boXld**",
    "Inline source edit did not settle before Select All"
  );
  await dispatchKey({ key: "a", code: "KeyA", virtualKeyCode: 65, modifiers: 4 });
  await waitForFullSourceSelection(
    editedMarkdown,
    "Inline-source Select All did not claim the edited physical Markdown document"
  );
  const copiedInline = await dispatchCopyAndCaptureText();
  if (copiedInline !== editedMarkdown) {
    throw new Error(
      `Inline-source Select All Copy emitted ${JSON.stringify(copiedInline)} instead of ${JSON.stringify(editedMarkdown)}`
    );
  }
  await waitForSaveState(false);
  await save(editedMarkdown);
  await cdp.send("Input.insertText", { text: replacement });
  await waitForSaveState(false);
  await save(replacement);
  await dispatchKey({ key: "z", code: "KeyZ", virtualKeyCode: 90, modifiers: 4 });
  await waitForSaveState(false);
  await save(editedMarkdown);
  await dispatchKey({ key: "z", code: "KeyZ", virtualKeyCode: 90, modifiers: 12 });
  await waitForSaveState(false);
  await save(replacement);
  await stopSession();

  await startSession(codeFixture, codeContent);
  await focusCodeBoundary("start");
  await dispatchKey({ key: "ArrowLeft", code: "ArrowLeft", virtualKeyCode: 37 });
  await waitForSourceControl(
    (state) => state?.active && state.value === codeBlockSource,
    "Fenced source did not activate before Select All"
  );
  await dispatchKey({ key: "a", code: "KeyA", virtualKeyCode: 65, modifiers: 4 });
  await waitForFullSourceSelection(
    codeFixture,
    "Block-source Select All did not claim the complete physical Markdown document"
  );
  const copiedBlock = await dispatchCopyAndCaptureText();
  if (copiedBlock !== codeFixture) {
    throw new Error(
      `Block-source Select All Copy emitted ${JSON.stringify(copiedBlock)} instead of ${JSON.stringify(codeFixture)}`
    );
  }
  await stopSession();
}

async function focusCodeBoundary(edge) {
  await waitFor(
    () => evaluate(`Boolean(document.querySelector(".milkdown-code-block .cm-content"))`),
    "rendered code editor did not become ready"
  );
  await clickElement(".milkdown-code-block .cm-content");
  await waitFor(
    () => evaluate(`document.activeElement?.matches?.(".cm-content")`),
    "pointer activation did not focus the rendered code editor"
  );
  await dispatchKey({
    key: edge === "start" ? "Home" : "End",
    code: edge === "start" ? "Home" : "End",
    virtualKeyCode: edge === "start" ? 36 : 35
  });
}

async function verifyCodeBoundaryNavigation() {
  const contentStart = codeBlockSource.indexOf("\n") + 1;
  const closingStart = codeBlockSource.lastIndexOf("\n") + 1;
  await startSession(codeFixture, codeContent);
  await focusCodeBoundary("start");
  await dispatchKey({ key: "ArrowLeft", code: "ArrowLeft", virtualKeyCode: 37 });
  await waitForSourceControl(
    (state) => state?.active && state.value === codeBlockSource &&
      state.selectionStart === contentStart - 1 && state.selectionEnd === contentStart - 1,
    "ArrowLeft skipped the physical opening-fence newline"
  );
  await stopSession();

  await startSession(codeFixture, codeContent);
  await focusCodeBoundary("end");
  await dispatchKey({ key: "ArrowRight", code: "ArrowRight", virtualKeyCode: 39 });
  await waitForSourceControl(
    (state) => state?.active && state.value === codeBlockSource &&
      state.selectionStart === closingStart && state.selectionEnd === closingStart,
    "ArrowRight skipped the physical closing-fence newline"
  );
  await stopSession();
}

async function verifyCodeBoundarySelection() {
  const contentStart = codeBlockSource.indexOf("\n") + 1;
  await startSession(codeFixture, codeContent);
  await focusCodeBoundary("start");
  await dispatchKey({ key: "ArrowLeft", code: "ArrowLeft", virtualKeyCode: 37, modifiers: 8 });
  await waitForSourceControl(
    (state) => state?.active && state.value === codeBlockSource &&
      state.selectionStart === contentStart - 1 && state.selectionEnd === contentStart &&
      state.selectionDirection === "backward",
    "Shift-ArrowLeft did not select the physical opening-fence newline"
  );
  await dispatchKey({ key: "ArrowLeft", code: "ArrowLeft", virtualKeyCode: 37, modifiers: 8 });
  await waitForSourceControl(
    (state) => state?.active && state.selectionStart === contentStart - 2 &&
      state.selectionEnd === contentStart && state.selectionDirection === "backward",
    "Shift-ArrowLeft did not continue into the opening fence info string"
  );
  await dispatchKey({ key: "Backspace", code: "Backspace", virtualKeyCode: 8 });
  const backwardDeletedSource = `${codeBlockSource.slice(0, contentStart - 2)}${
    codeBlockSource.slice(contentStart)
  }`;
  await waitForSaveState(false);
  await dispatchKey({ key: "s", code: "KeyS", virtualKeyCode: 83, modifiers: 4 });
  await waitForCompletedSave(codeFixture.replace(codeBlockSource, backwardDeletedSource));
  await stopSession();

  const contentEnd = contentStart + codeContent.length;
  await startSession(codeFixture, codeContent);
  await focusCodeBoundary("end");
  await dispatchKey({ key: "ArrowRight", code: "ArrowRight", virtualKeyCode: 39, modifiers: 8 });
  await waitForSourceControl(
    (state) => state?.active && state.value === codeBlockSource &&
      state.selectionStart === contentEnd && state.selectionEnd === contentEnd + 1 &&
      state.selectionDirection === "forward",
    "Shift-ArrowRight did not select the physical closing-fence newline"
  );
  await dispatchKey({ key: "ArrowRight", code: "ArrowRight", virtualKeyCode: 39, modifiers: 8 });
  await waitForSourceControl(
    (state) => state?.active && state.selectionStart === contentEnd &&
      state.selectionEnd === contentEnd + 2 && state.selectionDirection === "forward",
    "Shift-ArrowRight did not continue into the closing fence marker"
  );
  await dispatchKey({ key: "Delete", code: "Delete", virtualKeyCode: 46 });
  const forwardDeletedSource = `${codeBlockSource.slice(0, contentEnd)}${
    codeBlockSource.slice(contentEnd + 2)
  }`;
  await waitForSaveState(false);
  await dispatchKey({ key: "s", code: "KeyS", virtualKeyCode: 83, modifiers: 4 });
  await waitForCompletedSave(codeFixture.replace(codeBlockSource, forwardDeletedSource));
  await stopSession();
}

async function verifyCodeJumpNavigation() {
  const contentStart = codeBlockSource.indexOf("\n") + 1;
  const contentEnd = contentStart + codeContent.length;

  await startSession(codeFixture, codeContent);
  await focusCodeBoundary("start");
  await dispatchKey({ key: "ArrowLeft", code: "ArrowLeft", virtualKeyCode: 37, modifiers: 9 });
  await waitForSourceControl(
    (state) => state?.active && state.value === codeBlockSource
      && state.selectionStart === 3 && state.selectionEnd === contentStart
      && state.selectionDirection === "backward",
    "Shift-Option-ArrowLeft did not select the opening fence language and newline"
  );
  await stopSession();

  await startSession(codeFixture, codeContent);
  await focusCodeBoundary("end");
  await dispatchKey({ key: "ArrowRight", code: "ArrowRight", virtualKeyCode: 39, modifiers: 9 });
  await waitForSourceControl(
    (state) => state?.active && state.value === codeBlockSource
      && state.selectionStart === contentEnd && state.selectionEnd === codeBlockSource.length
      && state.selectionDirection === "forward",
    "Shift-Option-ArrowRight did not select the closing fence newline and marker"
  );
  await stopSession();

  await startSession(codeFixture, codeContent);
  await focusCodeBoundary("end");
  await dispatchKey({ key: "ArrowUp", code: "ArrowUp", virtualKeyCode: 38, modifiers: 4 });
  await waitFor(
    async () => {
      const state = await editorState();
      return state.anchorText === "Before." && state.anchorOffset === 0;
    },
    "Command-ArrowUp from code did not reach the physical document start"
  );
  await stopSession();

  await startSession(codeFixture, codeContent);
  await focusCodeBoundary("end");
  await dispatchKey({ key: "ArrowDown", code: "ArrowDown", virtualKeyCode: 40, modifiers: 4 });
  await waitFor(
    () => evaluate(`(() => {
      const selection = getSelection();
      return selection?.anchorNode?.data === "After."
        && selection.anchorOffset === "After.".length
        && Boolean(document.querySelector(".tether-source-newline-selection.is-caret"));
    })()`),
    "Command-ArrowDown from code did not retain the physical terminal newline caret"
  );
  await stopSession();

  await startSession(emptyCodeFixture, "Before.");
  await focusCodeBoundary("start");
  await dispatchKey({ key: "ArrowRight", code: "ArrowRight", virtualKeyCode: 39, modifiers: 4 });
  await waitForSourceControl(
    (state) => state?.active && state.value === emptyCodeBlockSource
      && state.selectionStart === emptyCodeBlockSource.length
      && state.selectionEnd === emptyCodeBlockSource.length,
    "Command-ArrowRight in an immediate empty fence did not reach the physical closing line end"
  );
  await stopSession();
}

async function verifyCodeExtendedWordNavigation() {
  await startSession(codeFixture, codeContent);
  await focusCodeBoundary("start");
  for (let step = 0; step < 4; step += 1) {
    await dispatchKey({ key: "ArrowRight", code: "ArrowRight", virtualKeyCode: 39 });
  }
  for (let step = 0; step < 4; step += 1) {
    await dispatchKey({
      key: "ArrowLeft",
      code: "ArrowLeft",
      virtualKeyCode: 37,
      modifiers: 8
    });
  }
  await dispatchKey({
    key: "ArrowLeft",
    code: "ArrowLeft",
    virtualKeyCode: 37,
    modifiers: 1
  });
  await waitForSourceControl(
    (state) => state?.active && state.value === codeBlockSource
      && state.selectionStart === 3 && state.selectionEnd === 3,
    "Option-ArrowLeft from an extended code selection did not continue into the opening fence"
  );
  await stopSession();

  await startSession(codeFixture, codeContent);
  await focusCodeBoundary("end");
  for (let step = 0; step < 4; step += 1) {
    await dispatchKey({ key: "ArrowLeft", code: "ArrowLeft", virtualKeyCode: 37 });
  }
  for (let step = 0; step < 4; step += 1) {
    await dispatchKey({
      key: "ArrowRight",
      code: "ArrowRight",
      virtualKeyCode: 39,
      modifiers: 8
    });
  }
  await dispatchKey({
    key: "ArrowRight",
    code: "ArrowRight",
    virtualKeyCode: 39,
    modifiers: 1
  });
  await waitForSourceControl(
    (state) => state?.active && state.value === codeBlockSource
      && state.selectionStart === codeBlockSource.length
      && state.selectionEnd === codeBlockSource.length,
    "Option-ArrowRight from an extended code selection did not continue through the closing fence"
  );
  await stopSession();
}

async function verifyCodeExtendedVerticalNavigation() {
  await startSession(codeFixture, codeContent);
  await focusCodeBoundary("start");
  for (let step = 0; step < 4; step += 1) {
    await dispatchKey({ key: "ArrowRight", code: "ArrowRight", virtualKeyCode: 39 });
  }
  for (let step = 0; step < 4; step += 1) {
    await dispatchKey({
      key: "ArrowLeft",
      code: "ArrowLeft",
      virtualKeyCode: 37,
      modifiers: 8
    });
  }
  await dispatchKey({ key: "ArrowUp", code: "ArrowUp", virtualKeyCode: 38 });
  await waitForSourceControl(
    (state) => state?.active && state.value === codeBlockSource
      && state.selectionStart === 0 && state.selectionEnd === 0,
    "ArrowUp from an extended code selection did not continue to the opening fence line"
  );
  await stopSession();

  await startSession(codeFixture, codeContent);
  await focusCodeBoundary("end");
  for (let step = 0; step < 4; step += 1) {
    await dispatchKey({ key: "ArrowLeft", code: "ArrowLeft", virtualKeyCode: 37 });
  }
  for (let step = 0; step < 4; step += 1) {
    await dispatchKey({
      key: "ArrowRight",
      code: "ArrowRight",
      virtualKeyCode: 39,
      modifiers: 8
    });
  }
  await dispatchKey({ key: "ArrowDown", code: "ArrowDown", virtualKeyCode: 40 });
  await waitForSourceControl(
    (state) => state?.active && state.value === codeBlockSource
      && state.selectionStart === codeBlockSource.length
      && state.selectionEnd === codeBlockSource.length,
    "ArrowDown from an extended code selection did not continue to the closing fence line"
  );
  await stopSession();
}

async function verifyCodeDocumentJumpReplacement() {
  const contentStart = codeBlockSource.indexOf("\n") + 1;
  const contentEnd = contentStart + codeContent.length;
  const selectionStart = codeFixture.indexOf(codeBlockSource) + contentEnd;
  const replaced = `${codeFixture.slice(0, selectionStart)}X`;
  const save = async (source) => {
    await dispatchKey({ key: "s", code: "KeyS", virtualKeyCode: 83, modifiers: 4 });
    await waitForCompletedSave(source);
  };

  await startSession(codeFixture, codeContent);
  await focusCodeBoundary("end");
  await dispatchKey({ key: "ArrowDown", code: "ArrowDown", virtualKeyCode: 40, modifiers: 12 });
  await cdp.send("Input.insertText", { text: "X" });
  await waitForSaveState(false);
  await save(replaced);

  await dispatchKey({ key: "z", code: "KeyZ", virtualKeyCode: 90, modifiers: 4 });
  await waitForSaveState(false);
  await save(codeFixture);
  await dispatchKey({ key: "z", code: "KeyZ", virtualKeyCode: 90, modifiers: 12 });
  await waitForSaveState(false);
  await save(replaced);
  await stopSession();
}

async function verifyCodeSelectAllEditing() {
  const replacement = "Replacement";
  const save = async (source) => {
    await dispatchKey({ key: "s", code: "KeyS", virtualKeyCode: 83, modifiers: 4 });
    await waitForCompletedSave(source);
  };
  const selectAllFromCode = async () => {
    await focusCodeBoundary("end");
    await dispatchKey({ key: "a", code: "KeyA", virtualKeyCode: 65, modifiers: 4 });
    await waitFor(
      () => evaluate(`(() => {
        const selection = document.querySelector(".ProseMirror")?.tetherGetActiveSourceSelection?.();
        return selection?.fullSource === ${JSON.stringify(selectAllCodeFixture)}
          && Math.min(selection.anchor, selection.head) === 0
          && Math.max(selection.anchor, selection.head) === ${selectAllCodeFixture.length};
      })()`),
      "Code-focused Select All did not claim the complete physical Markdown source"
    );
  };

  await startSession(selectAllCodeFixture, codeContent);
  await selectAllFromCode();
  const selectAllState = await evaluate(`(() => ({
    activeElement: document.activeElement?.className || document.activeElement?.tagName || null,
    domSelection: getSelection()?.toString() || "",
    codeText: document.querySelector(".cm-content")?.textContent ?? null,
    codeSelectionCount: document.querySelectorAll(".cm-selectionBackground").length,
    exactMarkerText: document.querySelector(".tether-source-newline-selection")?.textContent || null
  }))()`);
  const cutText = await dispatchCutAndCaptureText();
  if (cutText !== selectAllCodeFixture) {
    throw new Error(`Code-focused Select All Cut emitted ${JSON.stringify(cutText)} instead of ${JSON.stringify(selectAllCodeFixture)}; selection state: ${JSON.stringify(selectAllState)}`);
  }
  await waitFor(
    () => evaluate(`!document.querySelector(".milkdown-code-block")`),
    `Code-focused Select All Cut retained a code block; before: ${JSON.stringify(selectAllState)}`
  );
  await waitForSaveState(false);
  await save("");
  if (await dispatchPasteText(selectAllCodeFixture) == null) {
    throw new Error("No focused document editor received the Select All Paste event");
  }
  await waitForSaveState(false);
  await save(selectAllCodeFixture);
  await dispatchKey({ key: "z", code: "KeyZ", virtualKeyCode: 90, modifiers: 4 });
  await waitForSaveState(false);
  await save("");
  await dispatchKey({ key: "z", code: "KeyZ", virtualKeyCode: 90, modifiers: 12 });
  await waitForSaveState(false);
  await save(selectAllCodeFixture);
  await stopSession();

  await startSession(selectAllCodeFixture, codeContent);
  await selectAllFromCode();
  await cdp.send("Input.insertText", { text: replacement });
  await waitForSaveState(false);
  await save(replacement);
  await dispatchKey({ key: "z", code: "KeyZ", virtualKeyCode: 90, modifiers: 4 });
  await waitForSaveState(false);
  await save(selectAllCodeFixture);
  await dispatchKey({ key: "z", code: "KeyZ", virtualKeyCode: 90, modifiers: 12 });
  await waitForSaveState(false);
  await save(replacement);
  await stopSession();
}

async function verifyProseSelectAllEditing() {
  const replacement = "Replacement";
  const save = async (source) => {
    await dispatchKey({ key: "s", code: "KeyS", virtualKeyCode: 83, modifiers: 4 });
    await waitForCompletedSave(source);
  };
  const selectAllFromProse = async () => {
    await placeCaretInText("Intro ", 3);
    await dispatchKey({ key: "a", code: "KeyA", virtualKeyCode: 65, modifiers: 4 });
    let copiedText = null;
    await waitFor(async () => {
      copiedText = await dispatchCopyAndCaptureText();
      return copiedText === proseSelectAllFixture;
    }, "Prose-focused Select All did not expose the complete physical Markdown source");
    return copiedText;
  };

  await startSession(proseSelectAllFixture, "Intro bold and *literal*.");
  const copiedText = await selectAllFromProse();
  if (copiedText !== proseSelectAllFixture) {
    throw new Error(
      `Prose-focused Select All Copy emitted ${JSON.stringify(copiedText)} instead of ${JSON.stringify(proseSelectAllFixture)}`
    );
  }
  const cutText = await dispatchCutAndCaptureText();
  if (cutText !== proseSelectAllFixture) {
    throw new Error(
      `Prose-focused Select All Cut emitted ${JSON.stringify(cutText)} instead of ${JSON.stringify(proseSelectAllFixture)}`
    );
  }
  await waitForSaveState(false);
  await save("");
  if (await dispatchPasteText(proseSelectAllFixture) == null) {
    throw new Error("No rendered document editor received the Select All Paste event");
  }
  await waitForSaveState(false);
  await save(proseSelectAllFixture);
  await dispatchKey({ key: "z", code: "KeyZ", virtualKeyCode: 90, modifiers: 4 });
  await waitForSaveState(false);
  await save("");
  await dispatchKey({ key: "z", code: "KeyZ", virtualKeyCode: 90, modifiers: 12 });
  await waitForSaveState(false);
  await save(proseSelectAllFixture);
  await stopSession();

  await startSession(proseSelectAllFixture, "Intro bold and *literal*.");
  await selectAllFromProse();
  await cdp.send("Input.insertText", { text: replacement });
  await waitForSaveState(false);
  await save(replacement);
  await dispatchKey({ key: "z", code: "KeyZ", virtualKeyCode: 90, modifiers: 4 });
  await waitForSaveState(false);
  await save(proseSelectAllFixture);
  await dispatchKey({ key: "z", code: "KeyZ", virtualKeyCode: 90, modifiers: 12 });
  await waitForSaveState(false);
  await save(replacement);
  await stopSession();

  await startSession(proseSelectAllFixture, "Intro bold and *literal*.");
  await selectAllFromProse();
  await dispatchKey({ key: "Tab", code: "Tab", virtualKeyCode: 9 });
  await waitForSaveState(false);
  await save(indentedProseSelectAllFixture);
  await dispatchKey({ key: "z", code: "KeyZ", virtualKeyCode: 90, modifiers: 4 });
  await waitForSaveState(false);
  await save(proseSelectAllFixture);
  await dispatchKey({ key: "z", code: "KeyZ", virtualKeyCode: 90, modifiers: 12 });
  await waitForSaveState(false);
  await save(indentedProseSelectAllFixture);
  await dispatchKey({ key: "Tab", code: "Tab", virtualKeyCode: 9, modifiers: 8 });
  await waitForSaveState(false);
  await save(proseSelectAllFixture);
  await stopSession();
}

async function verifyCodeSelectAllTabHistory() {
  const save = async (source) => {
    await dispatchKey({ key: "s", code: "KeyS", virtualKeyCode: 83, modifiers: 4 });
    await waitForCompletedSave(source);
  };
  const assertExactSelection = async (source, message) => {
    await waitFor(
      () => evaluate(`(() => {
        const selection = document.querySelector(".ProseMirror")?.tetherGetActiveSourceSelection?.();
        return selection?.fullSource === ${JSON.stringify(source)}
          && selection.anchor !== selection.head;
      })()`),
      message,
      3000
    );
  };

  await startSession(selectAllCodeFixture, codeContent);
  await focusCodeBoundary("end");
  await dispatchKey({ key: "a", code: "KeyA", virtualKeyCode: 65, modifiers: 4 });
  await dispatchKey({ key: "Tab", code: "Tab", virtualKeyCode: 9 });
  await waitForSaveState(false);
  await assertExactSelection(indentedSelectAllCodeFixture, "Tab did not retain the indented physical source selection");
  await save(indentedSelectAllCodeFixture);
  await assertExactSelection(indentedSelectAllCodeFixture, "Save dropped the indented physical source selection");

  await dispatchKey({ key: "z", code: "KeyZ", virtualKeyCode: 90, modifiers: 4 });
  await waitForSaveState(false);
  await assertExactSelection(selectAllCodeFixture, "Undo did not restore the original physical source selection");
  await save(selectAllCodeFixture);
  await assertExactSelection(selectAllCodeFixture, "Save after Undo dropped the physical source selection");
  await dispatchKey({ key: "z", code: "KeyZ", virtualKeyCode: 90, modifiers: 12 });
  await waitForSaveState(false);
  await assertExactSelection(indentedSelectAllCodeFixture, "Redo did not restore the indented physical source selection");
  await save(indentedSelectAllCodeFixture);
  await assertExactSelection(indentedSelectAllCodeFixture, "Save after Redo dropped the physical source selection");

  await dispatchKey({ key: "Tab", code: "Tab", virtualKeyCode: 9, modifiers: 8 });
  await waitForSaveState(false);
  await save(selectAllCodeFixture);
  await dispatchKey({ key: "z", code: "KeyZ", virtualKeyCode: 90, modifiers: 4 });
  await waitForSaveState(false);
  await save(indentedSelectAllCodeFixture);
  await dispatchKey({ key: "z", code: "KeyZ", virtualKeyCode: 90, modifiers: 12 });
  await waitForSaveState(false);
  await save(selectAllCodeFixture);
  await stopSession();
}

async function verifyClosingFenceReplacement() {
  const contentEnd = codeBlockSource.indexOf("\n") + 1 + codeContent.length;
  await startSession(codeFixture, codeContent);
  await focusCodeBoundary("end");
  for (let step = 1; step <= 2; step += 1) {
    await dispatchKey({ key: "ArrowRight", code: "ArrowRight", virtualKeyCode: 39, modifiers: 8 });
    await waitForSourceControl(
      (state) => state?.active && state.value === codeBlockSource &&
        state.selectionStart === contentEnd && state.selectionEnd === contentEnd + step &&
        state.selectionDirection === "forward",
      `Shift-ArrowRight did not select ${step} closing-fence source character${step === 1 ? "" : "s"}`
    );
  }
  await cdp.send("Input.insertText", { text: "X" });
  await cdp.send("Input.insertText", { text: "Y" });
  const replacedSource = `${codeBlockSource.slice(0, contentEnd)}XY${
    codeBlockSource.slice(contentEnd + 2)
  }`;
  const expected = codeFixture.replace(codeBlockSource, replacedSource);
  await waitForSaveState(false);
  await dispatchKey({ key: "z", code: "KeyZ", virtualKeyCode: 90, modifiers: 4 });
  await waitForSaveState(true);
  await waitFor(
    () => evaluate(`document.querySelector(".cm-content")?.textContent === ${JSON.stringify(codeContent)} && document.querySelector(".ProseMirror")?.textContent.includes("After.")`),
    "undo did not restore a closing-fence source replacement"
  );
  await dispatchKey({ key: "z", code: "KeyZ", virtualKeyCode: 90, modifiers: 12 });
  await waitForSaveState(false);
  await dispatchKey({ key: "s", code: "KeyS", virtualKeyCode: 83, modifiers: 4 });
  await waitForCompletedSave(expected);
  await stopSession();
}

async function selectCodeEndIntoFollowingProse() {
  const contentStart = codeBlockSource.indexOf("\n") + 1;
  const contentEnd = contentStart + codeContent.length;
  const codeStart = codeFixture.indexOf(codeBlockSource);
  await focusCodeBoundary("end");
  for (let step = 1; step <= 4; step += 1) {
    await dispatchKey({ key: "ArrowRight", code: "ArrowRight", virtualKeyCode: 39, modifiers: 8 });
    await waitForSourceControl(
      (state) => state?.active && state.value === codeBlockSource &&
        state.selectionStart === contentEnd && state.selectionEnd === contentEnd + step &&
        state.selectionDirection === "forward",
      `Shift-ArrowRight did not extend ${step} source character${step === 1 ? "" : "s"} past the code content`
    );
  }
  await dispatchKey({ key: "ArrowRight", code: "ArrowRight", virtualKeyCode: 39, modifiers: 8 });
  await waitFor(
    async () => !(await sourceControlState()),
    "code selection did not cross from the closing fence into the root separator"
  );
  await dispatchKey({ key: "ArrowRight", code: "ArrowRight", virtualKeyCode: 39, modifiers: 8 });
  await dispatchKey({ key: "ArrowRight", code: "ArrowRight", virtualKeyCode: 39, modifiers: 8 });
  return { selectionStart: codeStart + contentEnd, selectedLength: 7 };
}

async function selectCodeStartIntoPreviousProse() {
  const contentStart = codeBlockSource.indexOf("\n") + 1;
  const codeStart = codeFixture.indexOf(codeBlockSource);
  await focusCodeBoundary("start");
  for (let step = 1; step <= contentStart; step += 1) {
    await dispatchKey({ key: "ArrowLeft", code: "ArrowLeft", virtualKeyCode: 37, modifiers: 8 });
    await waitForSourceControl(
      (state) => state?.active && state.value === codeBlockSource
        && state.selectionStart === contentStart - step
        && state.selectionEnd === contentStart
        && state.selectionDirection === "backward",
      `Shift-ArrowLeft did not extend ${step} source character${step === 1 ? "" : "s"} before the code content`
    );
  }
  await dispatchKey({ key: "ArrowLeft", code: "ArrowLeft", virtualKeyCode: 37, modifiers: 8 });
  await waitFor(
    async () => !(await sourceControlState()),
    "backward code selection did not cross from the opening fence into the root separator"
  );
  await dispatchKey({ key: "ArrowLeft", code: "ArrowLeft", virtualKeyCode: 37, modifiers: 8 });
  await dispatchKey({ key: "ArrowLeft", code: "ArrowLeft", virtualKeyCode: 37, modifiers: 8 });
  return { selectionStart: codeStart - 3, selectedLength: contentStart + 3 };
}

async function verifyCodeToProseSelection() {
  await startSession(codeFixture, codeContent);
  const { selectionStart, selectedLength } = await selectCodeEndIntoFollowingProse();
  await dispatchKey({ key: "Delete", code: "Delete", virtualKeyCode: 46 });
  const expected = `${codeFixture.slice(0, selectionStart)}${
    codeFixture.slice(selectionStart + selectedLength)
  }`;
  await waitForSaveState(false);
  await dispatchKey({ key: "z", code: "KeyZ", virtualKeyCode: 90, modifiers: 4 });
  await waitForSaveState(true);
  await waitFor(
    () => evaluate(`document.querySelector(".cm-content")?.textContent === ${JSON.stringify(codeContent)} && document.querySelector(".ProseMirror")?.textContent.includes("After.")`),
    "undo did not restore the fenced block and following prose"
  );
  await dispatchKey({ key: "z", code: "KeyZ", virtualKeyCode: 90, modifiers: 12 });
  await waitForSaveState(false);
  await dispatchKey({ key: "s", code: "KeyS", virtualKeyCode: 83, modifiers: 4 });
  await waitForCompletedSave(expected);
  await stopSession();
}

async function verifyCodeToProseReplacement() {
  await startSession(codeFixture, codeContent);
  const { selectionStart, selectedLength } = await selectCodeEndIntoFollowingProse();
  await cdp.send("Input.insertText", { text: "X" });
  const expected = `${codeFixture.slice(0, selectionStart)}X${
    codeFixture.slice(selectionStart + selectedLength)
  }`;
  await waitForSaveState(false);
  await dispatchKey({ key: "z", code: "KeyZ", virtualKeyCode: 90, modifiers: 4 });
  await waitForSaveState(true);
  await waitFor(
    () => evaluate(`document.querySelector(".cm-content")?.textContent === ${JSON.stringify(codeContent)} && document.querySelector(".ProseMirror")?.textContent.includes("After.")`),
    "undo did not restore a code-to-prose source replacement"
  );
  await dispatchKey({ key: "z", code: "KeyZ", virtualKeyCode: 90, modifiers: 12 });
  await waitForSaveState(false);
  await dispatchKey({ key: "s", code: "KeyS", virtualKeyCode: 83, modifiers: 4 });
  await waitForCompletedSave(expected);
  await stopSession();
}

async function verifyCodeToProseCutPaste() {
  await startSession(codeFixture, codeContent);
  const { selectionStart, selectedLength } = await selectCodeEndIntoFollowingProse();
  const cutSource = `${codeFixture.slice(0, selectionStart)}${
    codeFixture.slice(selectionStart + selectedLength)
  }`;
  const save = async (source) => {
    await dispatchKey({ key: "s", code: "KeyS", virtualKeyCode: 83, modifiers: 4 });
    await waitForCompletedSave(source);
  };

  const cutText = await dispatchCutAndCaptureText();
  const expectedCutText = codeFixture.slice(selectionStart, selectionStart + selectedLength);
  if (cutText !== expectedCutText) {
    throw new Error(`Cut emitted ${JSON.stringify(cutText)} instead of ${JSON.stringify(expectedCutText)}`);
  }
  await waitForSaveState(false);
  await save(cutSource);

  const pasteDispatched = await dispatchPasteText(expectedCutText);
  if (pasteDispatched == null) throw new Error("No focused element received the code-to-prose Paste event");
  await waitForSaveState(false);
  await save(codeFixture);

  await dispatchKey({ key: "z", code: "KeyZ", virtualKeyCode: 90, modifiers: 4 });
  await waitForSaveState(false);
  await save(cutSource);
  await dispatchKey({ key: "z", code: "KeyZ", virtualKeyCode: 90, modifiers: 12 });
  await waitForSaveState(false);
  await save(codeFixture);
  await stopSession();

  const codePaste = "X\nY";
  const codePasteFixture = codeFixture.replace(codeContent, `${codeContent}${codePaste}`);
  await startSession(codeFixture, codeContent);
  await focusCodeBoundary("end");
  if (await dispatchPasteText(codePaste) == null) {
    throw new Error("No focused code editor received the multiline Paste event");
  }
  await waitForSaveState(false);
  await save(codePasteFixture);
  await dispatchKey({ key: "z", code: "KeyZ", virtualKeyCode: 90, modifiers: 4 });
  await waitForSaveState(false);
  await save(codeFixture);
  await dispatchKey({ key: "z", code: "KeyZ", virtualKeyCode: 90, modifiers: 12 });
  await waitForSaveState(false);
  await save(codePasteFixture);
  await stopSession();
}

async function verifyBackwardCodeToProseCutPaste() {
  await startSession(codeFixture, codeContent);
  const { selectionStart, selectedLength } = await selectCodeStartIntoPreviousProse();
  const selectedText = codeFixture.slice(selectionStart, selectionStart + selectedLength);
  const cutSource = `${codeFixture.slice(0, selectionStart)}${
    codeFixture.slice(selectionStart + selectedLength)
  }`;
  const save = async (source) => {
    await dispatchKey({ key: "s", code: "KeyS", virtualKeyCode: 83, modifiers: 4 });
    await waitForCompletedSave(source);
  };

  const cutText = await dispatchCutAndCaptureText();
  if (cutText !== selectedText) {
    throw new Error(`Backward Cut emitted ${JSON.stringify(cutText)} instead of ${JSON.stringify(selectedText)}`);
  }
  await waitForSaveState(false);
  await save(cutSource);

  if (await dispatchPasteText(selectedText) == null) {
    throw new Error("No focused element received the backward code-to-prose Paste event");
  }
  await waitForSaveState(false);
  await save(codeFixture);
  await dispatchKey({ key: "z", code: "KeyZ", virtualKeyCode: 90, modifiers: 4 });
  await waitForSaveState(false);
  await save(cutSource);
  await dispatchKey({ key: "z", code: "KeyZ", virtualKeyCode: 90, modifiers: 12 });
  await waitForSaveState(false);
  await save(codeFixture);
  await stopSession();
}

async function verifyCodePointerDragCutPaste() {
  const codeOffset = codeContent.indexOf("value");
  const proseOffset = 2;
  const beforeOffset = 3;
  const contentStart = codeFixture.indexOf(codeContent);
  const beforeSelectionStart = codeFixture.indexOf("Before.") + beforeOffset;
  const afterSelectionEnd = codeFixture.indexOf("After.") + proseOffset;
  const scenarios = [
    {
      name: "code-to-prose",
      startText: codeContent,
      startOffset: codeOffset,
      startRoot: ".cm-content",
      endText: "After.",
      endOffset: proseOffset,
      endRoot: ".ProseMirror",
      selectionStart: contentStart + codeOffset,
      selectionEnd: codeFixture.indexOf("After.") + proseOffset
    },
    {
      name: "prose-to-code",
      startText: "Before.",
      startOffset: beforeOffset,
      startRoot: ".ProseMirror",
      endText: codeContent,
      endOffset: codeOffset,
      endRoot: ".cm-content",
      selectionStart: codeFixture.indexOf("Before.") + beforeOffset,
      selectionEnd: contentStart + codeOffset
    },
    {
      name: "prose-across-code-forward",
      startText: "Before.",
      startOffset: beforeOffset,
      startRoot: ".ProseMirror",
      endText: "After.",
      endOffset: proseOffset,
      endRoot: ".ProseMirror",
      selectionStart: beforeSelectionStart,
      selectionEnd: afterSelectionEnd
    },
    {
      name: "prose-across-code-backward",
      startText: "After.",
      startOffset: proseOffset,
      startRoot: ".ProseMirror",
      endText: "Before.",
      endOffset: beforeOffset,
      endRoot: ".ProseMirror",
      selectionStart: beforeSelectionStart,
      selectionEnd: afterSelectionEnd
    }
  ];
  const save = async (source) => {
    await dispatchKey({ key: "s", code: "KeyS", virtualKeyCode: 83, modifiers: 4 });
    await waitForCompletedSave(source);
  };

  for (const scenario of scenarios) {
    const selectedText = codeFixture.slice(scenario.selectionStart, scenario.selectionEnd);
    const cutSource = `${codeFixture.slice(0, scenario.selectionStart)}${codeFixture.slice(scenario.selectionEnd)}`;

    await startSession(codeFixture, codeContent);
    const start = await textBoundaryPoint(
      scenario.startText,
      scenario.startOffset,
      scenario.startRoot
    );
    const end = await textBoundaryPoint(
      scenario.endText,
      scenario.endOffset,
      scenario.endRoot
    );
    await dragBetweenTextBoundaries(start, end);
    const dragState = await evaluate(`(() => ({
      activeElement: document.activeElement?.className || document.activeElement?.tagName || null,
      domSelection: getSelection()?.toString() || "",
      cmSelection: document.querySelector(".cm-selectionBackground")?.getBoundingClientRect().toJSON() || null,
      exactMarker: document.querySelector(".tether-source-newline-selection")?.className || null,
      exactMarkerText: document.querySelector(".tether-source-newline-selection")?.textContent || null
    }))()`);
    const cutText = await dispatchCutAndCaptureText();
    if (cutText !== selectedText) {
      throw new Error(`${scenario.name} pointer-drag Cut emitted ${JSON.stringify(cutText)} instead of ${JSON.stringify(selectedText)}; drag state: ${JSON.stringify(dragState)}`);
    }
    await waitForSaveState(false);
    await save(cutSource);

    if (await dispatchPasteText(selectedText) == null) {
      throw new Error(`No focused editor received the ${scenario.name} pointer-drag Paste event`);
    }
    await waitForSaveState(false);
    await save(codeFixture);
    await dispatchKey({ key: "z", code: "KeyZ", virtualKeyCode: 90, modifiers: 4 });
    await waitForSaveState(false);
    await save(cutSource);
    await dispatchKey({ key: "z", code: "KeyZ", virtualKeyCode: 90, modifiers: 12 });
    await waitForSaveState(false);
    await save(codeFixture);
    await stopSession();
  }
}

async function verifyCodeToCodePointerDragCutPaste() {
  const firstOffset = firstCodeContent.indexOf("first");
  const secondOffset = secondCodeContent.indexOf("second") + 3;
  const selectionStart = twoCodeFixture.indexOf(firstCodeContent) + firstOffset;
  const selectionEnd = twoCodeFixture.indexOf(secondCodeContent) + secondOffset;
  const selectedText = twoCodeFixture.slice(selectionStart, selectionEnd);
  const cutSource = `${twoCodeFixture.slice(0, selectionStart)}${twoCodeFixture.slice(selectionEnd)}`;
  const scenarios = [
    {
      name: "forward",
      startText: firstCodeContent,
      startOffset: firstOffset,
      endText: secondCodeContent,
      endOffset: secondOffset
    },
    {
      name: "backward",
      startText: secondCodeContent,
      startOffset: secondOffset,
      endText: firstCodeContent,
      endOffset: firstOffset
    }
  ];
  const save = async (source) => {
    await dispatchKey({ key: "s", code: "KeyS", virtualKeyCode: 83, modifiers: 4 });
    await waitForCompletedSave(source);
  };

  for (const scenario of scenarios) {
    await startSession(twoCodeFixture, firstCodeContent);
    const start = await textBoundaryPoint(
      scenario.startText,
      scenario.startOffset,
      ".ProseMirror"
    );
    const end = await textBoundaryPoint(
      scenario.endText,
      scenario.endOffset,
      ".ProseMirror"
    );
    await dragBetweenTextBoundaries(start, end);
    const dragState = await evaluate(`(() => ({
      activeElement: document.activeElement?.className || document.activeElement?.tagName || null,
      domSelection: getSelection()?.toString() || "",
      codeSelections: [...document.querySelectorAll(".cm-selectionBackground")]
        .map((selection) => selection.getBoundingClientRect().toJSON()),
      exactMarkerText: document.querySelector(".tether-source-newline-selection")?.textContent || null
    }))()`);
    const cutText = await dispatchCutAndCaptureText();
    if (cutText !== selectedText) {
      throw new Error(`${scenario.name} code-to-code pointer Cut emitted ${JSON.stringify(cutText)} instead of ${JSON.stringify(selectedText)}; drag state: ${JSON.stringify(dragState)}`);
    }
    await waitForSaveState(false);
    await save(cutSource);

    if (await dispatchPasteText(selectedText) == null) {
      throw new Error(`No focused editor received the ${scenario.name} code-to-code pointer Paste event`);
    }
    await waitForSaveState(false);
    await save(twoCodeFixture);
    await dispatchKey({ key: "z", code: "KeyZ", virtualKeyCode: 90, modifiers: 4 });
    await waitForSaveState(false);
    await save(cutSource);
    await dispatchKey({ key: "z", code: "KeyZ", virtualKeyCode: 90, modifiers: 12 });
    await waitForSaveState(false);
    await save(twoCodeFixture);
    await stopSession();
  }
}

async function verifyStructuralMarkerNavigation() {
  const fixtures = [
    { name: "closed ATX heading", source: "## Title ##", visible: "Title", caret: 2, selector: "h2" },
    { name: "bullet list", source: "- Alpha", visible: "Alpha", caret: 1, selector: ".content-dom" },
    { name: "ordered list", source: "7) Alpha", visible: "Alpha", caret: 2, selector: ".content-dom" },
    { name: "task list", source: "+ [X] Alpha", visible: "Alpha", caret: 5, selector: ".content-dom" },
    { name: "blockquote", source: "> Alpha", visible: "Alpha", caret: 1, selector: "blockquote" },
    { name: "footnote definition", source: "[^note]: Alpha", visible: "Alpha", caret: 8, selector: null }
  ];

  for (const fixture of fixtures) {
    await startSession(`${fixture.source}\n`, fixture.visible);
    await placeCaretInText(fixture.visible, 0, ".ProseMirror", fixture.selector);
    await dispatchKey({ key: "ArrowLeft", code: "ArrowLeft", virtualKeyCode: 37 });
    await waitForSourceControl(
      (state) => state?.active && state.value === fixture.source &&
        state.selectionStart === fixture.caret && state.selectionEnd === fixture.caret,
      `ArrowLeft did not enter the final physical ${fixture.name} prefix byte`
    );
    await dispatchKey({ key: "ArrowLeft", code: "ArrowLeft", virtualKeyCode: 37, modifiers: 8 });
    await waitForSourceControl(
      (state) => state?.active && state.selectionStart === fixture.caret - 1 &&
        state.selectionEnd === fixture.caret && state.selectionDirection === "backward",
      `Shift+ArrowLeft did not select one physical ${fixture.name} marker byte`
    );
    const copied = await dispatchCopyAndCaptureText();
    if (copied !== fixture.source.slice(fixture.caret - 1, fixture.caret)) {
      throw new Error(
        `${fixture.name} Copy emitted ${JSON.stringify(copied)} instead of its selected source byte`
      );
    }
    await stopSession();
  }
}

async function verifyBlockAtomTraversal() {
  const fixture = "Before.\r\n\r\n* * *\r\n\r\nAfter.\r\n";
  const ruleSource = "* * *";
  const ruleStart = fixture.indexOf(ruleSource);
  const waitForExactCaret = async (offset, message) => {
    try {
      return await waitFor(async () => {
        const state = await editorState();
        return state.exactSourceSelection?.anchor === offset
          && state.exactSourceSelection?.head === offset
          && state.exactSourceSelection?.fullSource === fixture;
      }, message);
    } catch (error) {
      const state = await editorState().catch(() => null);
      const control = await sourceControlState().catch(() => null);
      throw new Error(`${error.message}\nEditor state: ${JSON.stringify(state)}\nSource control: ${JSON.stringify(control)}`);
    }
  };
  const waitForRenderedCaret = async (text, offset, message) => {
    try {
      return await waitFor(async () => {
        const state = await editorState();
        return state.anchorText === text && state.anchorOffset === offset
          && state.exactSourceSelection == null;
      }, message);
    } catch (error) {
      const state = await editorState().catch(() => null);
      const control = await sourceControlState().catch(() => null);
      throw new Error(`${error.message}\nEditor state: ${JSON.stringify(state)}\nSource control: ${JSON.stringify(control)}`);
    }
  };

  await startSession(fixture, "Before.");
  await placeCaretInText("Before.", "Before.".length);
  await dispatchKey({ key: "ArrowRight", code: "ArrowRight", virtualKeyCode: 39 });
  await waitForExactCaret(
    "Before.\r\n".length,
    "ArrowRight skipped the first CRLF before a rendered thematic break"
  );
  await dispatchKey({ key: "ArrowRight", code: "ArrowRight", virtualKeyCode: 39 });
  await waitForSourceControl(
    (state) => state?.active && state.value === ruleSource
      && state.selectionStart === 0 && state.selectionEnd === 0,
    "ArrowRight did not hand the blank CRLF into the rendered thematic-break boundary"
  );
  await dispatchKey({ key: "ArrowRight", code: "ArrowRight", virtualKeyCode: 39 });
  await waitForSourceControl(
    (state) => state?.active && state.value === ruleSource
      && state.selectionStart === 1 && state.selectionEnd === 1,
    "ArrowRight skipped the first physical thematic-break marker"
  );
  for (let offset = 2; offset <= ruleSource.length; offset += 1) {
    await dispatchKey({ key: "ArrowRight", code: "ArrowRight", virtualKeyCode: 39 });
    await waitForSourceControl(
      (state) => state?.active && state.selectionStart === offset && state.selectionEnd === offset,
      `ArrowRight did not traverse thematic-break source offset ${offset}`
    );
  }
  await dispatchKey({ key: "ArrowRight", code: "ArrowRight", virtualKeyCode: 39 });
  await assertSourceControlClosed(
    "ArrowRight did not leave the rendered thematic break through its trailing CRLF"
  );
  await waitForExactCaret(
    ruleStart + ruleSource.length + 2,
    "ArrowRight skipped the first CRLF after a rendered thematic break"
  );
  await dispatchKey({ key: "ArrowRight", code: "ArrowRight", virtualKeyCode: 39 });
  await waitForRenderedCaret(
    "After.",
    0,
    "ArrowRight did not hand the blank CRLF after a rendered thematic break into prose"
  );
  await cdp.send("Input.insertText", { text: "X" });
  await waitForSaveState(false);
  await dispatchKey({ key: "s", code: "KeyS", virtualKeyCode: 83, modifiers: 4 });
  await waitForCompletedSave(fixture.replace("After.", "XAfter."));
  await stopSession();

  await startSession(fixture, "After.");
  await placeCaretInText("After.", 0);
  await dispatchKey({ key: "ArrowLeft", code: "ArrowLeft", virtualKeyCode: 37 });
  await waitForExactCaret(
    ruleStart + ruleSource.length + 2,
    "ArrowLeft skipped the blank CRLF after a rendered thematic break"
  );
  await dispatchKey({ key: "ArrowLeft", code: "ArrowLeft", virtualKeyCode: 37 });
  await waitForSourceControl(
    (state) => state?.active && state.value === ruleSource
      && state.selectionStart === ruleSource.length && state.selectionEnd === ruleSource.length,
    "ArrowLeft did not hand the trailing CRLF into the thematic-break source boundary"
  );
  for (let offset = ruleSource.length - 1; offset >= 0; offset -= 1) {
    await dispatchKey({ key: "ArrowLeft", code: "ArrowLeft", virtualKeyCode: 37 });
    await waitForSourceControl(
      (state) => state?.active && state.selectionStart === offset && state.selectionEnd === offset,
      `ArrowLeft did not traverse thematic-break source offset ${offset}`
    );
  }
  await dispatchKey({ key: "ArrowLeft", code: "ArrowLeft", virtualKeyCode: 37 });
  await assertSourceControlClosed(
    "ArrowLeft did not leave the rendered thematic break through its leading CRLF"
  );
  await waitForExactCaret(
    "Before.\r\n".length,
    "ArrowLeft skipped the blank CRLF before a rendered thematic break"
  );
  await dispatchKey({ key: "ArrowLeft", code: "ArrowLeft", virtualKeyCode: 37 });
  await waitForRenderedCaret(
    "Before.",
    "Before.".length,
    "ArrowLeft did not hand the leading CRLF before a rendered thematic break into prose"
  );
  await cdp.send("Input.insertText", { text: "X" });
  await waitForSaveState(false);
  await dispatchKey({ key: "s", code: "KeyS", virtualKeyCode: 83, modifiers: 4 });
  await waitForCompletedSave(fixture.replace("Before.", "Before.X"));
  await stopSession();

  const leadingGapDeleted = fixture.replace("Before.\r\n\r\n", "Before.\r\n");
  await startSession(fixture, "Before.");
  await placeCaretInText("Before.", "Before.".length);
  await dispatchKey({ key: "Delete", code: "Delete", virtualKeyCode: 46 });
  await waitForSaveState(false);
  await dispatchKey({ key: "s", code: "KeyS", virtualKeyCode: 83, modifiers: 4 });
  await waitForCompletedSave(leadingGapDeleted);
  await dispatchKey({ key: "z", code: "KeyZ", virtualKeyCode: 90, modifiers: 4 });
  await waitForSaveState(false);
  await dispatchKey({ key: "s", code: "KeyS", virtualKeyCode: 83, modifiers: 4 });
  await waitForCompletedSave(fixture);
  await dispatchKey({ key: "z", code: "KeyZ", virtualKeyCode: 90, modifiers: 12 });
  await waitForSaveState(false);
  await dispatchKey({ key: "s", code: "KeyS", virtualKeyCode: 83, modifiers: 4 });
  await waitForCompletedSave(leadingGapDeleted);
  await stopSession();

  const trailingGapDeleted = fixture.replace("* * *\r\n\r\nAfter.", "* * *\r\nAfter.");
  await startSession(fixture, "After.");
  await placeCaretInText("After.", 0);
  await dispatchKey({ key: "Backspace", code: "Backspace", virtualKeyCode: 8 });
  await waitForSaveState(false);
  await dispatchKey({ key: "s", code: "KeyS", virtualKeyCode: 83, modifiers: 4 });
  await waitForCompletedSave(trailingGapDeleted);
  await dispatchKey({ key: "z", code: "KeyZ", virtualKeyCode: 90, modifiers: 4 });
  await waitForSaveState(false);
  await dispatchKey({ key: "s", code: "KeyS", virtualKeyCode: 83, modifiers: 4 });
  await waitForCompletedSave(fixture);
  await dispatchKey({ key: "z", code: "KeyZ", virtualKeyCode: 90, modifiers: 12 });
  await waitForSaveState(false);
  await dispatchKey({ key: "s", code: "KeyS", virtualKeyCode: 83, modifiers: 4 });
  await waitForCompletedSave(trailingGapDeleted);
  await stopSession();
}

async function verifyBlockAtomCutPasteHistory() {
  const fixture = "Before.\r\n\r\n* * *\r\n\r\nAfter.\r\n";
  const rangeStart = "Before.".length;
  const rangeEnd = fixture.indexOf("After.");
  const selectedSource = fixture.slice(rangeStart, rangeEnd);
  const cutFixture = `${fixture.slice(0, rangeStart)}${fixture.slice(rangeEnd)}`;
  const save = async (source) => {
    await dispatchKey({ key: "s", code: "KeyS", virtualKeyCode: 83, modifiers: 4 });
    await waitForCompletedSave(source);
  };
  const waitForExactSelection = (anchor, head, message) => waitFor(async () => {
    const exact = (await editorState()).exactSourceSelection;
    return exact?.anchor === anchor && exact?.head === head && exact?.fullSource === fixture;
  }, message);

  await startSession(fixture, "Before.");
  await placeCaretInText("Before.", "Before.".length);
  for (let step = 0; step < 9; step += 1) {
    await dispatchKey({ key: "ArrowRight", code: "ArrowRight", virtualKeyCode: 39, modifiers: 8 });
  }
  await waitForExactSelection(
    rangeStart,
    rangeEnd,
    "Shift+Right did not select both CRLF gaps and the complete rendered thematic break"
  );
  const copied = await dispatchCopyAndCaptureText();
  if (copied !== selectedSource) {
    throw new Error(
      `Block-atom Copy emitted ${JSON.stringify(copied)} instead of ${JSON.stringify(selectedSource)}`
    );
  }
  const cut = await dispatchCutAndCaptureText();
  if (cut !== selectedSource) {
    throw new Error(
      `Block-atom Cut emitted ${JSON.stringify(cut)} instead of ${JSON.stringify(selectedSource)}`
    );
  }
  await waitForSaveState(false);
  await save(cutFixture);
  if (await dispatchPasteText(selectedSource) == null) {
    throw new Error("No focused editor received the rendered block-atom source Paste event");
  }
  await waitForSaveState(false);
  await save(fixture);
  await dispatchKey({ key: "z", code: "KeyZ", virtualKeyCode: 90, modifiers: 4 });
  await waitForSaveState(false);
  await save(cutFixture);
  await dispatchKey({ key: "z", code: "KeyZ", virtualKeyCode: 90, modifiers: 12 });
  await waitForSaveState(false);
  await save(fixture);
  await stopSession();

  await startSession(fixture, "After.");
  await placeCaretInText("After.", 0);
  for (let step = 0; step < 9; step += 1) {
    await dispatchKey({ key: "ArrowLeft", code: "ArrowLeft", virtualKeyCode: 37, modifiers: 8 });
  }
  await waitForExactSelection(
    rangeEnd,
    rangeStart,
    "Shift+Left did not select the complete rendered thematic break in reverse source order"
  );
  const backwardCopied = await dispatchCopyAndCaptureText();
  if (backwardCopied !== selectedSource) {
    throw new Error(
      `Backward block-atom Copy emitted ${JSON.stringify(backwardCopied)} instead of ${JSON.stringify(selectedSource)}`
    );
  }
  await stopSession();
}

async function verifySourceSelectionNativeMovement() {
  const fixture = "Before.\r\n\r\n* * *\r\n\r\nAfter.\r\n";
  const anchor = "Before.".length;
  const head = fixture.indexOf("After.");
  const scenarios = [
    {
      name: "ArrowUp",
      input: { key: "ArrowUp", code: "ArrowUp", virtualKeyCode: 38 },
      offset: 0
    },
    {
      name: "ArrowDown",
      input: { key: "ArrowDown", code: "ArrowDown", virtualKeyCode: 40 },
      offset: fixture.length
    },
    {
      name: "Option-ArrowLeft",
      input: { key: "ArrowLeft", code: "ArrowLeft", virtualKeyCode: 37, modifiers: 1 },
      offset: fixture.indexOf("* * *") + 4,
      sourceControl: { value: "* * *", selection: 4 }
    },
    {
      name: "Option-ArrowRight",
      input: { key: "ArrowRight", code: "ArrowRight", virtualKeyCode: 39, modifiers: 1 },
      offset: fixture.indexOf("After.") + "After".length
    }
  ];

  for (const scenario of scenarios) {
    await startSession(fixture, "Before.");
    await placeCaretInText("Before.", "Before.".length);
    // Nine rendered Shift+Right motions traverse both CRLF gaps and the
    // complete thematic-break source, yielding the physical [anchor, head]
    // range above.
    for (let step = 0; step < 9; step += 1) {
      await dispatchKey({
        key: "ArrowRight",
        code: "ArrowRight",
        virtualKeyCode: 39,
        modifiers: 8
      });
    }
    try {
      await waitFor(
        () => evaluate(`(() => {
          const exact = document.querySelector(".ProseMirror")?.tetherGetActiveSourceSelection?.();
          return exact?.fullSource === ${JSON.stringify(fixture)}
            && exact.anchor === ${anchor}
            && exact.head === ${head};
        })()`),
        `${scenario.name} setup did not establish the forward physical source selection`
      );
    } catch (error) {
      throw new Error(`${error.message}; state: ${JSON.stringify(await editorState())}`);
    }
    await dispatchKey(scenario.input);
    if (scenario.sourceControl) {
      await waitForSourceControl(
        (state) => state?.active
          && state.value === scenario.sourceControl.value
          && state.selectionStart === scenario.sourceControl.selection
          && state.selectionEnd === scenario.sourceControl.selection,
        `${scenario.name} did not collapse at physical source offset ${scenario.offset}`
      );
      await stopSession();
      continue;
    }
    await cdp.send("Input.insertText", { text: "X" });
    await waitForSaveState(false);
    await dispatchKey({ key: "s", code: "KeyS", virtualKeyCode: 83, modifiers: 4 });
    await waitForCompletedSave(
      `${fixture.slice(0, scenario.offset)}X${fixture.slice(scenario.offset)}`
    );
    await stopSession();
  }
}

async function verifyListItemCutPaste() {
  const visibleOffset = 2;
  const selectionStart = listFixture.indexOf("Alpha") + visibleOffset;
  const selectionEnd = listFixture.indexOf("Beta") + visibleOffset;
  const selectedText = listFixture.slice(selectionStart, selectionEnd);
  const cutSource = `${listFixture.slice(0, selectionStart)}${listFixture.slice(selectionEnd)}`;
  const save = async (source) => {
    await dispatchKey({ key: "s", code: "KeyS", virtualKeyCode: 83, modifiers: 4 });
    await waitForCompletedSave(source);
  };

  await startSession(listFixture, "Alpha");
  const start = await textBoundaryPoint("Alpha", visibleOffset, ".ProseMirror");
  const end = await textBoundaryPoint("Beta", visibleOffset, ".ProseMirror");
  await dragBetweenTextBoundaries(start, end);
  await waitFor(
    () => evaluate(`(() => {
      const root = document.querySelector(".ProseMirror");
      const exact = root?.tetherGetActiveSourceSelection?.();
      const rendered = getSelection();
      return Boolean(
        (exact && exact.anchor !== exact.head)
        || (rendered && !rendered.isCollapsed)
      );
    })()`),
    "pointer drag did not establish the cross-item list selection"
  );
  const beforeCut = await editorState();
  const cutText = await dispatchCutAndCaptureText();
  if (cutText !== selectedText) {
    throw new Error(`List Cut emitted ${JSON.stringify(cutText)} instead of ${JSON.stringify(selectedText)}; selection state: ${JSON.stringify(beforeCut)}`);
  }
  await waitForSaveState(false);
  await save(cutSource);

  if (await dispatchPasteText(selectedText) == null) {
    throw new Error("No focused list editor received the structural Paste event");
  }
  await waitForSaveState(false);
  await save(listFixture);
  await dispatchKey({ key: "z", code: "KeyZ", virtualKeyCode: 90, modifiers: 4 });
  await waitForSaveState(false);
  await save(cutSource);
  await dispatchKey({ key: "z", code: "KeyZ", virtualKeyCode: 90, modifiers: 12 });
  await waitForSaveState(false);
  await save(listFixture);
  await stopSession();
}

async function verifyTaskCheckboxHistory() {
  const checkedFixture = taskFixture.replace("[ ] Alpha", "[x] Alpha");
  const save = async (source) => {
    await dispatchKey({ key: "s", code: "KeyS", virtualKeyCode: 83, modifiers: 4 });
    await waitForCompletedSave(source);
  };

  await startSession(taskFixture, "Alpha");
  await clickElement(".milkdown-list-item-block .label.unchecked");
  await waitFor(
    () => evaluate(`document.querySelectorAll(".milkdown-list-item-block .label.checked").length === 2`),
    "clicking an unchecked task marker did not render it checked"
  );
  await waitForSaveState(false);
  await save(checkedFixture);

  await dispatchKey({ key: "z", code: "KeyZ", virtualKeyCode: 90, modifiers: 4 });
  await waitFor(
    () => evaluate(`document.querySelectorAll(".milkdown-list-item-block .label.unchecked").length === 1`),
    "Undo did not restore the unchecked task marker"
  );
  await waitForSaveState(false);
  await save(taskFixture);
  await dispatchKey({ key: "z", code: "KeyZ", virtualKeyCode: 90, modifiers: 12 });
  await waitFor(
    () => evaluate(`document.querySelectorAll(".milkdown-list-item-block .label.checked").length === 2`),
    "Redo did not restore the checked task marker"
  );
  await waitForSaveState(false);
  await save(checkedFixture);
  await stopSession();
}

async function verifyTableBoundaryCutPasteHistory() {
  const alphaEnd = tableBlockSource.indexOf("Alpha") + "Alpha".length;
  const paddingDeletedBlock = `${tableBlockSource.slice(0, alphaEnd)}${
    tableBlockSource.slice(alphaEnd + 1)
  }`;
  const paddingDeletedFixture = tableFixture.replace(tableBlockSource, paddingDeletedBlock);
  const save = async (source) => {
    await dispatchKey({ key: "s", code: "KeyS", virtualKeyCode: 83, modifiers: 4 });
    await waitForCompletedSave(source);
  };

  await startSession(tableFixture, "Alpha");
  await placeCaretInText("Alpha", "Alpha".length);
  await dispatchKey({ key: "ArrowRight", code: "ArrowRight", virtualKeyCode: 39, modifiers: 8 });
  await waitForSourceControl(
    (state) => state?.active && state.value === tableBlockSource &&
      state.selectionStart === alphaEnd && state.selectionEnd === alphaEnd + 1 &&
      state.selectionDirection === "forward",
    "Shift+Right at a rendered table-cell edge did not select the exact hidden padding byte"
  );
  await dispatchKey({ key: "ArrowRight", code: "ArrowRight", virtualKeyCode: 39, modifiers: 8 });
  await waitForSourceControl(
    (state) => state?.active && state.selectionStart === alphaEnd &&
      state.selectionEnd === alphaEnd + 2 && state.selectionDirection === "forward" &&
      state.value.slice(state.selectionStart, state.selectionEnd) === " |",
    "A second Shift+Right did not extend through the physical table pipe"
  );
  await dispatchKey({ key: "ArrowLeft", code: "ArrowLeft", virtualKeyCode: 37, modifiers: 8 });
  await waitForSourceControl(
    (state) => state?.active && state.selectionStart === alphaEnd &&
      state.selectionEnd === alphaEnd + 1 && state.selectionDirection === "forward",
    "Shift+Left did not shrink the table-source selection back to its padding byte"
  );

  const cutText = await dispatchCutAndCaptureText();
  if (cutText !== " ") {
    throw new Error(`Table Cut emitted ${JSON.stringify(cutText)} instead of one padding space`);
  }
  await waitForSaveState(false);
  await save(paddingDeletedFixture);

  if (await dispatchPasteText(" ") == null) {
    throw new Error("No focused table source editor received the padding Paste event");
  }
  await waitForSaveState(false);
  await save(tableFixture);
  await dispatchKey({ key: "z", code: "KeyZ", virtualKeyCode: 90, modifiers: 4 });
  await waitForSaveState(false);
  await save(paddingDeletedFixture);
  await dispatchKey({ key: "z", code: "KeyZ", virtualKeyCode: 90, modifiers: 12 });
  await waitForSaveState(false);
  await save(tableFixture);
  await stopSession();
}

async function verifyHardBreakCutPasteHistory() {
  const save = async (source) => {
    await dispatchKey({ key: "s", code: "KeyS", virtualKeyCode: 83, modifiers: 4 });
    await waitForCompletedSave(source);
  };
  for (const { markerSource, lineEnding } of [
    { markerSource: "  ", lineEnding: "\n" },
    { markerSource: "\\", lineEnding: "\r\n" }
  ]) {
    const selectedSource = `${markerSource}${lineEnding}`;
    const hardBreakFixture = `Alpha${selectedSource}Beta${lineEnding}`;
    const collapsedFixture = `AlphaBeta${lineEnding}`;

    await startSession(hardBreakFixture, "Alpha");
    await placeCaretInText("Alpha", "Alpha".length);
    for (let selectedLength = 1; selectedLength <= markerSource.length; selectedLength += 1) {
      await dispatchKey({ key: "ArrowRight", code: "ArrowRight", virtualKeyCode: 39, modifiers: 8 });
      await waitForSourceControl(
        (state) => state?.active && state.value === markerSource &&
          state.selectionStart === 0 && state.selectionEnd === selectedLength &&
          state.selectionDirection === "forward",
        `Shift+Right did not select hard-break marker byte ${selectedLength}`
      );
    }
    await dispatchKey({ key: "ArrowRight", code: "ArrowRight", virtualKeyCode: 39, modifiers: 8 });
    await assertSourceControlClosed(
      "Extending through a hard break did not hand its source selection back to the document"
    );

    const cutText = await dispatchCutAndCaptureText();
    if (cutText !== selectedSource) {
      throw new Error(`Hard-break Cut emitted ${JSON.stringify(cutText)} instead of ${JSON.stringify(selectedSource)}`);
    }
    await waitForSaveState(false);
    await save(collapsedFixture);

    if (await dispatchPasteText(selectedSource) == null) {
      throw new Error("No focused editor received the hard-break source Paste event");
    }
    await waitForSaveState(false);
    await save(hardBreakFixture);
    await dispatchKey({ key: "z", code: "KeyZ", virtualKeyCode: 90, modifiers: 4 });
    await waitForSaveState(false);
    await save(collapsedFixture);
    await dispatchKey({ key: "z", code: "KeyZ", virtualKeyCode: 90, modifiers: 12 });
    await waitForSaveState(false);
    await save(hardBreakFixture);
    await stopSession();
  }
}

async function verifySoftLineEditing() {
  const fixture = "Alpha\r\nBeta\r\n";
  const editedFixture = "AlXpha\r\nBeta\r\n";
  const joinedFixture = "AlphaBeta\r\n";
  const navigatedFixture = "Alpha\r\nXBeta\r\n";
  const save = async (source) => {
    await dispatchKey({ key: "s", code: "KeyS", virtualKeyCode: 83, modifiers: 4 });
    await waitForCompletedSave(source);
  };

  await startSession(fixture, "Alpha");
  await placeCaretInText("Alpha", 2);
  await cdp.send("Input.insertText", { text: "X" });
  await waitForSaveState(false);
  await save(editedFixture);
  await dispatchKey({ key: "z", code: "KeyZ", virtualKeyCode: 90, modifiers: 4 });
  await waitForSaveState(false);
  await save(fixture);
  await dispatchKey({ key: "z", code: "KeyZ", virtualKeyCode: 90, modifiers: 12 });
  await waitForSaveState(false);
  await save(editedFixture);
  await stopSession();

  await startSession(fixture, "Alpha");
  await placeCaretInText("Alpha", "Alpha".length);
  await dispatchKey({ key: "ArrowRight", code: "ArrowRight", virtualKeyCode: 39, modifiers: 8 });
  const copied = await dispatchCopyAndCaptureText();
  if (copied !== "\r\n") {
    throw new Error(`Soft-line Copy emitted ${JSON.stringify(copied)} instead of "\\r\\n"`);
  }
  const cut = await dispatchCutAndCaptureText();
  if (cut !== "\r\n") {
    throw new Error(`Soft-line Cut emitted ${JSON.stringify(cut)} instead of "\\r\\n"`);
  }
  await waitForSaveState(false);
  await save(joinedFixture);
  await dispatchKey({ key: "z", code: "KeyZ", virtualKeyCode: 90, modifiers: 4 });
  await waitForSaveState(false);
  await save(fixture);
  await dispatchKey({ key: "z", code: "KeyZ", virtualKeyCode: 90, modifiers: 12 });
  await waitForSaveState(false);
  await save(joinedFixture);
  await stopSession();

  const spacedFixture = "Alpha \r\nBeta\r\n";
  await startSession(spacedFixture, "Alpha");
  await placeCaretInText("Alpha", "Alpha".length);
  await dispatchKey({ key: "ArrowRight", code: "ArrowRight", virtualKeyCode: 39, modifiers: 8 });
  await waitForSourceControl(
    (state) => state?.active && state.value === " " &&
      state.selectionStart === 0 && state.selectionEnd === 1 &&
      state.selectionDirection === "forward",
    "Shift+Right did not select the physical trailing space before a soft line"
  );
  const copiedSpace = await dispatchCopyAndCaptureText();
  if (copiedSpace !== " ") {
    throw new Error(`Soft-line marker Copy emitted ${JSON.stringify(copiedSpace)} instead of one space`);
  }
  await dispatchKey({ key: "ArrowRight", code: "ArrowRight", virtualKeyCode: 39, modifiers: 8 });
  await assertSourceControlClosed(
    "Extending through a soft line did not hand its source selection back to the document"
  );
  const copiedSpacedBreak = await dispatchCopyAndCaptureText();
  if (copiedSpacedBreak !== " \r\n") {
    throw new Error(
      `Soft-line marker/newline Copy emitted ${JSON.stringify(copiedSpacedBreak)} instead of " \\r\\n"`
    );
  }
  const cutSpacedBreak = await dispatchCutAndCaptureText();
  if (cutSpacedBreak !== " \r\n") {
    throw new Error(
      `Soft-line marker/newline Cut emitted ${JSON.stringify(cutSpacedBreak)} instead of " \\r\\n"`
    );
  }
  await waitForSaveState(false);
  await save(joinedFixture);
  await stopSession();

  await startSession(spacedFixture, "Alpha");
  await placeCaretInText("Alpha", "Alpha".length);
  await dispatchKey({ key: "Delete", code: "Delete", virtualKeyCode: 46 });
  await waitForSaveState(false);
  await save(fixture);
  await dispatchKey({ key: "z", code: "KeyZ", virtualKeyCode: 90, modifiers: 4 });
  await waitForSaveState(false);
  await save(spacedFixture);
  await dispatchKey({ key: "z", code: "KeyZ", virtualKeyCode: 90, modifiers: 12 });
  await waitForSaveState(false);
  await save(fixture);
  await stopSession();

  await startSession(spacedFixture, "Alpha");
  await placeCaretInText("Beta", 0);
  await dispatchKey({ key: "Backspace", code: "Backspace", virtualKeyCode: 8 });
  await waitForSaveState(false);
  await save("Alpha Beta\r\n");
  await dispatchKey({ key: "z", code: "KeyZ", virtualKeyCode: 90, modifiers: 4 });
  await waitForSaveState(false);
  await save(spacedFixture);
  await dispatchKey({ key: "z", code: "KeyZ", virtualKeyCode: 90, modifiers: 12 });
  await waitForSaveState(false);
  await save("Alpha Beta\r\n");
  await stopSession();

  for (const { text, offset, key, code, virtualKeyCode } of [
    { text: "Alpha", offset: "Alpha".length, key: "Delete", code: "Delete", virtualKeyCode: 46 },
    { text: "Beta", offset: 0, key: "Backspace", code: "Backspace", virtualKeyCode: 8 }
  ]) {
    await startSession(fixture, "Alpha");
    await placeCaretInText(text, offset);
    await dispatchKey({ key, code, virtualKeyCode });
    await waitForSaveState(false);
    await save(joinedFixture);
    await dispatchKey({ key: "z", code: "KeyZ", virtualKeyCode: 90, modifiers: 4 });
    await waitForSaveState(false);
    await save(fixture);
    await dispatchKey({ key: "z", code: "KeyZ", virtualKeyCode: 90, modifiers: 12 });
    await waitForSaveState(false);
    await save(joinedFixture);
    await stopSession();
  }

  await startSession(fixture, "Alpha");
  await placeCaretInText("Alpha", "Alpha".length);
  await dispatchKey({ key: "ArrowRight", code: "ArrowRight", virtualKeyCode: 39 });
  await cdp.send("Input.insertText", { text: "X" });
  await waitForSaveState(false);
  await save(navigatedFixture);
  await dispatchKey({ key: "z", code: "KeyZ", virtualKeyCode: 90, modifiers: 4 });
  await waitForSaveState(false);
  await save(fixture);
  await dispatchKey({ key: "z", code: "KeyZ", virtualKeyCode: 90, modifiers: 12 });
  await waitForSaveState(false);
  await save(navigatedFixture);
  await stopSession();
}

async function verifyProseToCodeReplacement() {
  const anchor = "Bef".length;
  const codeStart = codeFixture.indexOf(codeBlockSource);
  const openingFenceColumn = anchor;
  const expected = `${codeFixture.slice(0, anchor)}X${
    codeFixture.slice(codeStart + openingFenceColumn)
  }`;
  await startSession(codeFixture, "Before.");
  await placeCaretInText("Before.", anchor);
  await dispatchKey({ key: "ArrowDown", code: "ArrowDown", virtualKeyCode: 40, modifiers: 8 });
  await cdp.send("Input.insertText", { text: "X" });
  await waitForSaveState(false);
  await dispatchKey({ key: "z", code: "KeyZ", virtualKeyCode: 90, modifiers: 4 });
  await waitForSaveState(true);
  await waitFor(
    () => evaluate(`document.querySelector(".cm-content")?.textContent === ${JSON.stringify(codeContent)}`),
    "undo did not restore a prose-to-code source replacement"
  );
  await dispatchKey({ key: "z", code: "KeyZ", virtualKeyCode: 90, modifiers: 12 });
  await waitForSaveState(false);
  await dispatchKey({ key: "s", code: "KeyS", virtualKeyCode: 83, modifiers: 4 });
  await waitForCompletedSave(expected);
  await stopSession();
}

async function verifyProseToCodeCutPaste() {
  const anchor = "Bef".length;
  const codeStart = codeFixture.indexOf(codeBlockSource);
  const selectionEnd = codeStart + anchor;
  const selectedText = codeFixture.slice(anchor, selectionEnd);
  const cutSource = `${codeFixture.slice(0, anchor)}${codeFixture.slice(selectionEnd)}`;
  const save = async (source) => {
    await dispatchKey({ key: "s", code: "KeyS", virtualKeyCode: 83, modifiers: 4 });
    await waitForCompletedSave(source);
  };

  await startSession(codeFixture, "Before.");
  await placeCaretInText("Before.", anchor);
  await dispatchKey({ key: "ArrowDown", code: "ArrowDown", virtualKeyCode: 40, modifiers: 8 });
  const cutText = await dispatchCutAndCaptureText();
  if (cutText !== selectedText) {
    throw new Error(`Cut emitted ${JSON.stringify(cutText)} instead of ${JSON.stringify(selectedText)}`);
  }
  await waitForSaveState(false);
  await save(cutSource);

  const pasteDispatched = await dispatchPasteText(selectedText);
  if (pasteDispatched == null) {
    throw new Error("No focused element received the prose-to-code Paste event");
  }
  await waitForSaveState(false);
  await save(codeFixture);
  await dispatchKey({ key: "z", code: "KeyZ", virtualKeyCode: 90, modifiers: 4 });
  await waitForSaveState(false);
  await save(cutSource);
  await dispatchKey({ key: "z", code: "KeyZ", virtualKeyCode: 90, modifiers: 12 });
  await waitForSaveState(false);
  await save(codeFixture);
  await stopSession();

  const prosePaste = "X\nY";
  const prosePasteFixture = `${codeFixture.slice(0, anchor)}${prosePaste}${codeFixture.slice(anchor)}`;
  await startSession(codeFixture, "Before.");
  await placeCaretInText("Before.", anchor);
  if (await dispatchPasteText(prosePaste) == null) {
    throw new Error("No focused prose editor received the multiline Paste event");
  }
  await waitForSaveState(false);
  await save(prosePasteFixture);
  await dispatchKey({ key: "z", code: "KeyZ", virtualKeyCode: 90, modifiers: 4 });
  await waitForSaveState(false);
  await save(codeFixture);
  await dispatchKey({ key: "z", code: "KeyZ", virtualKeyCode: 90, modifiers: 12 });
  await waitForSaveState(false);
  await save(prosePasteFixture);
  await stopSession();
}

async function verifyCodeBoundaryDeletion() {
  const contentStart = codeBlockSource.indexOf("\n") + 1;
  const openingNewlineDeleted = `${codeBlockSource.slice(0, contentStart - 1)}${
    codeBlockSource.slice(contentStart)
  }`;
  await startSession(codeFixture, codeContent);
  await focusCodeBoundary("start");
  await dispatchKey({ key: "Backspace", code: "Backspace", virtualKeyCode: 8 });
  await waitForSourceControl(
    (state) => state?.active && state.value === openingNewlineDeleted &&
      state.selectionStart === contentStart - 1 && state.selectionEnd === contentStart - 1,
    "Backspace did not delete exactly the physical opening-fence newline"
  );
  await waitForSaveState(false);
  await dispatchKey({ key: "s", code: "KeyS", virtualKeyCode: 83, modifiers: 4 });
  await waitForCompletedSave(codeFixture.replace(codeBlockSource, openingNewlineDeleted));
  await stopSession();

  const contentEnd = contentStart + codeContent.length;
  const closingNewlineDeleted = `${codeBlockSource.slice(0, contentEnd)}${
    codeBlockSource.slice(contentEnd + 1)
  }`;
  await startSession(codeFixture, codeContent);
  await focusCodeBoundary("end");
  await dispatchKey({ key: "Delete", code: "Delete", virtualKeyCode: 46 });
  await waitForSourceControl(
    (state) => state?.active && state.value === closingNewlineDeleted &&
      state.selectionStart === contentEnd && state.selectionEnd === contentEnd,
    "Delete did not remove exactly the physical closing-fence newline"
  );
  await waitForSaveState(false);
  await dispatchKey({ key: "s", code: "KeyS", virtualKeyCode: 83, modifiers: 4 });
  await waitForCompletedSave(codeFixture.replace(codeBlockSource, closingNewlineDeleted));
  await stopSession();
}

async function verifyCodeToProseBackspace() {
  const afterStart = codeFixture.indexOf("After.");
  const onceDeleted = `${codeFixture.slice(0, afterStart - 1)}${codeFixture.slice(afterStart)}`;
  const twiceDeleted = `${codeFixture.slice(0, afterStart - 2)}${codeFixture.slice(afterStart)}`;
  await startSession(codeFixture, "After.");
  await placeCaretInText("After.", 2);
  await dispatchKey({ key: "ArrowLeft", code: "ArrowLeft", virtualKeyCode: 37 });
  await dispatchKey({ key: "ArrowLeft", code: "ArrowLeft", virtualKeyCode: 37 });
  await delay(150);
  await dispatchKey({ key: "Backspace", code: "Backspace", virtualKeyCode: 8 });
  await waitForSaveState(false);
  await dispatchKey({ key: "s", code: "KeyS", virtualKeyCode: 83, modifiers: 4 });
  await waitForCompletedSave(onceDeleted);
  await dispatchKey({ key: "Backspace", code: "Backspace", virtualKeyCode: 8 });
  await waitForSaveState(false);
  await dispatchKey({ key: "s", code: "KeyS", virtualKeyCode: 83, modifiers: 4 });
  await waitForCompletedSave(twiceDeleted);
  await stopSession();
}

async function verifyProseToCodeDelete() {
  const beforeEnd = codeFixture.indexOf("\n");
  const onceDeleted = `${codeFixture.slice(0, beforeEnd)}${codeFixture.slice(beforeEnd + 1)}`;
  const twiceDeleted = `${codeFixture.slice(0, beforeEnd)}${codeFixture.slice(beforeEnd + 2)}`;
  await startSession(codeFixture, "Before.");
  await placeCaretInText("Before.", "Before.".length - 2);
  await dispatchKey({ key: "ArrowRight", code: "ArrowRight", virtualKeyCode: 39 });
  await dispatchKey({ key: "ArrowRight", code: "ArrowRight", virtualKeyCode: 39 });
  await delay(150);
  await dispatchKey({ key: "Delete", code: "Delete", virtualKeyCode: 46 });
  await waitForSaveState(false);
  await dispatchKey({ key: "s", code: "KeyS", virtualKeyCode: 83, modifiers: 4 });
  await waitForCompletedSave(onceDeleted);
  await dispatchKey({ key: "Delete", code: "Delete", virtualKeyCode: 46 });
  await waitForSaveState(false);
  await dispatchKey({ key: "s", code: "KeyS", virtualKeyCode: 83, modifiers: 4 });
  await waitForCompletedSave(twiceDeleted);
  await stopSession();
}

async function verifyProseToCodeDeletionHistory() {
  const beforeEnd = codeFixture.indexOf("\n");
  const onceDeleted = `${codeFixture.slice(0, beforeEnd)}${codeFixture.slice(beforeEnd + 1)}`;
  const twiceDeleted = `${codeFixture.slice(0, beforeEnd)}${codeFixture.slice(beforeEnd + 2)}`;
  const save = async (source) => {
    await dispatchKey({ key: "s", code: "KeyS", virtualKeyCode: 83, modifiers: 4 });
    await waitForCompletedSave(source);
  };

  await startSession(codeFixture, "Before.");
  await placeCaretInText("Before.", "Before.".length - 2);
  await dispatchKey({ key: "ArrowRight", code: "ArrowRight", virtualKeyCode: 39 });
  await dispatchKey({ key: "ArrowRight", code: "ArrowRight", virtualKeyCode: 39 });
  await delay(150);
  await dispatchKey({ key: "Delete", code: "Delete", virtualKeyCode: 46 });
  await delay(80);
  await dispatchKey({ key: "Delete", code: "Delete", virtualKeyCode: 46 });
  await waitForSaveState(false);
  await save(twiceDeleted);

  await dispatchKey({ key: "z", code: "KeyZ", virtualKeyCode: 90, modifiers: 4 });
  await waitForSaveState(false);
  await save(onceDeleted);
  await dispatchKey({ key: "z", code: "KeyZ", virtualKeyCode: 90, modifiers: 4 });
  await waitForSaveState(false);
  await save(codeFixture);

  await dispatchKey({ key: "z", code: "KeyZ", virtualKeyCode: 90, modifiers: 12 });
  await waitForSaveState(false);
  await save(onceDeleted);
  await dispatchKey({ key: "z", code: "KeyZ", virtualKeyCode: 90, modifiers: 12 });
  await waitForSaveState(false);
  await save(twiceDeleted);
  await stopSession();
}

async function verifyCrlfProseToCodeDelete() {
  const beforeEnd = variantCodeFixture.indexOf("\r\n");
  const onceDeleted = `${variantCodeFixture.slice(0, beforeEnd)}${
    variantCodeFixture.slice(beforeEnd + 2)
  }`;
  const twiceDeleted = `${variantCodeFixture.slice(0, beforeEnd)}${
    variantCodeFixture.slice(beforeEnd + 4)
  }`;
  await startSession(variantCodeFixture, "Before.");
  await placeCaretInText("Before.", "Before.".length - 2);
  await dispatchKey({ key: "ArrowRight", code: "ArrowRight", virtualKeyCode: 39 });
  await dispatchKey({ key: "ArrowRight", code: "ArrowRight", virtualKeyCode: 39 });
  await delay(150);
  await dispatchKey({ key: "Delete", code: "Delete", virtualKeyCode: 46 });
  await waitForSaveState(false);
  await dispatchKey({ key: "s", code: "KeyS", virtualKeyCode: 83, modifiers: 4 });
  await waitForCompletedSave(onceDeleted);
  await dispatchKey({ key: "Delete", code: "Delete", virtualKeyCode: 46 });
  await waitForSaveState(false);
  await dispatchKey({ key: "s", code: "KeyS", virtualKeyCode: 83, modifiers: 4 });
  await waitForCompletedSave(twiceDeleted);
  await stopSession();
}

async function verifyLayeredCodeSourceHistory() {
  const contentStart = codeBlockSource.indexOf("\n") + 1;
  const deletedSource = `${codeBlockSource.slice(0, contentStart - 1)}${
    codeBlockSource.slice(contentStart)
  }`;
  const typedSource = `${deletedSource.slice(0, contentStart - 1)}X${
    deletedSource.slice(contentStart - 1)
  }`;
  await startSession(codeFixture, codeContent);
  await focusCodeBoundary("start");
  await dispatchKey({ key: "Backspace", code: "Backspace", virtualKeyCode: 8 });
  await waitForSourceControl(
    (state) => state?.active && state.value === deletedSource,
    "boundary deletion did not open its exact fenced source"
  );
  await cdp.send("Input.insertText", { text: "X" });
  await waitForSourceControl(
    (state) => state?.active && state.value === typedSource,
    "typing after a boundary deletion did not update fenced source"
  );
  await dispatchKey({ key: "z", code: "KeyZ", virtualKeyCode: 90, modifiers: 4 });
  await waitForSourceControl(
    (state) => state?.active && state.value === deletedSource,
    "first Undo did not remove only the live source input"
  );
  await waitForSaveState(false);
  await dispatchKey({ key: "z", code: "KeyZ", virtualKeyCode: 90, modifiers: 4 });
  await waitForSourceControl(
    (state) => state?.active && state.value === codeBlockSource,
    "second Undo did not restore the activation-time boundary deletion"
  );
  await waitForSaveState(true);
  await dispatchKey({ key: "z", code: "KeyZ", virtualKeyCode: 90, modifiers: 12 });
  await waitForSourceControl(
    (state) => state?.active && state.value === deletedSource,
    "first Redo did not replay the boundary deletion"
  );
  await dispatchKey({ key: "z", code: "KeyZ", virtualKeyCode: 90, modifiers: 12 });
  await waitForSourceControl(
    (state) => state?.active && state.value === typedSource,
    "second Redo did not replay the live source input"
  );
  await waitForSaveState(false);
  await dispatchKey({ key: "s", code: "KeyS", virtualKeyCode: 83, modifiers: 4 });
  await waitForCompletedSave(codeFixture.replace(codeBlockSource, typedSource));
  await stopSession();
}

async function verifyEmptyCodeEditing() {
  const expandedSource = "```js\n\n```";
  const expandedFixture = emptyCodeFixture.replace(emptyCodeBlockSource, expandedSource);
  await startSession(emptyCodeFixture, "Before.");
  await focusCodeBoundary("start");
  await dispatchKey({ key: "Enter", code: "Enter", virtualKeyCode: 13 });
  await waitForSaveState(false);
  await dispatchKey({ key: "s", code: "KeyS", virtualKeyCode: 83, modifiers: 4 });
  await waitForCompletedSave(expandedFixture);
  await waitFor(
    () => evaluate(`document.activeElement?.matches?.(".cm-content")`),
    "saving an empty-fence Enter edit did not restore CodeMirror focus"
  );

  await dispatchKey({ key: "z", code: "KeyZ", virtualKeyCode: 90, modifiers: 4 });
  await waitForSaveState(false);
  await dispatchKey({ key: "s", code: "KeyS", virtualKeyCode: 83, modifiers: 4 });
  await waitForCompletedSave(emptyCodeFixture);
  await dispatchKey({ key: "z", code: "KeyZ", virtualKeyCode: 90, modifiers: 12 });
  await waitForSaveState(false);
  await dispatchKey({ key: "s", code: "KeyS", virtualKeyCode: 83, modifiers: 4 });
  await waitForCompletedSave(expandedFixture);
  await stopSession();

  const combinedFixture = expandedFixture.replace("Before.", "Before.X");
  await startSession(emptyCodeFixture, "Before.");
  await focusCodeBoundary("start");
  await dispatchKey({ key: "Enter", code: "Enter", virtualKeyCode: 13 });
  await waitForSaveState(false);
  await placeCaretInText("Before.", "Before.".length);
  await cdp.send("Input.insertText", { text: "X" });
  await waitFor(
    () => evaluate(`document.querySelector(".ProseMirror")?.textContent.includes("Before.X")`),
    "rendered prose edit after an empty-fence source edit did not appear"
  );
  await dispatchKey({ key: "s", code: "KeyS", virtualKeyCode: 83, modifiers: 4 });
  await waitForCompletedSave(combinedFixture);
  await stopSession();

  const typedSource = "```js\nx```";
  const typedFixture = emptyCodeFixture.replace(emptyCodeBlockSource, typedSource);
  await startSession(emptyCodeFixture, "Before.");
  await waitFor(
    () => evaluate(`Boolean(document.querySelector(".milkdown-code-block .cm-content"))`),
    "empty rendered code editor did not become ready"
  );
  await clickElement(".milkdown-code-block .cm-content");
  await waitFor(
    () => evaluate(`document.activeElement?.matches?.(".cm-content")`),
    "pointer activation did not focus the empty rendered code editor"
  );
  await cdp.send("Input.insertText", { text: "x" });
  try {
    await waitFor(
      () => evaluate(`document.querySelector(".cm-content")?.textContent.startsWith("x\`\`\`")`),
      "typing at an immediate closing fence did not expose its backticks as literal code"
    );
  } catch (error) {
    const state = await sourceControlState();
    const code = await evaluate(`Array.from(document.querySelectorAll(".cm-content"), (node) => node.textContent)`);
    throw new Error(`${error.message}\nCodeMirror contents: ${JSON.stringify(code)}\nEditor state: ${JSON.stringify(state)}`);
  }
  await waitForSaveState(false);
  await dispatchKey({ key: "s", code: "KeyS", virtualKeyCode: 83, modifiers: 4 });
  await waitForCompletedSave(typedFixture);
  await stopSession();
}

async function verifyCodeEditing() {
  await startSession(codeFixture, "const value = 1;");
  const initialLanguage = await evaluate(
    `document.querySelector(".milkdown-code-block .language-button")?.textContent?.trim()`
  );
  if (!initialLanguage?.startsWith("JavaScript")) {
    throw new Error(`code-language control exposes a raw identifier: ${initialLanguage}`);
  }
  await waitFor(
    () => evaluate(`Boolean(document.querySelector(".milkdown-code-block .cm-content"))`),
    "rendered code editor did not become ready"
  );
  await clickElement(".milkdown-code-block .cm-content");
  await waitFor(
    () => evaluate(`document.activeElement?.matches?.(".cm-content")`),
    "pointer activation did not focus the rendered code editor"
  );
  await dispatchKey({ key: "End", code: "End", virtualKeyCode: 35 });
  await dispatchKey({ key: "ArrowLeft", code: "ArrowLeft", virtualKeyCode: 37 });
  await cdp.send("Input.insertText", { text: "2" });
  await waitFor(
    () => evaluate(`document.querySelector(".cm-content")?.textContent.includes("const value = 12;")`),
    "typed code did not render"
  );
  await waitForSaveState(false);
  await dispatchKey({ key: "s", code: "KeyS", virtualKeyCode: 83, modifiers: 4 });
  await waitForCompletedSave(editedCodeFixture);

  await dispatchKey({ key: "z", code: "KeyZ", virtualKeyCode: 90, modifiers: 4 });
  try {
    await waitFor(
      () => evaluate(`document.querySelector(".cm-content")?.textContent.includes("const value = 1;")`),
      "Undo did not restore the rendered code"
    );
  } catch (error) {
    const state = await editorState();
    const codeState = await evaluate(`(() => ({
      active: document.activeElement?.className || document.activeElement?.tagName || null,
      code: document.querySelector(".cm-content")?.textContent || null,
      block: document.querySelector(".milkdown-code-block")?.outerHTML || null
    }))()`);
    throw new Error(`${error.message}\nEditor state: ${JSON.stringify(state)}\nCode state: ${JSON.stringify(codeState)}`);
  }
  await waitForSaveState(false);
  await dispatchKey({ key: "s", code: "KeyS", virtualKeyCode: 83, modifiers: 4 });
  await waitForCompletedSave(codeFixture);
}

async function verifyFenceVariantEditing() {
  await startSession(variantCodeFixture, "const answer = 42;");
  await focusCodeBoundary("end");
  await dispatchKey({ key: "ArrowLeft", code: "ArrowLeft", virtualKeyCode: 37 });
  await dispatchKey({ key: "Backspace", code: "Backspace", virtualKeyCode: 8 });
  await cdp.send("Input.insertText", { text: "3" });
  await waitFor(
    () => evaluate(`document.querySelector(".cm-content")?.textContent.includes("const answer = 43;")`),
    "custom fenced code edit did not render"
  );
  await waitForSaveState(false);
  await dispatchKey({ key: "s", code: "KeyS", virtualKeyCode: 83, modifiers: 4 });
  await waitForCompletedSave(editedVariantCodeFixture);
  await stopSession();
}

async function verifyCodeCrlfClipboard() {
  const block = "~~~~js\r\nalpha\r\nbeta\r\n~~~~";
  const fixture = `Before.\r\n\r\n${block}\r\n\r\nAfter.\r\n`;
  const cutBlock = "~~~~js\r\na\r\n~~~~";
  const cutFixture = fixture.replace(block, cutBlock);
  const save = async (source) => {
    await dispatchKey({ key: "s", code: "KeyS", virtualKeyCode: 83, modifiers: 4 });
    await waitForCompletedSave(source);
  };

  await startSession(fixture, "alpha");
  await clickElement(".milkdown-code-block .cm-line:first-child");
  await waitFor(
    () => evaluate(`document.activeElement?.matches?.(".cm-content")`),
    "pointer activation did not focus the first CRLF code line"
  );
  await dispatchKey({ key: "Home", code: "Home", virtualKeyCode: 36 });
  await dispatchKey({ key: "End", code: "End", virtualKeyCode: 35, modifiers: 8 });
  await dispatchKey({ key: "ArrowRight", code: "ArrowRight", virtualKeyCode: 39, modifiers: 8 });
  await dispatchKey({ key: "End", code: "End", virtualKeyCode: 35, modifiers: 8 });

  const expected = "alpha\r\nbet";
  const copied = await dispatchSyntheticClipboardAndCaptureText("copy");
  if (copied !== expected) {
    throw new Error(
      `CRLF code Copy emitted ${JSON.stringify(copied)} instead of exact source ${JSON.stringify(expected)}`
    );
  }
  const cut = await dispatchSyntheticClipboardAndCaptureText("cut");
  if (cut !== expected) {
    throw new Error(
      `CRLF code Cut emitted ${JSON.stringify(cut)} instead of exact source ${JSON.stringify(expected)}`
    );
  }
  await waitForSaveState(false);
  await save(cutFixture);
  await dispatchKey({ key: "z", code: "KeyZ", virtualKeyCode: 90, modifiers: 4 });
  await waitForSaveState(false);
  await save(fixture);
  await dispatchKey({ key: "z", code: "KeyZ", virtualKeyCode: 90, modifiers: 12 });
  await waitForSaveState(false);
  await save(cutFixture);
  await stopSession();
}

async function verifyCodeBlockLayout() {
  await startSession(codeFixture, "const value = 1;");
  await waitFor(
    () => evaluate(`Boolean(
      document.querySelector(".milkdown-code-block .language-button")?.textContent?.trim().startsWith("JavaScript")
      && Array.from(document.querySelectorAll(".cm-lineNumbers .cm-gutterElement"))
        .some((node) => node.textContent === "1" && getComputedStyle(node).visibility !== "hidden")
    )`),
    "code language and line-number controls did not finish rendering"
  );
  const geometry = await evaluate(`(() => {
    const block = document.querySelector(".milkdown-code-block");
    const tools = block?.querySelector(".tools");
    const gutters = block?.querySelector(".cm-gutters");
    const foldGutter = block?.querySelector(".cm-foldGutter");
    const line = block?.querySelector(".cm-line");
    const blockRect = block?.getBoundingClientRect();
    const toolsRect = tools?.getBoundingClientRect();
    const guttersRect = gutters?.getBoundingClientRect();
    const foldGutterRect = foldGutter?.getBoundingClientRect();
    const lineRect = line?.getBoundingClientRect();
    if (!blockRect || !toolsRect || !guttersRect || !foldGutterRect || !lineRect) return null;
    return {
      blockHeight: blockRect.height,
      toolsHeight: toolsRect.height,
      topToText: lineRect.top - blockRect.top,
      textToBottom: blockRect.bottom - lineRect.bottom,
      guttersWidth: guttersRect.width,
      foldGutterWidth: foldGutterRect.width,
      gutterToText: lineRect.left - guttersRect.right
    };
  })()`);
  const compact = geometry
    && geometry.blockHeight >= 60
    && geometry.blockHeight <= 65
    && geometry.toolsHeight <= 24.5
    && geometry.topToText >= 28
    && geometry.topToText <= 31
    && geometry.textToBottom >= 12
    && geometry.textToBottom <= 15
    && geometry.guttersWidth >= 41.5
    && geometry.guttersWidth <= 42.5
    && geometry.foldGutterWidth === 0
    && geometry.gutterToText >= 7.5
    && geometry.gutterToText <= 8.5;
  if (!compact) throw new Error(`single-line code block spacing is imbalanced: ${JSON.stringify(geometry)}`);
  if (process.env.TETHER_PARITY_SCREENSHOT) {
    await delay(300);
    await captureElementsScreenshot([".milkdown-code-block"], process.env.TETHER_PARITY_SCREENSHOT);
  }
  await stopSession();
}

async function verifyMultilineCodeBlockLayout() {
  const lines = [
    "const first = 1;",
    "const second = 2;",
    "const third = 3;",
    `const longValue = "${"source-faithful-".repeat(18)}";`,
    "return first + second + third;"
  ];
  const fixture = `Before.\n\n\`\`\`js\n${lines.join("\n")}\n\`\`\`\n\nAfter.\n`;
  await startSession(fixture, lines[0]);
  await waitFor(
    () => evaluate(`document.querySelectorAll(".milkdown-code-block .cm-line").length === ${lines.length}`),
    "multiline code block did not render every source line"
  );
  const geometry = await evaluate(`(() => {
    const prose = document.querySelector(".ProseMirror");
    const block = prose?.querySelector(".milkdown-code-block");
    const tools = block?.querySelector(".tools");
    const scroller = block?.querySelector(".cm-scroller");
    const lines = [...(block?.querySelectorAll(".cm-line") || [])];
    const gutters = [...(block?.querySelectorAll(".cm-lineNumbers .cm-gutterElement") || [])]
      .filter((node) => node.textContent.trim());
    const proseRect = prose?.getBoundingClientRect();
    const blockRect = block?.getBoundingClientRect();
    const toolsRect = tools?.getBoundingClientRect();
    const firstRect = lines.at(0)?.getBoundingClientRect();
    const lastRect = lines.at(-1)?.getBoundingClientRect();
    const firstGutterRect = gutters.at(0)?.getBoundingClientRect();
    const lastGutterRect = gutters.at(-1)?.getBoundingClientRect();
    if (
      !proseRect || !blockRect || !toolsRect || !scroller
      || !firstRect || !lastRect || !firstGutterRect || !lastGutterRect
    ) return null;
    return {
      lineCount: lines.length,
      gutterCount: gutters.length,
      gutterLabels: gutters.map((node) => node.textContent.trim()),
      blockWithinDocument: blockRect.left >= proseRect.left - 0.5
        && blockRect.right <= proseRect.right + 0.5,
      documentOverflow: prose.scrollWidth - prose.clientWidth,
      horizontalOverflow: scroller.scrollWidth - scroller.clientWidth,
      toolsToFirstLine: firstRect.top - toolsRect.bottom,
      lastLineToBlockBottom: blockRect.bottom - lastRect.bottom,
      firstMarkerDelta: firstGutterRect.top - firstRect.top,
      lastMarkerDelta: lastGutterRect.top - lastRect.top,
      firstLineHeight: firstRect.height,
      lastLineHeight: lastRect.height
    };
  })()`);
  const balanced = geometry
    && geometry.lineCount === lines.length
    && Array.from({ length: lines.length }, (_, index) => String(index + 1))
      .every((label) => geometry.gutterLabels.includes(label))
    && geometry.blockWithinDocument
    && geometry.documentOverflow <= 1
    && geometry.horizontalOverflow > 80
    && geometry.toolsToFirstLine >= 0
    && geometry.toolsToFirstLine <= 3
    && geometry.lastLineToBlockBottom >= 12
    && geometry.lastLineToBlockBottom <= 32
    && Math.abs(geometry.firstMarkerDelta) <= 0.5
    && Math.abs(geometry.lastMarkerDelta) <= 0.5
    && Math.abs(geometry.firstLineHeight - geometry.lastLineHeight) <= 0.5;
  if (!balanced) {
    throw new Error(`multiline code block layout is clipped or misaligned: ${JSON.stringify(geometry)}`);
  }
  if (process.env.TETHER_PARITY_SCREENSHOT) {
    await captureElementsScreenshot([".milkdown-code-block"], process.env.TETHER_PARITY_SCREENSHOT);
  }
  await stopSession();
}

async function verifyCodeLanguagePickerPresentation() {
  await startSession(codeFixture, "const value = 1;");
  const closedOverflow = await evaluate(
    `getComputedStyle(document.querySelector(".milkdown-code-block")).overflow`
  );
  if (closedOverflow !== "hidden") {
    throw new Error(`closed code block no longer clips its contents: ${closedOverflow}`);
  }
  await evaluate(`document.querySelector(".milkdown-code-block .language-button")?.click()`);
  await waitFor(
    () => evaluate(`Boolean(
      document.querySelector(".milkdown-code-block .language-button[data-expanded='true']")
      && document.querySelector(".milkdown-code-block .language-picker .list-wrapper")
    )`),
    "code language picker did not open"
  );
  const presentation = await evaluate(`(() => {
    const block = document.querySelector(".milkdown-code-block");
    const picker = block?.querySelector(".language-picker:has(.list-wrapper)");
    const blockRect = block?.getBoundingClientRect();
    const pickerRect = picker?.getBoundingClientRect();
    if (!block || !picker || !blockRect || !pickerRect) return null;
    const sampleX = Math.min(pickerRect.right - 4, pickerRect.left + 24);
    const sampleY = Math.min(innerHeight - 4, pickerRect.bottom - 4, blockRect.bottom + 24);
    const hit = document.elementFromPoint(sampleX, sampleY);
    return {
      overflow: getComputedStyle(block).overflow,
      pickerExtendsPastBlock: pickerRect.bottom > blockRect.bottom + 100,
      overflowAreaIsInteractive: Boolean(hit?.closest(".language-picker") === picker)
    };
  })()`);
  if (
    presentation?.overflow !== "visible"
    || !presentation.pickerExtendsPastBlock
    || !presentation.overflowAreaIsInteractive
  ) {
    throw new Error(`code language picker is clipped or non-interactive: ${JSON.stringify(presentation)}`);
  }
  if (process.env.TETHER_PARITY_SCREENSHOT) {
    await captureElementsScreenshot(
      [".milkdown-code-block", ".milkdown-code-block .language-picker:has(.list-wrapper)"],
      process.env.TETHER_PARITY_SCREENSHOT
    );
  }
  await stopSession();
}

async function verifyCodeLanguagePickerSourceFidelity() {
  const expected = variantCodeFixture.replace("~~~~js title=demo", "~~~~python title=demo");
  await startSession(variantCodeFixture, "const answer = 42;");
  await evaluate(`document.querySelector(".milkdown-code-block .language-button")?.click()`);
  await waitFor(
    () => evaluate(`Boolean(document.querySelector(
      ".milkdown-code-block .language-list-item[data-language='python']"
    ))`),
    "Python code-language option did not render"
  );
  const selected = await evaluate(`(() => {
    const option = document.querySelector(
      ".milkdown-code-block .language-list-item[data-language='python']"
    );
    option?.click();
    return Boolean(option);
  })()`);
  if (!selected) throw new Error("Could not select Python from the code-language picker");
  await waitFor(
    () => evaluate(`document.querySelector(".milkdown-code-block .language-button")?.textContent
      ?.startsWith("Python")`),
    "code-language control did not update to Python"
  );
  await waitForSaveState(false);
  await dispatchKey({ key: "s", code: "KeyS", virtualKeyCode: 83, modifiers: 4 });
  await waitForCompletedSave(expected);
  await stopSession();
}

async function verifyCodeOptionVerticalNavigation() {
  const content = "alpha\nbeta\ngamma";
  const block = `\`\`\`text\n${content}\n\`\`\``;
  const fixture = `Before.\n\n${block}\n\nAfter.\n`;
  const save = async (source) => {
    await waitForSaveState(false);
    await dispatchKey({ key: "s", code: "KeyS", virtualKeyCode: 83, modifiers: 4 });
    await waitForCompletedSave(source);
  };

  await startSession(fixture, "alpha");
  await clickElement(".milkdown-code-block .cm-line:nth-child(2)");
  await dispatchKey({ key: "Home", code: "Home", virtualKeyCode: 36 });
  await dispatchKey({ key: "ArrowRight", code: "ArrowRight", virtualKeyCode: 39 });
  await dispatchKey({ key: "ArrowRight", code: "ArrowRight", virtualKeyCode: 39 });
  await dispatchKey({ key: "ArrowUp", code: "ArrowUp", virtualKeyCode: 38, modifiers: 1 });
  await waitFor(
    () => evaluate(`(() => {
      const selection = getSelection();
      const lines = Array.from(document.querySelectorAll(".milkdown-code-block .cm-line"));
      return lines.map((line) => line.textContent).join("\\n") === ${JSON.stringify(content)}
        && selection?.anchorNode?.data === "alpha"
        && selection.anchorOffset === 2;
    })()`),
    "Option-ArrowUp reordered code instead of navigating to the previous source line"
  );
  await cdp.send("Input.insertText", { text: "X" });
  await save(fixture.replace(content, "alXpha\nbeta\ngamma"));
  await stopSession();

  await startSession(fixture, "alpha");
  await clickElement(".milkdown-code-block .cm-line:nth-child(2)");
  await dispatchKey({ key: "Home", code: "Home", virtualKeyCode: 36 });
  await dispatchKey({ key: "ArrowRight", code: "ArrowRight", virtualKeyCode: 39 });
  await dispatchKey({ key: "ArrowRight", code: "ArrowRight", virtualKeyCode: 39 });
  await dispatchKey({ key: "ArrowDown", code: "ArrowDown", virtualKeyCode: 40, modifiers: 1 });
  await waitFor(
    () => evaluate(`(() => {
      const selection = getSelection();
      const lines = Array.from(document.querySelectorAll(".milkdown-code-block .cm-line"));
      return lines.map((line) => line.textContent).join("\\n") === ${JSON.stringify(content)}
        && selection?.anchorNode?.data === "gamma"
        && selection.anchorOffset === 2;
    })()`),
    "Option-ArrowDown reordered code instead of navigating to the next source line"
  );
  await cdp.send("Input.insertText", { text: "Y" });
  await save(fixture.replace(content, "alpha\nbeta\ngaYmma"));
  await stopSession();

  await startSession(fixture, "alpha");
  await clickElement(".milkdown-code-block .cm-line:first-child");
  await dispatchKey({ key: "Home", code: "Home", virtualKeyCode: 36 });
  await dispatchKey({ key: "ArrowRight", code: "ArrowRight", virtualKeyCode: 39 });
  await dispatchKey({ key: "ArrowRight", code: "ArrowRight", virtualKeyCode: 39 });
  await dispatchKey({ key: "ArrowUp", code: "ArrowUp", virtualKeyCode: 38, modifiers: 1 });
  await waitForSourceControl(
    (state) => state?.active && state.value === block
      && state.selectionStart === 2 && state.selectionEnd === 2,
    "Option-ArrowUp did not continue onto the physical opening-fence line"
  );
  await stopSession();

  const closingStart = block.lastIndexOf("\n") + 1;
  await startSession(fixture, "alpha");
  await clickElement(".milkdown-code-block .cm-line:last-child");
  await dispatchKey({ key: "Home", code: "Home", virtualKeyCode: 36 });
  await dispatchKey({ key: "ArrowRight", code: "ArrowRight", virtualKeyCode: 39 });
  await dispatchKey({ key: "ArrowRight", code: "ArrowRight", virtualKeyCode: 39 });
  await dispatchKey({ key: "ArrowDown", code: "ArrowDown", virtualKeyCode: 40, modifiers: 1 });
  await waitForSourceControl(
    (state) => state?.active && state.value === block
      && state.selectionStart === closingStart + 2
      && state.selectionEnd === closingStart + 2,
    "Option-ArrowDown did not continue onto the physical closing-fence line"
  );
  await stopSession();
}

async function verifyCodeShiftOptionVerticalSelection() {
  const content = "alpha\nbeta\ngamma";
  const block = `\`\`\`text\n${content}\n\`\`\``;
  const fixture = `Before.\n\n${block}\n\nAfter.\n`;
  const save = async (source) => {
    await waitForSaveState(false);
    await dispatchKey({ key: "s", code: "KeyS", virtualKeyCode: 83, modifiers: 4 });
    await waitForCompletedSave(source);
  };

  await startSession(fixture, "alpha");
  await clickElement(".milkdown-code-block .cm-line:nth-child(2)");
  await dispatchKey({ key: "Home", code: "Home", virtualKeyCode: 36 });
  await dispatchKey({ key: "ArrowRight", code: "ArrowRight", virtualKeyCode: 39 });
  await dispatchKey({ key: "ArrowRight", code: "ArrowRight", virtualKeyCode: 39 });
  await dispatchKey({
    key: "ArrowUp",
    code: "ArrowUp",
    virtualKeyCode: 38,
    modifiers: 9
  });
  await cdp.send("Input.insertText", { text: "X" });
  await save(fixture.replace(content, "alXta\ngamma"));
  await stopSession();

  await startSession(fixture, "alpha");
  await clickElement(".milkdown-code-block .cm-line:nth-child(2)");
  await dispatchKey({ key: "Home", code: "Home", virtualKeyCode: 36 });
  await dispatchKey({ key: "ArrowRight", code: "ArrowRight", virtualKeyCode: 39 });
  await dispatchKey({ key: "ArrowRight", code: "ArrowRight", virtualKeyCode: 39 });
  await dispatchKey({
    key: "ArrowDown",
    code: "ArrowDown",
    virtualKeyCode: 40,
    modifiers: 9
  });
  await cdp.send("Input.insertText", { text: "Y" });
  await save(fixture.replace(content, "alpha\nbeYmma"));
  await stopSession();

  const contentStart = block.indexOf("\n") + 1;
  await startSession(fixture, "alpha");
  await clickElement(".milkdown-code-block .cm-line:first-child");
  await dispatchKey({ key: "Home", code: "Home", virtualKeyCode: 36 });
  await dispatchKey({ key: "ArrowRight", code: "ArrowRight", virtualKeyCode: 39 });
  await dispatchKey({ key: "ArrowRight", code: "ArrowRight", virtualKeyCode: 39 });
  await dispatchKey({
    key: "ArrowUp",
    code: "ArrowUp",
    virtualKeyCode: 38,
    modifiers: 9
  });
  await waitForSourceControl(
    (state) => state?.active && state.value === block
      && state.selectionStart === 2
      && state.selectionEnd === contentStart + 2
      && state.selectionDirection === "backward",
    "Shift-Option-ArrowUp did not extend the code selection onto the opening fence line"
  );
  await stopSession();

  const lastLineHead = contentStart + content.indexOf("gamma") + 2;
  const closingStart = block.lastIndexOf("\n") + 1;
  await startSession(fixture, "alpha");
  await clickElement(".milkdown-code-block .cm-line:last-child");
  await dispatchKey({ key: "Home", code: "Home", virtualKeyCode: 36 });
  await dispatchKey({ key: "ArrowRight", code: "ArrowRight", virtualKeyCode: 39 });
  await dispatchKey({ key: "ArrowRight", code: "ArrowRight", virtualKeyCode: 39 });
  await dispatchKey({
    key: "ArrowDown",
    code: "ArrowDown",
    virtualKeyCode: 40,
    modifiers: 9
  });
  await waitForSourceControl(
    (state) => state?.active && state.value === block
      && state.selectionStart === lastLineHead
      && state.selectionEnd === closingStart + 2
      && state.selectionDirection === "forward",
    "Shift-Option-ArrowDown did not extend the code selection onto the closing fence line"
  );
  await stopSession();
}

async function run() {
  if (process.env.TETHER_PARITY_CASE === "code-option-vertical-navigation") {
    await verifyCodeOptionVerticalNavigation();
    console.log("Verified Option-Up/Down navigate fenced source without reordering code lines.");
    return;
  }
  if (process.env.TETHER_PARITY_CASE === "code-shift-option-vertical-selection") {
    await verifyCodeShiftOptionVerticalSelection();
    console.log("Verified Shift-Option-Up/Down extend fenced source without copying code lines.");
    return;
  }
  if (process.env.TETHER_PARITY_CASE === "source-selection-movement") {
    await verifySourceSelectionNativeMovement();
    console.log("Verified source selections collapse and move like a native text editor.");
    return;
  }
  if (process.env.TETHER_PARITY_CASE === "source-control-select-all") {
    await verifySourceControlSelectAllHistory();
    console.log("Verified temporary Markdown source Select All owns the complete physical document.");
    return;
  }
  if (process.env.TETHER_PARITY_CASE === "source-line-delete") {
    await verifySourceLineDeletionHistory();
    console.log("Verified hidden line deletion follows exact physical Markdown line bounds.");
    return;
  }
  if (process.env.TETHER_PARITY_CASE === "source-word-delete") {
    await verifySourceWordDeletionHistory();
    console.log("Verified hidden word deletion follows exact Markdown source across rendered boundaries.");
    return;
  }
  if (process.env.TETHER_PARITY_CASE === "inline-source-tab") {
    await verifyInlineSourceTabHistory();
    console.log("Verified hidden inline source uses physical Markdown Tab and Shift-Tab semantics.");
    return;
  }
  if (process.env.TETHER_PARITY_CASE === "inline-source-line-jumps") {
    await verifyInlineSourceLineJumps();
    console.log("Verified hidden inline source uses physical Markdown Home/End semantics.");
    return;
  }
  if (process.env.TETHER_PARITY_CASE === "inline-source-multiline-paste") {
    await verifyInlineSourceMultilinePasteHistory();
    console.log("Verified multiline Paste inside hidden inline source preserves exact Markdown and history.");
    return;
  }
  if (process.env.TETHER_PARITY_CASE === "inline-source-enter") {
    await verifyInlineSourceEnterHistory();
    console.log("Verified Enter inside hidden inline source preserves exact Markdown and history.");
    return;
  }
  if (process.env.TETHER_PARITY_CASE === "code-boundary-deletion") {
    await verifyCodeBoundaryDeletion();
    console.log("Verified code-boundary deletion publishes exact fence source immediately.");
    return;
  }
  if (process.env.TETHER_PARITY_CASE === "code-jump-navigation") {
    await verifyCodeJumpNavigation();
    console.log("Verified code line, word, and document jumps traverse physical fence source.");
    return;
  }
  if (process.env.TETHER_PARITY_CASE === "code-extended-word-navigation") {
    await verifyCodeExtendedWordNavigation();
    console.log("Verified extended code selections continue word navigation through fence source.");
    return;
  }
  if (process.env.TETHER_PARITY_CASE === "code-extended-vertical-navigation") {
    await verifyCodeExtendedVerticalNavigation();
    console.log("Verified extended code selections continue vertical navigation onto fence lines.");
    return;
  }
  if (process.env.TETHER_PARITY_CASE === "code-document-jump-replacement") {
    await verifyCodeDocumentJumpReplacement();
    console.log("Verified code document-jump replacement retains exact terminal source and history.");
    return;
  }
  if (process.env.TETHER_PARITY_CASE === "code-select-all-editing") {
    await verifyCodeSelectAllEditing();
    console.log("Verified CodeMirror Select All edits the exact physical Markdown document.");
    return;
  }
  if (process.env.TETHER_PARITY_CASE === "prose-select-all-editing") {
    await verifyProseSelectAllEditing();
    console.log("Verified rendered-prose Select All edits the exact physical Markdown document.");
    return;
  }
  if (process.env.TETHER_PARITY_CASE === "code-select-all-tab-history") {
    await verifyCodeSelectAllTabHistory();
    console.log("Verified CodeMirror Select All Tab and Shift-Tab preserve every physical line and history.");
    return;
  }
  if (process.env.TETHER_PARITY_CASE === "code-block-layout") {
    await verifyCodeBlockLayout();
    console.log("Verified compact, balanced single-line fenced-code spacing.");
    return;
  }
  if (process.env.TETHER_PARITY_CASE === "multiline-code-block-layout") {
    await verifyMultilineCodeBlockLayout();
    console.log("Verified multiline fenced-code alignment and contained horizontal scrolling.");
    return;
  }
  if (process.env.TETHER_PARITY_CASE === "code-language-picker") {
    await verifyCodeLanguagePickerPresentation();
    console.log("Verified the code language picker escapes the block and remains interactive.");
    return;
  }
  if (process.env.TETHER_PARITY_CASE === "code-language-picker-source") {
    await verifyCodeLanguagePickerSourceFidelity();
    console.log("Verified language selection preserves custom fence metadata and line endings.");
    return;
  }
  if (process.env.TETHER_PARITY_CASE === "prose-to-code-replacement") {
    await verifyProseToCodeReplacement();
    console.log("Verified real Electron prose-to-code source replacement history.");
    return;
  }
  if (process.env.TETHER_PARITY_CASE === "prose-to-code-cut-paste") {
    await verifyProseToCodeCutPaste();
    console.log("Verified prose-to-code Cut/Paste retains physical Markdown source and history.");
    return;
  }
  if (process.env.TETHER_PARITY_CASE === "code-to-prose-backspace") {
    await verifyCodeToProseBackspace();
    console.log("Verified repeated Backspace after fenced code removes one physical newline at a time.");
    return;
  }
  if (process.env.TETHER_PARITY_CASE === "prose-to-code-delete") {
    await verifyProseToCodeDelete();
    console.log("Verified repeated Delete before fenced code removes one physical newline at a time.");
    return;
  }
  if (process.env.TETHER_PARITY_CASE === "prose-to-code-deletion-history") {
    await verifyProseToCodeDeletionHistory();
    console.log("Verified consecutive fence-gap deletions keep independent Undo and Redo steps.");
    return;
  }
  if (process.env.TETHER_PARITY_CASE === "crlf-prose-to-code-delete") {
    await verifyCrlfProseToCodeDelete();
    console.log("Verified CRLF fence gaps delete one complete physical line ending at a time.");
    return;
  }
  if (process.env.TETHER_PARITY_CASE === "fence-variant-editing") {
    await verifyFenceVariantEditing();
    console.log("Verified CRLF tilde fences retain exact metadata and marker source after editing.");
    return;
  }
  if (process.env.TETHER_PARITY_CASE === "code-crlf-clipboard") {
    await verifyCodeCrlfClipboard();
    console.log("Verified fenced-code Copy and Cut retain physical CRLF source and history.");
    return;
  }
  if (process.env.TETHER_PARITY_CASE === "code-to-prose") {
    await verifyCodeToProseSelection();
    console.log("Verified real Electron code-to-prose source selection and history.");
    return;
  }
  if (process.env.TETHER_PARITY_CASE === "code-to-prose-replacement") {
    await verifyCodeToProseReplacement();
    console.log("Verified real Electron code-to-prose replacement history.");
    return;
  }
  if (process.env.TETHER_PARITY_CASE === "code-to-prose-cut-paste") {
    await verifyCodeToProseCutPaste();
    console.log("Verified code-to-prose Cut/Paste retains physical Markdown source and history.");
    return;
  }
  if (process.env.TETHER_PARITY_CASE === "backward-code-to-prose-cut-paste") {
    await verifyBackwardCodeToProseCutPaste();
    console.log("Verified backward code-to-prose Cut/Paste retains physical Markdown source and history.");
    return;
  }
  if (process.env.TETHER_PARITY_CASE === "code-pointer-drag-cut-paste") {
    await verifyCodePointerDragCutPaste();
    console.log("Verified bidirectional pointer drags between code and prose retain physical fence source and history.");
    return;
  }
  if (process.env.TETHER_PARITY_CASE === "code-to-code-pointer-drag-cut-paste") {
    await verifyCodeToCodePointerDragCutPaste();
    console.log("Verified pointer drags between code blocks retain partial content and physical fence source.");
    return;
  }
  if (process.env.TETHER_PARITY_CASE === "structural-marker-navigation") {
    await verifyStructuralMarkerNavigation();
    console.log("Verified rendered structural markers navigate one physical source byte at a time.");
    return;
  }
  if (process.env.TETHER_PARITY_CASE === "block-atom-traversal") {
    await verifyBlockAtomTraversal();
    console.log("Verified rendered block atoms traverse their exact surrounding source.");
    return;
  }
  if (process.env.TETHER_PARITY_CASE === "block-atom-cut-paste") {
    await verifyBlockAtomCutPasteHistory();
    console.log("Verified block-atom selections retain exact source and history.");
    return;
  }
  if (process.env.TETHER_PARITY_CASE === "list-item-cut-paste") {
    await verifyListItemCutPaste();
    console.log("Verified list-item Cut/Paste retains physical markers and history.");
    return;
  }
  if (process.env.TETHER_PARITY_CASE === "task-checkbox-history") {
    await verifyTaskCheckboxHistory();
    console.log("Verified rendered task checkboxes retain physical markers and history.");
    return;
  }
  if (process.env.TETHER_PARITY_CASE === "table-boundary-history") {
    await verifyTableBoundaryCutPasteHistory();
    console.log("Verified rendered table boundaries retain physical padding, pipes, and history.");
    return;
  }
  if (process.env.TETHER_PARITY_CASE === "hard-break-history") {
    await verifyHardBreakCutPasteHistory();
    console.log("Verified rendered hard breaks retain physical markers, line endings, and history.");
    return;
  }
  if (process.env.TETHER_PARITY_CASE === "soft-line-editing") {
    await verifySoftLineEditing();
    console.log("Verified edited soft lines retain physical CRLF source and history.");
    return;
  }
  if (process.env.TETHER_PARITY_CASE === "closing-fence-replacement") {
    await verifyClosingFenceReplacement();
    console.log("Verified real Electron closing-fence replacement history.");
    return;
  }
  if (process.env.TETHER_PARITY_CASE === "layered-code-source-history") {
    await verifyLayeredCodeSourceHistory();
    console.log("Verified layered fenced-source input and boundary history.");
    return;
  }
  if (process.env.TETHER_PARITY_CASE === "inline-boundary-exit") {
    await verifyInlineBoundaryExitNavigation();
    console.log("Verified inline source exits consume the next physical character.");
    return;
  }
  if (process.env.TETHER_PARITY_CASE === "literal-source-tokens") {
    await verifyLiteralSourceTokens();
    console.log("Verified escaped characters and entities retain physical source navigation.");
    return;
  }
  if (process.env.TETHER_PARITY_CASE === "inline-construct-deletion") {
    await verifyInlineConstructDeletion();
    console.log("Verified inline delimiter deletion stays source-faithful.");
    return;
  }
  await verifyInlineEditing();
  await stopSession();
  await verifyInlineBoundaryNavigation();
  await verifyInlineBoundaryExitNavigation();
  await stopSession();
  await verifyLiteralSourceTokens();
  await stopSession();
  await verifyInlineConstructBoundaries();
  await verifyInlineConstructDeletion();
  await verifyInlineCrossBoundarySelection();
  await verifyInlineSourceEnterHistory();
  await verifyInlineSourceMultilinePasteHistory();
  await verifyInlineSourceLineJumps();
  await verifyInlineSourceTabHistory();
  await verifySourceWordDeletionHistory();
  await verifySourceLineDeletionHistory();
  await verifySourceControlSelectAllHistory();
  await verifyCodeBoundaryNavigation();
  await verifyCodeBoundarySelection();
  await verifyCodeJumpNavigation();
  await verifyCodeExtendedWordNavigation();
  await verifyCodeExtendedVerticalNavigation();
  await verifyCodeOptionVerticalNavigation();
  await verifyCodeShiftOptionVerticalSelection();
  await verifyCodeDocumentJumpReplacement();
  await verifyCodeSelectAllEditing();
  await verifyProseSelectAllEditing();
  await verifyCodeSelectAllTabHistory();
  await verifyClosingFenceReplacement();
  await verifyCodeToProseSelection();
  await verifyCodeToProseReplacement();
  await verifyCodeToProseCutPaste();
  await verifyBackwardCodeToProseCutPaste();
  await verifyCodePointerDragCutPaste();
  await verifyCodeToCodePointerDragCutPaste();
  await verifyStructuralMarkerNavigation();
  await verifyBlockAtomTraversal();
  await verifyBlockAtomCutPasteHistory();
  await verifySourceSelectionNativeMovement();
  await verifyListItemCutPaste();
  await verifyTaskCheckboxHistory();
  await verifyTableBoundaryCutPasteHistory();
  await verifyHardBreakCutPasteHistory();
  await verifySoftLineEditing();
  await verifyProseToCodeReplacement();
  await verifyProseToCodeCutPaste();
  await verifyCodeBoundaryDeletion();
  await verifyCodeToProseBackspace();
  await verifyProseToCodeDelete();
  await verifyProseToCodeDeletionHistory();
  await verifyCrlfProseToCodeDelete();
  await verifyLayeredCodeSourceHistory();
  await verifyEmptyCodeEditing();
  await verifyCodeEditing();
  await stopSession();
  await verifyFenceVariantEditing();
  await verifyCodeCrlfClipboard();
  await verifyCodeBlockLayout();
  await verifyMultilineCodeBlockLayout();
  await verifyCodeLanguagePickerPresentation();
  await verifyCodeLanguagePickerSourceFidelity();
  console.log("Verified real Electron typing, saving, history, and fenced-code presentation.");
}

let exitCode = 0;
try {
  await run();
} catch (error) {
  console.error(error?.stack || error);
  exitCode = 1;
} finally {
  try {
    await stopSession(true);
    await backgroundElectron.cleanup();
  } catch (error) {
    console.error(error?.stack || error);
    exitCode = 1;
  }
}

// Multiple Node WebSocket sessions can leave an idle undici handle behind even
// after Electron and every isolated profile have been closed. Cleanup above is
// complete, so do not let that stale handle keep the verifier resident.
process.exit(exitCode);
