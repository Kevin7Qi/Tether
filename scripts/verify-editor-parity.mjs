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
// BrowserWindow. Rotate the background-only host after a small group as well:
// Chromium input state can otherwise leak across a long run even though each
// renderer is new. The accessory/offscreen host keeps these rotations invisible.
// Set TETHER_PARITY_WINDOWS_PER_PROCESS=1 for strict process-level isolation.
const maxWindowsPerElectronSession = requestedWindowsPerProcess > 0
  ? requestedWindowsPerProcess
  : 4;

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
    const host = document.querySelector(".tether-wysiwyg-host");
    const selection = getSelection();
    const anchorNode = selection?.anchorNode || null;
    const anchorOffset = selection?.anchorOffset ?? null;
    const focusNode = selection?.focusNode || null;
    const focusOffset = selection?.focusOffset ?? null;
    const followingText = anchorNode?.nodeType === Node.TEXT_NODE
      ? anchorNode.data.slice(anchorOffset)
      : anchorNode?.childNodes?.[anchorOffset]?.textContent ?? "";
    return {
      activeElement: document.activeElement?.className || document.activeElement?.tagName || null,
      anchorText: anchorNode?.data || null,
      anchorOffset,
      focusText: focusNode?.data || null,
      focusOffset,
      selectionText: selection?.toString() || "",
      followingText,
      dirty: Boolean(document.querySelector(".dirty-dot")),
      saveDisabled: document.querySelector(".save-button")?.disabled ?? null,
      status: document.querySelector(".status-copy")?.textContent || null,
      exactSourceSelection: root?.tetherGetActiveSourceSelection?.() || null,
      committedSourceDraft: root?.tetherCommittedSourceDraft?.markdown ?? null,
      committedSourceDraftMatches: Boolean(
        root?.tetherCommittedSourceDraft?.doc?.eq?.(root?.pmViewDesc?.node)
      ),
      documentAttrs: root?.pmViewDesc?.node?.attrs || null,
      baselineSource: host?.tetherGetLoadedSource?.() || null,
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

async function clickTextBoundary(text, offset, rootSelector = ".ProseMirror") {
  const point = await textBoundaryPoint(text, offset, rootSelector);
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...point });
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    button: "left",
    buttons: 1,
    clickCount: 1,
    ...point
  });
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    button: "left",
    buttons: 0,
    clickCount: 1,
    ...point
  });
  await delay(180);
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
    if (!control) return null;
    const physical = control.tetherGetPhysicalSourceState?.();
    return {
      value: physical?.value ?? control.value,
      selectionStart: physical?.start ?? control.selectionStart,
      selectionEnd: physical?.end ?? control.selectionEnd,
      selectionDirection: physical?.direction ?? control.selectionDirection,
      displayValue: control.value,
      displaySelectionStart: control.selectionStart,
      displaySelectionEnd: control.selectionEnd,
      className: control.className,
      active: document.activeElement === control
    };
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

async function dispatchTextKey(text, code, virtualKeyCode) {
  const common = {
    key: text,
    code,
    text,
    unmodifiedText: text,
    windowsVirtualKeyCode: virtualKeyCode
  };
  await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", ...common });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...common });
}

async function dispatchImeText(text) {
  await cdp.send("Input.imeSetComposition", {
    text,
    selectionStart: text.length,
    selectionEnd: text.length
  });
  await cdp.send("Input.insertText", { text });
}

async function dispatchEnterKey(modifiers = 0) {
  const common = {
    key: "Enter",
    code: "Enter",
    text: "\r",
    unmodifiedText: "\r",
    modifiers,
    windowsVirtualKeyCode: 13
  };
  await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", ...common });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...common });
}

async function dispatchNativeKey(keyCode, modifiers = []) {
  const handled = await evaluate(
    `window.remoteMarkdown.sendNativeKeyForTest(${JSON.stringify(keyCode)}, ${JSON.stringify(modifiers)})`
  );
  if (!handled) throw new Error(`Native key dispatch was unavailable for ${keyCode}`);
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
    const control = await sourceControlState().catch(() => null);
    throw new Error(
      `${error.message}\nActual source: ${JSON.stringify(actual)}`
      + `\nEditor state: ${JSON.stringify(state)}`
      + `\nSource control: ${JSON.stringify(control)}`
    );
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

async function startSession(fixture, visibleText, options = {}) {
  const startupAttempt = Number(options.__startupAttempt) || 0;
  // Reuse each invisible Electron host for a bounded fixture group, replacing
  // only its offscreen BrowserWindow until the isolation threshold is reached.
  if (child && sessionWindowCount >= maxWindowsPerElectronSession) {
    await stopSession(true);
  }
  electronOutput = "";
  let expectedSource = fixture;
  if (!child) {
    profilePath = await mkdtemp(path.join(os.tmpdir(), "tether-editor-parity-"));
    samplePath = path.join(profilePath, "sample.md");
    remoteDebugPort = await availablePort();
    await writeFile(samplePath, fixture, "utf8");
    const launchArguments = [];
    if (typeof options.externalFixture === "string") {
      const externalFileName = options.externalFileName || "opened-from-finder.md";
      const externalPath = path.join(profilePath, externalFileName);
      await writeFile(externalPath, options.externalFixture, "utf8");
      launchArguments.push(externalPath);
      expectedSource = options.externalFixture;
    }
    child = spawn(
      backgroundElectron.executable,
      [
        `--remote-debugging-port=${remoteDebugPort}`,
        `--user-data-dir=${profilePath}`,
        root,
        ...launchArguments
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
  try {
    await waitFor(
      () => evaluate(`typeof window.remoteMarkdown?.saveLocalSample === "function"`),
      "Tether native sample API did not become ready"
    );
    await waitFor(
      () => evaluate(`Boolean(document.querySelector(".tether-wysiwyg.is-ready .ProseMirror") && !document.querySelector(".document-loading"))`),
      "Tether editor did not become ready"
    );
  } catch (error) {
    const failedOutput = electronOutput;
    await stopSession(true);
    if (startupAttempt < 2) {
      console.warn(
        `Retrying stalled hidden Electron fixture (${startupAttempt + 1}/2): ${error.message}`
      );
      return startSession(fixture, visibleText, {
        ...options,
        __startupAttempt: startupAttempt + 1
      });
    }
    throw new Error(
      `${error.message} after ${startupAttempt + 1} hidden-host attempts`
      + `\nElectron output:\n${failedOutput}`
    );
  }
  try {
    await waitFor(
      () => evaluate(`document.querySelector(".tether-wysiwyg-host")?.tetherGetLoadedSource?.() === ${JSON.stringify(expectedSource)}`),
      "Tether editor did not adopt the exact fixture source"
    );
  } catch (error) {
    const actual = await evaluate(`document.querySelector(".tether-wysiwyg-host")?.tetherGetLoadedSource?.()`)
      .catch(() => null);
    throw new Error(
      `${error.message}; expected ${JSON.stringify(expectedSource)}, received ${JSON.stringify(actual)}`
      + `\nElectron output:\n${electronOutput}`
    );
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

async function waitForLoadedSource(source, message) {
  try {
    await waitFor(
      () => evaluate(`document.querySelector(".tether-wysiwyg-host")?.tetherGetLoadedSource?.() === ${JSON.stringify(source)}`),
      message
    );
  } catch (error) {
    const state = await editorState().catch(() => null);
    throw new Error(`${error.message}\nEditor state: ${JSON.stringify(state)}\nElectron output:\n${electronOutput}`);
  }
}

async function verifyExternalMarkdownOpening() {
  const launchContent = "# Finder launch\n\nOpened from Finder.\n";
  await startSession(inlineFixture, "Opened from Finder.", {
    externalFixture: launchContent,
    externalFileName: "opened-from-finder.md"
  });
  await waitFor(
    () => evaluate(`document.body.textContent.includes("opened-from-finder.md")`),
    "cold-launch Markdown path did not become the active local file"
  );

  const liveContent = "# Already running\n\nOpened while Tether was running.\n";
  const livePath = path.join(profilePath, "opened-while-running.markdown");
  await writeFile(livePath, liveContent, "utf8");
  await evaluate(`window.remoteMarkdown.openExternalMarkdownForTest(${JSON.stringify(livePath)})`);
  await waitForLoadedSource(
    liveContent,
    "an already-running Tether window did not adopt the external Markdown file"
  );

  // Opening another document is a tab switch, not a destructive replacement:
  // keep the exact unsaved source in the outgoing tab and never ask to discard
  // it merely because the next document arrived through Finder or drag/drop.
  const liveEditedContent = liveContent.replace("Already running", "Already Xrunning");
  await placeCaretInText("Already running", "Already ".length);
  await cdp.send("Input.insertText", { text: "X" });
  await waitFor(
    () => evaluate(`document.querySelector(".ProseMirror")?.textContent.includes("Already Xrunning")`),
    "the outgoing Markdown tab did not render its unsaved edit before a drop"
  );
  await waitForSaveState(false);
  await evaluate(`(() => {
    window.__tetherParityConfirmCount = 0;
    window.confirm = () => {
      window.__tetherParityConfirmCount += 1;
      return false;
    };
  })()`);

  const droppedContent = "# Dropped file\n\nOpened by drag and drop.\n";
  const droppedPath = path.join(profilePath, "dropped-document.mdown");
  await writeFile(droppedPath, droppedContent, "utf8");
  const point = await evaluate(`(() => {
    const rect = document.querySelector(".app-shell")?.getBoundingClientRect();
    return rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : null;
  })()`);
  if (!point) throw new Error("could not locate the app shell for the file-drop regression");
  const dragData = {
    items: [],
    files: [droppedPath],
    dragOperationsMask: 1
  };
  await cdp.send("Input.dispatchDragEvent", { type: "dragEnter", ...point, data: dragData });
  await waitFor(
    () => evaluate(`Boolean(document.querySelector(".file-drop-overlay"))`),
    "dragging a Markdown file did not show the drop affordance"
  );
  await cdp.send("Input.dispatchDragEvent", { type: "dragOver", ...point, data: dragData });
  await cdp.send("Input.dispatchDragEvent", { type: "drop", ...point, data: dragData });
  await waitForLoadedSource(droppedContent, "dropping a Markdown file did not open it");
  await waitFor(
    () => evaluate(`!document.querySelector(".file-drop-overlay")`),
    "the Markdown file drop affordance remained visible after opening"
  );
  const confirmCount = await evaluate("window.__tetherParityConfirmCount");
  if (confirmCount !== 0) {
    throw new Error(`dropping a Markdown file prompted to discard a preserved tab ${confirmCount} time(s)`);
  }
  await waitFor(
    () => evaluate(`(() => {
      const button = [...document.querySelectorAll(".tab-label")]
        .find((candidate) => candidate.title === ${JSON.stringify(livePath)});
      return Boolean(button?.closest(".tab")?.querySelector(".tab-dirty"));
    })()`),
    "the outgoing Markdown tab did not remain visibly unsaved after the drop"
  );
  const restored = await evaluate(`(() => {
    const button = [...document.querySelectorAll(".tab-label")]
      .find((candidate) => candidate.title === ${JSON.stringify(livePath)});
    button?.click();
    return Boolean(button);
  })()`);
  if (!restored) throw new Error("the preserved outgoing Markdown tab was missing after the drop");
  await waitFor(
    () => evaluate(`document.querySelector(".ProseMirror")?.textContent.includes("Already Xrunning")`),
    "returning to the outgoing Markdown tab did not restore its unsaved edit"
  );
  await waitForSaveState(false);
  await dispatchKey({ key: "s", code: "KeyS", virtualKeyCode: 83, modifiers: 4 });
  await waitFor(
    async () => (await readFile(livePath, "utf8").catch(() => null)) === liveEditedContent,
    "saving the restored outgoing tab did not preserve its exact Markdown source"
  );
  await delay(400);
  await waitForSaveState(true);
  // This scenario deliberately changes the native file bound to the window
  // several times. Rotate its hidden host so later source-fidelity fixtures
  // start with the same pristine process-level file state as an ordinary run.
  await stopSession(true);
}

async function verifyWholeDocumentSourceTraversal() {
  const fixture = [
    "# Heading *em*",
    "",
    "- item `code`",
    "- [x] task",
    "",
    "> Quote [link](https://example.test)",
    "",
    "```js",
    "const value = 1;",
    "```",
    "",
    "| A | B |",
    "| :- | -: |",
    "| x | y |",
    "",
    "![Alt](image.png)",
    "",
    "$x + y$",
    "",
    "Reference[^n].",
    "",
    "[^n]: Footnote",
    ""
  ].join("\n");

  await startSession(fixture, "Heading");
  await placeCaretInText("Heading", 0, ".ProseMirror", "h1");
  await dispatchKey({ key: "ArrowLeft", code: "ArrowLeft", virtualKeyCode: 37 });
  await waitForSourceControl(
    (state) => state?.active
      && state.value === "# Heading *em*"
      && state.selectionStart === 1
      && state.selectionEnd === 1,
    "ArrowLeft did not enter the first physical heading marker"
  );
  await dispatchKey({ key: "ArrowLeft", code: "ArrowLeft", virtualKeyCode: 37 });
  await waitForSourceControl(
    (state) => state?.active
      && state.selectionStart === 0
      && state.selectionEnd === 0,
    "ArrowLeft did not reach physical Markdown offset zero"
  );

  for (let offset = 1; offset <= fixture.length; offset += 1) {
    await dispatchKey({
      key: "ArrowRight",
      code: "ArrowRight",
      virtualKeyCode: 39,
      modifiers: 8
    });
    const copied = await dispatchCopyAndCaptureText();
    const expected = fixture.slice(0, offset);
    if (copied !== expected) {
      const state = await editorState().catch(() => null);
      const control = await sourceControlState().catch(() => null);
      throw new Error(
        `Shift+ArrowRight diverged at physical source offset ${offset}; `
        + `copied ${JSON.stringify(copied)} instead of ${JSON.stringify(expected)}`
        + `\nEditor state: ${JSON.stringify(state)}`
        + `\nSource control: ${JSON.stringify(control)}`
      );
    }
  }

  // Collapse the completed forward selection at the physical document end,
  // then grow a new backward selection across the same mixed source. This
  // exercises the opposite anchor/head direction through every handoff.
  await dispatchKey({ key: "ArrowRight", code: "ArrowRight", virtualKeyCode: 39 });
  for (let offset = fixture.length - 1; offset >= 0; offset -= 1) {
    await dispatchKey({
      key: "ArrowLeft",
      code: "ArrowLeft",
      virtualKeyCode: 37,
      modifiers: 8
    });
    const copied = await dispatchCopyAndCaptureText();
    const expected = fixture.slice(offset);
    if (copied !== expected) {
      const state = await editorState().catch(() => null);
      const control = await sourceControlState().catch(() => null);
      throw new Error(
        `Shift+ArrowLeft diverged at physical source offset ${offset}; `
        + `copied ${JSON.stringify(copied)} instead of ${JSON.stringify(expected)}`
        + `\nEditor state: ${JSON.stringify(state)}`
        + `\nSource control: ${JSON.stringify(control)}`
      );
    }
  }
  await stopSession();
}

async function verifyMixedDocumentInsertionOffsets() {
  const fixture = [
    "# Heading *em*",
    "",
    "- item `code`",
    "- [x] task",
    "",
    "> Quote [link](https://example.test)",
    "",
    "```js",
    "const value = 1;",
    "```",
    "",
    "| A | B |",
    "| :- | -: |",
    "| x | y |",
    "",
    "![Alt](image.png)",
    "",
    "$x + y$",
    "",
    "Reference[^n].",
    "",
    "[^n]: Footnote",
    ""
  ].join("\n");
  const at = (needle, delta = 0) => fixture.indexOf(needle) + delta;
  const scenarios = [
    { name: "heading marker", offset: 1 },
    { name: "emphasis opener", offset: at("*em*", 1) },
    { name: "root separator", offset: at("\n\n") + 1 },
    { name: "bullet marker", offset: at("- item", 1) },
    { name: "task checkbox", offset: at("[x]", 2) },
    { name: "quote block start", offset: at("> Quote") },
    { name: "quote marker", offset: at("> Quote", 1) },
    { name: "link destination", offset: at("example.test", 7) },
    { name: "opening fence", offset: at("```js", 2) },
    { name: "code content", offset: at("value", 3) },
    { name: "closing fence", offset: fixture.indexOf("```", at("const value")) + 1 },
    { name: "table alignment marker", offset: at("| :- |", 3) },
    { name: "image destination", offset: at("image.png", 5) },
    { name: "math source", offset: at("$x + y$", 4) },
    { name: "footnote reference", offset: at("[^n].", 2) },
    { name: "footnote definition marker", offset: at("[^n]: Footnote", 4) }
  ];

  const requestedScenario = process.env.TETHER_PARITY_OFFSET_CASE || "";
  const selectedScenarios = requestedScenario
    ? scenarios.filter(({ name }) => name === requestedScenario)
    : scenarios;
  if (!selectedScenarios.length) {
    throw new Error(`Unknown mixed-document insertion scenario ${JSON.stringify(requestedScenario)}`);
  }

  for (const scenario of selectedScenarios) {
    await startSession(fixture, "Heading");
    await placeCaretInText("Heading", 0, ".ProseMirror", "h1");
    await dispatchKey({ key: "ArrowLeft", code: "ArrowLeft", virtualKeyCode: 37 });
    await dispatchKey({ key: "ArrowLeft", code: "ArrowLeft", virtualKeyCode: 37 });
    for (let offset = 0; offset < scenario.offset; offset += 1) {
      await dispatchKey({
        key: "ArrowRight",
        code: "ArrowRight",
        virtualKeyCode: 39,
        modifiers: 8
      });
    }
    // Collapse the exact physical prefix selection at its forward edge, as a
    // native source editor does before typing at that offset. Whole-document
    // traversal above separately proves that every Shift+Arrow step selects
    // the expected byte.
    await dispatchKey({ key: "ArrowRight", code: "ArrowRight", virtualKeyCode: 39 });
    const cursorStateBeforeInsert = {
      exactSourceSelection: (await editorState().catch(() => null))?.exactSourceSelection || null,
      sourceControl: await sourceControlState().catch(() => null)
    };
    await cdp.send("Input.insertText", { text: "X" });
    await waitForSaveState(false);
    await dispatchKey({ key: "s", code: "KeyS", virtualKeyCode: 83, modifiers: 4 });
    try {
      await waitForCompletedSave(
        `${fixture.slice(0, scenario.offset)}X${fixture.slice(scenario.offset)}`
      );
    } catch (error) {
      const actualSource = await readFile(samplePath, "utf8").catch(() => null);
      const state = await editorState().catch(() => null);
      const control = await sourceControlState().catch(() => null);
      throw new Error(
        `${scenario.name} insertion did not save at physical source offset ${scenario.offset}`
        + `\nActual source: ${JSON.stringify(actualSource)}`
        + `\nCursor before insertion: ${JSON.stringify(cursorStateBeforeInsert)}`
        + `\nEditor state: ${JSON.stringify(state)}`
        + `\nSource control: ${JSON.stringify(control)}`,
        { cause: error }
      );
    }
    // Every case starts from physical source offset zero. Give it a fresh
    // Chromium input process so a prior fixture's temporary-control focus
    // cannot shift the next case before its first key event.
    await stopSession(true);
  }
}

async function verifyRepresentativeDocumentEditingSession() {
  const fixture = [
    "# Roadmap *draft*",
    "",
    "- Alpha `code`",
    "- [ ] Ship task",
    "",
    "> Quote [label](https://example.test/path)",
    "",
    "```js",
    "const value = 1;",
    "```",
    "",
    "| Key | Value |",
    "| :- | -: |",
    "| Alpha | Beta |",
    "",
    "![Diagram](image.png)",
    "",
    "$x + y$",
    "",
    "Reference[^n].",
    "",
    "[^n]: Footnote",
    ""
  ].join("\n");
  let expected = fixture;
  const save = async () => {
    await dispatchKey({ key: "s", code: "KeyS", virtualKeyCode: 83, modifiers: 4 });
    await waitForCompletedSave(expected);
  };

  await startSession(fixture, "Roadmap");

  await placeCaretInText("Roadmap", "Roadmap".length, ".ProseMirror", "h1");
  await cdp.send("Input.insertText", { text: " 2026" });
  await waitForSaveState(false);
  expected = expected.replace("# Roadmap *draft*", "# Roadmap 2026 *draft*");
  await save();

  await clickElement(".milkdown-list-item-block .label.unchecked");
  await waitFor(
    () => evaluate(`document.querySelectorAll(".milkdown-list-item-block .label.checked").length === 1`),
    "the representative session did not render its task as checked"
  );
  await waitForSaveState(false);
  expected = expected.replace("- [ ] Ship task", "- [x] Ship task");
  await save();

  await placeCaretInText("Quote ", "Quote ".length, ".ProseMirror", "blockquote");
  await cdp.send("Input.insertText", { text: "updated " });
  await waitForSaveState(false);
  expected = expected.replace("> Quote [label]", "> Quote updated [label]");
  await save();

  await waitFor(
    () => evaluate(`Boolean(document.querySelector(".milkdown-code-block .cm-content"))`),
    "the representative session code editor did not become ready"
  );
  await clickElement(".milkdown-code-block .cm-content");
  await waitFor(
    () => evaluate(`document.activeElement?.matches?.(".cm-content")`),
    "the representative session could not focus its rendered code"
  );
  await dispatchKey({ key: "End", code: "End", virtualKeyCode: 35 });
  await dispatchKey({ key: "ArrowLeft", code: "ArrowLeft", virtualKeyCode: 37 });
  await cdp.send("Input.insertText", { text: " + 1" });
  await waitForSaveState(false);
  expected = expected.replace("const value = 1;", "const value = 1 + 1;");
  await save();

  await placeCaretInText("Beta", "Beta".length);
  await cdp.send("Input.insertText", { text: "!" });
  await waitForSaveState(false);
  const beforeTableEdit = expected;
  expected = expected.replace("| Alpha | Beta |", "| Alpha | Beta! |");
  await save();

  await dispatchKey({ key: "z", code: "KeyZ", virtualKeyCode: 90, modifiers: 4 });
  await waitForSaveState(false);
  expected = beforeTableEdit;
  await save();

  await dispatchKey({ key: "z", code: "KeyZ", virtualKeyCode: 90, modifiers: 12 });
  await waitForSaveState(false);
  expected = expected.replace("| Alpha | Beta |", "| Alpha | Beta! |");
  await save();
  await stopSession();
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

async function verifyRenderedPointerInsertion() {
  const fixtures = [
    {
      name: "ATX heading",
      source: "## Alpha Beta\n",
      visible: "Alpha Beta",
      offset: 5,
      expected: "## AlphaX Beta\n"
    },
    {
      name: "closed ATX heading",
      source: "## Alpha Beta ##\n",
      visible: "Alpha Beta",
      offset: 5,
      expected: "## AlphaX Beta ##\n"
    },
    {
      name: "setext heading",
      source: "Alpha Beta\n---\n",
      visible: "Alpha Beta",
      offset: 5,
      expected: "AlphaX Beta\n---\n"
    },
    {
      name: "quoted ATX heading",
      source: "> ## Alpha Beta\n",
      visible: "Alpha Beta",
      offset: 5,
      expected: "> ## AlphaX Beta\n"
    },
    {
      name: "list ATX heading",
      source: "- ## Alpha Beta\n",
      visible: "Alpha Beta",
      offset: 5,
      expected: "- ## AlphaX Beta\n"
    },
    {
      name: "ordered-list ATX heading",
      source: "7) ## Alpha Beta\n",
      visible: "Alpha Beta",
      offset: 5,
      expected: "7) ## AlphaX Beta\n"
    },
    {
      name: "quoted setext heading",
      source: "> Alpha Beta\n> ---\n",
      visible: "Alpha Beta",
      offset: 5,
      expected: "> AlphaX Beta\n> ---\n"
    },
    {
      name: "strong",
      source: "Before **bold** after.\n",
      visible: "bold",
      offset: 2,
      expected: "Before **boXld** after.\n"
    },
    {
      name: "emphasis",
      source: "Before *italic* after.\n",
      visible: "italic",
      offset: 3,
      expected: "Before *itaXlic* after.\n"
    },
    {
      name: "inline code",
      source: "Before `code` after.\n",
      visible: "code",
      offset: 2,
      expected: "Before `coXde` after.\n"
    },
    {
      name: "link",
      source: "Before [guide](https://example.com) after.\n",
      visible: "guide",
      offset: 2,
      expected: "Before [guXide](https://example.com) after.\n"
    },
    {
      name: "strikethrough",
      source: "Before ~~strike~~ after.\n",
      visible: "strike",
      offset: 3,
      expected: "Before ~~strXike~~ after.\n"
    }
  ];

  for (const fixture of fixtures) {
    await startSession(fixture.source, fixture.visible);
    await clickTextBoundary(fixture.visible, fixture.offset);
    await cdp.send("Input.insertText", { text: "X" });
    await waitForSaveState(false);
    await dispatchKey({ key: "s", code: "KeyS", virtualKeyCode: 83, modifiers: 4 });
    await waitForCompletedSave(fixture.expected);
    await stopSession();
  }

  const mathSource = "Before $x + y$ after.\n";
  await startSession(mathSource, "Before");
  const mathPoint = await waitFor(
    () => evaluate(`(() => {
      const math = document.querySelector('span[data-type="math_inline"]');
      const rect = math?.getBoundingClientRect();
      return rect ? { x: rect.left + 1, y: rect.top + rect.height / 2 } : null;
    })()`),
    "rendered inline math did not expose a click target"
  );
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    button: "left",
    buttons: 1,
    clickCount: 1,
    ...mathPoint
  });
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    button: "left",
    buttons: 0,
    clickCount: 1,
    ...mathPoint
  });
  await waitForSourceControl(
    (state) => state?.active
      && state.value === "$x + y$"
      && state.selectionStart === 1
      && state.selectionEnd === 1,
    "a normal rendered formula click did not retain its exact source caret"
  );
  await cdp.send("Input.insertText", { text: "X" });
  await waitForSaveState(false);
  await dispatchKey({ key: "s", code: "KeyS", virtualKeyCode: 83, modifiers: 4 });
  await waitForCompletedSave("Before $Xx + y$ after.\n");
  await stopSession();

  const atomClickFixtures = [
    {
      name: "image",
      source: "Before ![Alt](https://example.com/image.png) after.\n",
      selector: "img:not(.ProseMirror-separator)",
      token: "![Alt](https://example.com/image.png)"
    },
    {
      name: "footnote reference",
      source: "Before [^note] after.\n\n[^note]: Footnote\n",
      selector: 'sup[data-type="footnote_reference"]',
      token: "[^note]"
    }
  ];
  for (const fixture of atomClickFixtures) {
    await startSession(fixture.source, "Before");
    const point = await waitFor(
      () => evaluate(`(() => {
        const atom = document.querySelector(${JSON.stringify(fixture.selector)});
        const rect = atom?.getBoundingClientRect();
        return rect ? { x: rect.left + 0.01, y: rect.top + rect.height / 2 } : null;
      })()`),
      `rendered ${fixture.name} did not expose a click target`
    );
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      button: "left",
      buttons: 1,
      clickCount: 1,
      ...point
    });
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      button: "left",
      buttons: 0,
      clickCount: 1,
      ...point
    });
    await waitForSourceControl(
      (state) => state?.active
        && state.value === fixture.token
        && state.selectionStart === 0
        && state.selectionEnd === 0,
      `a rendered ${fixture.name} click did not open its exact source start`
    );
    await cdp.send("Input.insertText", { text: "X" });
    await waitForSaveState(false);
    await dispatchKey({ key: "s", code: "KeyS", virtualKeyCode: 83, modifiers: 4 });
    await waitForCompletedSave(fixture.source.replace(fixture.token, `X${fixture.token}`));
    await stopSession();
  }
}

