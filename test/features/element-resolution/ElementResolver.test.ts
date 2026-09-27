import { describe, expect, test } from "bun:test";
import { ElementResolver } from "../../../src/features/utility/ElementResolver";
import { SearchableHierarchy } from "../../../src/features/utility/SearchableNode";

const bounds = { left: 0, top: 0, right: 100, bottom: 100 };
const node = (id: string, text = "", extra = {}) => ({
  "resource-id": id,
  text,
  bounds,
  clickable: true,
  ...extra,
});
const snapshot = (nodes: unknown[], id = "capture-1", windows?: any[]) => ({
  id,
  nodes: new SearchableHierarchy().project({ hierarchy: { node: nodes }, windows } as any),
});
const resolver = new ElementResolver(() => 0.9);
const tap = { action: "tap" as const };

describe("pure element resolver", () => {
  test("full IDs are exact and bare IDs use namespace matching, never substrings", () => {
    const capture = snapshot([node("app:id/btn_login_help"), node("app:id/btn_login")]);
    expect(resolver.resolve(capture, { elementId: "btn_login" }, tap).chosen?.nativeId).toBe(
      "app:id/btn_login",
    );
    expect(
      resolver.resolve(capture, { elementId: "app:id/btn_login" }, tap).candidates,
    ).toHaveLength(1);
    expect(resolver.resolve(capture, { elementId: "login" }, tap).chosen).toBeNull();
  });
  test("ambiguous bare IDs list packages and refuse a target", () => {
    const result = resolver.resolve(
      snapshot([node("one:id/map"), node("two:id/map")]),
      { elementId: "map" },
      tap,
    );
    expect(result.chosen).toBeNull();
    expect(result.error).toContain("one:id/map");
    expect(result.error).toContain("two:id/map");
  });
  test("qualified ID takes precedence over bare Compose compatibility fallback", () => {
    const capture = snapshot([node("map"), node("app:id/map")]);
    expect(resolver.resolve(capture, { elementId: "app:id/map" }, tap).chosen?.nativeId).toBe(
      "app:id/map",
    );
    expect(
      resolver.resolve(snapshot([node("map")]), { elementId: "app:id/map" }, tap).chosen?.nativeId,
    ).toBe("map");
  });
  test("exact bare native ID takes precedence over a qualified suffix peer", () => {
    const capture = snapshot([node("app:id/save"), node("save")]);
    const result = resolver.resolve(capture, { elementId: "save" }, tap);
    expect(result.chosen?.nativeId).toBe("save");
    expect(result.candidates.map((candidate) => candidate.nativeId)).toEqual(["save"]);
  });
  test("text is normalized exact first, then contains only when exact is absent", () => {
    const capture = snapshot([
      node("help", "Don't continue help"),
      node("exact", "Don’t continue"),
    ]);
    expect(resolver.resolve(capture, { text: "Don't continue" }, tap).chosen?.nativeId).toBe(
      "exact",
    );
    expect(resolver.resolve(capture, { text: "continue" }, tap).matchMode).toBe("contains");
    expect(
      resolver.resolve(capture, { text: "continue" }, { ...tap, negative: true }).chosen,
    ).toBeNull();
  });
  test("a wait can reuse its initially selected match mode", () => {
    const first = resolver.resolve(
      snapshot([node("a", "Continue now")]),
      { text: "Continue" },
      tap,
    );
    const later = resolver.resolve(
      snapshot([node("a", "Continue now"), node("b", "Continue")]),
      { text: "Continue" },
      { ...tap, matchMode: first.matchMode },
    );
    expect(later.candidates).toHaveLength(2);
  });
  test("windows rank before area, index and injected random use the same ranked list", () => {
    const capture = snapshot([node("main", "Open")], "c", [
      { windowLayer: 10, hierarchy: { node: [node("dialog", "Open")] } },
    ]);
    expect(resolver.resolve(capture, { text: "Open" }, tap).chosen?.nativeId).toBe("dialog");
    expect(resolver.resolve(capture, { text: "Open", index: 1 }, tap).chosen?.nativeId).toBe(
      "main",
    );
    expect(
      resolver.resolve(capture, { text: "Open", selectionStrategy: "random" }, tap).chosen
        ?.nativeId,
    ).toBe("main");
  });
  test("synthetic keys do not become native IDs and bounds-less matches stay diagnostic", () => {
    const capture = snapshot([{ "view-id": "s-stable", text: "Continue" }]);
    expect(
      resolver.resolve(capture, { elementId: "s-stable" }, { action: "inspect" }).candidates,
    ).toHaveLength(1);
    expect(resolver.resolve(capture, { elementId: "s-stable" }, tap).chosen).toBeNull();
    expect(
      resolver.resolve(
        capture,
        { elementId: "s-stable" },
        { action: "inspect", requireResourceId: true },
      ).chosen,
    ).toBeNull();
  });
  test("explicit contains ID discovery reports contains rather than exact", () => {
    const result = resolver.resolve(
      snapshot([node("app:id/map_controls")]),
      { elementId: "map", match: "contains" },
      { action: "inspect" },
    );
    expect(result.matches[0].kind).toBe("contains");
  });
  test("container scopes use ancestry rather than matching IDs on another peer", () => {
    const capture = snapshot([
      node("container", "", { node: [node("target", "One")] }),
      node("target", "Outside"),
    ]);
    const result = resolver.resolve(
      capture,
      { elementId: "target", container: { elementId: "container" } },
      tap,
    );
    expect(result.chosen?.label).toBe("One");
  });
});

