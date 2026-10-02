import { FakeElementParser } from "../../fakes/FakeElementParser";
import { DefaultObserveElementCollector } from "../../../src/features/observe/ObserveElementCollector";
import { describe, expect, test } from "bun:test";
import { SearchableHierarchy, toSearchable } from "../../../src/features/utility/SearchableNode";
import { foldSearchableLabels } from "../../../src/features/utility/SearchableLabels";

const bounds = { left: 0, top: 0, right: 100, bottom: 50 };

describe("searchable node derivation", () => {
  test("projects flat and nested hierarchy attributes equivalently", () => {
    const attributes = {
      class: "android.widget.Button",
      text: "Continue",
      clickable: true,
      bounds,
    };
    const projection = new SearchableHierarchy();
    const flat = projection.project({ hierarchy: { node: attributes } })[0];
    const nested = projection.project({ hierarchy: { node: { $: attributes } } })[0];

    expect(flat?.label).toBe("Continue");
    expect(nested?.label).toBe(flat?.label);
    expect(nested?.bounds).toEqual(flat?.bounds);
    expect(nested?.affordances).toEqual(flat?.affordances);
    expect(flat?.actionable).toBe(true);
    expect(nested?.actionable).toBe(true);
  });

  test("keeps native and synthetic identity distinct", () => {
    const node = toSearchable({ bounds, "resource-id": "pkg:id/save", "view-id": "s-stable" });
    expect(node.nativeId).toBe("pkg:id/save");
    expect(node.nodeKey).toBe("s-stable");
    expect(node.elementId).toBe("pkg:id/save");
    expect(toSearchable({ bounds, "view-id": "s-only" }).nativeId).toBeUndefined();
  });

  test("retains bounds-less nodes and marks them non-actionable", () => {
    const node = toSearchable({ text: "Heading", clickable: true, class: "TextView" });
    expect(node.label).toBe("Heading");
    expect(node.bounds).toBeUndefined();
    expect(node.actionable).toBe(false);
    expect(node.className).toBe("TextView");
  });

  test("captures the skeleton's trimmed label alongside the raw text field", () => {
    const node = toSearchable({ text: "  Save  ", clickable: true, bounds });
    expect(node.label).toBe("  Save  ");
    expect(node.displayedLabel).toBe("Save");
    expect(node.textFields).toEqual(["Save", "  Save  "]);
  });

  test("a trailing-space own label stays consistent with skeleton display (#6240)", () => {
    const [row] = new SearchableHierarchy().project({
      hierarchy: {
        node: {
          bounds,
          "resource-id": "bt-row",
          "content-desc": "Bluetooth ",
          clickable: true,
          node: {
            bounds: { left: 1, top: 1, right: 90, bottom: 40 },
            "resource-id": "bt-state",
            text: "Off",
          },
        },
      },
    });

    expect(row.label).toBe("Bluetooth");
    expect(row.displayedLabel).toBe("Bluetooth");
    expect(row.textFields).toContain("Off");
    expect(row.textFields).not.toContain("Off Bluetooth");
  });

  test("whitespace-only own labels fold as absent without an extra delimiter (#6240)", () => {
    expect(foldSearchableLabels({ label: " \t " }, ["Bluetooth", "Off"])).toEqual({
      label: "Bluetooth",
      sublabel: "Off",
    });
  });

  test("template folding excludes descendant labels equal to the trimmed own label (#6240)", () => {
    const [row] = new SearchableHierarchy().project({
      hierarchy: {
        node: {
          bounds,
          "content-desc": " Alarm",
          clickable: true,
          node: ["Alarm", "8:30 AM"].map((text, index) => ({
            bounds: { left: 1, top: 1 + index * 20, right: 90, bottom: 20 + index * 20 },
            text,
          })),
        },
      },
    });

    expect(row.label).toBe("8:30 AM Alarm");
    expect(row.displayedLabel).toBe("8:30 AM Alarm");
  });

  test("editable value and accessible label remain searchable", () => {
    const node = toSearchable({
      bounds,
      class: "android.widget.EditText",
      text: "placeholder",
      value: "Alice",
      "content-desc": "Name",
      focusable: true,
    });
    expect(node.label).toBe("Alice");
    expect(node.textFields).toEqual(["Alice", "placeholder", "Name"]);
    expect(node.affordances).toContain("input");
    expect(node.focusable).toBe(true);
  });

  test("does not expose an editable hint as searchable label or text", () => {
    const node = toSearchable({
      bounds,
      class: "android.widget.EditText",
      focusable: true,
      "hint-text": "Email",
    });
    expect(node.label).toBeUndefined();
    expect(node.textFields).toEqual([]);
    expect(node.textSources).toEqual({});
  });

  test("exposes an iOS text field placeholder as a searchable label", () => {
    const node = toSearchable({
      bounds,
      class: "UITextField",
      "hint-text": "Name",
      actions: ["set_text"],
    });
    expect(node.label).toBe("Name");
    expect(node.textFields).toContain("Name");
    expect(node.textSources["hint-text"]).toBe("Name");
  });

  test("keeps category text separate from editable display value", () => {
    const node = toSearchable({
      bounds,
      class: "android.widget.EditText",
      text: "placeholder",
      value: "Alice",
    });
    expect(node.categoryText).toBe("placeholder");
    expect(node.categories.text).toBe(true);
  });

  test("includes an iOS accessibility-only label in observable text", () => {
    const hierarchy = {
      hierarchy: {
        node: {
          bounds,
          clickable: true,
          node: [{ bounds, "ios-accessibility-label": "Open details" }],
        },
      },
    };
    const searchable = toSearchable({ bounds, "ios-accessibility-label": "Open details" });
    expect(searchable.categoryText).toBe("Open details");
    const observed = new DefaultObserveElementCollector().collect(hierarchy, "ios")!;
    expect(
      observed.text?.some((entry) => entry["ios-accessibility-label"] === "Open details"),
    ).toBe(true);
  });

  test("whitespace text does not mask an accessibility label", () => {
    expect(toSearchable({ text: "  ", "ios-accessibility-label": "Open" }).categoryText).toBe(
      "Open",
    );
  });

  test("unifies compact bounds and accessibility actions", () => {
    const node = toSearchable({
      bounds: [1, 2, 3, 4],
      actions: ["click", "long_click"],
      scrollable: "true",
    });
    expect(node.bounds).toEqual({ left: 1, top: 2, right: 3, bottom: 4 });
    expect(node.affordances).toEqual(["tap", "long-press", "scroll"]);
  });
});