async function verifyHeadingSourceEditing() {
  const backspaceCases = [
    {
      name: "ATX H2 start",
      source: "## Title\n",
      selector: "h2",
      expected: "##Title\n",
      history: true
    },
    {
      name: "closed ATX H3 start",
      source: "### Title ###\n",
      selector: "h3",
      expected: "###Title ###\n",
      history: true
    },
    {
      name: "quoted closed ATX start",
      source: "> ## Title ##\n",
      selector: "h2",
      expected: "> ##Title ##\n",
      history: true
    },
    {
      name: "list ATX start",
      source: "- ## Title\n",
      selector: "h2",
      expected: "- ##Title\n",
      reparsedSelector: "li p",
      reparsedText: "##Title",
      reparsedCaretOffset: 2,
      history: true
    },
    {
      name: "quoted setext start",
      source: "> Title\n> =====\n",
      selector: "h1",
      expected: ">Title\n> =====\n",
      history: true
    }
  ];

  const selectedBackspaceCases = process.env.TETHER_PARITY_SCENARIO
    ? backspaceCases.filter(({ name }) => name.includes(process.env.TETHER_PARITY_SCENARIO))
    : backspaceCases;
  for (const testCase of selectedBackspaceCases) {
    await startSession(testCase.source, "Title");
    await placeCaretInText("Title", 0, ".ProseMirror", testCase.selector);
    await dispatchKey({ key: "Backspace", code: "Backspace", virtualKeyCode: 8 });
    if (testCase.reparsedSelector) {
      await waitFor(
        () => evaluate(`(() => {
          const reparsed = document.querySelector(${JSON.stringify(testCase.reparsedSelector)});
          const selection = window.getSelection();
          return reparsed?.textContent === ${JSON.stringify(testCase.reparsedText)}
            && !document.querySelector(".tether-continuous-source")
            && reparsed.contains(selection?.anchorNode)
            && selection?.anchorNode?.textContent === ${JSON.stringify(testCase.reparsedText)}
            && selection?.anchorOffset === ${testCase.reparsedCaretOffset}
            && selection?.isCollapsed;
        })()`),
        `${testCase.name} did not reparse invalid heading syntax while preserving its exact caret`
      );
    }
    await waitForSaveState(false);
    await dispatchKey({ key: "s", code: "KeyS", virtualKeyCode: 83, modifiers: 4 });
    await waitForCompletedSave(testCase.expected);
    if (testCase.history) {
      await dispatchKey({ key: "z", code: "KeyZ", virtualKeyCode: 90, modifiers: 4 });
      await waitForSaveState(false);
      await dispatchKey({ key: "s", code: "KeyS", virtualKeyCode: 83, modifiers: 4 });
      await waitForCompletedSave(testCase.source);
      await dispatchKey({ key: "z", code: "KeyZ", virtualKeyCode: 90, modifiers: 12 });
      await waitForSaveState(false);
      await dispatchKey({ key: "s", code: "KeyS", virtualKeyCode: 83, modifiers: 4 });
      await waitForCompletedSave(testCase.expected);
    }
    await stopSession();
  }

  const deleteCases = [
    {
      name: "closed ATX end",
      source: "## Title ##\n",
      selector: "h2",
      expected: "## Title##\n",
      history: true
    },
    {
      name: "quoted closed ATX end",
      source: "> ## Title ##\n",
      selector: "h2",
      expected: "> ## Title##\n",
      history: true
    },
    {
      name: "quoted setext end",
      source: "> Title\n> =====\n",
      selector: "h1",
      expected: "> Title> =====\n",
      history: true
    }
  ];
  for (const testCase of deleteCases) {
    await startSession(testCase.source, "Title");
    await placeCaretInText("Title", "Title".length, ".ProseMirror", testCase.selector);
    await dispatchKey({ key: "Delete", code: "Delete", virtualKeyCode: 46 });
    await waitForSaveState(false);
    await dispatchKey({ key: "s", code: "KeyS", virtualKeyCode: 83, modifiers: 4 });
    await waitForCompletedSave(testCase.expected);
    if (testCase.history) {
      await dispatchKey({ key: "z", code: "KeyZ", virtualKeyCode: 90, modifiers: 4 });
      await waitForSaveState(false);
      await dispatchKey({ key: "s", code: "KeyS", virtualKeyCode: 83, modifiers: 4 });
      await waitForCompletedSave(testCase.source);
      await dispatchKey({ key: "z", code: "KeyZ", virtualKeyCode: 90, modifiers: 12 });
      await waitForSaveState(false);
      await dispatchKey({ key: "s", code: "KeyS", virtualKeyCode: 83, modifiers: 4 });
      await waitForCompletedSave(testCase.expected);
    }
    await stopSession();
  }

  const setextSource = "Title\n=====\n";
  await startSession(setextSource, "Title");
  await placeCaretInText("Title", 0, ".ProseMirror", "h1");
  await dispatchKey({ key: "Backspace", code: "Backspace", virtualKeyCode: 8 });
  await delay(200);
  const setextState = await editorState();
  if (setextState.dirty) {
    throw new Error(
      `Backspace at physical source offset zero changed a setext title: ${
        JSON.stringify(setextState)
      }`
    );
  }
  await stopSession();

  await startSession(setextSource, "Title");
  await placeCaretInText("Title", "Title".length, ".ProseMirror", "h1");
  await dispatchKey({ key: "Delete", code: "Delete", virtualKeyCode: 46 });
  await waitForSaveState(false);
  await dispatchKey({ key: "s", code: "KeyS", virtualKeyCode: 83, modifiers: 4 });
  await waitForCompletedSave("Title=====\n");
  await dispatchKey({ key: "z", code: "KeyZ", virtualKeyCode: 90, modifiers: 4 });
  await waitForSaveState(false);
  await dispatchKey({ key: "s", code: "KeyS", virtualKeyCode: 83, modifiers: 4 });
  await waitForCompletedSave(setextSource);
  await dispatchKey({ key: "z", code: "KeyZ", virtualKeyCode: 90, modifiers: 12 });
  await waitForSaveState(false);
  await dispatchKey({ key: "s", code: "KeyS", virtualKeyCode: 83, modifiers: 4 });
  await waitForCompletedSave("Title=====\n");
  await stopSession();
}

