// Pure helpers for the open-document tab strip. Tabs are grouped per source
// (sourceKey) and identified by sourceKey + path, so opening the same file twice
// focuses the existing tab instead of duplicating it.

export function tabId(sourceKey, path) {
  return `${sourceKey}::${path}`;
}

export function makeTab({ sourceKey, kind, path, label, doc, metadata = null, refreshedAt = null, scrollRatio = 0 }) {
  return {
    id: tabId(sourceKey, path),
    sourceKey,
    kind,
    path,
    label,
    doc,
    metadata,
    refreshedAt,
    scrollRatio
  };
}

export function tabsForSource(tabs, sourceKey) {
  return tabs.filter((tab) => tab.sourceKey === sourceKey);
}

export function upsertTab(tabs, tab) {
  const index = tabs.findIndex((existing) => existing.id === tab.id);
  if (index < 0) return [...tabs, tab];
  const next = tabs.slice();
  next[index] = { ...next[index], ...tab };
  return next;
}

export function patchTab(tabs, id, patch) {
  return tabs.map((tab) => (tab.id === id ? { ...tab, ...patch } : tab));
}

export function removeTab(tabs, id) {
  return tabs.filter((tab) => tab.id !== id);
}

// Re-key every tab from one source to another, preserving order and per-tab
// state. Used when a browsed folder is promoted to the source root and the
// source's directory-derived key changes, so open tabs aren't orphaned.
export function rekeyTabsForSource(tabs, oldKey, newKey) {
  if (oldKey === newKey) return tabs;
  return tabs.map((tab) =>
    tab.sourceKey === oldKey ? { ...tab, sourceKey: newKey, id: tabId(newKey, tab.path) } : tab
  );
}

// Which tab should become active after `closedId` is closed: the one to its
// left within the same source, else the new leftmost, else null (none left).
export function selectNeighborTab(tabs, sourceKey, closedId) {
  const sourceTabs = tabsForSource(tabs, sourceKey);
  const index = sourceTabs.findIndex((tab) => tab.id === closedId);
  const remaining = sourceTabs.filter((tab) => tab.id !== closedId);
  if (remaining.length === 0) return null;
  if (index < 0) return remaining[0].id;
  return (remaining[index - 1] || remaining[0]).id;
}
