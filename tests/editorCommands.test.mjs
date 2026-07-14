import assert from "node:assert/strict";
import test from "node:test";
import {
  dispatchEditorHistoryCommand,
  editorHistoryShortcut,
  scheduleEditorHistoryFocusRestore
} from "../src/renderer/lib/editorCommands.js";

test("editor history shortcuts use platform-native undo and redo modifiers", () => {
  assert.deepEqual(
    editorHistoryShortcut("undo", "MacIntel"),
    {
      key: "z",
      code: "KeyZ",
      bubbles: true,
      cancelable: true,
      composed: true,
      ctrlKey: false,
      metaKey: true,
      shiftKey: false
    }
  );
  assert.equal(editorHistoryShortcut("redo", "Linux x86_64").ctrlKey, true);
  assert.equal(editorHistoryShortcut("redo", "Linux x86_64").shiftKey, true);
  assert.equal(editorHistoryShortcut("save", "MacIntel"), null);
});

test("editor history commands dispatch through the active structured editor", () => {
  let dispatchedEvent = null;
  let focusOptions = null;
  class FakeKeyboardEvent {
    constructor(type, options) {
      this.type = type;
      Object.assign(this, options);
      this.defaultPrevented = false;
    }

    preventDefault() {
      if (this.cancelable) this.defaultPrevented = true;
    }
  }
  const activeElement = {
    closest: (selector) => selector === ".ProseMirror" ? activeElement : null,
    dispatchEvent: (event) => {
      dispatchedEvent = event;
      event.preventDefault();
      return false;
    },
    focus: (options) => {
      focusOptions = options;
    },
    matches: () => false
  };
  const documentRef = {
    activeElement,
    defaultView: { KeyboardEvent: FakeKeyboardEvent },
    querySelector: () => null
  };

  assert.equal(dispatchEditorHistoryCommand("redo", documentRef, "MacIntel"), true);
  assert.equal(dispatchedEvent.type, "keydown");
  assert.equal(dispatchedEvent.metaKey, true);
  assert.equal(dispatchedEvent.shiftKey, true);
  assert.deepEqual(focusOptions, { preventScroll: true });
});

test("plain text controls retain Chromium's native undo history", () => {
  const calls = [];
  const documentRef = {
    activeElement: {
      matches: (selector) => selector === "input, textarea",
      closest: () => null
    },
    execCommand: (command) => {
      calls.push(command);
      return true;
    }
  };

  assert.equal(dispatchEditorHistoryCommand("undo", documentRef, "MacIntel"), true);
  assert.deepEqual(calls, ["undo"]);
});

test("structured history refocuses the surviving code editor when focus falls to the document shell", () => {
  const focusCalls = [];
  const shell = {};
  const nextContent = {
    closest: (selector) => selector === ".ProseMirror" ? shell : null,
    focus: (options) => focusCalls.push(options)
  };
  const nextEditor = { querySelector: () => nextContent };
  const originalEditor = {};
  const originalContent = {
    closest: (selector) => {
      if (selector === ".cm-editor") return originalEditor;
      if (selector === ".ProseMirror") return shell;
      return null;
    }
  };
  const documentRef = {
    activeElement: shell,
    body: {},
    documentElement: {},
    defaultView: { setTimeout: (callback) => callback() },
    querySelectorAll: () => [nextEditor]
  };
  // The original editor occupies the same document slot as its replacement.
  documentRef.querySelectorAll = (() => {
    let call = 0;
    return () => call++ === 0 ? [originalEditor] : [nextEditor];
  })();

  assert.equal(scheduleEditorHistoryFocusRestore(documentRef, originalContent, [0]), true);
  assert.deepEqual(focusCalls, [{ preventScroll: true }]);
});