async function verifyPlatformNativeHeadingNavigation() {
  const fixtures = [
    {
      name: "closed ATX",
      source: "## Alpha Beta ##\nAfter.\n",
      selector: "h2"
    },
    {
      name: "quoted closed ATX",
      source: "> ### Alpha Beta ###\nAfter.\n",
      selector: "h3"
    },
    {
      name: "unordered-list ATX",
      source: "- ## Alpha Beta ##\nAfter.\n",
      selector: "h2"
    },
    {
      name: "ordered-list ATX",
      source: "1. ## Alpha Beta ##\nAfter.\n",
      selector: "h2"
    },
    {
      name: "quoted Setext",
      source: "> Alpha Beta\n> ==========\nAfter.\n",
      selector: "h1"
    }
  ];
  const visibleText = "Alpha Beta";
  const actions = [
    {
      name: "ArrowLeft from content start",
      visibleOffset: 0,
      keyCode: "Left",
      key: "ArrowLeft",
      code: "ArrowLeft",
      virtualKeyCode: 37,
      nativeModifiers: [],
      modifiers: 0
    },
    {
      name: "Shift-ArrowLeft from content start",
      visibleOffset: 0,
      keyCode: "Left",
      key: "ArrowLeft",
      code: "ArrowLeft",
      virtualKeyCode: 37,
      nativeModifiers: ["shift"],
      modifiers: 8
    },
    {
      name: "ArrowRight from content end",
      visibleOffset: visibleText.length,
      keyCode: "Right",
      key: "ArrowRight",
      code: "ArrowRight",
      virtualKeyCode: 39,
      nativeModifiers: [],
      modifiers: 0
    },
    {
      name: "Shift-ArrowRight from content end",
      visibleOffset: visibleText.length,
      keyCode: "Right",
      key: "ArrowRight",
      code: "ArrowRight",
      virtualKeyCode: 39,
      nativeModifiers: ["shift"],
      modifiers: 8
    },
    {
      name: "Option-ArrowLeft from content end",
      visibleOffset: visibleText.length,
      keyCode: "Left",
      key: "ArrowLeft",
      code: "ArrowLeft",
      virtualKeyCode: 37,
      nativeModifiers: ["alt"],
      modifiers: 1
    },
    {
      name: "Shift-Option-ArrowLeft from content end",
      visibleOffset: visibleText.length,
      keyCode: "Left",
      key: "ArrowLeft",
      code: "ArrowLeft",
      virtualKeyCode: 37,
      nativeModifiers: ["shift", "alt"],
      modifiers: 9
    },
    {
      name: "Option-ArrowRight from content start",
      visibleOffset: 0,
      keyCode: "Right",
      key: "ArrowRight",
      code: "ArrowRight",
      virtualKeyCode: 39,
      nativeModifiers: ["alt"],
      modifiers: 1
    },
    {
      name: "Shift-Option-ArrowRight from content start",
      visibleOffset: 0,
      keyCode: "Right",
      key: "ArrowRight",
      code: "ArrowRight",
      virtualKeyCode: 39,
      nativeModifiers: ["shift", "alt"],
      modifiers: 9
    },
    {
      name: "Command-ArrowLeft from content middle",
      visibleOffset: "Alpha".length,
      keyCode: "Left",
      key: "ArrowLeft",
      code: "ArrowLeft",
      virtualKeyCode: 37,
      nativeModifiers: ["meta"],
      modifiers: 4
    },
    {
      name: "Shift-Command-ArrowLeft from content middle",
      visibleOffset: "Alpha".length,
      keyCode: "Left",
      key: "ArrowLeft",
      code: "ArrowLeft",
      virtualKeyCode: 37,
      nativeModifiers: ["shift", "meta"],
      modifiers: 12
    },
    {
      name: "Command-ArrowRight from content middle",
      visibleOffset: "Alpha".length,
      keyCode: "Right",
      key: "ArrowRight",
      code: "ArrowRight",
      virtualKeyCode: 39,
      nativeModifiers: ["meta"],
      modifiers: 4
    },
    {
      name: "Shift-Command-ArrowRight from content middle",
      visibleOffset: "Alpha".length,
      keyCode: "Right",
      key: "ArrowRight",
      code: "ArrowRight",
      virtualKeyCode: 39,
      nativeModifiers: ["shift", "meta"],
      modifiers: 12
    }
  ];
  const scenarios = fixtures.flatMap((fixture) => actions.map((action) => ({
    ...fixture,
    ...action,
    name: `${fixture.name} ${action.name}`
  })));
  const selectedScenarios = process.env.TETHER_PARITY_SCENARIO
    ? scenarios.filter(({ name }) => name.includes(process.env.TETHER_PARITY_SCENARIO))
    : scenarios;
  const mismatches = [];

  for (let index = 0; index < selectedScenarios.length; index += 1) {
    const scenario = selectedScenarios[index];
    const sourceCaret = scenario.source.indexOf(visibleText) + scenario.visibleOffset;
    const controlId = `tether-native-heading-${index}`;
    await startSession(scenario.source, visibleText);
    await evaluate(`(() => {
      const control = document.createElement("textarea");
      control.id = ${JSON.stringify(controlId)};
      control.style.position = "fixed";
      control.style.left = "-10000px";
      control.value = ${JSON.stringify(scenario.source)};
      document.body.append(control);
      control.focus();
      control.setSelectionRange(${sourceCaret}, ${sourceCaret});
      return true;
    })()`);
    await dispatchNativeKey(scenario.keyCode, scenario.nativeModifiers);
    await cdp.send("Input.insertText", { text: "x" });
    const nativeState = await evaluate(`(() => {
      const control = document.querySelector(${JSON.stringify(`#${controlId}`)});
      if (!control) return null;
      const state = {
        source: control.value,
        selectionStart: control.selectionStart,
        selectionEnd: control.selectionEnd,
        selectionDirection: control.selectionDirection
      };
      control.remove();
      return state;
    })()`);

    await placeCaretInText(
      visibleText,
      scenario.visibleOffset,
      ".ProseMirror",
      scenario.selector
    );
    await dispatchKey({
      key: scenario.key,
      code: scenario.code,
      virtualKeyCode: scenario.virtualKeyCode,
      modifiers: scenario.modifiers
    });
    const renderedNavigation = {
      editor: await editorState().catch(() => null),
      sourceControl: await sourceControlState().catch(() => null)
    };
    await dispatchTextKey("x", "KeyX", 88);
    await waitForSaveState(false);
    await dispatchKey({ key: "s", code: "KeyS", virtualKeyCode: 83, modifiers: 4 });
    await waitForCompletedSave(nativeState.source);
    const renderedSource = await readFile(samplePath, "utf8");
    if (renderedSource !== nativeState.source) {
      mismatches.push({
        scenario: scenario.name,
        expectedSource: nativeState.source,
        actualSource: renderedSource,
        nativeSelectionAfterInsert: {
          start: nativeState.selectionStart,
          end: nativeState.selectionEnd,
          direction: nativeState.selectionDirection
        },
        renderedNavigation,
        postSaveState: await editorState().catch(() => null),
        postSaveSourceControl: await sourceControlState().catch(() => null)
      });
    }
    await stopSession();
  }

  if (mismatches.length) {
    throw new Error(
      `Rendered heading navigation diverged from a native source textarea:\n${
        JSON.stringify(mismatches, null, 2)
      }`
    );
  }
}

async function verifyRenderedPointerSelection() {
  const source = "Before **bold** after.\n";
  const selectionStart = "Before".length;
  const selectionEnd = source.indexOf("after.");
  const selectedSource = source.slice(selectionStart, selectionEnd);
  const cutSource = `${source.slice(0, selectionStart)}${source.slice(selectionEnd)}`;

  await startSession(source, "Before bold after.");
  const start = await textBoundaryPoint("Before ", "Before ".length, ".ProseMirror");
  const end = await textBoundaryPoint(" after.", 1, ".ProseMirror");
  await dragBetweenTextBoundaries(start, end);
  await waitFor(
    async () => (await editorState()).selectionText === " bold ",
    "pointer drag across rendered bold text did not retain its visible selection"
  );
  const copied = await dispatchCopyAndCaptureText();
  if (copied !== selectedSource) {
    const state = await editorState().catch(() => null);
    throw new Error(
      `Rendered pointer Copy emitted ${JSON.stringify(copied)} instead of ${JSON.stringify(selectedSource)}\n`
      + `Editor state: ${JSON.stringify(state)}`
    );
  }
  const cut = await dispatchCutAndCaptureText();
  if (cut !== selectedSource) {
    throw new Error(
      `Rendered pointer Cut emitted ${JSON.stringify(cut)} instead of ${JSON.stringify(selectedSource)}`
    );
  }
  await waitForSaveState(false);
  await dispatchKey({ key: "s", code: "KeyS", virtualKeyCode: 83, modifiers: 4 });
  await waitForCompletedSave(cutSource);
  if (await dispatchPasteText(selectedSource) == null) {
    throw new Error("No focused editor received the rendered pointer-selection Paste event");
  }
  await waitForSaveState(false);
  await dispatchKey({ key: "s", code: "KeyS", virtualKeyCode: 83, modifiers: 4 });
  await waitForCompletedSave(source);
  await stopSession();

  await startSession(source, "Before bold after.");
  const backwardStart = await textBoundaryPoint(" after.", 1, ".ProseMirror");
  const backwardEnd = await textBoundaryPoint("Before ", "Before".length, ".ProseMirror");
  await dragBetweenTextBoundaries(backwardStart, backwardEnd);
  try {
    await waitFor(
      async () => (await editorState()).selectionText === " bold ",
      "backward pointer drag across rendered bold text did not retain its visible selection"
    );
  } catch (error) {
    const state = await editorState().catch(() => null);
    throw new Error(`${error.message}\nEditor state: ${JSON.stringify(state)}`);
  }
  const backwardCopied = await dispatchCopyAndCaptureText();
  if (backwardCopied !== selectedSource) {
    const state = await editorState().catch(() => null);
    throw new Error(
      `Backward rendered pointer Copy emitted ${JSON.stringify(backwardCopied)} instead of `
      + `${JSON.stringify(selectedSource)}\nEditor state: ${JSON.stringify(state)}`
    );
  }
  await cdp.send("Input.insertText", { text: "X" });
  await waitForSaveState(false);
  await dispatchKey({ key: "s", code: "KeyS", virtualKeyCode: 83, modifiers: 4 });
  await waitForCompletedSave(`${source.slice(0, selectionStart)}X${source.slice(selectionEnd)}`);
  await stopSession();

  const atomFixtures = [
    {
      name: "inline math",
      source: "Before $x + y$ after.\n"
    },
    {
      name: "image",
      source: "Before ![Alt](https://example.com/image.png) after.\n"
    },
    {
      name: "footnote reference",
      source: "Before [^note] after.\n\n[^note]: Footnote\n"
    },
    {
      name: "inline HTML",
      source: "Before <em>html</em> after.\n"
    }
  ];
  for (const fixture of atomFixtures) {
    const atomSelectionStart = "Before".length;
    const atomSelectionEnd = fixture.source.indexOf("after.");
    const expectedSelection = fixture.source.slice(atomSelectionStart, atomSelectionEnd);
    await startSession(fixture.source, "Before");
    const atomStart = await textBoundaryPoint("Before ", "Before".length, ".ProseMirror");
    const atomEnd = await textBoundaryPoint(" after.", 1, ".ProseMirror");
    const atomGeometry = await evaluate(`(() => {
      const atom = document.querySelector('span[data-type="math_inline"]');
      const rect = atom?.getBoundingClientRect();
      return rect ? {
        startX: ${JSON.stringify(atomStart.x)},
        left: rect.left,
        distance: Math.max(0, rect.left - ${JSON.stringify(atomStart.x)})
      } : null;
    })()`);
    await dragBetweenTextBoundaries(atomStart, atomEnd);
    try {
      await waitFor(
        () => evaluate(`Boolean(
          document.querySelector(".ProseMirror")?.tetherGetActiveSourceSelection?.()
          || (getSelection() && !getSelection().isCollapsed)
        )`),
        `pointer drag across rendered ${fixture.name} did not retain a selection`
      );
    } catch (error) {
      const state = await editorState().catch(() => null);
      throw new Error(
        `${error.message}\nAtom geometry: ${JSON.stringify(atomGeometry)}`
        + `\nEditor state: ${JSON.stringify(state)}`
      );
    }
    const atomCopied = await dispatchCopyAndCaptureText();
    if (atomCopied !== expectedSelection) {
      const state = await editorState().catch(() => null);
      throw new Error(
        `Rendered ${fixture.name} pointer Copy emitted ${JSON.stringify(atomCopied)} instead of `
        + `${JSON.stringify(expectedSelection)}\nEditor state: ${JSON.stringify(state)}`
      );
    }
    await stopSession();
  }

  const atomOriginFixtures = [
    {
      name: "image",
      source: "Before ![Alt](https://example.com/image.png) after.\n",
      selector: "img:not(.ProseMirror-separator)",
      token: "![Alt](https://example.com/image.png)"
    },
    {
      name: "footnote reference",
      source: "Before [^note] after.\n\n[^note]: Footnote\n",
      selector: 'sup[data-type="footnote_reference"]',
      token: "[^note]"
    }
  ];
  for (const fixture of atomOriginFixtures) {
    await startSession(fixture.source, "Before");
    const atomStart = await waitFor(
      () => evaluate(`(() => {
        const atom = document.querySelector(${JSON.stringify(fixture.selector)});
        const rect = atom?.getBoundingClientRect();
        return rect ? { x: rect.left + 0.01, y: rect.top + rect.height / 2 } : null;
      })()`),
      `rendered ${fixture.name} did not expose an origin-drag target`
    );
    const atomEnd = await textBoundaryPoint(" after.", 1, ".ProseMirror");
    await dragBetweenTextBoundaries(atomStart, atomEnd);
    await waitFor(
      () => evaluate(`Boolean(
        document.querySelector(".ProseMirror")?.tetherGetActiveSourceSelection?.()
      )`),
      `pointer drag originating on rendered ${fixture.name} lost its source selection`
    );
    const copied = await dispatchCopyAndCaptureText();
    const expected = fixture.source.slice(
      fixture.source.indexOf(fixture.token),
      fixture.source.indexOf("after.")
    );
    if (copied !== expected) {
      const state = await editorState().catch(() => null);
      const control = await sourceControlState().catch(() => null);
      throw new Error(
        `${fixture.name} origin-drag Copy emitted ${JSON.stringify(copied)} instead of `
        + `${JSON.stringify(expected)}\nSource control: ${JSON.stringify(control)}`
        + `\nEditor state: ${JSON.stringify(state)}`
      );
    }
    await stopSession();
  }

  const mathSource = "Before $x + y$ after.\n";
  const mathSelectionStart = mathSource.indexOf("$") + 1;
  const mathSelectionEnd = mathSource.indexOf("after.");
  await startSession(mathSource, "Before");
  const mathStart = await waitFor(
    () => evaluate(`(() => {
      const math = document.querySelector('span[data-type="math_inline"]');
      const rect = math?.getBoundingClientRect();
      return rect ? { x: rect.left + 1, y: rect.top + rect.height / 2 } : null;
    })()`),
    "rendered inline math did not expose a pointer target"
  );
  const mathEnd = await textBoundaryPoint(" after.", 1, ".ProseMirror");
  await dragBetweenTextBoundaries(mathStart, mathEnd);
  try {
    await waitFor(
      () => evaluate(`Boolean(
        document.querySelector(".ProseMirror")?.tetherGetActiveSourceSelection?.()
        || (getSelection() && !getSelection().isCollapsed)
      )`),
      "pointer drag originating on rendered inline math did not retain a selection"
    );
  } catch (error) {
    const state = await editorState().catch(() => null);
    const control = await sourceControlState().catch(() => null);
    throw new Error(
      `${error.message}\nSource control: ${JSON.stringify(control)}`
      + `\nEditor state: ${JSON.stringify(state)}`
    );
  }
  const mathCopied = await dispatchCopyAndCaptureText();
  const expectedMathSelection = mathSource.slice(mathSelectionStart, mathSelectionEnd);
  if (mathCopied !== expectedMathSelection) {
    const state = await editorState().catch(() => null);
    throw new Error(
      `Inline-math-origin pointer Copy emitted ${JSON.stringify(mathCopied)} instead of `
      + `${JSON.stringify(expectedMathSelection)}\nEditor state: ${JSON.stringify(state)}`
    );
  }
  await stopSession();

  await startSession(mathSource, "Before");
  const backwardMathStart = await waitFor(
    () => evaluate(`(() => {
      const math = document.querySelector('span[data-type="math_inline"]');
      const rect = math?.getBoundingClientRect();
      return rect ? { x: rect.left + 1, y: rect.top + rect.height / 2 } : null;
    })()`),
    "rendered inline math did not expose a backward-drag target"
  );
  const backwardMathEnd = await textBoundaryPoint("Before ", "Before".length, ".ProseMirror");
  await dragBetweenTextBoundaries(backwardMathStart, backwardMathEnd);
  await waitFor(
    () => evaluate(`Boolean(
      document.querySelector(".ProseMirror")?.tetherGetActiveSourceSelection?.()
    )`),
    "backward pointer drag originating on rendered inline math lost its source selection"
  );
  const backwardMathCopied = await dispatchCopyAndCaptureText();
  const expectedBackwardMathSelection = mathSource.slice(
    "Before".length,
    mathSource.indexOf("$") + 1
  );
  if (backwardMathCopied !== expectedBackwardMathSelection) {
    const state = await editorState().catch(() => null);
    throw new Error(
      `Backward inline-math-origin pointer Copy emitted ${JSON.stringify(backwardMathCopied)} instead of `
      + `${JSON.stringify(expectedBackwardMathSelection)}\nEditor state: ${JSON.stringify(state)}`
    );
  }
  await stopSession();
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

async function verifyPlatformNativeInlineBoundaryNavigation() {
  const fixtures = [
    { name: "strong", source: "**bold**" },
    { name: "strong CJK", source: "**中文测试**" },
    { name: "link", source: "[guide](https://example.com)" },
    { name: "inline-code", source: "`code`" },
    { name: "strikethrough", source: "~~gone~~" }
  ];
  const scenarios = fixtures.flatMap((fixture) => {
    const markdown = `Before ${fixture.source} after.\n`;
    const sourceStart = "Before ".length;
    const sourceEnd = sourceStart + fixture.source.length;
    return [
      {
        ...fixture,
        name: `${fixture.name} ArrowRight`,
        markdown,
        visibleText: "Before ",
        visibleOffset: "Before ".length,
        sourceCaret: sourceStart,
        keyCode: "Right",
        key: "ArrowRight",
        code: "ArrowRight",
        virtualKeyCode: 39,
        nativeModifiers: [],
        modifiers: 0
      },
      {
        ...fixture,
        name: `${fixture.name} Shift-ArrowRight`,
        markdown,
        visibleText: "Before ",
        visibleOffset: "Before ".length,
        sourceCaret: sourceStart,
        keyCode: "Right",
        key: "ArrowRight",
        code: "ArrowRight",
        virtualKeyCode: 39,
        nativeModifiers: ["shift"],
        modifiers: 8
      },
      {
        ...fixture,
        name: `${fixture.name} ArrowLeft`,
        markdown,
        visibleText: " after.",
        visibleOffset: 0,
        sourceCaret: sourceEnd,
        keyCode: "Left",
        key: "ArrowLeft",
        code: "ArrowLeft",
        virtualKeyCode: 37,
        nativeModifiers: [],
        modifiers: 0
      },
      {
        ...fixture,
        name: `${fixture.name} Shift-ArrowLeft`,
        markdown,
        visibleText: " after.",
        visibleOffset: 0,
        sourceCaret: sourceEnd,
        keyCode: "Left",
        key: "ArrowLeft",
        code: "ArrowLeft",
        virtualKeyCode: 37,
        nativeModifiers: ["shift"],
        modifiers: 8
      },
      {
        ...fixture,
        name: `${fixture.name} Option-ArrowRight`,
        markdown,
        visibleText: "Before ",
        visibleOffset: "Before ".length,
        sourceCaret: sourceStart,
        keyCode: "Right",
        key: "ArrowRight",
        code: "ArrowRight",
        virtualKeyCode: 39,
        nativeModifiers: ["alt"],
        modifiers: 1
      },
      {
        ...fixture,
        name: `${fixture.name} Shift-Option-ArrowRight`,
        markdown,
        visibleText: "Before ",
        visibleOffset: "Before ".length,
        sourceCaret: sourceStart,
        keyCode: "Right",
        key: "ArrowRight",
        code: "ArrowRight",
        virtualKeyCode: 39,
        nativeModifiers: ["shift", "alt"],
        modifiers: 9
      },
      {
        ...fixture,
        name: `${fixture.name} Option-ArrowLeft`,
        markdown,
        visibleText: " after.",
        visibleOffset: 0,
        sourceCaret: sourceEnd,
        keyCode: "Left",
        key: "ArrowLeft",
        code: "ArrowLeft",
        virtualKeyCode: 37,
        nativeModifiers: ["alt"],
        modifiers: 1
      },
      {
        ...fixture,
        name: `${fixture.name} Shift-Option-ArrowLeft`,
        markdown,
        visibleText: " after.",
        visibleOffset: 0,
        sourceCaret: sourceEnd,
        keyCode: "Left",
        key: "ArrowLeft",
        code: "ArrowLeft",
        virtualKeyCode: 37,
        nativeModifiers: ["shift", "alt"],
        modifiers: 9
      },
      {
        ...fixture,
        name: `${fixture.name} Delete`,
        markdown,
        visibleText: "Before ",
        visibleOffset: "Before ".length,
        sourceCaret: sourceStart,
        keyCode: "Delete",
        key: "Delete",
        code: "Delete",
        virtualKeyCode: 46,
        nativeModifiers: [],
        modifiers: 0
      },
      {
        ...fixture,
        name: `${fixture.name} Backspace`,
        markdown,
        visibleText: " after.",
        visibleOffset: 0,
        sourceCaret: sourceEnd,
        keyCode: "Backspace",
        key: "Backspace",
        code: "Backspace",
        virtualKeyCode: 8,
        nativeModifiers: [],
        modifiers: 0
      },
      {
        ...fixture,
        name: `${fixture.name} Shift-Delete`,
        markdown,
        visibleText: "Before ",
        visibleOffset: "Before ".length,
        sourceCaret: sourceStart,
        keyCode: "Delete",
        key: "Delete",
        code: "Delete",
        virtualKeyCode: 46,
        nativeModifiers: ["shift"],
        modifiers: 8
      },
      {
        ...fixture,
        name: `${fixture.name} Shift-Backspace`,
        markdown,
        visibleText: " after.",
        visibleOffset: 0,
        sourceCaret: sourceEnd,
        keyCode: "Backspace",
        key: "Backspace",
        code: "Backspace",
        virtualKeyCode: 8,
        nativeModifiers: ["shift"],
        modifiers: 8
      },
      {
        ...fixture,
        name: `${fixture.name} Enter before`,
        markdown,
        visibleText: "Before ",
        visibleOffset: "Before ".length,
        sourceCaret: sourceStart,
        keyCode: "Enter",
        key: "Enter",
        code: "Enter",
        virtualKeyCode: 13,
        nativeModifiers: [],
        modifiers: 0
      },
      {
        ...fixture,
        name: `${fixture.name} Enter after`,
        markdown,
        visibleText: " after.",
        visibleOffset: 0,
        sourceCaret: sourceEnd,
        keyCode: "Enter",
        key: "Enter",
        code: "Enter",
        virtualKeyCode: 13,
        nativeModifiers: [],
        modifiers: 0
      },
      {
        ...fixture,
        name: `${fixture.name} Option-Delete`,
        markdown,
        visibleText: "Before ",
        visibleOffset: "Before ".length,
        sourceCaret: sourceStart,
        keyCode: "Delete",
        key: "Delete",
        code: "Delete",
        virtualKeyCode: 46,
        nativeModifiers: ["alt"],
        modifiers: 1
      },
      {
        ...fixture,
        name: `${fixture.name} Option-Backspace`,
        markdown,
        visibleText: " after.",
        visibleOffset: 0,
        sourceCaret: sourceEnd,
        keyCode: "Backspace",
        key: "Backspace",
        code: "Backspace",
        virtualKeyCode: 8,
        nativeModifiers: ["alt"],
        modifiers: 1
      },
      {
        ...fixture,
        name: `${fixture.name} Command-Delete`,
        markdown,
        visibleText: "Before ",
        visibleOffset: "Before ".length,
        sourceCaret: sourceStart,
        keyCode: "Delete",
        key: "Delete",
        code: "Delete",
        virtualKeyCode: 46,
        nativeModifiers: ["meta"],
        modifiers: 4
      },
      {
        ...fixture,
        name: `${fixture.name} Command-Backspace`,
        markdown,
        visibleText: " after.",
        visibleOffset: 0,
        sourceCaret: sourceEnd,
        keyCode: "Backspace",
        key: "Backspace",
        code: "Backspace",
        virtualKeyCode: 8,
        nativeModifiers: ["meta"],
        modifiers: 4
      }
    ];
  });
  const selectedScenarios = process.env.TETHER_PARITY_SCENARIO
    ? scenarios.filter(({ name }) => name.includes(process.env.TETHER_PARITY_SCENARIO))
    : scenarios;
  const mismatches = [];

  for (let index = 0; index < selectedScenarios.length; index += 1) {
    const scenario = selectedScenarios[index];
    const controlId = `tether-native-inline-boundary-${index}`;
    await startSession(scenario.markdown, "Before ");
    await evaluate(`(() => {
      const control = document.createElement("textarea");
      control.id = ${JSON.stringify(controlId)};
      control.style.position = "fixed";
      control.style.left = "-10000px";
      control.value = ${JSON.stringify(scenario.markdown)};
      document.body.append(control);
      control.focus();
      control.setSelectionRange(${scenario.sourceCaret}, ${scenario.sourceCaret});
      return true;
    })()`);
    if (scenario.key === "Enter" && !scenario.nativeModifiers.length) {
      await cdp.send("Input.insertText", { text: "\n" });
    } else {
      await dispatchNativeKey(scenario.keyCode, scenario.nativeModifiers);
    }
    await cdp.send("Input.insertText", { text: "x" });
    const nativeSource = await evaluate(
      `document.querySelector(${JSON.stringify(`#${controlId}`)})?.value ?? null`
    );
    await stopSession();

    await startSession(scenario.markdown, "Before ");
    await placeCaretInText(scenario.visibleText, scenario.visibleOffset);
    if (scenario.key === "Enter" && !scenario.modifiers) {
      await dispatchEnterKey();
    } else {
      await dispatchKey({
        key: scenario.key,
        code: scenario.code,
        virtualKeyCode: scenario.virtualKeyCode,
        modifiers: scenario.modifiers
      });
    }
    const renderedNavigation = await evaluate(`(() => {
      const root = document.querySelector(".ProseMirror");
      const control = document.querySelector(".tether-continuous-source");
      const selection = getSelection();
      return {
        activeElement: document.activeElement?.className || document.activeElement?.tagName || null,
        exactSourceSelection: root?.tetherGetActiveSourceSelection?.() || null,
        sourceControl: control ? {
          value: control.value,
          start: control.selectionStart,
          end: control.selectionEnd,
          direction: control.selectionDirection
        } : null,
        anchorText: selection?.anchorNode?.data || null,
        anchorOffset: selection?.anchorOffset ?? null
      };
    })()`);
    await dispatchTextKey("x", "KeyX", 88);
    await waitForSaveState(false);
    await dispatchKey({ key: "s", code: "KeyS", virtualKeyCode: 83, modifiers: 4 });
    // The button can become disabled as soon as the renderer dispatches Save,
    // before the main-process write is observable on disk. Require both sides
    // of the save contract so a slow IPC round trip cannot look like data loss.
    await waitForCompletedSave(nativeSource);
    const renderedSource = await readFile(samplePath, "utf8");
    if (renderedSource !== nativeSource) {
      mismatches.push({
        scenario: scenario.name,
        expectedSource: nativeSource,
        actualSource: renderedSource,
        renderedNavigation,
        postSaveState: await editorState().catch(() => null),
        postSaveSourceControl: await sourceControlState().catch(() => null)
      });
    }
    await stopSession();
  }

  if (mismatches.length) {
    throw new Error(
      `Rendered inline-boundary navigation diverged from native source controls:\n${
        JSON.stringify(mismatches, null, 2)
      }`
    );
  }
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
  await waitForSourceControl(
    (state) => state?.active
      && state.value === source
      && state.selectionStart === localCaret
      && state.selectionEnd === localCaret,
    "Cmd-Left did not remain inert like the native macOS source control"
  );
  await cdp.send("Input.insertText", { text: "X" });
  await waitForSaveState(false);
  await save(`Before ${source.slice(0, localCaret)}X${source.slice(localCaret)} after.\n`);
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
  await waitForSourceControl(
    (state) => state?.active
      && state.value === source
      && state.selectionStart === localCaret
      && state.selectionEnd === localCaret,
    "Shift-Cmd-Right did not remain inert like the native macOS source control"
  );
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
  await cdp.send("Input.insertText", { text: "x" });
  await waitForSaveState(false);
  const inlineInserted = "Before **boxld** after.\n";
  await save(inlineInserted);
  await dispatchKey({ key: "z", code: "KeyZ", virtualKeyCode: 90, modifiers: 4 });
  await waitForSaveState(false);
  await save(markdown);
  await dispatchKey({ key: "z", code: "KeyZ", virtualKeyCode: 90, modifiers: 12 });
  await waitForSaveState(false);
  await save(inlineInserted);
  await stopSession();

  await startSession(markdown, "Before ");
  await placeCaretInText("Before ", 3);
  await dispatchKey({ key: "Delete", code: "Delete", virtualKeyCode: 46, modifiers: 4 });
  await cdp.send("Input.insertText", { text: "x" });
  await waitForSaveState(false);
  await save("Befxore **bold** after.\n");
  await stopSession();

  const contentStart = codeBlockSource.indexOf("\n") + 1;
  const lineCaret = contentStart + "const ".length;
  const insertedBlock = `${codeBlockSource.slice(0, lineCaret)}x${
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
  await cdp.send("Input.insertText", { text: "x" });
  await waitForSaveState(false);
  await save(codeFixture.replace(codeBlockSource, insertedBlock));
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
  await dispatchTextKey("x", "KeyX", 88);
  await waitForSaveState(false);
  await dispatchKey({ key: "s", code: "KeyS", virtualKeyCode: 83, modifiers: 4 });
  await waitForCompletedSave(codeFixture.replace(codeContent, `${codeContent}x`));
  await stopSession();

  await startSession(codeFixture, codeContent);
  await focusCodeBoundary("end");
  await dispatchKey({ key: "ArrowDown", code: "ArrowDown", virtualKeyCode: 40, modifiers: 4 });
  await dispatchTextKey("x", "KeyX", 88);
  await waitForSaveState(false);
  await dispatchKey({ key: "s", code: "KeyS", virtualKeyCode: 83, modifiers: 4 });
  await waitForCompletedSave(codeFixture.replace(codeContent, `${codeContent}x`));
  await stopSession();

  await startSession(emptyCodeFixture, "Before.");
  await focusCodeBoundary("start");
  await dispatchKey({ key: "ArrowRight", code: "ArrowRight", virtualKeyCode: 39, modifiers: 4 });
  await delay(120);
  const emptyCommandState = await editorState();
  if (
    !String(emptyCommandState.activeElement || "").includes("cm-content")
    || emptyCommandState.dirty
  ) {
    throw new Error(
      `Command-ArrowRight in an immediate empty fence diverged from the native no-op: ${
        JSON.stringify(emptyCommandState)
      }`
    );
  }
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
  const replaced = codeFixture.replace(codeContent, `${codeContent}X`);
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

  for (const scenario of scenarios.filter((candidate) => (
    !process.env.TETHER_PARITY_CODE_SCENARIO
    || candidate.name === process.env.TETHER_PARITY_CODE_SCENARIO
  ))) {
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
    { name: "quoted closed ATX heading", source: "> ## Title ##", visible: "Title", caret: 4, selector: "h2" },
    { name: "list ATX heading", source: "- ## Title", visible: "Title", caret: 4, selector: "h2" },
    { name: "quoted setext heading", source: "> Title\n> =====", visible: "Title", caret: 1, selector: "h1" },
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

  const forwardFixtures = [
    {
      name: "quoted closed ATX heading",
      source: "> ## Title ##",
      visible: "Title",
      caret: 11,
      nextCaret: 12,
      selector: "h2"
    },
    {
      name: "quoted CRLF setext heading",
      source: "> Title\r\n> =====",
      visible: "Title",
      caret: 9,
      nextCaret: 10,
      selector: "h1"
    }
  ];
  for (const fixture of forwardFixtures) {
    await startSession(`${fixture.source}\n`, fixture.visible);
    await placeCaretInText(
      fixture.visible,
      fixture.visible.length,
      ".ProseMirror",
      fixture.selector
    );
    await dispatchKey({ key: "ArrowRight", code: "ArrowRight", virtualKeyCode: 39 });
    await waitForSourceControl(
      (state) => state?.active && state.value === fixture.source
        && state.selectionStart === fixture.caret && state.selectionEnd === fixture.caret,
      `ArrowRight did not enter the first physical ${fixture.name} suffix byte`
    );
    await dispatchKey({ key: "ArrowRight", code: "ArrowRight", virtualKeyCode: 39, modifiers: 8 });
    await waitForSourceControl(
      (state) => state?.active && state.selectionStart === fixture.caret
        && state.selectionEnd === fixture.nextCaret && state.selectionDirection === "forward",
      `Shift+ArrowRight did not select one physical ${fixture.name} suffix byte`
    );
    const copied = await dispatchCopyAndCaptureText();
    if (copied !== fixture.source.slice(fixture.caret, fixture.nextCaret)) {
      throw new Error(
        `${fixture.name} Copy emitted ${JSON.stringify(copied)} instead of its selected source byte`
      );
    }
    await stopSession();
  }

  const nestedHeadingEdits = [
    {
      name: "quoted",
      source: "> ## Title ##",
      edited: "> ## NTitle ##",
      prefixCaret: 4
    },
    {
      name: "listed",
      source: "- ## Title",
      edited: "- ## NTitle",
      prefixCaret: 4
    },
    {
      name: "ordered-list",
      source: "7) ## Title",
      edited: "7) ## NTitle",
      prefixCaret: 5
    }
  ];
  for (const fixture of nestedHeadingEdits) {
    await startSession(`${fixture.source}\n`, "Title");
    await placeCaretInText("Title", 0, ".ProseMirror", "h2");
    await dispatchKey({ key: "ArrowLeft", code: "ArrowLeft", virtualKeyCode: 37 });
    await waitForSourceControl(
      (state) => state?.active && state.value === fixture.source
        && state.selectionStart === fixture.prefixCaret
        && state.selectionEnd === fixture.prefixCaret,
      `${fixture.name} heading did not expose its complete physical source before editing`
    );
    const presentationClass = await evaluate(
      `document.querySelector(".tether-continuous-source")?.className || ""`
    );
    if (!presentationClass.includes("is-heading-depth-2")) {
      throw new Error(
        `${fixture.name} heading lost its rendered hierarchy in source mode: ${presentationClass}`
      );
    }
    await dispatchKey({ key: "ArrowRight", code: "ArrowRight", virtualKeyCode: 39 });
    await waitForSourceControl(
      (state) => state?.active
        && state.selectionStart === fixture.prefixCaret + 1
        && state.selectionEnd === fixture.prefixCaret + 1,
      `${fixture.name} heading source did not navigate from its final prefix byte to title text`
    );
    await dispatchTextKey("N", "KeyN", 78);
    await waitForSourceControl(
      (state) => state?.active && state.value === fixture.edited
        && state.selectionStart === fixture.prefixCaret + 2
        && state.selectionEnd === fixture.prefixCaret + 2,
      `Typing in a ${fixture.name} heading did not preserve its structural and ATX markers`
    );
    await dispatchKey({ key: "s", code: "KeyS", virtualKeyCode: 83, modifiers: 4 });
    await waitForCompletedSave(`${fixture.edited}\n`);

    await dispatchKey({ key: "z", code: "KeyZ", virtualKeyCode: 90, modifiers: 4 });
    await waitForSaveState(false);
    await dispatchKey({ key: "s", code: "KeyS", virtualKeyCode: 83, modifiers: 4 });
    await waitForCompletedSave(`${fixture.source}\n`);
    await dispatchKey({ key: "z", code: "KeyZ", virtualKeyCode: 90, modifiers: 12 });
    await waitForSaveState(false);
    await dispatchKey({ key: "s", code: "KeyS", virtualKeyCode: 83, modifiers: 4 });
    await waitForCompletedSave(`${fixture.edited}\n`);
    await stopSession();
  }
}

async function verifySourceControlImeEditing() {
  const originalBlock = "> Title\r\n> =====";
  const editedBlock = "> 章节\r\n> =====";
  await startSession(`${originalBlock}\r\n`, "Title");
  await placeCaretInText("Title", 0, ".ProseMirror", "h1");
  await dispatchKey({ key: "ArrowLeft", code: "ArrowLeft", virtualKeyCode: 37 });
  await waitForSourceControl(
    (state) => state?.active && state.value === originalBlock
      && state.selectionStart === 1 && state.selectionEnd === 1,
    "Quoted CRLF setext heading did not expose its physical source before IME editing"
  );
  const selected = await evaluate(`(() => {
    const control = document.querySelector(".tether-continuous-source");
    control?.tetherSetPhysicalSourceSelection?.(2, 7, "forward");
    return control?.tetherGetPhysicalSourceState?.() || null;
  })()`);
  if (
    selected?.start !== 2
    || selected?.end !== 7
    || selected?.value !== originalBlock
  ) {
    throw new Error(`IME heading setup lost its physical selection: ${JSON.stringify(selected)}`);
  }

  await dispatchImeText("章节");
  await waitForSourceControl(
    (state) => state?.active && state.value === editedBlock
      && state.selectionStart === 4 && state.selectionEnd === 4,
    "IME composition did not replace the rendered heading title in physical source"
  );
  await waitForSaveState(false);

  await dispatchKey({ key: "z", code: "KeyZ", virtualKeyCode: 90, modifiers: 4 });
  await waitForSourceControl(
    (state) => state?.active && state.value === originalBlock
      && state.selectionStart === 2 && state.selectionEnd === 7,
    "Undo did not restore the pre-composition heading source and selection"
  );
  await dispatchKey({ key: "z", code: "KeyZ", virtualKeyCode: 90, modifiers: 12 });
  await waitForSourceControl(
    (state) => state?.active && state.value === editedBlock
      && state.selectionStart === 4 && state.selectionEnd === 4,
    "Redo did not restore the committed IME heading edit"
  );

  await dispatchKey({ key: "s", code: "KeyS", virtualKeyCode: 83, modifiers: 4 });
  await waitForCompletedSave(`${editedBlock}\r\n`);
  await stopSession();

  const originalInline = "**bold**";
  const editedInline = "**强调**";
  await startSession(`Before ${originalInline} after.\n`, "Before bold after.");
  await placeCaretInText("Before ", "Before ".length);
  await dispatchKey({ key: "ArrowRight", code: "ArrowRight", virtualKeyCode: 39 });
  await waitForSourceControl(
    (state) => state?.active && state.value === originalInline
      && state.selectionStart === 1 && state.selectionEnd === 1,
    "Strong source did not open before inline IME editing"
  );
  const selectedInline = await evaluate(`(() => {
    const control = document.querySelector(".tether-continuous-source");
    control?.tetherSetPhysicalSourceSelection?.(2, 6, "forward");
    return control?.tetherGetPhysicalSourceState?.() || null;
  })()`);
  if (selectedInline?.start !== 2 || selectedInline?.end !== 6) {
    throw new Error(`Inline IME setup lost its delimiter-aware selection: ${JSON.stringify(selectedInline)}`);
  }
  await dispatchImeText("强调");
  await waitForSourceControl(
    (state) => state?.active && state.value === editedInline
      && state.selectionStart === 4 && state.selectionEnd === 4,
    "IME composition did not preserve inline emphasis delimiters"
  );
  await dispatchKey({ key: "z", code: "KeyZ", virtualKeyCode: 90, modifiers: 4 });
  await waitForSourceControl(
    (state) => state?.active && state.value === originalInline
      && state.selectionStart === 2 && state.selectionEnd === 6,
    "Undo did not restore inline source before IME composition"
  );
  await dispatchKey({ key: "z", code: "KeyZ", virtualKeyCode: 90, modifiers: 12 });
  await waitForSourceControl(
    (state) => state?.active && state.value === editedInline
      && state.selectionStart === 4 && state.selectionEnd === 4,
    "Redo did not restore inline IME composition"
  );
  await dispatchKey({ key: "s", code: "KeyS", virtualKeyCode: 83, modifiers: 4 });
  await waitForCompletedSave(`Before ${editedInline} after.\n`);
  await stopSession();
}

async function verifyHeadingSourcePresentation() {
  const fixtures = [
    { depth: 1, source: "# Primary #", visible: "Primary", selector: "h1" },
    { depth: 2, source: "## Section ##", visible: "Section", selector: "h2" },
    { depth: 6, source: "###### Detail", visible: "Detail", selector: "h6" },
    {
      depth: 2,
      source: "> ## Quoted ##",
      visible: "Quoted",
      selector: "blockquote h2"
    },
    {
      depth: 2,
      source: "- ## Listed",
      visible: "Listed",
      selector: "li h2"
    },
    {
      depth: 2,
      source: "7) ## Ordered",
      visible: "Ordered",
      selector: "li h2"
    },
    {
      depth: 1,
      source: "- # Listed primary",
      visible: "Listed primary",
      selector: "li h1"
    },
    {
      depth: 6,
      source: "7) ###### Ordered detail",
      visible: "Ordered detail",
      selector: "li h6"
    },
    {
      depth: 1,
      source: "> Setext\n> ======",
      visible: "Setext",
      selector: "blockquote h1",
      presentation: false
    },
    {
      depth: 2,
      source: "> ## Mixed\n>\n> Body",
      visible: "Mixed",
      selector: "blockquote h2",
      presentation: false
    }
  ];
  const styleSnapshot = (selector) => evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return null;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    const rootRect = element.closest(".ProseMirror")?.getBoundingClientRect() || null;
    const listItem = element.closest(".list-item");
    const listLabelRect = listItem?.querySelector(":scope > .label-wrapper > .label")
      ?.getBoundingClientRect() || null;
    let textLeft = null;
    if (element.matches("textarea.tether-continuous-source.is-heading-source")) {
      const depth = Number(element.className.match(/is-heading-depth-(\\d)/)?.[1]);
      const match = Number.isInteger(depth)
        ? new RegExp("(^|[^#])(#{" + depth + "})([\\t ]+)").exec(element.value)
        : null;
      if (match) {
        const markerEnd = match.index + match[1].length + match[2].length + match[3].length;
        const canvas = document.createElement("canvas");
        const context = canvas.getContext("2d");
        context.font = style.fontStyle + " " + style.fontWeight + " "
          + style.fontSize + " " + style.fontFamily;
        const prefix = element.value.slice(0, markerEnd);
        const letterSpacing = Number.parseFloat(style.letterSpacing || "0") || 0;
        textLeft = rect.left
          + (Number.parseFloat(style.borderLeftWidth || "0") || 0)
          + (Number.parseFloat(style.paddingLeft || "0") || 0)
          + context.measureText(prefix).width
          + Math.max(0, prefix.length - 1) * letterSpacing
          - element.scrollLeft;
      }
    } else {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (!node.data) continue;
        const range = document.createRange();
        range.setStart(node, 0);
        range.setEnd(node, 1);
        const textRect = range.getBoundingClientRect();
        if (textRect.height > 0) {
          textLeft = textRect.left;
          break;
        }
      }
    }
    return {
      fontFamily: style.fontFamily,
      fontSize: style.fontSize,
      fontWeight: style.fontWeight,
      lineHeight: style.lineHeight,
      letterSpacing: style.letterSpacing,
      color: style.color,
      marginTop: style.marginTop,
      marginBottom: style.marginBottom,
      height: rect.height,
      top: rect.top,
      left: rect.left,
      right: rect.right,
      textLeft,
      sourceStartLeft: element.matches("textarea.tether-continuous-source")
        ? rect.left
          + (Number.parseFloat(style.borderLeftWidth || "0") || 0)
          + (Number.parseFloat(style.paddingLeft || "0") || 0)
          - element.scrollLeft
        : null,
      rootLeft: rootRect?.left ?? null,
      scrollLeft: element.scrollLeft ?? null,
      headingSourceShift: element.dataset.headingSourceShift || null,
      headingSourceVerticalShift: element.dataset.headingSourceVerticalShift || null,
      listMarkerCenter: listLabelRect ? listLabelRect.top + listLabelRect.height / 2 : null,
      headingLineCenter: element.matches("h1, h2, h3, h4, h5, h6")
        ? rect.top + Number.parseFloat(style.lineHeight) / 2
        : null,
      listHtml: listItem?.innerHTML || null
    };
  })()`);

  for (const fixture of fixtures) {
    await startSession(`${fixture.source}\n`, fixture.visible);
    const rendered = await styleSnapshot(`.tether-wysiwyg .ProseMirror ${fixture.selector}`);
    const shouldPresent = fixture.presentation !== false;
    if (process.env.TETHER_PARITY_SCREENSHOT && fixture.depth === 2 && shouldPresent) {
      const renderedPath = process.env.TETHER_PARITY_SCREENSHOT.replace(
        /(\.png)?$/,
        "-rendered.png"
      );
      await captureElementsScreenshot([".ProseMirror"], renderedPath);
    }
    await placeCaretInText(
      fixture.visible,
      0,
      ".ProseMirror",
      fixture.selector
    );
    await dispatchKey({ key: "ArrowLeft", code: "ArrowLeft", virtualKeyCode: 37 });
    await waitForSourceControl(
      (state) => state?.active && state.value === fixture.source,
      `Heading ${fixture.depth} did not expose its physical source for presentation QA`
    );
    await waitFor(
      () => evaluate(`document.querySelector(".tether-continuous-source")?.getBoundingClientRect().height > 10`),
      `Heading ${fixture.depth} source control did not settle its visual line box`
    );
    if (!shouldPresent) {
      const incorrectlyStyled = await evaluate(
        `Boolean(document.querySelector(".tether-continuous-source.is-heading-source"))`
      );
      if (incorrectlyStyled) {
        throw new Error(
          `Multiline heading source ${JSON.stringify(fixture.source)} styled every physical line as one heading`
        );
      }
      await stopSession();
      continue;
    }
    const sourceControl = await styleSnapshot(
      `.tether-continuous-source.is-heading-source.is-heading-depth-${fixture.depth}`
    );
    const sourceControlClass = await evaluate(
      `document.querySelector(".tether-continuous-source")?.className ?? null`
    );
    const comparableProperties = [
      "fontFamily",
      "fontSize",
      "fontWeight",
      "lineHeight",
      "letterSpacing",
      "color",
      "marginBottom"
    ];
    const mismatches = comparableProperties.filter((property) =>
      rendered?.[property] !== sourceControl?.[property]
    );
    const listMarkerAligned = rendered?.listMarkerCenter == null
      || Math.abs(rendered.listMarkerCenter - rendered.headingLineCenter) <= 1;
    const completeSourcePrefixVisible = sourceControl?.sourceStartLeft != null
      && sourceControl?.rootLeft != null
      && sourceControl.sourceStartLeft >= sourceControl.rootLeft - 0.75
      && sourceControl.scrollLeft <= 0.5;
    const sourceMarkersAdvanceTitle = sourceControl?.textLeft != null
      && rendered?.textLeft != null
      && sourceControl.textLeft > rendered.textLeft + 2;
    if (
      !rendered
      || !sourceControl
      || mismatches.length
      || !listMarkerAligned
      || !completeSourcePrefixVisible
      || !sourceMarkersAdvanceTitle
      // Textarea controls retain a small platform-native internal line box;
      // keep it visually negligible while requiring every typography and
      // margin property to match the rendered heading exactly.
      || Math.abs(rendered.height - sourceControl.height) > 4
      || Math.abs(
        (rendered.top + rendered.height / 2)
        - (sourceControl.top + sourceControl.height / 2)
      ) > 1.25
    ) {
      throw new Error(
        `Heading ${fixture.depth} ${JSON.stringify(fixture.source)} source presentation shifted hierarchy: ${
          JSON.stringify({
            mismatches,
            listMarkerAligned,
            completeSourcePrefixVisible,
            sourceMarkersAdvanceTitle,
            rendered,
            sourceControl,
            sourceControlClass
          })
        }`
      );
    }
    await dispatchKey({ key: "ArrowRight", code: "ArrowRight", virtualKeyCode: 39 });
    const beforeLiveEdit = await sourceControlState();
    await dispatchTextKey("X", "KeyX", 88);
    const editedSource = `${beforeLiveEdit.value.slice(0, beforeLiveEdit.selectionStart)}X${
      beforeLiveEdit.value.slice(beforeLiveEdit.selectionEnd)
    }`;
    await waitForSourceControl(
      (state) => state?.active && state.value === editedSource,
      `Heading ${fixture.depth} did not retain its physical source during a live title edit`
    );
    const editedPresentation = await styleSnapshot(
      `.tether-continuous-source.is-heading-source.is-heading-depth-${fixture.depth}`
    );
    if (
      !editedPresentation
      || editedPresentation.headingSourceShift !== "0"
      || editedPresentation.scrollLeft > 0.5
      || editedPresentation.sourceStartLeft < editedPresentation.rootLeft - 0.75
    ) {
      throw new Error(
        `Heading ${fixture.depth} hid physical prefix bytes after live editing: ${
          JSON.stringify({ beforeLiveEdit, editedSource, editedPresentation })
        }`
      );
    }
    if (process.env.TETHER_PARITY_SCREENSHOT && fixture.depth === 2) {
      await captureElementsScreenshot(
        [".ProseMirror"],
        process.env.TETHER_PARITY_SCREENSHOT
      );
    }
    await stopSession();
  }
}

async function verifyInlineSourcePresentation() {
  const fixtures = [
    {
      name: "strong",
      source: "Before **Bold** after.\n",
      visible: "Bold",
      token: "**Bold**",
      selector: "strong",
      properties: ["fontFamily", "fontSize", "fontStyle", "fontWeight", "lineHeight", "color"]
    },
    {
      name: "emphasis",
      source: "Before *Slanted* after.\n",
      visible: "Slanted",
      token: "*Slanted*",
      selector: "em",
      properties: ["fontFamily", "fontSize", "fontStyle", "fontWeight", "lineHeight", "color"]
    },
    {
      name: "nested strong emphasis",
      source: "Before **Bold *Both*** after.\n",
      visible: "Bold Both",
      token: "**Bold *Both***",
      selector: "em strong",
      properties: ["fontFamily", "fontSize", "fontStyle", "fontWeight", "lineHeight", "color"]
    },
    {
      name: "strikethrough",
      source: "Before ~~Removed~~ after.\n",
      visible: "Removed",
      token: "~~Removed~~",
      selector: "del",
      properties: [
        "fontFamily",
        "fontSize",
        "fontStyle",
        "fontWeight",
        "lineHeight",
        "color",
        "textDecorationLine"
      ]
    },
    {
      name: "link",
      source: "Before [Guide](https://example.test) after.\n",
      visible: "Guide",
      token: "[Guide](https://example.test)",
      selector: "a",
      properties: [
        "fontFamily",
        "fontSize",
        "fontStyle",
        "fontWeight",
        "lineHeight",
        "color",
        "textDecorationLine"
      ]
    },
    {
      name: "inline code",
      source: "Before `value` after.\n",
      visible: "value",
      token: "`value`",
      selector: "code",
      properties: [
        "fontFamily",
        "fontSize",
        "fontStyle",
        "fontWeight",
        "lineHeight",
        "color",
        "backgroundColor",
        "borderTopWidth",
        "borderRadius"
      ]
    }
  ];
  const styleSnapshot = (selector) => evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return null;
    const style = getComputedStyle(element);
    const parentStyle = element.parentElement ? getComputedStyle(element.parentElement) : null;
    const rect = element.getBoundingClientRect();
    const lineContainerRect = element.closest("p")?.getBoundingClientRect() || null;
    return {
      fontFamily: style.fontFamily,
      fontSize: style.fontSize,
      fontStyle: style.fontStyle,
      fontWeight: style.fontWeight,
      lineHeight: style.lineHeight,
      color: style.color,
      textDecorationLine: style.textDecorationLine,
      backgroundColor: style.backgroundColor,
      borderTopWidth: style.borderTopWidth,
      borderRadius: style.borderRadius,
      top: rect.top,
      bottom: rect.bottom,
      left: rect.left,
      right: rect.right,
      height: rect.height,
      lineContainer: lineContainerRect ? {
        top: lineContainerRect.top,
        height: lineContainerRect.height
      } : null,
      className: element.className || null,
      parent: element.parentElement ? {
        tagName: element.parentElement.tagName,
        className: element.parentElement.className || null,
        fontFamily: parentStyle.fontFamily,
        fontSize: parentStyle.fontSize,
        fontStyle: parentStyle.fontStyle,
        fontWeight: parentStyle.fontWeight,
        lineHeight: parentStyle.lineHeight,
        color: parentStyle.color,
        textDecorationLine: parentStyle.textDecorationLine,
        top: element.parentElement.getBoundingClientRect().top,
        height: element.parentElement.getBoundingClientRect().height
      } : null
    };
  })()`);

  for (const fixture of fixtures) {
    await startSession(fixture.source, `Before ${fixture.visible} after.`);
    const rendered = await styleSnapshot(`.ProseMirror ${fixture.selector}`);
    await placeCaretInText(" after.", 0);
    await dispatchKey({ key: "ArrowLeft", code: "ArrowLeft", virtualKeyCode: 37 });
    await waitForSourceControl(
      (state) => state?.active && state.value === fixture.token,
      `${fixture.name} did not expose its physical inline source for presentation QA`
    );
    const sourceControl = await styleSnapshot("input.tether-continuous-source");
    const mismatches = fixture.properties.filter((property) =>
      rendered?.[property] !== sourceControl?.[property]
    );
    const geometryStable = rendered?.lineContainer
      && sourceControl?.lineContainer
      && Math.abs(rendered.top - sourceControl.top) <= 0.25
      && Math.abs(rendered.lineContainer.top - sourceControl.lineContainer.top) <= 0.1
      && Math.abs(rendered.lineContainer.height - sourceControl.lineContainer.height) <= 0.25;
    if (!rendered || !sourceControl || mismatches.length || !geometryStable) {
      throw new Error(
        `${fixture.name} source presentation diverged from rendered inline text: ${
          JSON.stringify({ mismatches, geometryStable, rendered, sourceControl })
        }`
      );
    }
    if (process.env.TETHER_PARITY_SCREENSHOT && fixture.name === "strong") {
      await captureElementsScreenshot(
        [".ProseMirror p"],
        process.env.TETHER_PARITY_SCREENSHOT
      );
    }
    await stopSession();
  }
}

