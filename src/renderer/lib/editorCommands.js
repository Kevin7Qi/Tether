const historyCommands = new Set(["undo", "redo"]);

export function editorHistoryShortcut(command, platform = "") {
  if (!historyCommands.has(command)) return null;
  const isMac = /Mac|iPhone|iPad|iPod/i.test(String(platform));
  return {
    key: "z",
    code: "KeyZ",
    bubbles: true,
    cancelable: true,
    composed: true,
    ctrlKey: !isMac,
    metaKey: isMac,
    shiftKey: command === "redo"
  };
}

export function scheduleEditorHistoryFocusRestore(documentRef, editorTarget, delays = [120, 600]) {
  const windowRef = documentRef?.defaultView;
  if (!documentRef || !editorTarget || typeof windowRef?.setTimeout !== "function") return false;

  const codeEditor = editorTarget.closest?.(".cm-editor");
  const editorShell = editorTarget.closest?.(".ProseMirror");
  const codeEditors = codeEditor ? [...(documentRef.querySelectorAll?.(".cm-editor") || [])] : [];
  const codeEditorIndex = codeEditor ? codeEditors.indexOf(codeEditor) : -1;
  const resolveTarget = () => {
    if (codeEditorIndex >= 0) {
      return documentRef.querySelectorAll?.(".cm-editor")?.[codeEditorIndex]?.querySelector?.(".cm-content") || null;
    }
    return editorShell?.isConnected ? editorShell : documentRef.querySelector?.(".ProseMirror-focused");
  };

  for (const delay of delays) {
    windowRef.setTimeout(() => {
      const nextTarget = resolveTarget();
      if (!nextTarget?.focus) return;
      const activeElement = documentRef.activeElement;
      const nextShell = nextTarget.closest?.(".ProseMirror");
      const focusStayedInHistorySurface = !activeElement
        || activeElement === documentRef.body
        || activeElement === documentRef.documentElement
        || activeElement === nextTarget
        || activeElement === nextShell;
      if (focusStayedInHistorySurface) nextTarget.focus({ preventScroll: true });
    }, delay);
  }
  return true;
}

export function dispatchEditorHistoryCommand(
  command,
  documentRef = globalThis.document,
  platform = globalThis.navigator?.platform || ""
) {
  const shortcut = editorHistoryShortcut(command, platform);
  if (!shortcut || !documentRef) return false;

  const activeElement = documentRef.activeElement;
  const isNativeTextControl = Boolean(
    activeElement?.matches?.("input, textarea")
      && !activeElement.closest?.(".cm-editor")
  );
  if (isNativeTextControl) {
    if (activeElement.tetherHandleHistoryCommand?.(command)) return true;
    return Boolean(documentRef.execCommand?.(command));
  }

  const focusedCodeTarget = activeElement?.closest?.(".cm-editor")?.querySelector?.(".cm-content")
    || documentRef.querySelector?.(".cm-editor.cm-focused .cm-content")
    || null;
  // The ProseMirror document is the canonical history owner. Dispatching a
  // native menu accelerator back into CodeMirror can consume an exact
  // source-spanning edit in the rebuilt code node's unrelated local history.
  // Route the command through the document shell, then restore the code caret.
  const editorTarget = activeElement?.closest?.(".ProseMirror")
    || focusedCodeTarget?.closest?.(".ProseMirror")
    || documentRef.querySelector?.(".ProseMirror-focused")
    || documentRef.querySelector?.(".ProseMirror")
    || focusedCodeTarget
    || activeElement;
  if (!editorTarget?.dispatchEvent) return false;

  const KeyboardEventConstructor = documentRef.defaultView?.KeyboardEvent || globalThis.KeyboardEvent;
  if (!KeyboardEventConstructor) return false;
  editorTarget.focus?.({ preventScroll: true });
  const event = new KeyboardEventConstructor("keydown", shortcut);
  editorTarget.dispatchEvent(event);
  scheduleEditorHistoryFocusRestore(documentRef, focusedCodeTarget || editorTarget);
  return event.defaultPrevented;
}
