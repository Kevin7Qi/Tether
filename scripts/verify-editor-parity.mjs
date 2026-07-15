import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import electronPath from "electron";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const inlineFixture = "Before **bold** after.\n";
const editedInlineFixture = "Before **boXld** after.\n";
const codeFixture = "Before.\n\n```js\nconst value = 1;\n```\n\nAfter.\n";
const editedCodeFixture = "Before.\n\n```js\nconst value = 12;\n```\n\nAfter.\n";
let child = null;
let cdp = null;
let profilePath = null;
let samplePath = null;
let electronOutput = "";

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
      text: root?.textContent || null,
      html: root?.innerHTML || null
    };
  })()`);
}

async function placeCaretInText(text, offset, rootSelector = ".ProseMirror") {
  const expected = JSON.stringify(text);
  const selector = JSON.stringify(rootSelector);
  const installed = await waitFor(
    () => evaluate(`(() => {
      const root = document.querySelector(${selector});
      if (!root) return false;
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      const nodes = [];
      let node;
      while ((node = walker.nextNode())) nodes.push(node);
      const combined = nodes.map((candidate) => candidate.data).join("");
      const start = combined.indexOf(${expected});
      if (start < 0) return false;
      const target = start + ${offset};
      let consumed = 0;
      for (const candidate of nodes) {
        const end = consumed + candidate.data.length;
        if (target <= end) {
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
      const selection = getSelection();
      if (document.activeElement !== root || !selection.anchorNode) return false;
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let consumed = 0;
      let node;
      while ((node = walker.nextNode())) {
        if (node === selection.anchorNode) break;
        consumed += node.data.length;
      }
      const combined = root.textContent || "";
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

async function dispatchKey({ key, code, virtualKeyCode, modifiers = 0 }) {
  const common = { key, code, modifiers, windowsVirtualKeyCode: virtualKeyCode };
  await cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...common });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...common });
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

async function startSession(fixture, visibleText) {
  profilePath = await mkdtemp(path.join(os.tmpdir(), "tether-editor-parity-"));
  samplePath = path.join(profilePath, "sample.md");
  electronOutput = "";
  const port = await availablePort();
  await writeFile(samplePath, fixture, "utf8");
  child = spawn(
    electronPath,
    [`--remote-debugging-port=${port}`, `--user-data-dir=${profilePath}`, root],
    {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "true" }
    }
  );
  for (const stream of [child.stdout, child.stderr]) {
    stream?.on("data", (chunk) => {
      electronOutput = `${electronOutput}${chunk}`.slice(-8000);
    });
  }

  const target = await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`);
    if (!response.ok) return null;
    const targets = await response.json();
    return targets.find((candidate) => candidate.type === "page" && candidate.url.includes("dist/index.html"));
  }, "Tether renderer did not expose a CDP target");

  cdp = new CdpSession(target.webSocketDebuggerUrl);
  await cdp.open();
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");
  await waitFor(
    () => evaluate(`Boolean(document.querySelector(".tether-wysiwyg.is-ready .ProseMirror") && !document.querySelector(".document-loading"))`),
    "Tether editor did not become ready"
  );
  await waitFor(
    () => evaluate(`document.querySelector(".ProseMirror")?.textContent.includes(${JSON.stringify(visibleText)})`),
    `fixture did not render ${JSON.stringify(visibleText)}`
  );
  await delay(200);
}

async function stopSession() {
  try {
    await cdp?.send("Browser.close");
  } catch {
    child?.kill("SIGTERM");
  }
  cdp?.close();
  cdp = null;
  await delay(200);
  child?.kill("SIGTERM");
  child = null;
  if (profilePath) await rm(profilePath, { recursive: true, force: true });
  profilePath = null;
  samplePath = null;
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

async function verifyCodeEditing() {
  await startSession(codeFixture, "const value = 1;");
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

async function run() {
  await verifyInlineEditing();
  await stopSession();
  await verifyCodeEditing();
  console.log("Verified real Electron typing, saving, and history preserve inline and fenced-code Markdown source.");
}

try {
  await run();
} finally {
  await stopSession();
}
