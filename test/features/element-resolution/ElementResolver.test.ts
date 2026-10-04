import { describe, expect, test } from "bun:test";
import { ElementResolver } from "../../../src/features/utility/ElementResolver";
import { SearchableHierarchy } from "../../../src/features/utility/SearchableNode";
import { DefaultObserveElementCollector } from "../../../src/features/observe/ObserveElementCollector";
import { projectSkeleton } from "../../../src/features/observe/output/SkeletonProjection";
import { DefaultElementSelector } from "../../../src/features/utility/DefaultElementSelector";
import { iosFormsSwitch } from "../../fixtures/observe/ios-forms-switch";
import { ResolverElementSelector } from "../../../src/features/utility/ResolverElementSelector";
import type { ViewHierarchyResult } from "../../../src/models";

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

describe("Android editable hint fallback", () => {
  const field = (id: string, text: string, hint?: string, extra = {}) =>
    node(id, text, {
      class: "android.widget.EditText",
      focusable: true,
      "hint-text": hint,
      ...extra,
    });

  test("resolves a filled field by hint while retaining entered text as its label", () => {
    const result = resolver.resolve(
      snapshot([field("phone", "5551234", "Phone")]),
      { text: "Phone" },
      { action: "input" },
    );
    expect(result.chosen?.nativeId).toBe("phone");
    expect(result.chosen?.label).toBe("5551234");
    expect(result.matchMode).toBe("exact");
  });

  for (const property of ["text", "content-desc"] as const) {
    for (const visible of ["Phone", "Phone number"]) {
      test(`${property} ${visible} keeps its existing target ahead of an exact hint`, () => {
        const primary = node("visible", "", { [property]: visible });
        const before = resolver.resolve(snapshot([primary]), { text: "Phone" }, tap);
        const after = resolver.resolve(
          snapshot([
            field("hint", "5551234", "Phone", {
              bounds: { left: 0, top: 0, right: 10, bottom: 10 },
            }),
            primary,
          ]),
          { text: "Phone", selectionStrategy: "unique" },
          tap,
        );
        expect(after.chosen?.nativeId).toBe(before.chosen?.nativeId);
        expect(after.candidates.map((candidate) => candidate.nativeId)).toEqual(["visible"]);
        expect(after.matchMode).toBe(before.matchMode);
        expect(after.error).toBeUndefined();
      });
    }
  }

  test("hint exact matches precede hint substrings even when the substring is smaller", () => {
    const result = resolver.resolve(
      snapshot([
        field("substring", "123", "Phone number", {
          bounds: { left: 0, top: 0, right: 10, bottom: 10 },
        }),
        field("exact", "456", "Phone"),
      ]),
      { text: "Phone", selectionStrategy: "unique" },
      tap,
    );
    expect(result.chosen?.nativeId).toBe("exact");
    expect(result.matchMode).toBe("exact");
    expect(result.candidates).toHaveLength(1);
  });

  test("Android input-type metadata supports app-defined editable classes", () => {
    const result = resolver.resolve(
      snapshot([
        field("phone", "5551234", "Phone", {
          class: "dev.example.PhoneField",
          "input-type": "phone",
          actions: ["set_text"],
        }),
      ]),
      { text: "Phone" },
      { action: "input" },
    );
    expect(result.chosen?.nativeId).toBe("phone");
  });

  test("hint substring fallback uses the existing normalization", () => {
    const result = resolver.resolve(
      snapshot([field("phone", "5551234", "  Mobile   Phone  ")]),
      { text: "mobile phone" },
      tap,
    );
    expect(result.chosen?.nativeId).toBe("phone");
    expect(result.matchMode).toBe("exact");
    expect(
      resolver.resolve(
        snapshot([field("phone", "5551234", "Mobile Phone")]),
        { text: "phone" },
        tap,
      ).matchMode,
    ).toBe("contains");
  });

  test("hints do not make a previously unique entered-text match ambiguous", () => {
    const result = resolver.resolve(
      snapshot([field("entered", "Phone", "Phone"), field("other", "5551234", "Phone")]),
      { text: "Phone", selectionStrategy: "unique" },
      { action: "input" },
    );
    expect(result.chosen?.nativeId).toBe("entered");
    expect(result.candidates).toHaveLength(1);
    expect(result.error).toBeUndefined();
  });

  test("hint-only matches retain smallest-area and topmost-window ordering", () => {
    const fields = [
      field("large", "123", "Phone"),
      field("small", "456", "Phone", { bounds: { left: 0, top: 0, right: 10, bottom: 10 } }),
    ];
    expect(resolver.resolve(snapshot(fields), { text: "Phone" }, tap).chosen?.nativeId).toBe(
      "small",
    );
    expect(
      resolver.resolve(
        snapshot(fields, "capture", [
          { windowLayer: 10, hierarchy: { node: field("top", "789", "Phone") } },
        ]),
        { text: "Phone" },
        tap,
      ).chosen?.nativeId,
    ).toBe("top");
  });

  test("explicit match modes and case sensitivity apply to hints", () => {
    const capture = snapshot([field("phone", "5551234", "Mobile Phone")]);
    expect(resolver.resolve(capture, { text: "phone", match: "exact" }, tap).chosen).toBeNull();
    expect(
      resolver.resolve(capture, { text: "phone", caseSensitive: true }, tap).chosen,
    ).toBeNull();
    expect(
      resolver.resolve(capture, { text: "phone", match: "contains" }, tap).chosen?.nativeId,
    ).toBe("phone");
    expect(
      resolver.resolve(capture, { text: "^mobile.*phone$", match: "regex" }, tap).chosen?.nativeId,
    ).toBe("phone");
  });

  test("hints do not satisfy content-description selectors or non-editable nodes", () => {
    const capture = snapshot([field("phone", "5551234", "Phone")]);
    expect(resolver.resolve(capture, { contentDescription: "Phone" }, tap).chosen).toBeNull();
    expect(
      resolver.resolve(
        snapshot([
          node("button", "Submit", { class: "android.widget.Button", "hint-text": "Phone" }),
        ]),
        { text: "Phone" },
        tap,
      ).chosen,
    ).toBeNull();
  });

  test("fields without hints keep their existing text resolution", () => {
    const capture = snapshot([field("phone", "5551234")]);
    expect(resolver.resolve(capture, { text: "5551234" }, tap).chosen?.nativeId).toBe("phone");
    expect(resolver.resolve(capture, { text: "Phone" }, tap).chosen).toBeNull();
  });

  test("empty and whitespace hints stay absent even for regex selectors", () => {
    for (const hint of ["", " \t "]) {
      expect(
        resolver.resolve(
          snapshot([field("phone", "5551234", hint)]),
          { text: "^\\s*$", match: "regex" },
          tap,
        ).chosen,
      ).toBeNull();
    }
  });

  test("filled iOS hints keep their existing searchable-text ranking and value label", () => {
    const capture = snapshot([
      node("ios", "", {
        class: "UITextField",
        value: "5551234",
        "hint-text": "Phone",
        actions: ["set_text"],
        bounds: { left: 0, top: 0, right: 10, bottom: 10 },
      }),
      node("visible", "Phone"),
    ]);
    const result = resolver.resolve(capture, { text: "Phone" }, tap);
    expect(result.chosen?.nativeId).toBe("ios");
    expect(result.chosen?.label).toBe("5551234");
    expect(result.candidates).toHaveLength(2);
  });
});

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
  test("duplicated id-less runner view IDs report ambiguity instead of picking a peer", () => {
    for (const id of ["runner/path", "s2-short"]) {
      const capture = snapshot([
        { "view-id": id, bounds, clickable: true },
        { "view-id": id, bounds: { ...bounds, top: 120, bottom: 220 }, clickable: true },
      ]);
      const result = resolver.resolve(capture, { elementId: id }, tap);
      expect(result.chosen).toBeNull();
      expect(result.error).toContain("ambiguous");
    }
  });
  test("explicit contains ID discovery reports contains rather than exact", () => {
    const result = resolver.resolve(
      snapshot([node("app:id/map_controls")]),
      { elementId: "map", match: "contains" },
      { action: "inspect" },
    );
    expect(result.matches[0].kind).toBe("contains");
  });
  test("elementId contains-match is case-insensitive by default (#7713)", () => {
    const capture = snapshot([node("app:id/SaveButton")]);
    expect(
      resolver.resolve(capture, { elementId: "savebutton", match: "contains" }, tap).chosen
        ?.nativeId,
    ).toBe("app:id/SaveButton");
  });
  test("elementId contains-match honors explicit caseSensitive (#7713)", () => {
    const capture = snapshot([node("app:id/SaveButton")]);
    expect(
      resolver.resolve(
        capture,
        { elementId: "savebutton", match: "contains", caseSensitive: true },
        tap,
      ).chosen,
    ).toBeNull();
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
  expect(resolver.resolve(capture, { text: "Save", index: 0 }, tap).chosen?.nativeId).toBe("small");
  expect(resolver.resolve(capture, { text: "Save", index: 1 }, tap).chosen?.nativeId).toBe("large");
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

test("labels copied from skeleton resolve hoisted, whitespace-normalized, and upstream-truncated rows", () => {
  const truncated = `${"A long notification title ".repeat(7)}…`;
  const hierarchy: ViewHierarchyResult = {
    hierarchy: {
      node: [
        {
          "resource-id": "app:id/hoisted",
          clickable: true,
          bounds: { left: 0, top: 0, right: 200, bottom: 60 },
          node: [
            { text: "  Save settings  ", bounds: { left: 10, top: 10, right: 160, bottom: 30 } },
            { text: "  Now  ", bounds: { left: 10, top: 30, right: 80, bottom: 50 } },
          ],
        },
        {
          "resource-id": "app:id/spaced",
          clickable: true,
          bounds: { left: 0, top: 70, right: 200, bottom: 130 },
          node: [
            {
              text: "  Wi-Fi   and\nBluetooth  ",
              bounds: { left: 10, top: 80, right: 190, bottom: 120 },
            },
          ],
        },
        {
          "resource-id": "app:id/truncated",
          "content-desc": " details",
          clickable: true,
          bounds: { left: 0, top: 140, right: 200, bottom: 200 },
          node: [{ text: truncated, bounds: { left: 10, top: 150, right: 190, bottom: 190 } }],
        },
      ],
    },
  };
  const rows = projectSkeleton(
    new DefaultObserveElementCollector().collect(hierarchy, "android")!,
  ).skeleton;
  const capture = { id: "displayed-labels", nodes: new SearchableHierarchy().project(hierarchy) };
  const publicSelector = new ResolverElementSelector();
  for (const [id, expectedLabel] of [
    ["app:id/hoisted", "Save settings"],
    ["app:id/spaced", "Wi-Fi   and\nBluetooth"],
    ["app:id/truncated", `${truncated} details`],
  ]) {
    const displayed = rows.find((row) => row.elementId === id)?.label;
    expect(displayed).toBe(expectedLabel);
    const result = resolver.resolve(capture, { text: displayed!, match: "exact" }, tap);
    expect(result.matchMode).toBe("exact");
    expect(result.chosen?.nativeId).toBe(id);
    expect(
      publicSelector.selectByText(hierarchy, displayed!, { partialMatch: false }).element?.bounds,
    ).toEqual(result.chosen?.bounds);
  }
  expect(
    resolver.resolve(capture, { text: "Wi-Fi and Bluetooth", match: "exact" }, tap).chosen
      ?.nativeId,
  ).toBe("app:id/spaced");
  const fallback = resolver.resolve(capture, { text: "settings" }, tap);
  expect(fallback.matchMode).toBe("contains");
  expect(fallback.chosen?.nativeId).toBe("app:id/hoisted");
  expect(
    resolver.resolve(capture, { text: "settings" }, { ...tap, negative: true }).chosen,
  ).toBeNull();
});

test("a raw exact text match wins over a smaller displayed-only folded alias in its window", () => {
  const capture = snapshot([
    node("raw", "Save details", { bounds: { left: 0, top: 0, right: 200, bottom: 80 } }),
    node("folded", " details", {
      bounds: { left: 0, top: 90, right: 100, bottom: 130 },
      node: [{ text: "Save", bounds: { left: 5, top: 95, right: 50, bottom: 120 } }],
    }),
  ]);
  const result = resolver.resolve(capture, { text: "Save details" }, tap);
  expect(result.candidates.map((candidate) => candidate.nativeId)).toEqual(["raw", "folded"]);
  expect(result.chosen?.nativeId).toBe("raw");
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

describe("ensureChecked selection intent", () => {
  const settings = (label = "Wi-Fi", checkable = true): ViewHierarchyResult => ({
    hierarchy: {
      node: node("row", "Wi-Fi", {
        bounds: { left: 0, top: 826, right: 1080, bottom: 981 },
        node: checkable
          ? [
              node("switch", label, {
                checkable: true,
                checked: true,
                bounds: { left: 901, top: 840, right: 1038, bottom: 966 },
              }),
            ]
          : [],
      }),
    },
  });
  const selector = new ResolverElementSelector();
  const options = { intentAction: "inspect" as const, selectionIntent: "toggle" as const };

  test("baseline inspect tap lookup picks the labelled row", () => {
    expect(
      selector.selectByText(settings(), "Wi-Fi", {
        intentAction: "inspect",
        selectionIntent: "tap",
      }).element?.["resource-id"],
    ).toBe("row");
  });
  test("toggle intent selects the same-label switch and its checked state", () => {
    const selected = selector.selectByText(settings(), "Wi-Fi", options);
    expect(selected.element?.["resource-id"]).toBe("switch");
    expect(selected.element?.checked).toBe(true);
  });
  test("toggle intent selects an unlabelled descendant switch", () => {
    expect(selector.selectByText(settings(""), "Wi-Fi", options).element?.["resource-id"]).toBe(
      "switch",
    );
  });
  test("toggle intent without a checkable descendant still selects the row", () => {
    expect(
      selector.selectByText(settings("", false), "Wi-Fi", options).element?.["resource-id"],
    ).toBe("row");
  });
  test("the legacy selector uses the same toggle preference", () => {
    const legacy = new DefaultElementSelector();
    expect(legacy.selectByText(settings(), "Wi-Fi", options).element?.["resource-id"]).toBe(
      "switch",
    );
    expect(legacy.selectByText(settings(""), "Wi-Fi", options).element?.["resource-id"]).toBe(
      "switch",
    );
    expect(
      legacy.selectByText(settings(), "Wi-Fi", { ...options, index: 0 }).element?.["resource-id"],
    ).toBe(
      legacy.selectByText(settings(), "Wi-Fi", { selectionIntent: "tap", index: 0 }).element?.[
        "resource-id"
      ],
    );
  });
  test("exact text precedes substring toggles and narrows within exact matches", () => {
    const capture = {
      hierarchy: {
        node: [
          node("row", "Wi-Fi"),
          node("partial", "Wi-Fi backup", { checkable: true }),
          node("exact", "Wi-Fi", { checkable: true }),
        ],
      },
    };
    expect(selector.selectByText(capture, "Wi-Fi", options).element?.["resource-id"]).toBe("exact");
    const partialOnly = { hierarchy: { node: capture.hierarchy.node.slice(0, 2) } };
    expect(selector.selectByText(partialOnly, "Wi-Fi", options).element?.["resource-id"]).toBe(
      "row",
    );
  });
  for (const [name, textSelector] of [
    ["resolver", selector],
    ["legacy", new DefaultElementSelector()],
  ] as const) {
    test(`${name} toggle intent keeps the exact row when only a substring has a switch`, () => {
      const capture = {
        hierarchy: {
          node: [node("row", "Wi-Fi"), node("backup", "Wi-Fi backup", { checkable: true })],
        },
      };
      expect(textSelector.selectByText(capture, "Wi-Fi", options).element?.["resource-id"]).toBe(
        "row",
      );
    });
    test(`${name} toggle intent selects the exact row's descendant before a substring switch`, () => {
      const capture = settings("");
      capture.hierarchy.node = [
        node("backup", "Wi-Fi backup", { checkable: true }),
        capture.hierarchy.node,
      ];
      expect(textSelector.selectByText(capture, "Wi-Fi", options).element?.["resource-id"]).toBe(
        "switch",
      );
    });
    test(`${name} toggle intent uses a substring switch when there is no exact match`, () => {
      const capture = {
        hierarchy: { node: node("backup", "Wi-Fi backup", { checkable: true }) },
      };
      expect(textSelector.selectByText(capture, "Wi-Fi", options).element?.["resource-id"]).toBe(
        "backup",
      );
    });
  }
  test("toggle candidates retain window and size ordering", () => {
    const capture = settings();
    capture.windows = [
      { windowLayer: 10, hierarchy: { node: node("dialog", "Wi-Fi", { checkable: true }) } },
    ];
    expect(selector.selectByText(capture, "Wi-Fi", options).element?.["resource-id"]).toBe(
      "dialog",
    );
  });
  test("explicit index and element ID retain their targets", () => {
    expect(
      selector.selectByText(settings(), "Wi-Fi", { ...options, index: 0 }).element?.["resource-id"],
    ).toBe("row");
    expect(selector.selectByResourceId(settings(), "row", options).element?.["resource-id"]).toBe(
      "row",
    );
  });
});

test("toggle intent selects the iOS descendant control with checked state", () => {
  const result = new ResolverElementSelector().selectByText(
    iosFormsSwitch("true"),
    "Enable Notifications",
    {
      intentAction: "inspect",
      selectionIntent: "toggle",
    },
  );
  expect(result.element?.checked).toBe("true");
  expect(result.element?.bounds).toEqual({ left: 301, top: 296, right: 364, bottom: 324 });
});