test("text labels resolve to the owning actionable row for tap and highlight", () => {
  const capture = snapshot([
    node("row", "", {
      node: [{ bounds: { left: 5, top: 5, right: 30, bottom: 20 }, text: "Wi-Fi" }],
    }),
  ]);
  expect(resolver.resolve(capture, { text: "Wi-Fi" }, tap).chosen?.nativeId).toBe("row");
  expect(
    resolver.resolve(capture, { text: "Wi-Fi" }, { action: "highlight" }).chosen?.nativeId,
  ).toBe("row");
});

test("default selection keeps smallest eligible area within the topmost window", () => {
  const capture = snapshot([
    node("large", "Save"),
    node("small", "Save", { bounds: { left: 0, top: 0, right: 20, bottom: 20 } }),
  ]);
  expect(resolver.resolve(capture, { text: "Save" }, tap).chosen?.nativeId).toBe("small");
  expect(resolver.resolve(capture, { text: "Save", index: 0 }, tap).chosen?.nativeId).toBe("large");
});

test("newer captures require matching identity proof for references", () => {
  const capture = snapshot([node("app:id/a", "Original", { "view-id": "s-a" })]);
  const ref = {
    snapshotId: capture.id,
    nodeKey: "s-a",
    nativeId: "app:id/a",
    label: "Original",
    bounds,
  };
  expect(resolver.resolve(capture, { elementId: "s-a" }, { ...tap, ref }).chosen).not.toBeNull();
  const same = snapshot([node("app:id/a", "Original", { "view-id": "s-a" })], "capture-2");
  expect(resolver.resolve(same, { elementId: "s-a" }, { ...tap, ref }).chosen).not.toBeNull();
  const recycled = snapshot([node("app:id/a", "Changed", { "view-id": "s-a" })], "capture-2");
  expect(resolver.resolve(recycled, { elementId: "s-a" }, { ...tap, ref }).error).toContain(
    "Stale reference",
  );
});

test("explicit index retains the shared ranked actionable rows across intents", () => {
  const capture = snapshot([
    node("label", "Buy milk"),
    node("input", "Buy milk", { class: "android.widget.EditText", focusable: true }),
  ]);
  const result = resolver.resolve(capture, { text: "Buy milk", index: 1 }, { action: "input" });
  expect(result.candidates.map((entry) => entry.nativeId)).toEqual(["label", "input"]);
  expect(result.chosen?.nativeId).toBe("input");
  expect(result.matches).toHaveLength(2);
  expect(
    resolver.resolve(capture, { text: "Buy milk", index: 0 }, { action: "input" }).chosen,
  ).toBeNull();
});

test("the folded and trimmed displayed label resolves exactly to its row", () => {
  const capture = snapshot([
    node("alarm", " Alarm", {
      node: [
        { text: "8:30 AM", bounds: { left: 0, top: 0, right: 30, bottom: 20 } },
        { text: "Weekdays", bounds: { left: 0, top: 20, right: 30, bottom: 40 } },
      ],
    }),
  ]);
  const result = resolver.resolve(capture, { text: "8:30 AM Alarm", match: "exact" }, tap);
  expect(result.chosen?.nativeId).toBe("alarm");
  expect(result.chosen?.label).toBe("8:30 AM Alarm");
  expect(result.matchMode).toBe("exact");
});

test("sibling scope stays in the anchor's nearest row", () => {
  const capture = snapshot([
    { bounds, node: [node("label", "First", { clickable: false }), node("remove", "Remove")] },
    { bounds, node: [node("label", "Second", { clickable: false }), node("remove", "Remove")] },
  ]);
  const result = resolver.resolve(
    capture,
    { elementId: "remove", sibling: { text: "Second" } },
    tap,
  );
  expect(result.chosen?.index).toBe(5);
});

test("qualified native IDs take precedence over colliding node keys", () => {
  const capture = snapshot([
    node("app:id/go"),
    { "view-id": "app:id/go", bounds: { left: 0, top: 0, right: 1, bottom: 1 }, clickable: true },
  ]);
  expect(resolver.resolve(capture, { elementId: "app:id/go" }, tap).chosen?.nativeId).toBe(
    "app:id/go",
  );
});

test("a newer reference without identity evidence is stale", () => {
  const capture = snapshot([{ "view-id": "same" }], "new");
  expect(
    resolver.resolve(
      capture,
      { elementId: "same" },
      { action: "inspect", ref: { snapshotId: "old", nodeKey: "same" } },
    ).error,
  ).toContain("Stale");
});

test("one source in main and a window is counted once at topmost rank", () => {
  const shared = node("shared", "Open");
  const capture = snapshot([shared], "c", [{ windowLayer: 10, hierarchy: { node: [shared] } }]);
  const result = resolver.resolve(capture, { text: "Open" }, tap);
  expect(result.candidates).toHaveLength(1);
  expect(result.chosen?.windowRank).toBe(0);
});