async function verifyLongInlineSourceContainment() {
  const destination = `https://example.test/${"deep-path/".repeat(18)}document.md?${
    "long-query=value&".repeat(8)
  }final=true`;
  const token = `[Guide](${destination})`;
  const source = `A short prefix ${token} suffix.\n`;
  const selectionStart = token.indexOf("deep-path/") + 5;
  const selectionEnd = selectionStart + 54;
  const replacement = "X";
  const editedToken = `${token.slice(0, selectionStart)}${replacement}${token.slice(selectionEnd)}`;
  const editedSource = source.replace(token, editedToken);

  await startSession(source, "A short prefix Guide suffix.");
  await placeCaretInText(" suffix.", 0);
  await dispatchKey({ key: "ArrowLeft", code: "ArrowLeft", virtualKeyCode: 37 });
  await waitForSourceControl(
    (state) => state?.active && state.value === token
      && state.selectionStart === token.length - 1 && state.selectionEnd === token.length - 1,
    "long inline link did not expose its exact closing-delimiter boundary"
  );

  const geometry = await evaluate(`(() => {
    const root = document.querySelector(".ProseMirror");
    const control = document.querySelector("input.tether-continuous-source");
    const paragraph = control?.closest("p");
    if (!root || !control || !paragraph) return null;
    const rootRect = root.getBoundingClientRect();
    const controlRect = control.getBoundingClientRect();
    const paragraphRect = paragraph.getBoundingClientRect();
    return {
      root: {
        left: rootRect.left,
        right: rootRect.right,
        clientWidth: root.clientWidth,
        scrollWidth: root.scrollWidth
      },
      paragraph: {
        left: paragraphRect.left,
        right: paragraphRect.right,
        clientWidth: paragraph.clientWidth,
        scrollWidth: paragraph.scrollWidth
      },
      control: {
        left: controlRect.left,
        right: controlRect.right,
        clientWidth: control.clientWidth,
        scrollWidth: control.scrollWidth,
        scrollLeft: control.scrollLeft
      }
    };
  })()`);
  const contained = geometry
    && geometry.root.scrollWidth <= geometry.root.clientWidth + 1
    && geometry.paragraph.scrollWidth <= geometry.paragraph.clientWidth + 1
    && geometry.control.left >= geometry.paragraph.left - 1
    && geometry.control.right <= geometry.paragraph.right + 1
    && geometry.control.scrollWidth > geometry.control.clientWidth + 1
    && geometry.control.scrollLeft > 0;
  if (!contained) {
    throw new Error(`long inline Markdown source escaped or displaced its document column: ${
      JSON.stringify(geometry)
    }`);
  }
  if (process.env.TETHER_PARITY_SCREENSHOT) {
    await captureElementsScreenshot([".ProseMirror p"], process.env.TETHER_PARITY_SCREENSHOT);
  }

  await evaluate(`(() => {
    const control = document.querySelector("input.tether-continuous-source");
    control?.tetherSetPhysicalSourceSelection?.(
      ${selectionStart},
      ${selectionEnd},
      "forward"
    );
  })()`);
  await waitForSourceControl(
    (state) => state?.active && state.selectionStart === selectionStart
      && state.selectionEnd === selectionEnd && state.selectionDirection === "forward",
    "long inline source did not retain an exact selection inside its scrolled destination"
  );
  const copied = await dispatchCopyAndCaptureText();
  if (copied !== token.slice(selectionStart, selectionEnd)) {
    throw new Error(
      `long inline source Copy emitted ${JSON.stringify(copied)} instead of ${
        JSON.stringify(token.slice(selectionStart, selectionEnd))
      }`
    );
  }
  await cdp.send("Input.insertText", { text: replacement });
  await waitForSaveState(false);
  await dispatchKey({ key: "s", code: "KeyS", virtualKeyCode: 83, modifiers: 4 });
  await waitForCompletedSave(editedSource);
  await dispatchKey({ key: "z", code: "KeyZ", virtualKeyCode: 90, modifiers: 4 });
  await waitForSaveState(false);
  await dispatchKey({ key: "s", code: "KeyS", virtualKeyCode: 83, modifiers: 4 });
  await waitForCompletedSave(source);
  await dispatchKey({ key: "z", code: "KeyZ", virtualKeyCode: 90, modifiers: 12 });
  await waitForSaveState(false);
  await dispatchKey({ key: "s", code: "KeyS", virtualKeyCode: 83, modifiers: 4 });
  await waitForCompletedSave(editedSource);
  await stopSession();
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

    await startSession(hardBreakFixture, "Beta");
    const controlId = `tether-native-hard-break-shift-backspace-${
      markerSource === "\\" ? "slash" : "spaces"
    }`;
    await evaluate(`(() => {
      const control = document.createElement("textarea");
      control.id = ${JSON.stringify(controlId)};
      control.style.position = "fixed";
      control.style.left = "-10000px";
      control.value = ${JSON.stringify(hardBreakFixture)};
      document.body.append(control);
      control.focus();
      const caret = control.value.indexOf("Beta");
      control.setSelectionRange(caret, caret);
      return true;
    })()`);
    await dispatchNativeKey("Backspace", ["shift"]);
    await cdp.send("Input.insertText", { text: "x" });
    const normalizedNativeSource = await evaluate(
      `document.querySelector(${JSON.stringify(`#${controlId}`)})?.value ?? null`
    );
    const nativeSource = lineEnding === "\r\n"
      ? normalizedNativeSource.replaceAll("\n", "\r\n")
      : normalizedNativeSource;
    await evaluate(`document.querySelector(${JSON.stringify(`#${controlId}`)})?.remove()`);

    await placeCaretInText("Beta", 0);
    await dispatchKey({
      key: "Backspace",
      code: "Backspace",
      virtualKeyCode: 8,
      modifiers: 8
    });
    await cdp.send("Input.insertText", { text: "x" });
    await waitForSaveState(false);
    await save(nativeSource);
    await stopSession();
  }
}