test("capture projection retains unbounded ancestry, ranks windows and memoizes per capture", () => {
  const capture = {
    hierarchy: { node: { text: "Continue", node: [{ bounds, text: "Child" }] } },
    windows: [{ windowLayer: 10, hierarchy: { node: { bounds, text: "Dialog" } } }],
  };
  const projection = new SearchableHierarchy();
  const nodes = projection.project(capture);
  expect(nodes).toHaveLength(3);
  expect(nodes[0].label).toBe("Continue");
  expect(nodes[0].element).toBeUndefined();
  expect(nodes[1].parentIndex).toBe(0);
  expect(nodes[2].windowRank).toBeLessThan(nodes[0].windowRank);
  expect(projection.project(capture)).toBe(nodes);
  expect(projection.project({ ...capture })).not.toBe(nodes);
});

test("collector calls do not share mutable output descriptors", () => {
  const collector = new DefaultObserveElementCollector();
  const capture = { hierarchy: { node: { bounds, text: "Original", clickable: true } } };
  const first = collector.collect(capture, "android")!;
  first.clickable![0].text = "Changed by caller";
  const second = collector.collect(capture, "android")!;
  expect(second.clickable![0].text).toBe("Original");
  expect(second.clickable![0]).not.toBe(first.clickable![0]);
});

test("collector output bounds cannot mutate cached compact capture bounds", () => {
  const collector = new DefaultObserveElementCollector();
  const capture = {
    hierarchy: { node: { bounds: [0, 0, 100, 50], text: "Original", clickable: true } },
  };
  const first = collector.collect(capture, "android")!;
  first.clickable![0].bounds.left = 99;
  expect(collector.collect(capture, "android")!.clickable![0].bounds.left).toBe(0);
});

test("minimal parsed descriptors retain raw observe categories", () => {
  const parser = new FakeElementParser();
  parser.nextNodeProperties = { clickable: true, scrollable: true, text: "Go" };
  parser.nextParsedNode = { bounds };
  const capture = { hierarchy: { node: { bounds } } };
  const elements = new DefaultObserveElementCollector(parser).collect(capture, "android")!;
  expect(elements.clickable).toHaveLength(1);
  expect(elements.scrollable).toHaveLength(1);
  expect(elements.text).toHaveLength(1);
  expect(elements.text![0]).toEqual({ bounds });
});

test("minimal parsed descriptors retain all raw searchable metadata and normalized bounds", () => {
  const parser = new FakeElementParser();
  parser.nextNodeProperties = {
    "resource-id": "pkg:id/go",
    text: "Go",
    class: "Button",
    clickable: true,
  };
  parser.nextParsedNode = { bounds };
  const [entry] = new SearchableHierarchy(parser).project({ hierarchy: { node: { bounds } } });
  expect(entry.nativeId).toBe("pkg:id/go");
  expect(entry.elementId).toBe("pkg:id/go");
  expect(entry.label).toBe("Go");
  expect(entry.textFields).toEqual(["Go"]);
  expect(entry.className).toBe("Button");
  expect(entry.affordances).toContain("tap");
  expect(entry.actionable).toBe(true);
  expect(entry.bounds).toEqual(bounds);
  expect(entry.element).toEqual({ bounds });
});

test("collector output nested fields cannot mutate a cached capture", () => {
  const collector = new DefaultObserveElementCollector();
  const capture = {
    hierarchy: {
      node: {
        bounds,
        text: "Original",
        actions: [],
        extras: { nested: { label: "Original" } },
        "semantic-links": [{ text: "Original", occurrence: 0 }],
      },
    },
  };
  const first = collector.collect(capture, "android")!.text![0];
  first.actions.push("click");
  first.extras.nested.label = "Changed";
  first["semantic-links"]![0].text = "Changed";
  const second = collector.collect(capture, "android")!;
  expect(second.text![0].actions).toEqual([]);
  expect(second.text![0].extras.nested.label).toBe("Original");
  expect(second.text![0]["semantic-links"]![0].text).toBe("Original");
  expect(second.clickable).toHaveLength(0);
});

test("searchable class identity accepts className while preferring class", () => {
  expect(toSearchable({ bounds, className: "XCUIElementTypeTextField" }).className).toBe(
    "XCUIElementTypeTextField",
  );
  expect(toSearchable({ bounds, class: "Primary", className: "Alias" }).className).toBe("Primary");
});
