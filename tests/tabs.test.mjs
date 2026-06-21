import test from "node:test";
import assert from "node:assert/strict";
import {
  tabId,
  makeTab,
  tabsForSource,
  upsertTab,
  patchTab,
  removeTab,
  rekeyTabsForSource,
  selectNeighborTab
} from "../src/renderer/lib/tabs.js";

const doc = { content: "x", editorContent: "x", fileVersion: null, dirty: false, conflict: false, remoteShadow: null };

test("tabId and makeTab derive a stable per-source-path identity", () => {
  assert.equal(tabId("remote:deploy@edge-03:22", "/srv/a.md"), "remote:deploy@edge-03:22::/srv/a.md");
  const tab = makeTab({ sourceKey: "s", kind: "remote", path: "/a.md", label: "a.md", doc });
  assert.equal(tab.id, "s::/a.md");
  assert.equal(tab.label, "a.md");
  assert.equal(tab.scrollRatio, 0);
});

test("upsertTab adds new tabs and merges updates to existing ones", () => {
  let tabs = [];
  tabs = upsertTab(tabs, makeTab({ sourceKey: "s", kind: "remote", path: "/a.md", label: "a.md", doc }));
  tabs = upsertTab(tabs, makeTab({ sourceKey: "s", kind: "remote", path: "/b.md", label: "b.md", doc }));
  assert.equal(tabs.length, 2);
  tabs = upsertTab(tabs, { id: "s::/a.md", label: "a.md (edited)" });
  assert.equal(tabs.length, 2);
  assert.equal(tabs.find((t) => t.id === "s::/a.md").label, "a.md (edited)");
});

test("tabsForSource and removeTab scope by source", () => {
  const tabs = [
    makeTab({ sourceKey: "s1", kind: "remote", path: "/a.md", label: "a", doc }),
    makeTab({ sourceKey: "s2", kind: "local", path: "/b.md", label: "b", doc }),
    makeTab({ sourceKey: "s1", kind: "remote", path: "/c.md", label: "c", doc })
  ];
  assert.deepEqual(tabsForSource(tabs, "s1").map((t) => t.path), ["/a.md", "/c.md"]);
  assert.equal(removeTab(tabs, "s1::/a.md").length, 2);
});

test("patchTab updates only the targeted tab", () => {
  const tabs = [makeTab({ sourceKey: "s", kind: "remote", path: "/a.md", label: "a", doc, metadata: null })];
  const patched = patchTab(tabs, "s::/a.md", { metadata: { size: 10 } });
  assert.deepEqual(patched[0].metadata, { size: 10 });
});

test("rekeyTabsForSource moves a source's tabs to a new key, leaving others alone", () => {
  const tabs = [
    makeTab({ sourceKey: "local:/root", kind: "local", path: "/root/a.md", label: "a", doc }),
    makeTab({ sourceKey: "remote:x", kind: "remote", path: "/b.md", label: "b", doc }),
    makeTab({ sourceKey: "local:/root", kind: "local", path: "/root/sub/c.md", label: "c", doc })
  ];
  const moved = rekeyTabsForSource(tabs, "local:/root", "local:/root/sub");
  assert.deepEqual(
    moved.map((t) => t.id),
    ["local:/root/sub::/root/a.md", "remote:x::/b.md", "local:/root/sub::/root/sub/c.md"]
  );
  assert.equal(moved[0].sourceKey, "local:/root/sub");
  assert.equal(moved[1].sourceKey, "remote:x");
  // No-op when keys match
  assert.equal(rekeyTabsForSource(tabs, "k", "k"), tabs);
});

test("selectNeighborTab activates the left tab, then the new leftmost, then null", () => {
  const tabs = ["a", "b", "c"].map((p) => makeTab({ sourceKey: "s", kind: "remote", path: `/${p}.md`, label: p, doc }));
  // closing the middle tab -> activate the one to its left
  assert.equal(selectNeighborTab(tabs, "s", "s::/b.md"), "s::/a.md");
  // closing the first tab -> activate the new leftmost
  assert.equal(selectNeighborTab(tabs, "s", "s::/a.md"), "s::/b.md");
  // closing the only tab -> null
  assert.equal(selectNeighborTab([tabs[0]], "s", "s::/a.md"), null);
});
