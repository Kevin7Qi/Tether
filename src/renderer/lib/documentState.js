// Pure reducer for the document/editor state cluster:
//   content        - the clean base text (what was loaded/last saved)
//   editorContent  - the live textarea value
//   fileVersion    - optimistic-concurrency token for the open file
//   dirty          - editorContent diverges from content
//   conflict       - a newer remote/local version exists alongside local edits
//   remoteShadow   - that newer version, held until the user resolves
//
// Consolidating these six fields (previously six independent useState values
// mutated across ~13 handlers) into one reducer keeps the conflict/save
// invariants in a single tested place. Non-cluster effects (file metadata,
// last-refresh time, error/status, scroll capture) stay with their callers.

export function createDocumentState(initialText = "") {
  return {
    content: initialText,
    editorContent: initialText,
    fileVersion: null,
    dirty: false,
    conflict: false,
    remoteShadow: null
  };
}

export function documentReducer(state, action) {
  switch (action.type) {
    case "LOAD_FRESH": {
      // Adopt a file as the clean base (applyFreshFile, sample load, and
      // "take theirs" with file = the remote shadow). Clears dirty/conflict.
      const { file } = action;
      return {
        ...state,
        content: file.content,
        editorContent: file.content,
        fileVersion: file.version,
        dirty: false,
        conflict: false,
        remoteShadow: null
      };
    }

    case "REMOTE_UPDATE": {
      // A remote/live change arrived (applyRemoteFile). With local edits in
      // flight, stash it as a conflict shadow; otherwise adopt it in place.
      const { file } = action;
      if (state.dirty) {
        return { ...state, remoteShadow: file, conflict: true };
      }
      return {
        ...state,
        content: file.content,
        editorContent: file.content,
        fileVersion: file.version,
        remoteShadow: null,
        conflict: false
      };
    }

    case "EDIT": {
      // Textarea change. Reverting back to the base text resolves a conflict:
      // there is no longer a local divergence to reconcile.
      const { value } = action;
      const dirty = value !== state.content;
      if (!dirty && state.conflict) {
        return { ...state, editorContent: value, dirty: false, conflict: false, remoteShadow: null };
      }
      return { ...state, editorContent: value, dirty };
    }

    case "SET_TEXT": {
      // Placeholder copy ("choose a file") or clearing the document: a clean,
      // version-less base with no edits or conflict.
      const text = action.text ?? "";
      return {
        ...state,
        content: text,
        editorContent: text,
        fileVersion: null,
        dirty: false,
        conflict: false,
        remoteShadow: null
      };
    }

    case "CONFLICT_DETECTED": {
      // A save returned a *_CONFLICT: keep the local edits, hold the newer
      // remote/local version for the resolve banner.
      return { ...state, remoteShadow: action.shadow, conflict: true };
    }

    case "RESTORE": {
      // Make a previously-open tab live again: adopt its full saved cluster
      // (content, unsaved edits, version, dirty/conflict) verbatim.
      return action.doc ? { ...action.doc } : state;
    }

    default:
      return state;
  }
}