async function verifySoftLineEditing() {
  const fixture = "Alpha\r\nBeta\r\n";
  const editedFixture = "AlXpha\r\nBeta\r\n";
  const enteredFixture = "Al\r\npha\r\nBeta\r\n";
  const enteredAndTypedFixture = "Al\r\nXpha\r\nBeta\r\n";
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
  await placeCaretInText("Alpha", 2);
  await dispatchEnterKey();
  await waitForSaveState(false);
  await save(enteredFixture);
  await dispatchKey({ key: "z", code: "KeyZ", virtualKeyCode: 90, modifiers: 4 });
  await waitForSaveState(false);
  await save(fixture);
  await dispatchKey({ key: "z", code: "KeyZ", virtualKeyCode: 90, modifiers: 12 });
  await waitForSaveState(false);
  await save(enteredFixture);
  await cdp.send("Input.insertText", { text: "X" });
  await waitForSaveState(false);
  await save(enteredAndTypedFixture);
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

async function verifyStructuralEnterEditing() {
  const cases = [
    {
      name: "ATX heading interior",
      markdown: "## Alpha Beta\n",
      text: "Alpha Beta",
      offset: "Alpha".length,
      splitSource: "## Alpha\n\nBeta\n",
      typedSource: "## Alpha\n\nxBeta\n",
      history: true
    },
    {
      name: "setext heading interior",
      markdown: "Alpha Beta\n---\n",
      text: "Alpha Beta",
      offset: "Alpha".length,
      splitSource: "Alpha\n---\n\nBeta\n",
      typedSource: "Alpha\n---\n\nxBeta\n"
    },
    {
      name: "bullet item interior",
      markdown: "+ Alpha Beta\n",
      text: "Alpha Beta",
      offset: "Alpha".length,
      splitSource: "+ Alpha\n+ Beta\n",
      typedSource: "+ Alpha\n+ xBeta\n"
    },
    {
      name: "ordered item interior",
      markdown: "3) Alpha Beta\n7) Keep\n",
      text: "Alpha Beta",
      offset: "Alpha".length,
      splitSource: "3) Alpha\n4) Beta\n7) Keep\n",
      typedSource: "3) Alpha\n4) xBeta\n7) Keep\n",
      history: true
    },
    {
      name: "CRLF ordered item interior",
      markdown: "10. Alpha Beta\r\n20. Keep\r\n",
      text: "Alpha Beta",
      offset: "Alpha".length,
      splitSource: "10. Alpha\r\n11. Beta\r\n20. Keep\r\n",
      typedSource: "10. Alpha\r\n11. xBeta\r\n20. Keep\r\n"
    },
    {
      name: "task item interior",
      markdown: "- [X] Alpha Beta\n",
      text: "Alpha Beta",
      offset: "Alpha".length,
      splitSource: "- [X] Alpha\n- [ ] Beta\n",
      typedSource: "- [X] Alpha\n- [ ] xBeta\n"
    },
    {
      name: "no-space quote interior",
      markdown: ">Alpha Beta\n",
      text: "Alpha Beta",
      offset: "Alpha".length,
      splitSource: ">Alpha\n>Beta\n",
      typedSource: ">Alpha\n>xBeta\n"
    },
    {
      name: "nested bullet interior",
      markdown: "- Parent\n  * Alpha Beta\n",
      text: "Alpha Beta",
      offset: "Alpha".length,
      splitSource: "- Parent\n  * Alpha\n  * Beta\n",
      typedSource: "- Parent\n  * Alpha\n  * xBeta\n"
    }
  ];
  const selectedCases = process.env.TETHER_PARITY_SCENARIO
    ? cases.filter(({ name }) => name.includes(process.env.TETHER_PARITY_SCENARIO))
    : cases;
  for (const testCase of selectedCases) {
    await startSession(testCase.markdown, testCase.text);
    await placeCaretInText(testCase.text, testCase.offset);
    await dispatchEnterKey();
    await waitForSaveState(false);
    const splitState = await editorState();
    if (splitState.followingText !== "Beta") {
      throw new Error(
        `${testCase.name} did not place the rendered caret before its retained tail: ${
          JSON.stringify(splitState)
        }`
      );
    }
    await dispatchKey({ key: "s", code: "KeyS", virtualKeyCode: 83, modifiers: 4 });
    await waitForCompletedSave(testCase.splitSource);
    if (testCase.history) {
      await dispatchKey({ key: "z", code: "KeyZ", virtualKeyCode: 90, modifiers: 4 });
      await waitForSaveState(false);
      await dispatchKey({ key: "s", code: "KeyS", virtualKeyCode: 83, modifiers: 4 });
      await waitForCompletedSave(testCase.markdown);
      await dispatchKey({ key: "z", code: "KeyZ", virtualKeyCode: 90, modifiers: 12 });
      await waitForSaveState(false);
      await dispatchKey({ key: "s", code: "KeyS", virtualKeyCode: 83, modifiers: 4 });
      await waitForCompletedSave(testCase.splitSource);
      const restoredState = await editorState();
      const expectedRestoredOffset = testCase.splitSource.indexOf("Beta");
      const restoredExactSelection = restoredState.exactSourceSelection;
      if (
        restoredState.followingText !== "Beta"
        || (restoredExactSelection && (
          restoredExactSelection.anchor !== expectedRestoredOffset
          || restoredExactSelection.head !== expectedRestoredOffset
        ))
      ) {
        throw new Error(
          `${testCase.name} did not restore its rendered continuation caret after redo: ${
            JSON.stringify(restoredState)
          }`
        );
      }
    }
    await dispatchTextKey("x", "KeyX", 88);
    await waitForSaveState(false);
    const typedState = await editorState();
    if (typedState.followingText !== "Beta") {
      throw new Error(
        `${testCase.name} did not advance one rendered character after typing: ${
          JSON.stringify(typedState)
        }`
      );
    }
    await dispatchKey({ key: "s", code: "KeyS", virtualKeyCode: 83, modifiers: 4 });
    await waitForCompletedSave(testCase.typedSource);
    await delay(500);
    const state = await editorState();
    if (state.dirty || state.anchorOffset !== 1 || state.anchorText !== "xBeta") {
      throw new Error(
        `${testCase.name} did not retain its clean rendered continuation caret: ${
          JSON.stringify(state)
        }`
      );
    }
    await stopSession();
  }
}

async function verifyStructuralEnterEdges() {
  const cases = [
    {
      name: "ATX heading end",
      markdown: "## Alpha\n",
      enters: 1,
      expected: "## Alpha\nx\n",
      history: true
    },
    {
      name: "closed ATX heading end",
      markdown: "## Alpha ##\n",
      enters: 1,
      expected: "## Alpha ##\nx\n"
    },
    {
      name: "setext heading end",
      markdown: "Alpha\n---\n",
      enters: 1,
      expected: "Alpha\n---\nx\n"
    },
    {
      name: "bullet continuation",
      markdown: "+ Alpha\n",
      enters: 1,
      expected: "+ Alpha\n+ x\n",
      history: true
    },
    {
      name: "ordered continuation",
      markdown: "3) Alpha\n7) Keep\n",
      enters: 1,
      expected: "3) Alpha\n4) x\n7) Keep\n",
      history: true
    },
    {
      name: "CRLF ordered continuation",
      markdown: "10. Alpha\r\n20. Keep\r\n",
      enters: 1,
      expected: "10. Alpha\r\n11. x\r\n20. Keep\r\n"
    },
    {
      name: "task continuation",
      markdown: "- [X] Alpha\n",
      enters: 1,
      expected: "- [X] Alpha\n- [ ] x\n",
      directInput: true
    },
    {
      name: "no-space quote continuation",
      markdown: ">Alpha\n",
      enters: 1,
      expected: ">Alpha\n>x\n"
    },
    {
      name: "nested bullet continuation",
      markdown: "- Parent\n  * Alpha\n",
      enters: 1,
      expected: "- Parent\n  * Alpha\n  * x\n"
    },
    {
      name: "bullet continuation exit",
      markdown: "+ Alpha\n",
      enters: 2,
      expected: "+ Alpha\n\nx\n"
    },
    {
      name: "task continuation exit",
      markdown: "- [X] Alpha\n",
      enters: 2,
      expected: "- [X] Alpha\n\nx\n",
      history: true
    },
    {
      name: "quote continuation exit",
      markdown: ">Alpha\n",
      enters: 2,
      expected: ">Alpha\n\nx\n"
    },
    {
      name: "CRLF quote continuation exit",
      markdown: ">Alpha\r\n",
      enters: 2,
      expected: ">Alpha\r\n\r\nx\r\n"
    },
    {
      name: "nested bullet outdent",
      markdown: "- Parent\n  * Alpha\n",
      enters: 2,
      expected: "- Parent\n  * Alpha\n- x\n"
    }
  ];
  const selectedCases = process.env.TETHER_PARITY_SCENARIO
    ? cases.filter(({ name }) => name.includes(process.env.TETHER_PARITY_SCENARIO))
    : cases;
  for (const testCase of selectedCases) {
    await startSession(testCase.markdown, "Alpha");
    await placeCaretInText("Alpha", "Alpha".length);
    for (let index = 0; index < testCase.enters; index += 1) {
      await dispatchEnterKey();
      await delay(150);
    }
    if (testCase.directInput) {
      await cdp.send("Input.insertText", { text: "x" });
    } else {
      await dispatchTextKey("x", "KeyX", 88);
    }
    await waitForSaveState(false);
    await dispatchKey({ key: "s", code: "KeyS", virtualKeyCode: 83, modifiers: 4 });
    await waitForCompletedSave(testCase.expected);
    if (testCase.history) {
      for (let index = 0; index <= testCase.enters; index += 1) {
        await dispatchKey({ key: "z", code: "KeyZ", virtualKeyCode: 90, modifiers: 4 });
      }
      await waitForSaveState(false);
      await dispatchKey({ key: "s", code: "KeyS", virtualKeyCode: 83, modifiers: 4 });
      await waitForCompletedSave(testCase.markdown);
      for (let index = 0; index <= testCase.enters; index += 1) {
        await dispatchKey({ key: "z", code: "KeyZ", virtualKeyCode: 90, modifiers: 12 });
      }
      await waitForSaveState(false);
      await dispatchKey({ key: "s", code: "KeyS", virtualKeyCode: 83, modifiers: 4 });
      await waitForCompletedSave(testCase.expected);
    }
    await delay(300);
    const state = await editorState();
    if (
      state.dirty
      || state.anchorText !== "x"
      || state.anchorOffset !== 1
      || state.exactSourceSelection
    ) {
      throw new Error(
        `${testCase.name} did not retain a clean rendered caret after structural Return: ${
          JSON.stringify(state)
        }`
      );
    }
    await stopSession();
  }
}

async function verifyStructuralEnterSelections() {
  const cases = [
    {
      name: "ATX selected tail",
      markdown: "## Alpha Beta\n",
      expected: "## Alpha\nx\n",
      history: true
    },
    {
      name: "bullet selected tail",
      markdown: "+ Alpha Beta\n",
      expected: "+ Alpha\n+ x\n",
      history: true
    },
    {
      name: "ordered selected tail",
      markdown: "3) Alpha Beta\n7) Keep\n",
      expected: "3) Alpha\n4) x\n7) Keep\n"
    },
    {
      name: "CRLF ordered selected tail",
      markdown: "10. Alpha Beta\r\n20. Keep\r\n",
      expected: "10. Alpha\r\n11. x\r\n20. Keep\r\n"
    },
    {
      name: "task selected tail",
      markdown: "- [X] Alpha Beta\n",
      expected: "- [X] Alpha\n- [ ] x\n",
      directInput: true
    },
    {
      name: "quote selected tail",
      markdown: ">Alpha Beta\n",
      expected: ">Alpha\n>x\n"
    }
  ];
  const selectedCases = process.env.TETHER_PARITY_SCENARIO
    ? cases.filter(({ name }) => name.includes(process.env.TETHER_PARITY_SCENARIO))
    : cases;
  for (const testCase of selectedCases) {
    await startSession(testCase.markdown, "Alpha Beta");
    const start = await textBoundaryPoint(
      "Alpha Beta",
      "Alpha".length,
      ".ProseMirror"
    );
    const end = await textBoundaryPoint(
      "Alpha Beta",
      "Alpha Beta".length,
      ".ProseMirror"
    );
    await dragBetweenTextBoundaries(start, end);
    await waitFor(
      () => evaluate(`getSelection()?.toString() === " Beta"`),
      `${testCase.name} could not install its rendered tail selection`
    );
    await dispatchEnterKey();
    if (testCase.directInput) {
      await cdp.send("Input.insertText", { text: "x" });
    } else {
      await dispatchTextKey("x", "KeyX", 88);
    }
    await waitForSaveState(false);
    await dispatchKey({ key: "s", code: "KeyS", virtualKeyCode: 83, modifiers: 4 });
    await waitForCompletedSave(testCase.expected);
    if (testCase.history) {
      for (let index = 0; index < 2; index += 1) {
        await dispatchKey({ key: "z", code: "KeyZ", virtualKeyCode: 90, modifiers: 4 });
      }
      await waitForSaveState(false);
      await dispatchKey({ key: "s", code: "KeyS", virtualKeyCode: 83, modifiers: 4 });
      await waitForCompletedSave(testCase.markdown);
      for (let index = 0; index < 2; index += 1) {
        await dispatchKey({ key: "z", code: "KeyZ", virtualKeyCode: 90, modifiers: 12 });
      }
      await waitForSaveState(false);
      await dispatchKey({ key: "s", code: "KeyS", virtualKeyCode: 83, modifiers: 4 });
      await waitForCompletedSave(testCase.expected);
    }
    await delay(300);
    const state = await editorState();
    if (
      state.dirty
      || state.anchorText !== "x"
      || state.anchorOffset !== 1
      || state.followingText
      || state.exactSourceSelection
    ) {
      throw new Error(
        `${testCase.name} did not retain a clean rendered caret after replacing its selection: ${
          JSON.stringify(state)
        }`
      );
    }
    await stopSession();
  }
}

async function verifyShiftEnterEditing() {
  const cases = [
    {
      name: "plain interior",
      markdown: "Alpha Beta\n",
      text: "Alpha Beta",
      visibleOffset: "Alpha".length,
      sourceOffset: "Alpha".length,
      expected: "Alpha\nx Beta\n",
      history: true
    },
    {
      name: "CRLF plain interior",
      markdown: "Alpha Beta\r\n",
      text: "Alpha Beta",
      visibleOffset: "Alpha".length,
      sourceOffset: "Alpha".length,
      expected: "Alpha\r\nx Beta\r\n",
      lineEnding: "\r\n"
    },
    {
      name: "heading interior",
      markdown: "## Alpha Beta\n",
      text: "Alpha Beta",
      visibleOffset: "Alpha".length,
      sourceOffset: "## Alpha".length,
      expected: "## Alpha\nx Beta\n"
    },
    {
      name: "bullet interior",
      markdown: "+ Alpha Beta\n",
      text: "Alpha Beta",
      visibleOffset: "Alpha".length,
      sourceOffset: "+ Alpha".length,
      expected: "+ Alpha\nx Beta\n",
      history: true
    },
    {
      name: "task end",
      markdown: "- [X] Alpha\n",
      text: "Alpha",
      visibleOffset: "Alpha".length,
      sourceOffset: "- [X] Alpha".length,
      expected: "- [X] Alpha\nx\n"
    },
    {
      name: "quote interior",
      markdown: ">Alpha Beta\n",
      text: "Alpha Beta",
      visibleOffset: "Alpha".length,
      sourceOffset: ">Alpha".length,
      expected: ">Alpha\nx Beta\n"
    },
    {
      name: "backward bullet selection",
      markdown: "+ Alpha Beta\n",
      text: "Alpha Beta",
      visibleOffset: "Alpha".length,
      visibleEndOffset: "Alpha Beta".length,
      sourceOffset: "+ Alpha".length,
      sourceEndOffset: "+ Alpha Beta".length,
      backward: true,
      expected: "+ Alpha\nx\n"
    },
    {
      name: "heading selection",
      markdown: "## Alpha Beta\n",
      text: "Alpha Beta",
      visibleOffset: "Alpha".length,
      visibleEndOffset: "Alpha Beta".length,
      sourceOffset: "## Alpha".length,
      sourceEndOffset: "## Alpha Beta".length,
      expected: "## Alpha\nx\n"
    },
    {
      name: "repeated bullet newline",
      markdown: "+ Alpha Beta\n",
      text: "Alpha Beta",
      visibleOffset: "Alpha".length,
      sourceOffset: "+ Alpha".length,
      enters: 2,
      expected: "+ Alpha\n\nx Beta\n"
    }
  ];
  const selectedCases = process.env.TETHER_PARITY_SCENARIO
    ? cases.filter(({ name }) => name.includes(process.env.TETHER_PARITY_SCENARIO))
    : cases;
  for (let index = 0; index < selectedCases.length; index += 1) {
    const testCase = selectedCases[index];
    const enters = testCase.enters || 1;
    const sourceEndOffset = testCase.sourceEndOffset ?? testCase.sourceOffset;
    await startSession(testCase.markdown, testCase.text);
    const controlId = `tether-shift-enter-${index}`;
    await evaluate(`(() => {
      const control = document.createElement("textarea");
      control.id = ${JSON.stringify(controlId)};
      control.value = ${JSON.stringify(testCase.markdown)};
      control.style.position = "fixed";
      control.style.left = "-10000px";
      document.body.append(control);
      control.focus();
      control.setSelectionRange(
        ${testCase.sourceOffset},
        ${sourceEndOffset},
        ${JSON.stringify(testCase.backward ? "backward" : "forward")}
      );
      return true;
    })()`);
    for (let enter = 0; enter < enters; enter += 1) {
      await dispatchEnterKey(8);
    }
    await cdp.send("Input.insertText", { text: "x" });
    const normalizedNativeSource = await evaluate(
      `document.querySelector(${JSON.stringify(`#${controlId}`)})?.value ?? null`
    );
    const nativeSource = testCase.lineEnding === "\r\n"
      ? normalizedNativeSource.replaceAll("\n", "\r\n")
      : normalizedNativeSource;
    await evaluate(`document.querySelector(${JSON.stringify(`#${controlId}`)})?.remove()`);
    if (nativeSource !== testCase.expected) {
      throw new Error(
        `${testCase.name} native source fixture produced ${JSON.stringify(nativeSource)}`
      );
    }

    if (Number.isFinite(testCase.visibleEndOffset)) {
      const start = await textBoundaryPoint(
        testCase.text,
        testCase.visibleOffset,
        ".ProseMirror"
      );
      const end = await textBoundaryPoint(
        testCase.text,
        testCase.visibleEndOffset,
        ".ProseMirror"
      );
      await dragBetweenTextBoundaries(
        testCase.backward ? end : start,
        testCase.backward ? start : end
      );
      await waitFor(
        () => evaluate(`getSelection()?.toString() === " Beta"`),
        `${testCase.name} could not install its rendered selection`
      );
    } else {
      await placeCaretInText(testCase.text, testCase.visibleOffset);
    }
    for (let enter = 0; enter < enters; enter += 1) {
      await dispatchEnterKey(8);
    }
    await cdp.send("Input.insertText", { text: "x" });
    await waitForSaveState(false);
    await dispatchKey({ key: "s", code: "KeyS", virtualKeyCode: 83, modifiers: 4 });
    await waitForCompletedSave(testCase.expected);
    if (testCase.history) {
      for (let step = 0; step < (testCase.historySteps || 1); step += 1) {
        await dispatchKey({ key: "z", code: "KeyZ", virtualKeyCode: 90, modifiers: 4 });
      }
      await waitForSaveState(false);
      await dispatchKey({ key: "s", code: "KeyS", virtualKeyCode: 83, modifiers: 4 });
      await waitForCompletedSave(testCase.markdown);
      for (let step = 0; step < (testCase.historySteps || 1); step += 1) {
        await dispatchKey({ key: "z", code: "KeyZ", virtualKeyCode: 90, modifiers: 12 });
      }
      await waitForSaveState(false);
      await dispatchKey({ key: "s", code: "KeyS", virtualKeyCode: 83, modifiers: 4 });
      await waitForCompletedSave(testCase.expected);
    }
    await delay(300);
    const state = await editorState();
    if (
      state.dirty
      || state.anchorOffset !== 1
      || !state.anchorText?.startsWith("x")
      || state.exactSourceSelection
    ) {
      throw new Error(
        `${testCase.name} did not retain a clean rendered caret after Shift+Return: ${
          JSON.stringify(state)
        }`
      );
    }
    await stopSession();
  }
}

async function verifyRenderedTabEditing() {
  const cases = [
    {
      name: "plain collapsed Tab",
      markdown: "Alpha Beta\n",
      text: "Alpha Beta",
      visibleOffset: "Alpha".length,
      expected: "Alpha\tX Beta\n"
    },
    {
      name: "heading collapsed Tab",
      markdown: "## Alpha Beta\n",
      text: "Alpha Beta",
      visibleOffset: "Alpha".length,
      expected: "## Alpha\tX Beta\n"
    },
    {
      name: "bullet collapsed Tab",
      markdown: "+ Alpha Beta\n",
      text: "Alpha Beta",
      visibleOffset: "Alpha".length,
      expected: "+ Alpha\tX Beta\n",
      history: true
    },
    {
      name: "task collapsed Tab",
      markdown: "- [X] Alpha Beta\n",
      text: "Alpha Beta",
      visibleOffset: "Alpha".length,
      expected: "- [X] Alpha\tX Beta\n"
    },
    {
      name: "quote collapsed Tab",
      markdown: ">Alpha Beta\n",
      text: "Alpha Beta",
      visibleOffset: "Alpha".length,
      expected: ">Alpha\tX Beta\n"
    },
    {
      name: "backward plain selection Tab",
      markdown: "Alpha Beta\n",
      text: "Alpha Beta",
      visibleOffset: "Alpha ".length,
      visibleEndOffset: "Alpha Beta".length,
      backward: true,
      expected: "\tAlpha X\n"
    },
    {
      name: "bullet selection Tab",
      markdown: "+ Alpha Beta\n",
      text: "Alpha Beta",
      visibleOffset: "Alpha ".length,
      visibleEndOffset: "Alpha Beta".length,
      expected: "\t+ Alpha X\n"
    },
    {
      name: "nested bullet collapsed Shift-Tab",
      markdown: "- Parent\n    + Alpha Beta\n",
      text: "Alpha Beta",
      visibleOffset: "Alpha".length,
      shift: true,
      expected: "- Parent\n+ AlphaX Beta\n"
    },
    {
      name: "plain collapsed Shift-Tab",
      markdown: "Alpha Beta\n",
      text: "Alpha Beta",
      visibleOffset: "Alpha".length,
      shift: true,
      expected: "AlphaX Beta\n"
    }
  ];
  const selectedCases = process.env.TETHER_PARITY_SCENARIO
    ? cases.filter(({ name }) => name.includes(process.env.TETHER_PARITY_SCENARIO))
    : cases;
  for (const testCase of selectedCases) {
    await startSession(testCase.markdown, testCase.text);
    if (Number.isFinite(testCase.visibleEndOffset)) {
      const start = await textBoundaryPoint(
        testCase.text,
        testCase.visibleOffset,
        ".ProseMirror"
      );
      const end = await textBoundaryPoint(
        testCase.text,
        testCase.visibleEndOffset,
        ".ProseMirror"
      );
      await dragBetweenTextBoundaries(
        testCase.backward ? end : start,
        testCase.backward ? start : end
      );
      await waitFor(
        () => evaluate(`getSelection()?.toString() === "Beta"`),
        `${testCase.name} could not install its rendered selection`
      );
    } else {
      await placeCaretInText(testCase.text, testCase.visibleOffset);
    }
    await dispatchKey({
      key: "Tab",
      code: "Tab",
      virtualKeyCode: 9,
      modifiers: testCase.shift ? 8 : 0
    });
    await dispatchTextKey("X", "KeyX", 88);
    await waitForSaveState(false);
    await dispatchKey({ key: "s", code: "KeyS", virtualKeyCode: 83, modifiers: 4 });
    await waitForCompletedSave(testCase.expected);
    if (testCase.history) {
      await dispatchKey({ key: "z", code: "KeyZ", virtualKeyCode: 90, modifiers: 4 });
      await dispatchKey({ key: "z", code: "KeyZ", virtualKeyCode: 90, modifiers: 4 });
      await waitForSaveState(false);
      await dispatchKey({ key: "s", code: "KeyS", virtualKeyCode: 83, modifiers: 4 });
      await waitForCompletedSave(testCase.markdown);
      await dispatchKey({ key: "z", code: "KeyZ", virtualKeyCode: 90, modifiers: 12 });
      await dispatchKey({ key: "z", code: "KeyZ", virtualKeyCode: 90, modifiers: 12 });
      await waitForSaveState(false);
      await dispatchKey({ key: "s", code: "KeyS", virtualKeyCode: 83, modifiers: 4 });
      await waitForCompletedSave(testCase.expected);
    }
    await stopSession();
  }
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
  // A source editor visits the physical blank line between prose and the
  // opening fence first. The second Shift-Down reaches the same source column
  // on the fence line, retaining this scenario's cross-block selection.
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

async function verifyPlatformNativeCodeBoundaryDeletion() {
  const contentStart = codeFixture.indexOf(codeContent);
  const blockContentStart = codeBlockSource.indexOf("\n") + 1;
  const openingNewlineDeleted = `${codeBlockSource.slice(0, blockContentStart - 1)}${
    codeBlockSource.slice(blockContentStart)
  }`;
  const scenarios = [
    {
      name: "Shift-Backspace at opening fence",
      boundary: "start",
      sourceCaret: contentStart,
      keyCode: "Backspace",
      key: "Backspace",
      code: "Backspace",
      virtualKeyCode: 8,
      expectedSourceControl: openingNewlineDeleted
    },
    {
      name: "Shift-Delete at closing fence",
      boundary: "end",
      sourceCaret: contentStart + codeContent.length,
      keyCode: "Delete",
      key: "Delete",
      code: "Delete",
      virtualKeyCode: 46
    }
  ];
  const mismatches = [];

  for (let index = 0; index < scenarios.length; index += 1) {
    const scenario = scenarios[index];
    const controlId = `tether-native-code-boundary-deletion-${index}`;
    await startSession(codeFixture, codeContent);
    await evaluate(`(() => {
      const control = document.createElement("textarea");
      control.id = ${JSON.stringify(controlId)};
      control.style.position = "fixed";
      control.style.left = "-10000px";
      control.value = ${JSON.stringify(codeFixture)};
      document.body.append(control);
      control.focus();
      control.setSelectionRange(${scenario.sourceCaret}, ${scenario.sourceCaret});
      return true;
    })()`);
    await dispatchNativeKey(scenario.keyCode, ["shift"]);
    await cdp.send("Input.insertText", { text: "x" });
    const nativeSource = await evaluate(
      `document.querySelector(${JSON.stringify(`#${controlId}`)})?.value ?? null`
    );
    await stopSession();

    await startSession(codeFixture, codeContent);
    await focusCodeBoundary(scenario.boundary);
    await dispatchKey({
      key: scenario.key,
      code: scenario.code,
      virtualKeyCode: scenario.virtualKeyCode,
      modifiers: 8
    });
    if (scenario.expectedSourceControl) {
      await waitForSourceControl(
        (state) => state?.active
          && state.value === scenario.expectedSourceControl
          && state.selectionStart === blockContentStart - 1
          && state.selectionEnd === blockContentStart - 1,
        `${scenario.name} did not hand the caret to the exact physical fence source`
      );
    }
    await cdp.send("Input.insertText", { text: "x" });
    await waitForSaveState(false);
    await dispatchKey({ key: "s", code: "KeyS", virtualKeyCode: 83, modifiers: 4 });
    await waitForSaveState(true);
    const actualSource = await readFile(samplePath, "utf8");
    if (actualSource !== nativeSource) {
      mismatches.push({
        scenario: scenario.name,
        expectedSource: nativeSource,
        actualSource,
        state: await editorState()
      });
    }
    await stopSession();
  }

  if (mismatches.length) {
    throw new Error(
      `Fenced-code boundary deletion diverged from native source controls:\n${
        JSON.stringify(mismatches, null, 2)
      }`
    );
  }
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

async function verifyCodeImeEditing() {
  const replacement = "// 中文注释";
  const editedFixture = variantCodeFixture.replace("const answer = 42;", replacement);
  await startSession(variantCodeFixture, "const answer = 42;");
  await waitFor(
    () => evaluate(`Boolean(document.querySelector(".milkdown-code-block .cm-content"))`),
    "CRLF fenced code did not mount before IME editing"
  );
  await clickElement(".milkdown-code-block .cm-content");
  await waitFor(
    () => evaluate(`document.activeElement?.matches?.(".cm-content")`),
    "CodeMirror did not receive focus before IME editing"
  );
  await dispatchKey({ key: "Home", code: "Home", virtualKeyCode: 36 });
  await dispatchKey({ key: "End", code: "End", virtualKeyCode: 35, modifiers: 8 });
  await dispatchImeText(replacement);
  await waitFor(
    () => evaluate(`document.querySelector(".cm-content")?.textContent === ${JSON.stringify(replacement)}`),
    "IME composition did not replace the selected fenced-code line"
  );
  await waitForSaveState(false);
  await dispatchKey({ key: "s", code: "KeyS", virtualKeyCode: 83, modifiers: 4 });
  await waitForCompletedSave(editedFixture);

  await dispatchKey({ key: "z", code: "KeyZ", virtualKeyCode: 90, modifiers: 4 });
  await waitFor(
    () => evaluate(`document.querySelector(".cm-content")?.textContent === "const answer = 42;"`),
    "Undo did not restore fenced code before IME composition"
  );
  await waitForSaveState(false);
  await dispatchKey({ key: "z", code: "KeyZ", virtualKeyCode: 90, modifiers: 12 });
  await waitFor(
    () => evaluate(`document.querySelector(".cm-content")?.textContent === ${JSON.stringify(replacement)}`),
    "Redo did not restore fenced-code IME composition"
  );
  await dispatchKey({ key: "s", code: "KeyS", virtualKeyCode: 83, modifiers: 4 });
  await waitForCompletedSave(editedFixture);
  await stopSession();
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
  const save = async (source) => {
    await dispatchKey({ key: "s", code: "KeyS", virtualKeyCode: 83, modifiers: 4 });
    await waitForCompletedSave(source);
  };
  const scenarios = [
    {
      name: "root fence",
      source: [
        "Before.",
        "",
        "~~~~js",
        "alpha",
        "beta",
        "~~~~",
        "",
        "After.",
        ""
      ].join("\r\n")
    },
    {
      name: "blockquote with prose",
      source: [
        "> Intro",
        ">",
        "> ~~~~js",
        "> alpha",
        "> beta",
        "> ~~~~~",
        ">",
        "> Outro",
        ""
      ].join("\r\n")
    },
    {
      name: "multi-item list",
      source: [
        "- before",
        "- ~~~~js",
        "  alpha",
        "  beta",
        "  ~~~~~",
        "- after",
        ""
      ].join("\r\n")
    },
    {
      name: "list and blockquote",
      source: [
        "- > ~~~~js",
        "  > alpha",
        "  > beta",
        "  > ~~~~~",
        ""
      ].join("\r\n")
    }
  ];

  for (const scenario of scenarios) {
    const selectionStart = scenario.source.indexOf("alpha");
    const selectionEnd = scenario.source.indexOf("beta") + "beta".length;
    const expected = scenario.source.slice(selectionStart, selectionEnd);
    const cutSource = `${scenario.source.slice(0, selectionStart)}${
      scenario.source.slice(selectionEnd)
    }`;

    await startSession(scenario.source, "alpha");
    await clickElement(".milkdown-code-block .cm-line:first-child");
    await waitFor(
      () => evaluate(`document.activeElement?.matches?.(".cm-content")`),
      `${scenario.name} did not focus its first CRLF code line`
    );
    await dispatchKey({ key: "Home", code: "Home", virtualKeyCode: 36 });
    await dispatchKey({ key: "End", code: "End", virtualKeyCode: 35, modifiers: 8 });
    await dispatchKey({
      key: "ArrowRight",
      code: "ArrowRight",
      virtualKeyCode: 39,
      modifiers: 8
    });
    await dispatchKey({ key: "End", code: "End", virtualKeyCode: 35, modifiers: 8 });

    const copied = await dispatchSyntheticClipboardAndCaptureText("copy");
    if (copied !== expected) {
      throw new Error(
        `${scenario.name} CRLF Copy emitted ${JSON.stringify(copied)} instead of physical source ${
          JSON.stringify(expected)
        }`
      );
    }
    const cut = await dispatchSyntheticClipboardAndCaptureText("cut");
    if (cut !== expected) {
      throw new Error(
        `${scenario.name} CRLF Cut emitted ${JSON.stringify(cut)} instead of physical source ${
          JSON.stringify(expected)
        }`
      );
    }
    await waitForSaveState(false);
    await save(cutSource);
    await dispatchKey({ key: "z", code: "KeyZ", virtualKeyCode: 90, modifiers: 4 });
    await waitForSaveState(false);
    await save(scenario.source);
    await dispatchKey({ key: "z", code: "KeyZ", virtualKeyCode: 90, modifiers: 12 });
    await waitForSaveState(false);
    await save(cutSource);
    await stopSession();
  }
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
    const language = block?.querySelector(".language-button");
    const copy = block?.querySelector(".copy-button");
    const copyIcon = copy?.querySelector("svg");
    const blockRect = block?.getBoundingClientRect();
    const toolsRect = tools?.getBoundingClientRect();
    const guttersRect = gutters?.getBoundingClientRect();
    const foldGutterRect = foldGutter?.getBoundingClientRect();
    const lineRect = line?.getBoundingClientRect();
    const languageRect = language?.getBoundingClientRect();
    const copyRect = copy?.getBoundingClientRect();
    const copyIconRect = copyIcon?.getBoundingClientRect();
    if (
      !blockRect || !toolsRect || !guttersRect || !foldGutterRect
      || !lineRect || !languageRect || !copyRect || !copyIconRect
    ) return null;
    return {
      blockHeight: blockRect.height,
      toolsHeight: toolsRect.height,
      toolsBorderTop: Number.parseFloat(getComputedStyle(tools).borderTopWidth) || 0,
      languageCenterDelta: (
        languageRect.top + languageRect.height / 2
      ) - (
        toolsRect.top + toolsRect.height / 2
      ),
      copyHeight: copyRect.height,
      copyCenterDelta: (
        copyRect.top + copyRect.height / 2
      ) - (
        toolsRect.top + toolsRect.height / 2
      ),
      copyIconTopInset: copyIconRect.top - copyRect.top,
      copyIconBottomInset: copyRect.bottom - copyIconRect.bottom,
      topToText: lineRect.top - blockRect.top,
      textToBottom: blockRect.bottom - lineRect.bottom,
      textToTools: toolsRect.top - lineRect.bottom,
      toolsToBottom: blockRect.bottom - toolsRect.bottom,
      guttersWidth: guttersRect.width,
      foldGutterWidth: foldGutterRect.width,
      gutterToText: lineRect.left - guttersRect.right
    };
  })()`);
  const compact = geometry
    && geometry.blockHeight >= 54
    && geometry.blockHeight <= 56
    && geometry.toolsHeight >= 17.5
    && geometry.toolsHeight <= 18.5
    && geometry.toolsBorderTop === 1
    && Math.abs(geometry.languageCenterDelta) <= 0.5
    && geometry.copyHeight >= 17.5
    && geometry.copyHeight <= 18.5
    && Math.abs(geometry.copyCenterDelta) <= 0.5
    && geometry.copyIconTopInset >= 2
    && geometry.copyIconBottomInset >= 2
    && geometry.topToText >= 8.5
    && geometry.topToText <= 9.5
    && geometry.textToBottom >= 24.5
    && geometry.textToBottom <= 25.5
    && geometry.textToTools >= 1.5
    && geometry.textToTools <= 2.5
    && geometry.toolsToBottom >= 4.5
    && geometry.toolsToBottom <= 5.5
    && geometry.guttersWidth >= 42.5
    && geometry.guttersWidth <= 43.5
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

async function verifyCodeSourcePresentationFixture({
  name,
  documentSource,
  visibleText,
  blockSource
}) {
  await startSession(documentSource, visibleText);
  const rendered = await evaluate(`(() => {
    const block = document.querySelector(".milkdown-code-block");
    const scroller = block?.querySelector(".cm-scroller");
    const rect = block?.getBoundingClientRect();
    if (!block || !scroller || !rect) return null;
    const style = getComputedStyle(block);
    const textStyle = getComputedStyle(scroller);
    return {
      left: rect.left,
      right: rect.right,
      width: rect.width,
      backgroundColor: style.backgroundColor,
      borderRadius: style.borderRadius,
      borderTopWidth: style.borderTopWidth,
      fontFamily: textStyle.fontFamily,
      fontSize: textStyle.fontSize,
      lineHeight: textStyle.lineHeight
    };
  })()`);

  await clickElement(".milkdown-code-block .cm-line:first-child");
  await waitFor(
    () => evaluate(`document.activeElement?.matches?.(".cm-content")`),
    "fenced-source presentation could not focus the first rendered code line"
  );
  // Reach the physical start of the visible line first. For indented code,
  // Home itself crosses into the hidden indentation; fenced variants need the
  // following ArrowLeft to cross their opening-line newline. This mirrors a
  // normal source editor while keeping the presentation check independent of
  // where the pointer happened to place the CodeMirror caret.
  await dispatchKey({ key: "Home", code: "Home", virtualKeyCode: 36 });
  let activatedSource = await sourceControlState();
  if (!activatedSource?.active) {
    await dispatchKey({ key: "ArrowLeft", code: "ArrowLeft", virtualKeyCode: 37 });
    activatedSource = await sourceControlState();
  }
  await waitForSourceControl(
    (state) => state?.active && state.value === blockSource,
    `${name} code boundary did not expose its exact physical source`
  );
  await waitFor(
    () => evaluate(`(() => {
      const control = document.querySelector("textarea.tether-continuous-source.is-code_block");
      return control && control.scrollHeight <= control.clientHeight + 1;
    })()`),
    `${name} active code source did not resize to its complete physical content`
  );
  const source = await evaluate(`(() => {
    const prose = document.querySelector(".ProseMirror");
    const control = document.querySelector("textarea.tether-continuous-source.is-code_block");
    const rect = control?.getBoundingClientRect();
    if (!prose || !control || !rect) return null;
    const style = getComputedStyle(control);
    return {
      left: rect.left,
      right: rect.right,
      width: rect.width,
      backgroundColor: style.backgroundColor,
      borderRadius: style.borderRadius,
      borderTopWidth: style.borderTopWidth,
      fontFamily: style.fontFamily,
      fontSize: style.fontSize,
      lineHeight: style.lineHeight,
      scrollHeight: control.scrollHeight,
      clientHeight: control.clientHeight,
      documentOverflow: prose.scrollWidth - prose.clientWidth,
      renderedBlocks: Array.from(
        prose.querySelectorAll(".milkdown-code-block"),
        (block) => {
          const blockRect = block.getBoundingClientRect();
          return {
            className: block.className,
            parentClassName: block.parentElement?.className || null,
            previousClassName: block.previousElementSibling?.className || null,
            display: getComputedStyle(block).display,
            height: blockRect.height
          };
        }
      )
    };
  })()`);
  const visuallyContinuous = rendered
    && source
    && Math.abs(rendered.left - source.left) <= 0.5
    && Math.abs(rendered.right - source.right) <= 0.5
    && Math.abs(rendered.width - source.width) <= 0.5
    && rendered.backgroundColor === source.backgroundColor
    && rendered.borderRadius === source.borderRadius
    && rendered.borderTopWidth === source.borderTopWidth
    && rendered.fontFamily === source.fontFamily
    && rendered.fontSize === source.fontSize
    && rendered.lineHeight === source.lineHeight
    && source.scrollHeight <= source.clientHeight + 1
    && source.documentOverflow <= 1
    && source.renderedBlocks.every(({ display, height }) => display === "none" || height === 0);
  if (!visuallyContinuous) {
    throw new Error(`${name} active code source diverged from its rendered block: ${
      JSON.stringify({ rendered, source })
    }`);
  }
  if (process.env.TETHER_PARITY_SCREENSHOT) {
    const screenshotPath = process.env.TETHER_PARITY_SCREENSHOT.replace(
      /(\.png)?$/,
      `-${name}.png`
    );
    await captureElementsScreenshot(
      ["textarea.tether-continuous-source.is-code_block"],
      screenshotPath
    );
  }
  if (["quoted-fence", "listed-fence"].includes(name)) {
    const identifier = name === "quoted-fence" ? "quoted" : "listed";
    const insertionOffset = blockSource.indexOf(identifier) + identifier.length;
    const installed = await evaluate(`(() => {
      const control = document.querySelector("textarea.tether-continuous-source.is-code_block");
      if (!control) return false;
      control.focus();
      control.setSelectionRange(${insertionOffset}, ${insertionOffset});
      return control.selectionStart === ${insertionOffset};
    })()`);
    if (!installed) throw new Error(`${name} source caret could not be positioned for editing`);
    await cdp.send("Input.insertText", { text: "X" });
    const editedBlock = `${
      blockSource.slice(0, insertionOffset)
    }X${blockSource.slice(insertionOffset)}`;
    const editedDocument = documentSource.replace(blockSource, editedBlock);
    await waitForSaveState(false);
    await dispatchKey({ key: "s", code: "KeyS", virtualKeyCode: 83, modifiers: 4 });
    await waitForCompletedSave(editedDocument);
  }
  await stopSession();
}

async function verifyCodeSourcePresentation() {
  const content = [
    "const first = 1;",
    "const second = 2;",
    "return first + second;"
  ].join("\n");
  const ordinary = `\`\`\`js\n${content}\n\`\`\``;
  const tilde = "~~~~ python key=value\r\nprint('ok')\r\n~~~~~";
  const indented = "    first()\n\tsecond()";
  const frontMatter = "---\ntitle: Tether\npublished: false\n---";
  const unclosed = "```text\nalpha\nbeta";
  const quoted = "> ~~~~js\n> const quoted = true;\n> ~~~~~";
  const listed = "- ~~~~js\n  const listed = true;\n  ~~~~~";
  const fixtures = [
    {
      name: "ordinary-fence",
      documentSource: `Before.\n\n${ordinary}\n\nAfter.\n`,
      visibleText: "const first = 1;",
      blockSource: ordinary
    },
    {
      name: "tilde-crlf-fence",
      documentSource: `Before.\r\n\r\n${tilde}\r\n\r\nAfter.\r\n`,
      visibleText: "print('ok')",
      blockSource: tilde
    },
    {
      name: "indented-code",
      documentSource: `Before.\n\n${indented}\n\nAfter.\n`,
      visibleText: "first()",
      blockSource: indented
    },
    {
      name: "front-matter",
      documentSource: `${frontMatter}\n\nAfter.\n`,
      visibleText: "title: Tether",
      blockSource: frontMatter
    },
    {
      name: "unclosed-fence",
      documentSource: `Before.\n\n${unclosed}`,
      visibleText: "alpha",
      blockSource: unclosed
    },
    {
      name: "quoted-fence",
      documentSource: `${quoted}\n`,
      visibleText: "const quoted = true;",
      blockSource: quoted
    },
    {
      name: "listed-fence",
      documentSource: `${listed}\n`,
      visibleText: "const listed = true;",
      blockSource: listed
    }
  ];
  for (const fixture of fixtures) {
    await verifyCodeSourcePresentationFixture(fixture);
  }
}

async function verifyNestedCodePhysicalSourceEditing() {
  const scenarios = [
    {
      name: "blockquote",
      source: "> ~~~~js\n> const quoted = true;\n> ~~~~~",
      visibleText: "const quoted = true;",
      linePrefix: "> ",
      sourceClass: "is-code_block"
    },
    {
      name: "multi-item list",
      source: [
        "- before",
        "- ~~~~js",
        "  const listed = true;",
        "  ~~~~~",
        "- after"
      ].join("\n"),
      visibleText: "const listed = true;",
      linePrefix: "  ",
      sourceClass: "is-bullet_list"
    },
    {
      name: "list and blockquote",
      source: [
        "- > ~~~~js",
        "  > const mixed = true;",
        "  > ~~~~~"
      ].join("\n"),
      visibleText: "const mixed = true;",
      linePrefix: "  > ",
      sourceClass: "is-code_block"
    },
    {
      name: "blockquote with prose",
      source: [
        "> Intro",
        ">",
        "> ~~~~js",
        "> const mixedProse = true;",
        "> ~~~~~",
        ">",
        "> Outro"
      ].join("\n"),
      visibleText: "const mixedProse = true;",
      linePrefix: "> ",
      sourceClass: "is-blockquote"
    }
  ];
  const activateCodeStart = async (key, modifiers = 0) => {
    await clickElement(".milkdown-code-block .cm-line:first-child");
    await waitFor(
      () => evaluate(`document.activeElement?.matches?.(".cm-content")`),
      "nested code could not focus its first rendered line"
    );
    await dispatchKey({ key: "Home", code: "Home", virtualKeyCode: 36 });
    await dispatchKey({
      key,
      code: key,
      virtualKeyCode: key === "Backspace" ? 8 : 37,
      modifiers
    });
  };

  for (const scenario of scenarios) {
    const fixture = `${scenario.source}\n`;
    const contentStart = scenario.source.indexOf(scenario.visibleText);
    const lineStart = contentStart - scenario.linePrefix.length;

    await startSession(fixture, scenario.visibleText);
    await activateCodeStart("ArrowLeft");
    await waitForSourceControl(
      (state) => state?.active
        && state.value === scenario.source
        && state.selectionStart === contentStart - 1
        && state.selectionEnd === contentStart - 1
        && state.className.includes(scenario.sourceClass),
      `${scenario.name} code navigation skipped its adjacent physical prefix byte`
    );
    for (let index = 1; index < scenario.linePrefix.length; index += 1) {
      await dispatchKey({ key: "ArrowLeft", code: "ArrowLeft", virtualKeyCode: 37 });
    }
    for (let index = 0; index < scenario.linePrefix.length; index += 1) {
      await dispatchKey({
        key: "ArrowRight",
        code: "ArrowRight",
        virtualKeyCode: 39,
        modifiers: 8
      });
    }
    const copiedPrefix = await dispatchSyntheticClipboardAndCaptureText("copy");
    if (copiedPrefix !== scenario.linePrefix) {
      throw new Error(
        `${scenario.name} code selected ${JSON.stringify(copiedPrefix)} instead of physical prefix ${
          JSON.stringify(scenario.linePrefix)
        }`
      );
    }
    await stopSession();

    await startSession(fixture, scenario.visibleText);
    await activateCodeStart("ArrowLeft", 8);
    await waitForSourceControl(
      (state) => state?.active
        && state.value === scenario.source
        && state.selectionStart === contentStart - 1
        && state.selectionEnd === contentStart
        && state.selectionDirection === "backward",
      `Shift-Left from ${scenario.name} code did not select one adjacent prefix byte`
    );
    for (let index = 1; index < scenario.linePrefix.length; index += 1) {
      await dispatchKey({
        key: "ArrowLeft",
        code: "ArrowLeft",
        virtualKeyCode: 37,
        modifiers: 8
      });
    }
    const copiedExtendedPrefix = await dispatchSyntheticClipboardAndCaptureText("copy");
    if (copiedExtendedPrefix !== scenario.linePrefix) {
      throw new Error(
        `${scenario.name} extended selection copied ${
          JSON.stringify(copiedExtendedPrefix)
        } instead of ${JSON.stringify(scenario.linePrefix)}`
      );
    }
    await stopSession();

    if (scenario.name === "blockquote") {
      await startSession(fixture, scenario.visibleText);
      await activateCodeStart("ArrowLeft", 1);
      await waitForSourceControl(
        (state) => state?.active
          && state.value === scenario.source
          && state.selectionStart === lineStart
          && state.selectionEnd === lineStart,
        "Option-Left from nested code skipped or collapsed its physical quote prefix"
      );
      await stopSession();
    }

    const deletedSource = scenario.source.slice(0, contentStart - 1)
      + scenario.source.slice(contentStart);
    await startSession(fixture, scenario.visibleText);
    await activateCodeStart("Backspace");
    await waitForSourceControl(
      (state) => state?.active
        && state.value === deletedSource
        && state.selectionStart === contentStart - 1
        && state.selectionEnd === contentStart - 1,
      `Backspace from ${scenario.name} code did not delete its adjacent physical prefix byte`
    );
    await dispatchKey({ key: "s", code: "KeyS", virtualKeyCode: 83, modifiers: 4 });
    await waitForCompletedSave(`${deletedSource}\n`);
    await dispatchKey({ key: "z", code: "KeyZ", virtualKeyCode: 90, modifiers: 4 });
    await waitForSaveState(false);
    await dispatchKey({ key: "s", code: "KeyS", virtualKeyCode: 83, modifiers: 4 });
    await waitForCompletedSave(fixture);
    await dispatchKey({ key: "z", code: "KeyZ", virtualKeyCode: 90, modifiers: 12 });
    await waitForSaveState(false);
    await dispatchKey({ key: "s", code: "KeyS", virtualKeyCode: 83, modifiers: 4 });
    await waitForCompletedSave(`${deletedSource}\n`);
    await stopSession();
  }
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
      firstLineToBlockTop: firstRect.top - blockRect.top,
      lastLineToTools: toolsRect.top - lastRect.bottom,
      toolsToBlockBottom: blockRect.bottom - toolsRect.bottom,
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
    && geometry.firstLineToBlockTop >= 8.5
    && geometry.firstLineToBlockTop <= 9.5
    && geometry.lastLineToTools >= 13.5
    && geometry.lastLineToTools <= 14.5
    && geometry.toolsToBlockBottom >= 4.5
    && geometry.toolsToBlockBottom <= 5.5
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
  const verify = async (line, edge, key, marker, expectedContent, message) => {
    await startSession(fixture, "alpha");
    await clickElement(`.milkdown-code-block .cm-line:nth-child(${line})`);
    await dispatchKey({
      key: edge,
      code: edge,
      virtualKeyCode: edge === "Home" ? 36 : 35
    });
    if (edge === "Home") {
      await dispatchKey({ key: "ArrowRight", code: "ArrowRight", virtualKeyCode: 39 });
      await dispatchKey({ key: "ArrowRight", code: "ArrowRight", virtualKeyCode: 39 });
    }
    await dispatchKey({
      key,
      code: key,
      virtualKeyCode: key === "ArrowUp" ? 38 : 40,
      modifiers: 9
    });
    await cdp.send("Input.insertText", { text: marker });
    await waitForSaveState(false).catch(async (error) => {
      throw new Error(`${message}: ${error.message}`);
    });
    await dispatchKey({ key: "s", code: "KeyS", virtualKeyCode: 83, modifiers: 4 });
    await waitForCompletedSave(fixture.replace(content, expectedContent));
    await stopSession();
  };

  await verify(
    2,
    "Home",
    "ArrowUp",
    "X",
    "alpha\nbeXta\ngamma",
    "Shift-Option-Up changed the middle code caret"
  );
  await verify(
    2,
    "Home",
    "ArrowDown",
    "Y",
    "alpha\nbeYta\ngamma",
    "Shift-Option-Down changed the middle code caret"
  );
  await verify(
    1,
    "Home",
    "ArrowUp",
    "X",
    "alXpha\nbeta\ngamma",
    "Shift-Option-Up crossed into the opening fence"
  );
  await verify(
    3,
    "Home",
    "ArrowDown",
    "Y",
    "alpha\nbeta\ngaYmma",
    "Shift-Option-Down crossed into the closing fence"
  );
}

async function verifyCodeNativeNoopShortcuts() {
  const content = "alpha\nbeta\ngamma";
  const fixture = `Before.\n\n\`\`\`text\n${content}\n\`\`\`\n\nAfter.\n`;
  const verify = async (shortcut, insertion, expectedContent, message) => {
    await startSession(fixture, "alpha");
    await clickElement(".milkdown-code-block .cm-line:nth-child(2)");
    await dispatchKey({ key: "Home", code: "Home", virtualKeyCode: 36 });
    await dispatchKey({ key: "ArrowRight", code: "ArrowRight", virtualKeyCode: 39 });
    await dispatchKey({ key: "ArrowRight", code: "ArrowRight", virtualKeyCode: 39 });
    await dispatchKey(shortcut);
    await cdp.send("Input.insertText", { text: insertion });
    await waitForSaveState(false).catch(async (error) => {
      throw new Error(`${message}: ${error.message}`);
    });
    await dispatchKey({ key: "s", code: "KeyS", virtualKeyCode: 83, modifiers: 4 });
    await waitForCompletedSave(fixture.replace(content, expectedContent));
    await stopSession();
  };

  await verify(
    { key: "ArrowUp", code: "ArrowUp", virtualKeyCode: 38, modifiers: 5 },
    "X",
    "alpha\nbeXta\ngamma",
    "Command-Option-Up created an extra code caret"
  );
  await verify(
    { key: "ArrowDown", code: "ArrowDown", virtualKeyCode: 40, modifiers: 5 },
    "Y",
    "alpha\nbeYta\ngamma",
    "Command-Option-Down created an extra code caret"
  );
  await verify(
    { key: "Enter", code: "Enter", virtualKeyCode: 13, modifiers: 4 },
    "Z",
    "alpha\nbeZta\ngamma",
    "Command-Enter changed code structure or moved the source caret"
  );
}

async function verifyCodeNativeControlShortcuts() {
  const content = "alpha\nbeta";
  const fixture = `Before.\n\n\`\`\`text\n${content}\n\`\`\`\n\nAfter.\n`;
  const caret = content.indexOf("beta") + 2;
  const shortcuts = [
    { keyCode: "A", name: "Control-A" },
    { keyCode: "E", name: "Control-E" },
    { keyCode: "B", name: "Control-B" },
    { keyCode: "F", name: "Control-F" },
    { keyCode: "P", name: "Control-P" },
    { keyCode: "N", name: "Control-N" },
    { keyCode: "H", name: "Control-H" },
    { keyCode: "D", name: "Control-D" },
    { keyCode: "K", name: "Control-K" },
    { keyCode: "O", name: "Control-O" },
    { keyCode: "T", name: "Control-T" },
    { keyCode: "V", name: "Control-V" },
    { keyCode: "L", name: "Control-L" },
    ...["A", "E", "B", "F", "P", "N", "D", "H", "K", "O", "T", "V", "L"].map((keyCode) => ({
      keyCode,
      name: `Shift-Control-${keyCode}`,
      nativeModifiers: ["shift", "control"],
      modifiers: 10
    })),
    ...[
      ["Up", 38],
      ["Down", 40],
      ["Left", 37],
      ["Right", 39]
    ].map(([keyCode, virtualKeyCode]) => ({
      keyCode,
      name: `Control-Arrow${keyCode}`,
      key: `Arrow${keyCode}`,
      code: `Arrow${keyCode}`,
      virtualKeyCode
    })),
    ...[
      ["Up", 38],
      ["Down", 40],
      ["Left", 37],
      ["Right", 39]
    ].map(([keyCode, virtualKeyCode]) => ({
      keyCode,
      name: `Shift-Control-Arrow${keyCode}`,
      key: `Arrow${keyCode}`,
      code: `Arrow${keyCode}`,
      virtualKeyCode,
      nativeModifiers: ["shift", "control"],
      modifiers: 10
    }))
  ];

  await startSession(fixture, "alpha");
  const nativeResults = [];
  for (const shortcut of shortcuts) {
    await evaluate(`(() => {
      let control = document.querySelector("#tether-native-control-shortcut");
      if (!control) {
        control = document.createElement("textarea");
        control.id = "tether-native-control-shortcut";
        control.style.position = "fixed";
        control.style.left = "-10000px";
        document.body.append(control);
      }
      control.value = ${JSON.stringify(content)};
      control.focus();
      control.setSelectionRange(${caret}, ${caret});
      return true;
    })()`);
    await dispatchNativeKey(shortcut.keyCode, shortcut.nativeModifiers || ["control"]);
    nativeResults.push(await evaluate(`(() => {
      const control = document.querySelector("#tether-native-control-shortcut");
      return {
        value: control?.value ?? null,
        start: control?.selectionStart ?? null,
        end: control?.selectionEnd ?? null,
        direction: control?.selectionDirection ?? null
      };
    })()`));
  }
  await evaluate(`document.querySelector("#tether-native-control-shortcut")?.remove()`);
  await stopSession();

  const mismatches = [];
  for (let index = 0; index < shortcuts.length; index += 1) {
    const shortcut = shortcuts[index];
    const native = nativeResults[index];
    const expectedContent = `${native.value.slice(0, native.start)}X${native.value.slice(native.end)}`;
    const expectedSource = fixture.replace(content, expectedContent);

    await startSession(fixture, "alpha");
    await clickElement(".milkdown-code-block .cm-line:nth-child(2)");
    await dispatchKey({ key: "Home", code: "Home", virtualKeyCode: 36 });
    await dispatchKey({ key: "ArrowRight", code: "ArrowRight", virtualKeyCode: 39 });
    await dispatchKey({ key: "ArrowRight", code: "ArrowRight", virtualKeyCode: 39 });
    await dispatchKey({
      key: shortcut.key || shortcut.keyCode.toLowerCase(),
      code: shortcut.code || `Key${shortcut.keyCode}`,
      virtualKeyCode: shortcut.virtualKeyCode || shortcut.keyCode.charCodeAt(0),
      modifiers: shortcut.modifiers || 2
    });
    await delay(25);
    await dispatchTextKey("X", "KeyX", 88);
    try {
      await waitForSaveState(false);
    } catch (error) {
      throw new Error(`${shortcut.name} did not synchronize its marker insertion`, { cause: error });
    }
    await dispatchKey({ key: "s", code: "KeyS", virtualKeyCode: 83, modifiers: 4 });
    await waitFor(
      async () => (await readFile(samplePath, "utf8").catch(() => fixture)) !== fixture,
      `${shortcut.name} comparison did not save its marker insertion`
    );
    const actualSource = await readFile(samplePath, "utf8");
    if (actualSource !== expectedSource) {
      mismatches.push({
        shortcut: shortcut.name,
        native,
        expectedSource,
        actualSource
      });
    }
    await stopSession();
  }

  if (mismatches.length) {
    throw new Error(`CodeMirror diverged from native source controls:\n${JSON.stringify(mismatches, null, 2)}`);
  }
}

async function verifyPlatformNativeDocumentShortcuts() {
  const content = "alpha beta";
  const caret = content.indexOf("beta") + 2;
  const codeFixture = `Before.\n\n\`\`\`text\n${content}\n\`\`\`\n\nAfter.\n`;
  const scenarios = [
    {
      name: "Control-A",
      steps: [
        { keyCode: "A", key: "a", code: "KeyA", virtualKeyCode: 65, nativeModifiers: ["control"], modifiers: 2 },
        { text: "x" }
      ]
    },
    {
      name: "Control-Z",
      steps: [
        { text: "q" },
        { keyCode: "Z", key: "z", code: "KeyZ", virtualKeyCode: 90, nativeModifiers: ["control"], modifiers: 2 },
        { text: "x" }
      ]
    },
    {
      name: "Control-Y",
      steps: [
        { text: "q" },
        { keyCode: "Y", key: "y", code: "KeyY", virtualKeyCode: 89, nativeModifiers: ["control"], modifiers: 2 },
        { text: "x" }
      ]
    },
    {
      name: "Command-Backspace",
      steps: [
        {
          keyCode: "Backspace",
          key: "Backspace",
          code: "Backspace",
          virtualKeyCode: 8,
          nativeModifiers: ["meta"],
          modifiers: 4
        },
        { text: "x" }
      ]
    },
    {
      name: "Command-Delete",
      steps: [
        {
          keyCode: "Delete",
          key: "Delete",
          code: "Delete",
          virtualKeyCode: 46,
          nativeModifiers: ["meta"],
          modifiers: 4
        },
        { text: "x" }
      ]
    },
    {
      name: "Shift-Backspace",
      steps: [
        {
          keyCode: "Backspace",
          key: "Backspace",
          code: "Backspace",
          virtualKeyCode: 8,
          nativeModifiers: ["shift"],
          modifiers: 8
        },
        { text: "x" }
      ]
    },
    {
      name: "Shift-Delete",
      steps: [
        {
          keyCode: "Delete",
          key: "Delete",
          code: "Delete",
          virtualKeyCode: 46,
          nativeModifiers: ["shift"],
          modifiers: 8
        },
        { text: "x" }
      ]
    },
    {
      name: "Shift-Delete with selection",
      steps: [
        {
          keyCode: "Left",
          key: "ArrowLeft",
          code: "ArrowLeft",
          virtualKeyCode: 37,
          nativeModifiers: ["shift"],
          modifiers: 8
        },
        {
          keyCode: "Delete",
          key: "Delete",
          code: "Delete",
          virtualKeyCode: 46,
          nativeModifiers: ["shift"],
          modifiers: 8
        },
        { text: "x" }
      ]
    },
    {
      name: "Shift-Backspace with selection",
      steps: [
        {
          keyCode: "Left",
          key: "ArrowLeft",
          code: "ArrowLeft",
          virtualKeyCode: 37,
          nativeModifiers: ["shift"],
          modifiers: 8
        },
        {
          keyCode: "Backspace",
          key: "Backspace",
          code: "Backspace",
          virtualKeyCode: 8,
          nativeModifiers: ["shift"],
          modifiers: 8
        },
        { text: "x" }
      ]
    },
    {
      name: "Enter",
      steps: [
        {
          keyCode: "Enter",
          key: "Enter",
          code: "Enter",
          virtualKeyCode: 13,
          nativeModifiers: [],
          modifiers: 0
        },
        { text: "x" }
      ]
    }
  ];
  const runNativeSteps = async (scenario, index) => {
    const controlId = `tether-native-document-shortcut-${index}`;
    await evaluate(`(() => {
      const control = document.createElement("textarea");
      control.id = ${JSON.stringify(controlId)};
      control.style.position = "fixed";
      control.style.left = "-10000px";
      control.value = ${JSON.stringify(content)};
      document.body.append(control);
      control.focus();
      control.setSelectionRange(${caret}, ${caret});
      return true;
    })()`);
    for (const step of scenario.steps) {
      if (step.text) await cdp.send("Input.insertText", { text: step.text });
      else if (step.key === "Enter" && !step.nativeModifiers?.length) {
        await cdp.send("Input.insertText", { text: "\n" });
      }
      else await dispatchNativeKey(step.keyCode, step.nativeModifiers);
      await delay(25);
    }
    const value = await evaluate(
      `document.querySelector(${JSON.stringify(`#${controlId}`)})?.value ?? null`
    );
    await evaluate(`document.querySelector(${JSON.stringify(`#${controlId}`)})?.remove()`);
    return value;
  };
  const runRenderedSteps = async (scenario) => {
    for (const step of scenario.steps) {
      if (step.text) {
        await dispatchTextKey(
          step.text,
          `Key${step.text.toUpperCase()}`,
          step.text.toUpperCase().charCodeAt(0)
        );
      } else if (step.key === "Enter" && !step.modifiers) {
        await dispatchEnterKey();
      } else {
        await dispatchKey({
          key: step.key,
          code: step.code,
          virtualKeyCode: step.virtualKeyCode,
          modifiers: step.modifiers
        });
      }
      await delay(25);
    }
  };

  await startSession(codeFixture, content);
  const nativeResults = [];
  for (let index = 0; index < scenarios.length; index += 1) {
    nativeResults.push(await runNativeSteps(scenarios[index], index));
  }
  await stopSession();

  const mismatches = [];
  for (let index = 0; index < scenarios.length; index += 1) {
    const scenario = scenarios[index];
    const nativeValue = nativeResults[index];

    await startSession(content, content);
    await placeCaretInText(content, caret);
    await evaluate(`(() => {
      window.__tetherShortcutTrace = [];
      window.addEventListener("keydown", (event) => {
        queueMicrotask(() => window.__tetherShortcutTrace.push({
          key: event.key,
          code: event.code,
          ctrlKey: event.ctrlKey,
          metaKey: event.metaKey,
          shiftKey: event.shiftKey,
          defaultPrevented: event.defaultPrevented,
          cancelBubble: event.cancelBubble
        }));
      }, true);
      return true;
    })()`);
    await runRenderedSteps(scenario);
    await waitForSaveState(false);
    await dispatchKey({ key: "s", code: "KeyS", virtualKeyCode: 83, modifiers: 4 });
    try {
      await waitForCompletedSave(nativeValue);
    } catch (error) {
      mismatches.push({
        shortcut: scenario.name,
        surface: "prose",
        nativeValue,
        actualSource: await readFile(samplePath, "utf8").catch(() => null),
        eventTrace: await evaluate("window.__tetherShortcutTrace || []")
      });
    }
    await stopSession();

    await startSession(codeFixture, content);
    await clickElement(".milkdown-code-block .cm-line");
    await dispatchKey({ key: "Home", code: "Home", virtualKeyCode: 36 });
    for (let offset = 0; offset < caret; offset += 1) {
      await dispatchKey({ key: "ArrowRight", code: "ArrowRight", virtualKeyCode: 39 });
    }
    await runRenderedSteps(scenario);
    await waitForSaveState(false);
    await dispatchKey({ key: "s", code: "KeyS", virtualKeyCode: 83, modifiers: 4 });
    const expectedCodeSource = codeFixture.replace(content, nativeValue);
    try {
      await waitForCompletedSave(expectedCodeSource);
    } catch (error) {
      mismatches.push({
        shortcut: scenario.name,
        surface: "code",
        nativeValue,
        actualSource: await readFile(samplePath, "utf8").catch(() => null)
      });
    }
    await stopSession();
  }
  if (mismatches.length) {
    throw new Error(`Rendered editor shortcuts diverged from native source controls:\n${JSON.stringify(mismatches, null, 2)}`);
  }
}

async function verifyPlatformNativeModifiedEnterShortcuts() {
  const content = "alpha\nbravo";
  const caret = content.indexOf("bravo") + 2;
  const codeFixture = `Before.\n\n\`\`\`text\n${content}\n\`\`\`\n\nAfter.\n`;
  const shortcuts = [
    { name: "Command-Enter", nativeModifiers: ["meta"], modifiers: 4 },
    { name: "Control-Enter", nativeModifiers: ["control"], modifiers: 2 },
    { name: "Option-Enter", nativeModifiers: ["alt"], modifiers: 1 },
    { name: "Shift-Command-Enter", nativeModifiers: ["shift", "meta"], modifiers: 12 },
    { name: "Shift-Control-Enter", nativeModifiers: ["shift", "control"], modifiers: 10 },
    { name: "Shift-Option-Enter", nativeModifiers: ["shift", "alt"], modifiers: 9 },
    { name: "Command-Option-Enter", nativeModifiers: ["meta", "alt"], modifiers: 5 },
    { name: "Control-Option-Enter", nativeModifiers: ["control", "alt"], modifiers: 3 }
  ];
  const nativeValues = [];
  await startSession(content, "bravo");
  for (let index = 0; index < shortcuts.length; index += 1) {
    const shortcut = shortcuts[index];
    const controlId = `tether-native-modified-enter-${index}`;
    await evaluate(`(() => {
      const control = document.createElement("textarea");
      control.id = ${JSON.stringify(controlId)};
      control.style.position = "fixed";
      control.style.left = "-10000px";
      control.value = ${JSON.stringify(content)};
      document.body.append(control);
      control.focus();
      control.setSelectionRange(${caret}, ${caret});
      return true;
    })()`);
    await dispatchNativeKey("Enter", shortcut.nativeModifiers);
    await delay(25);
    await cdp.send("Input.insertText", { text: "X" });
    nativeValues.push(await evaluate(
      `document.querySelector(${JSON.stringify(`#${controlId}`)})?.value ?? null`
    ));
    await evaluate(`document.querySelector(${JSON.stringify(`#${controlId}`)})?.remove()`);
  }
  await stopSession();

  const saveAndRead = async (expectedSource) => {
    await waitForSaveState(false);
    await dispatchKey({ key: "s", code: "KeyS", virtualKeyCode: 83, modifiers: 4 });
    await waitForCompletedSave(expectedSource);
    return readFile(samplePath, "utf8");
  };
  const mismatches = [];
  for (let index = 0; index < shortcuts.length; index += 1) {
    const shortcut = shortcuts[index];
    const expected = nativeValues[index];

    await startSession(content, "bravo");
    await placeCaretInText("bravo", 2);
    await dispatchEnterKey(shortcut.modifiers);
    await dispatchTextKey("X", "KeyX", 88);
    const proseSource = await saveAndRead(expected);
    if (proseSource !== expected) {
      mismatches.push({
        shortcut: shortcut.name,
        surface: "prose",
        expected,
        actualSource: proseSource
      });
    }
    await stopSession();

    await startSession(codeFixture, "alpha");
    await clickElement(".milkdown-code-block .cm-line:nth-child(2)");
    await dispatchKey({ key: "Home", code: "Home", virtualKeyCode: 36 });
    await dispatchKey({ key: "ArrowRight", code: "ArrowRight", virtualKeyCode: 39 });
    await dispatchKey({ key: "ArrowRight", code: "ArrowRight", virtualKeyCode: 39 });
    await dispatchEnterKey(shortcut.modifiers);
    await dispatchTextKey("X", "KeyX", 88);
    const expectedCodeSource = codeFixture.replace(content, expected);
    const codeSource = await saveAndRead(expectedCodeSource);
    if (codeSource !== expectedCodeSource) {
      mismatches.push({
        shortcut: shortcut.name,
        surface: "code",
        expectedSource: expectedCodeSource,
        actualSource: codeSource
      });
    }
    await stopSession();
  }
  if (mismatches.length) {
    throw new Error(
      `Modified Return diverged from native source controls:\n${JSON.stringify(mismatches, null, 2)}`
    );
  }
}

async function verifyPlatformNativeNavigationShortcuts() {
  const content = "alpha\nbravo\ncharlie";
  const caret = content.indexOf("bravo") + 2;
  const codeFixture = `Before.\n\n\`\`\`text\n${content}\n\`\`\`\n\nAfter.\n`;
  const baseShortcuts = [
    { name: "Home", keyCode: "Home", key: "Home", code: "Home", virtualKeyCode: 36 },
    { name: "End", keyCode: "End", key: "End", code: "End", virtualKeyCode: 35 },
    { name: "Command-ArrowLeft", keyCode: "Left", key: "ArrowLeft", code: "ArrowLeft", virtualKeyCode: 37, nativeModifiers: ["meta"], modifiers: 4 },
    { name: "Command-ArrowRight", keyCode: "Right", key: "ArrowRight", code: "ArrowRight", virtualKeyCode: 39, nativeModifiers: ["meta"], modifiers: 4 },
    { name: "Command-ArrowUp", keyCode: "Up", key: "ArrowUp", code: "ArrowUp", virtualKeyCode: 38, nativeModifiers: ["meta"], modifiers: 4 },
    { name: "Command-ArrowDown", keyCode: "Down", key: "ArrowDown", code: "ArrowDown", virtualKeyCode: 40, nativeModifiers: ["meta"], modifiers: 4 },
    { name: "Command-Home", keyCode: "Home", key: "Home", code: "Home", virtualKeyCode: 36, nativeModifiers: ["meta"], modifiers: 4 },
    { name: "Command-End", keyCode: "End", key: "End", code: "End", virtualKeyCode: 35, nativeModifiers: ["meta"], modifiers: 4 },
    { name: "Control-Home", keyCode: "Home", key: "Home", code: "Home", virtualKeyCode: 36, nativeModifiers: ["control"], modifiers: 2 },
    { name: "Control-End", keyCode: "End", key: "End", code: "End", virtualKeyCode: 35, nativeModifiers: ["control"], modifiers: 2 }
  ];
  const shortcuts = baseShortcuts.flatMap((shortcut) => [
    shortcut,
    {
      ...shortcut,
      name: `Shift-${shortcut.name}`,
      nativeModifiers: ["shift", ...(shortcut.nativeModifiers || [])],
      modifiers: (shortcut.modifiers || 0) | 8
    }
  ]);
  const nativeResults = [];

  await startSession(codeFixture, "alpha");
  for (let index = 0; index < shortcuts.length; index += 1) {
    const shortcut = shortcuts[index];
    const controlId = `tether-native-navigation-shortcut-${index}`;
    await evaluate(`(() => {
      const control = document.createElement("textarea");
      control.id = ${JSON.stringify(controlId)};
      control.style.position = "fixed";
      control.style.left = "-10000px";
      control.value = ${JSON.stringify(content)};
      document.body.append(control);
      control.focus();
      control.setSelectionRange(${caret}, ${caret});
      return true;
    })()`);
    await dispatchNativeKey(shortcut.keyCode, shortcut.nativeModifiers || []);
    await delay(25);
    const selection = await evaluate(`(() => {
      const control = document.querySelector(${JSON.stringify(`#${controlId}`)});
      return {
        start: control?.selectionStart ?? null,
        end: control?.selectionEnd ?? null,
        direction: control?.selectionDirection ?? null
      };
    })()`);
    await cdp.send("Input.insertText", { text: "x" });
    nativeResults.push({
      value: await evaluate(
        `document.querySelector(${JSON.stringify(`#${controlId}`)})?.value ?? null`
      ),
      selection
    });
    await evaluate(`document.querySelector(${JSON.stringify(`#${controlId}`)})?.remove()`);
  }
  await stopSession();

  const saveAndRead = async (expectedSource) => {
    await waitForSaveState(false);
    await dispatchKey({ key: "s", code: "KeyS", virtualKeyCode: 83, modifiers: 4 });
    await waitForCompletedSave(expectedSource);
    return readFile(samplePath, "utf8");
  };
  const dispatchNavigation = async (shortcut) => {
    await dispatchKey({
      key: shortcut.key,
      code: shortcut.code,
      virtualKeyCode: shortcut.virtualKeyCode,
      modifiers: shortcut.modifiers || 0
    });
    await delay(25);
    await dispatchTextKey("x", "KeyX", 88);
  };
  const mismatches = [];
  for (let index = 0; index < shortcuts.length; index += 1) {
    const shortcut = shortcuts[index];
    const native = nativeResults[index];

    await startSession(content, "bravo");
    await placeCaretInText("bravo", 2);
    await dispatchNavigation(shortcut);
    const proseSource = await saveAndRead(native.value);
    if (proseSource !== native.value) {
      mismatches.push({
        shortcut: shortcut.name,
        surface: "prose",
        native,
        expectedSource: native.value,
        actualSource: proseSource
      });
    }
    await stopSession();

    await startSession(codeFixture, "alpha");
    await clickElement(".milkdown-code-block .cm-line:nth-child(2)");
    await dispatchKey({ key: "Home", code: "Home", virtualKeyCode: 36 });
    await dispatchKey({ key: "ArrowRight", code: "ArrowRight", virtualKeyCode: 39 });
    await dispatchKey({ key: "ArrowRight", code: "ArrowRight", virtualKeyCode: 39 });
    await dispatchNavigation(shortcut);
    const expectedCodeSource = codeFixture.replace(content, native.value);
    const codeSource = await saveAndRead(expectedCodeSource);
    if (codeSource !== expectedCodeSource) {
      mismatches.push({
        shortcut: shortcut.name,
        surface: "code",
        native,
        expectedSource: expectedCodeSource,
        actualSource: codeSource
      });
    }
    await stopSession();
  }
  if (mismatches.length) {
    throw new Error(`Rendered navigation diverged from native source controls:\n${JSON.stringify(mismatches, null, 2)}`);
  }
}

async function verifyPlatformNativeNavigationShortcutGroup({
  label,
  content,
  activeLine,
  caretInLine,
  shortcuts
}) {
  const lineStart = content.indexOf(activeLine);
  const caret = lineStart + caretInLine;
  const codeFixture = `Before.\n\n\`\`\`text\n${content}\n\`\`\`\n\nAfter.\n`;
  const nativeResults = [];

  await startSession(codeFixture, activeLine);
  for (let index = 0; index < shortcuts.length; index += 1) {
    const shortcut = shortcuts[index];
    const controlId = `tether-native-${label.toLowerCase().replace(/\W+/g, "-")}-navigation-${index}`;
    await evaluate(`(() => {
      const control = document.createElement("textarea");
      control.id = ${JSON.stringify(controlId)};
      control.style.position = "fixed";
      control.style.left = "-10000px";
      control.value = ${JSON.stringify(content)};
      document.body.append(control);
      control.focus();
      control.setSelectionRange(${caret}, ${caret});
      return true;
    })()`);
    await dispatchNativeKey(shortcut.keyCode, shortcut.nativeModifiers);
    await delay(25);
    const selection = await evaluate(`(() => {
      const control = document.querySelector(${JSON.stringify(`#${controlId}`)});
      return {
        start: control?.selectionStart ?? null,
        end: control?.selectionEnd ?? null,
        direction: control?.selectionDirection ?? null
      };
    })()`);
    await cdp.send("Input.insertText", { text: "x" });
    nativeResults.push({
      value: await evaluate(
        `document.querySelector(${JSON.stringify(`#${controlId}`)})?.value ?? null`
      ),
      selection
    });
    await evaluate(`document.querySelector(${JSON.stringify(`#${controlId}`)})?.remove()`);
  }
  await stopSession();

  const saveAndRead = async (expectedSource) => {
    await waitForSaveState(false);
    await dispatchKey({ key: "s", code: "KeyS", virtualKeyCode: 83, modifiers: 4 });
    await waitForCompletedSave(expectedSource);
    return readFile(samplePath, "utf8");
  };
  const dispatchNavigation = async (shortcut) => {
    await dispatchKey({
      key: shortcut.key,
      code: shortcut.code,
      virtualKeyCode: shortcut.virtualKeyCode,
      modifiers: shortcut.modifiers
    });
    await delay(25);
    await dispatchTextKey("x", "KeyX", 88);
  };
  const mismatches = [];
  for (let index = 0; index < shortcuts.length; index += 1) {
    const shortcut = shortcuts[index];
    const native = nativeResults[index];

    await startSession(content, activeLine);
    await placeCaretInText(activeLine, caretInLine);
    await dispatchNavigation(shortcut);
    const proseSource = await saveAndRead(native.value);
    if (proseSource !== native.value) {
      mismatches.push({
        shortcut: shortcut.name,
        surface: "prose",
        native,
        expectedSource: native.value,
        actualSource: proseSource
      });
    }
    await stopSession();

    await startSession(codeFixture, activeLine);
    await clickElement(".milkdown-code-block .cm-line:nth-child(2)");
    await dispatchKey({ key: "Home", code: "Home", virtualKeyCode: 36 });
    for (let offset = 0; offset < caretInLine; offset += 1) {
      await dispatchKey({ key: "ArrowRight", code: "ArrowRight", virtualKeyCode: 39 });
    }
    await dispatchNavigation(shortcut);
    const expectedCodeSource = codeFixture.replace(content, native.value);
    const codeSource = await saveAndRead(expectedCodeSource);
    if (codeSource !== expectedCodeSource) {
      mismatches.push({
        shortcut: shortcut.name,
        surface: "code",
        native,
        expectedSource: expectedCodeSource,
        actualSource: codeSource
      });
    }
    await stopSession();
  }
  if (mismatches.length) {
    throw new Error(
      `Rendered ${label} navigation diverged from native source controls:\n${
        JSON.stringify(mismatches, null, 2)
      }`
    );
  }
}

async function verifyPlatformNativePlainVerticalNavigationShortcuts() {
  const content = "alpha foo-bar\nbravo baz_qux\ncharlie omega";
  const activeLine = "bravo baz_qux";
  const caretInLine = activeLine.indexOf("baz_qux") + "baz".length;
  const baseShortcuts = [
    {
      name: "ArrowUp",
      keyCode: "Up",
      key: "ArrowUp",
      code: "ArrowUp",
      virtualKeyCode: 38
    },
    {
      name: "ArrowDown",
      keyCode: "Down",
      key: "ArrowDown",
      code: "ArrowDown",
      virtualKeyCode: 40
    }
  ];
  const shortcuts = baseShortcuts.flatMap((shortcut) => [
    {
      ...shortcut,
      nativeModifiers: [],
      modifiers: 0
    },
    {
      ...shortcut,
      name: `Shift-${shortcut.name}`,
      nativeModifiers: ["shift"],
      modifiers: 8
    }
  ]);
  await verifyPlatformNativeNavigationShortcutGroup({
    label: "plain vertical",
    content,
    activeLine,
    caretInLine,
    shortcuts
  });
}

async function verifyPlatformNativeOptionNavigationShortcuts() {
  const content = "alpha foo-bar\nbravo baz_qux\ncharlie omega";
  const activeLine = "bravo baz_qux";
  const caretInLine = activeLine.indexOf("baz_qux") + "baz".length;
  const baseShortcuts = [
    {
      name: "Option-ArrowLeft",
      keyCode: "Left",
      key: "ArrowLeft",
      code: "ArrowLeft",
      virtualKeyCode: 37
    },
    {
      name: "Option-ArrowRight",
      keyCode: "Right",
      key: "ArrowRight",
      code: "ArrowRight",
      virtualKeyCode: 39
    },
    {
      name: "Option-ArrowUp",
      keyCode: "Up",
      key: "ArrowUp",
      code: "ArrowUp",
      virtualKeyCode: 38
    },
    {
      name: "Option-ArrowDown",
      keyCode: "Down",
      key: "ArrowDown",
      code: "ArrowDown",
      virtualKeyCode: 40
    }
  ];
  const shortcuts = baseShortcuts.flatMap((shortcut) => [
    {
      ...shortcut,
      nativeModifiers: ["alt"],
      modifiers: 1
    },
    {
      ...shortcut,
      name: `Shift-${shortcut.name}`,
      nativeModifiers: ["shift", "alt"],
      modifiers: 9
    }
  ]);
  await verifyPlatformNativeNavigationShortcutGroup({
    label: "Option",
    content,
    activeLine,
    caretInLine,
    shortcuts
  });

  const unicodeContent = "alpha one-two\n前言 中文测试，next_word\n尾声 omega";
  const unicodeActiveLine = "前言 中文测试，next_word";
  const unicodeCaretInLine = unicodeActiveLine.indexOf("测试");
  await verifyPlatformNativeNavigationShortcutGroup({
    label: "Unicode Option",
    content: unicodeContent,
    activeLine: unicodeActiveLine,
    caretInLine: unicodeCaretInLine,
    shortcuts: shortcuts.filter(({ key }) =>
      ["ArrowLeft", "ArrowRight"].includes(key)
    )
  });
}

async function run() {
  if (process.env.TETHER_PARITY_CASE === "external-markdown-open") {
    await verifyExternalMarkdownOpening();
    console.log("Verified cold-launch, already-running, and drag-drop Markdown opening.");
    return;
  }
  if (process.env.TETHER_PARITY_CASE === "whole-document-source-traversal") {
    await verifyWholeDocumentSourceTraversal();
    console.log("Verified continuous forward and backward selection traverses every physical Markdown source byte.");
    return;
  }
  if (process.env.TETHER_PARITY_CASE === "mixed-document-insertion-offsets") {
    await verifyMixedDocumentInsertionOffsets();
    console.log("Verified mixed rendered constructs insert at their exact physical Markdown offsets.");
    return;
  }
  if (process.env.TETHER_PARITY_CASE === "representative-document-editing") {
    await verifyRepresentativeDocumentEditingSession();
    console.log("Verified one representative document survives a continuous rendered edit, save, undo, and redo session.");
    return;
  }
  if (process.env.TETHER_PARITY_CASE === "rendered-pointer-insertion") {
    await verifyRenderedPointerInsertion();
    console.log("Verified pointer insertion inside rendered inline Markdown preserves exact source.");
    return;
  }
  if (process.env.TETHER_PARITY_CASE === "heading-source-editing") {
    await verifyHeadingSourceEditing();
    console.log("Verified heading boundary edits follow exact physical Markdown source.");
    return;
  }
  if (process.env.TETHER_PARITY_CASE === "heading-native-navigation") {
    await verifyPlatformNativeHeadingNavigation();
    console.log("Verified rendered heading navigation matches a native source textarea.");
    return;
  }
  if (process.env.TETHER_PARITY_CASE === "rendered-pointer-selection") {
    await verifyRenderedPointerSelection();
    console.log("Verified pointer selection across rendered inline Markdown preserves exact source.");
    return;
  }
  if (process.env.TETHER_PARITY_CASE === "code-native-noop-shortcuts") {
    await verifyCodeNativeNoopShortcuts();
    console.log("Verified native no-op shortcuts do not invoke CodeMirror structural commands.");
    return;
  }
  if (process.env.TETHER_PARITY_CASE === "code-native-control-shortcuts") {
    await verifyCodeNativeControlShortcuts();
    console.log("Verified macOS Control shortcuts match native source controls inside code.");
    return;
  }
  if (process.env.TETHER_PARITY_CASE === "platform-native-shortcuts") {
    await verifyPlatformNativeDocumentShortcuts();
    console.log("Verified macOS document shortcuts match native source controls.");
    return;
  }
  if (process.env.TETHER_PARITY_CASE === "platform-native-modified-enter") {
    await verifyPlatformNativeModifiedEnterShortcuts();
    console.log("Verified modified Return shortcuts against native source controls.");
    return;
  }
  if (process.env.TETHER_PARITY_CASE === "platform-native-navigation") {
    await verifyPlatformNativeNavigationShortcuts();
    console.log("Verified macOS line and document navigation match native source controls.");
    return;
  }
  if (process.env.TETHER_PARITY_CASE === "platform-native-plain-vertical-navigation") {
    await verifyPlatformNativePlainVerticalNavigationShortcuts();
    console.log("Verified plain vertical navigation matches native source controls.");
    return;
  }
  if (process.env.TETHER_PARITY_CASE === "platform-native-inline-boundary-navigation") {
    await verifyPlatformNativeInlineBoundaryNavigation();
    console.log("Verified rendered inline boundaries match native source controls.");
    return;
  }
  if (process.env.TETHER_PARITY_CASE === "platform-native-option-navigation") {
    await verifyPlatformNativeOptionNavigationShortcuts();
    console.log("Verified macOS Option navigation matches native source controls.");
    return;
  }
  if (process.env.TETHER_PARITY_CASE === "code-option-vertical-navigation") {
    await verifyCodeOptionVerticalNavigation();
    console.log("Verified Option-Up/Down navigate fenced source without reordering code lines.");
    return;
  }
  if (process.env.TETHER_PARITY_CASE === "code-shift-option-vertical-selection") {
    await verifyCodeShiftOptionVerticalSelection();
    console.log("Verified Shift-Option-Up/Down stay inert like native macOS source controls.");
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
    console.log("Verified macOS document deletion remains source-native across editor surfaces.");
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
  if (process.env.TETHER_PARITY_CASE === "code-boundary-selection") {
    await verifyCodeBoundarySelection();
    console.log("Verified extended code-boundary selections edit exact fence source.");
    return;
  }
  if (process.env.TETHER_PARITY_CASE === "platform-native-code-boundary-deletion") {
    await verifyPlatformNativeCodeBoundaryDeletion();
    console.log("Verified fenced-code Shift deletion matches native source controls.");
    return;
  }
  if (process.env.TETHER_PARITY_CASE === "code-editing-history") {
    await verifyEmptyCodeEditing();
    await verifyCodeEditing();
    console.log("Verified empty and populated fenced-code editing retain document Undo history.");
    return;
  }
  if (process.env.TETHER_PARITY_CASE === "code-ime-editing") {
    await verifyCodeImeEditing();
    console.log("Verified fenced-code IME composition preserves CRLF source and history.");
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
  if (process.env.TETHER_PARITY_CASE === "code-source-presentation") {
    await verifyCodeSourcePresentation();
    console.log("Verified active fenced source retains its rendered code-block presentation.");
    return;
  }
  if (process.env.TETHER_PARITY_CASE === "nested-code-physical-source") {
    await verifyNestedCodePhysicalSourceEditing();
    console.log("Verified nested code traverses and edits every physical container prefix.");
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
  if (process.env.TETHER_PARITY_CASE === "source-control-ime-editing") {
    await verifySourceControlImeEditing();
    console.log("Verified IME composition preserves nested CRLF headings and inline delimiters.");
    return;
  }
  if (process.env.TETHER_PARITY_CASE === "heading-source-presentation") {
    await verifyHeadingSourcePresentation();
    console.log("Verified active heading source retains its rendered visual hierarchy.");
    return;
  }
  if (process.env.TETHER_PARITY_CASE === "inline-source-presentation") {
    await verifyInlineSourcePresentation();
    console.log("Verified active inline source retains its rendered typography.");
    return;
  }
  if (process.env.TETHER_PARITY_CASE === "long-inline-source-containment") {
    await verifyLongInlineSourceContainment();
    console.log("Verified long inline Markdown source stays contained and preserves exact editing history.");
    return;
  }
  if (process.env.TETHER_PARITY_CASE === "inline-cross-boundary-selection") {
    await verifyInlineCrossBoundarySelection();
    console.log("Verified inline source selections cross rendered boundaries exactly.");
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
  if (process.env.TETHER_PARITY_CASE === "structural-enter-editing") {
    await verifyStructuralEnterEditing();
    console.log("Verified structural Return preserves heading, list, task, quote, and nested source.");
    return;
  }
  if (process.env.TETHER_PARITY_CASE === "structural-enter-edge-editing") {
    await verifyStructuralEnterEdges();
    console.log("Verified structural Return continues and exits rendered blocks at their physical source edges.");
    return;
  }
  if (process.env.TETHER_PARITY_CASE === "structural-enter-selection-editing") {
    await verifyStructuralEnterSelections();
    console.log("Verified structural Return replaces rendered selections at their physical source positions.");
    return;
  }
  if (process.env.TETHER_PARITY_CASE === "shift-enter-editing") {
    await verifyShiftEnterEditing();
    console.log("Verified Shift+Return inserts one literal source newline across rendered blocks.");
    return;
  }
  if (process.env.TETHER_PARITY_CASE === "rendered-tab-editing") {
    await verifyRenderedTabEditing();
    console.log("Verified Tab and Shift+Tab edit rendered blocks at their physical source positions.");
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
  await verifyExternalMarkdownOpening();
  await verifyWholeDocumentSourceTraversal();
  await verifyMixedDocumentInsertionOffsets();
  await verifyRepresentativeDocumentEditingSession();
  await verifyInlineEditing();
  await verifyRenderedPointerInsertion();
  await verifyHeadingSourceEditing();
  await verifyPlatformNativeHeadingNavigation();
  await verifySourceControlImeEditing();
  await verifyHeadingSourcePresentation();
  await verifyInlineSourcePresentation();
  await verifyLongInlineSourceContainment();
  await verifyRenderedPointerSelection();
  await stopSession();
  await verifyInlineBoundaryNavigation();
  await verifyPlatformNativeInlineBoundaryNavigation();
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
  await verifyCodeNativeNoopShortcuts();
  await verifyCodeNativeControlShortcuts();
  await verifyPlatformNativeDocumentShortcuts();
  await verifyPlatformNativeModifiedEnterShortcuts();
  await verifyPlatformNativeNavigationShortcuts();
  await verifyPlatformNativePlainVerticalNavigationShortcuts();
  await verifyPlatformNativeOptionNavigationShortcuts();
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
  await verifyStructuralEnterEditing();
  await verifyStructuralEnterEdges();
  await verifyStructuralEnterSelections();
  await verifyShiftEnterEditing();
  await verifyRenderedTabEditing();
  await verifyProseToCodeReplacement();
  await verifyProseToCodeCutPaste();
  await verifyCodeBoundaryDeletion();
  await verifyPlatformNativeCodeBoundaryDeletion();
  await verifyCodeToProseBackspace();
  await verifyProseToCodeDelete();
  await verifyProseToCodeDeletionHistory();
  await verifyCrlfProseToCodeDelete();
  await verifyLayeredCodeSourceHistory();
  await verifyEmptyCodeEditing();
  await verifyCodeEditing();
  await verifyCodeImeEditing();
  await stopSession();
  await verifyFenceVariantEditing();
  await verifyCodeCrlfClipboard();
  await verifyCodeBlockLayout();
  await verifyCodeSourcePresentation();
  await verifyNestedCodePhysicalSourceEditing();
  await verifyMultilineCodeBlockLayout();
  await verifyCodeLanguagePickerPresentation();
  await verifyCodeLanguagePickerSourceFidelity();
  console.log("Verified real Electron Markdown opening, source traversal, exact insertion, typing, saving, history, and fenced-code presentation.");
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
