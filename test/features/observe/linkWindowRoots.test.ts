import { describe, expect, test } from "bun:test";
import { linkWindowRoots } from "../../../src/features/observe/linkWindowRoots";
import type { ViewHierarchyWindowInfo } from "../../../src/models/ViewHierarchyResult";

describe("linkWindowRoots truncation attribution", () => {
  test("preserves per-window reasons when linking the canonical root", () => {
    const root = { windowId: 1, text: "App" };
    const window: ViewHierarchyWindowInfo = { id: 1, truncationReasons: ["max_nodes"] };

    const linked = linkWindowRoots({ node: root }, [window]);

    expect(linked).toEqual([{ ...window, hierarchy: root }]);
    expect(linked?.[0]?.hierarchy).toBe(root);
    expect(window).toEqual({ id: 1, truncationReasons: ["max_nodes"] });
  });

  test("keeps legacy windows free of attribution keys", () => {
    const root = { windowId: 1, text: "App" };
    const windows: ViewHierarchyWindowInfo[] = [{ id: 1 }, { id: 2 }];

    const linked = linkWindowRoots({ node: root }, windows);

    expect(linked).toEqual([{ id: 1, hierarchy: root }, { id: 2 }]);
    expect(linked?.[1]).toBe(windows[1]);
    expect(JSON.stringify(linked)).not.toContain("truncationReasons");
    expect(windows).toEqual([{ id: 1 }, { id: 2 }]);
  });

  test("carries a window's own package through linking and omits it for older APKs", () => {
    const root = { windowId: 2, text: "Overlay" };
    const windows: ViewHierarchyWindowInfo[] = [
      { id: 1, type: 1 },
      { id: 2, type: 4, packageName: "dev.jasonpearson.automobile.ctrlproxy" },
    ];

    const linked = linkWindowRoots({ node: root }, windows);

    expect(linked?.[0]).toEqual({ id: 1, type: 1 });
    expect(linked?.[0]).not.toHaveProperty("packageName");
    expect(linked?.[1]).toEqual({
      id: 2,
      type: 4,
      packageName: "dev.jasonpearson.automobile.ctrlproxy",
      hierarchy: root,
    });
  });
});
