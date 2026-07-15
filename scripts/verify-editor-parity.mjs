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
const deletedInlineMarkerFixture = "Before *bold** after.\n";
const literalSourceFixture = "Before \\*literal\\* and &copy; after.\n";
const codeFixture = "Before.\n\n```js\nconst value = 1;\n```\n\nAfter.\n";
const editedCodeFixture = "Before.\n\n```js\nconst value = 12;\n```\n\nAfter.\n";
const codeBlockSource = "```js\nconst value = 1;\n```";
const codeContent = "const value = 1;";
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
  { name: "inline math", source: "$x + y$" }
];
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
    () => evaluate(`typeof window.remoteMarkdown?.saveLocalSample === "function"`),
    "Tether native sample API did not become ready"
  );
  const seeded = await evaluate(`window.remoteMarkdown.saveLocalSample(${JSON.stringify(fixture)})`);
  if (!seeded?.ok) throw new Error(`Could not seed the isolated native sample: ${JSON.stringify(seeded)}`);
  await cdp.send("Page.reload", { ignoreCache: true });
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
  const sessionCdp = cdp;
  const sessionChild = child;
  const sessionProfilePath = profilePath;
  cdp = null;
  child = null;
  profilePath = null;
  samplePath = null;

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
    const markdown = `Before ${fixture.source} after.\n`;
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
    const markdown = `Before ${fixture.source} after.\n`;
    const forwardSource = fixture.source.slice(1);
    const forwardMarkdown = `Before ${forwardSource} after.\n`;
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
    const backwardMarkdown = `Before ${backwardSource} after.\n`;
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

async function verifyCodeBlockLayout() {
  await startSession(codeFixture, "const value = 1;");
  const geometry = await evaluate(`(() => {
    const block = document.querySelector(".milkdown-code-block");
    const tools = block?.querySelector(".tools");
    const line = block?.querySelector(".cm-line");
    const blockRect = block?.getBoundingClientRect();
    const toolsRect = tools?.getBoundingClientRect();
    const lineRect = line?.getBoundingClientRect();
    if (!blockRect || !toolsRect || !lineRect) return null;
    return {
      blockHeight: blockRect.height,
      toolsHeight: toolsRect.height,
      topToText: lineRect.top - blockRect.top,
      textToBottom: blockRect.bottom - lineRect.bottom
    };
  })()`);
  const compact = geometry
    && geometry.blockHeight >= 60
    && geometry.blockHeight <= 65
    && geometry.toolsHeight <= 24.5
    && geometry.topToText >= 28
    && geometry.topToText <= 31
    && geometry.textToBottom >= 12
    && geometry.textToBottom <= 15;
  if (!compact) throw new Error(`single-line code block spacing is imbalanced: ${JSON.stringify(geometry)}`);
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

async function run() {
  if (process.env.TETHER_PARITY_CASE === "code-jump-navigation") {
    await verifyCodeJumpNavigation();
    console.log("Verified code line, word, and document jumps traverse physical fence source.");
    return;
  }
  if (process.env.TETHER_PARITY_CASE === "code-document-jump-replacement") {
    await verifyCodeDocumentJumpReplacement();
    console.log("Verified code document-jump replacement retains exact terminal source and history.");
    return;
  }
  if (process.env.TETHER_PARITY_CASE === "code-block-layout") {
    await verifyCodeBlockLayout();
    console.log("Verified compact, balanced single-line fenced-code spacing.");
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
  await verifyCodeBoundaryNavigation();
  await verifyCodeBoundarySelection();
  await verifyCodeJumpNavigation();
  await verifyCodeDocumentJumpReplacement();
  await verifyClosingFenceReplacement();
  await verifyCodeToProseSelection();
  await verifyCodeToProseReplacement();
  await verifyProseToCodeReplacement();
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
  await verifyCodeBlockLayout();
  await verifyCodeLanguagePickerPresentation();
  await verifyCodeLanguagePickerSourceFidelity();
  console.log("Verified real Electron typing, saving, history, and fenced-code presentation.");
}

try {
  await run();
} finally {
  await stopSession();
}

// Multiple Node WebSocket sessions can leave an idle undici handle behind even
// after Electron and every isolated profile have been closed. Cleanup above is
// complete, so do not let that stale handle keep the verifier resident.
process.exit(0);
