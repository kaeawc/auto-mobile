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
});