test("blank text never falls back to matching everything", () => {
  expect(
    resolver.resolve(snapshot([node("a", "Anything")]), { text: "   " }, tap).chosen,
  ).toBeNull();
});

test("long-press intent promotes to a long-clickable ancestor", () => {
  const capture = snapshot([
    node("long", "", {
      clickable: false,
      "long-clickable": true,
      node: [{ text: "Hold", bounds }],
    }),
  ]);
  expect(
    resolver.resolve(capture, { text: "Hold" }, { action: "long-press" }).chosen?.nativeId,
  ).toBe("long");
});

test("sibling matching never escapes a row into a non-scrollable collection", () => {
  const capture = snapshot([
    {
      bounds,
      class: "androidx.recyclerview.widget.RecyclerView",
      node: [
        node("first-row", "", { node: [node("label", "First", { clickable: false })] }),
        node("second-row", "", { node: [node("remove", "Remove")] }),
      ],
    },
  ]);
  for (const sibling of [{ text: "First" }, { elementId: "label" }]) {
    expect(resolver.resolve(capture, { elementId: "remove", sibling }, tap).chosen).toBeNull();
  }
});

test("XCUI tables prevent sibling traversal into another cell", () => {
  const capture = snapshot([
    {
      bounds,
      class: "XCUIElementTypeTable",
      node: [
        node("first-row", "", { node: [node("label", "First", { clickable: false })] }),
        node("second-row", "", { node: [node("remove", "Remove")] }),
      ],
    },
  ]);
  expect(
    resolver.resolve(capture, { elementId: "remove", sibling: { text: "First" } }, tap).chosen,
  ).toBeNull();
});

test("non-scrollable ViewPager prevents sibling traversal into another page", () => {
  const capture = snapshot([
    {
      bounds,
      class: "androidx.viewpager.widget.ViewPager",
      node: [
        node("first-page", "", { node: [node("label", "First", { clickable: false })] }),
        node("second-page", "", { node: [node("remove", "Remove")] }),
      ],
    },
  ]);
  expect(
    resolver.resolve(capture, { elementId: "remove", sibling: { text: "First" } }, tap).chosen,
  ).toBeNull();
});

test("content-description indices count actionable rows after promotion", () => {
  const capture = snapshot([
    node("first-row", "", {
      node: [
        { bounds, "content-desc": "Label" },
        { bounds, "content-desc": "Label" },
      ],
    }),
    node("second-row", "", { node: [{ bounds, "content-desc": "Label" }] }),
  ]);
  expect(
    resolver.resolve(capture, { contentDescription: "Label", index: 1 }, tap).chosen?.nativeId,
  ).toBe("second-row");
});

test("nested label text and ID have the same sibling control", () => {
  const capture = snapshot([
    {
      bounds,
      node: [
        { bounds, node: [node("label", "First", { clickable: false })] },
        node("remove", "Remove"),
      ],
    },
  ]);
  for (const sibling of [{ text: "First" }, { elementId: "label" }]) {
    expect(resolver.resolve(capture, { elementId: "remove", sibling }, tap).chosen?.nativeId).toBe(
      "remove",
    );
  }
});

test("text index counts displayed actionable rows rather than standalone text", () => {
  const capture = snapshot([
    node("label", "Row", { clickable: false }),
    node("first", "Row"),
    node("second", "Row", { bounds: { left: 0, top: 0, right: 20, bottom: 20 } }),
    node("third", "Row"),
  ]);
  expect(resolver.resolve(capture, { text: "Row", index: 2 }, tap).chosen?.nativeId).toBe("third");
  expect(resolver.resolve(capture, { text: "Row" }, tap).chosen?.nativeId).toBe("second");
});

test("scroll text indices count scroll rows rather than inert labels", () => {
  const capture = snapshot([
    { bounds, scrollable: true, text: "Feed", node: [{ bounds, text: "Feed" }] },
    { bounds, scrollable: true, text: "Feed", node: [{ bounds, text: "Feed" }] },
  ]);
  const result = resolver.resolve(capture, { text: "Feed", index: 1 }, { action: "scroll" });
  expect(result.candidates).toHaveLength(2);
  expect(result.chosen?.index).toBe(2);
});

test("sibling search never enters a nested collection", () => {
  const capture = snapshot([
    {
      bounds,
      node: [
        { bounds, text: "Header" },
        {
          bounds,
          class: "android.widget.GridView",
          node: [{ bounds, "resource-id": "nested", clickable: true }],
        },
      ],
    },
  ]);
  expect(
    resolver.resolve(capture, { elementId: "nested", sibling: { text: "Header" } }, tap).chosen,
  ).toBeNull();
});

test("contains matching uses the advertised synthetic view ID", () => {
  const capture = snapshot([{ bounds, clickable: true, "view-id": "s-stable-123" }]);
  expect(
    resolver.resolve(capture, { elementId: "stable", match: "contains" }, tap).chosen?.nodeKey,
  ).toBe("s-stable-123");
});
