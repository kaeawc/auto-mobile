import { expect, describe, test, beforeEach } from "bun:test";
import fc from "fast-check";
import { readFileSync } from "node:fs";
import { Element, ViewHierarchyResult, ViewHierarchyNode } from "../../../src/models";
import { DefaultElementParser } from "../../../src/features/utility/ElementParser";
import type { ElementParser } from "../../../src/utils/interfaces/ElementParser";
import {
  extractNavigationElements,
  enrichElementWithChildProperties,
  extractScrollableContainers,
  isNavigationCandidate,
  extractAllElements,
  getElementKey,
  filterUnexhaustedElements,
  tapSelectorFor,
} from "../../../src/features/navigation/ExploreElementExtraction";
import { ResolverElementSelector } from "../../../src/features/utility/ResolverElementSelector";
import type { ElementSelector } from "../../../src/utils/interfaces/ElementSelector";
import type { TrackedElement } from "../../../src/features/navigation/ExploreTypes";
import { isLoginScreen } from "../../../src/features/navigation/ExploreBlockerDetection";

describe("ExploreElementExtraction", () => {
  let elementParser: ElementParser;

  beforeEach(() => {
    elementParser = new DefaultElementParser();
  });

  function createMockElement(overrides: Partial<Element> = {}): Element {
    return {
      bounds: { left: 0, top: 0, right: 100, bottom: 50 },
      clickable: true,
      enabled: true,
      text: "Button",
      class: "android.widget.Button",
      "resource-id": "com.test:id/button",
      ...overrides,
    } as Element;
  }

  function createMockViewHierarchy(
    nodes: ViewHierarchyNode[] = [],
    packageName: string = "com.test.app",
  ): ViewHierarchyResult {
    return {
      hierarchy: {
        node: nodes,
      },
      packageName,
    };
  }

  function createMockNode(overrides: Partial<ViewHierarchyNode["$"]> = {}): ViewHierarchyNode {
    const defaults = {
      $: {
        class: "android.widget.Button",
        text: "Button",
        "resource-id": "com.test:id/button",
        clickable: "true",
        enabled: "true",
        bounds: { left: 0, top: 0, right: 100, bottom: 50 },
      },
    };

    return {
      $: { ...defaults.$, ...overrides },
      bounds: { left: 0, top: 0, right: 100, bottom: 50 },
    };
  }

  describe("tapSelectorFor", () => {
    for (const nested of [false, true]) {
      test(`recovers ${nested ? "grandchild" : "child"} text from a flattened clickable parent`, () => {
        const child = createMockNode({ text: "Skip", clickable: "false", "resource-id": "" });
        child.bounds = { left: 20, top: 10, right: 80, bottom: 40 };
        const wrapper = createMockNode({
          text: "",
          class: "",
          clickable: "false",
          "resource-id": "",
        });
        wrapper.node = [child];
        const parent = createMockNode({ text: "", class: "", "resource-id": "" });
        parent.node = [nested ? wrapper : child];
        const hierarchy = createMockViewHierarchy([parent]);
        const [element] = extractNavigationElements(hierarchy, elementParser);

        expect(element.node).toBeUndefined();
        expect(tapSelectorFor(element, hierarchy)).toEqual({ text: "Skip" });
        // The resolver promotes the non-clickable label to its clickable owner (#10268).
        const selected = new ResolverElementSelector().selectByText(hierarchy, "Skip");
        expect(selected.element?.bounds).toEqual(parent.bounds);
        expect(selected.element?.clickable).toBe("true");
      });
    }

    test("recovers selectors from the existing Playground Compose capture", () => {
      const capture: { viewHierarchy: ViewHierarchyResult } = JSON.parse(
        readFileSync(
          new URL(
            "../../fixtures/android-focus/playground-text-field-pre-tap.json",
            import.meta.url,
          ),
          "utf8",
        ),
      );
      const elements = extractNavigationElements(capture.viewHierarchy, elementParser);
      for (const text of ["Tap", "Demos", "Slides", "Settings"]) {
        const candidate = elements.find((element) => element.text === text);
        expect(candidate).toBeDefined();
        const target = tapSelectorFor(candidate!, capture.viewHierarchy);
        expect(target).toHaveProperty("text", text);
        const selected = new ResolverElementSelector().selectByText(
          capture.viewHierarchy,
          text,
          target ?? {},
        );
        expect(selected.element).toBeDefined();
        expect(selected.element!.bounds.left).toBeGreaterThanOrEqual(candidate!.bounds.left);
        expect(selected.element!.bounds.right).toBeLessThanOrEqual(candidate!.bounds.right);
        expect(selected.element!.bounds.top).toBeGreaterThanOrEqual(candidate!.bounds.top);
        expect(selected.element!.bounds.bottom).toBeLessThanOrEqual(candidate!.bounds.bottom);
      }
    });

    test("indexes repeated descendant labels by subtree identity", () => {
      const parents = [0, 1].map((index) => {
        const parent = createMockNode({ text: "", class: "", "resource-id": "" });
        parent.bounds = { left: 0, top: index * 100, right: 100, bottom: index * 100 + 50 };
        const child = createMockNode({ text: "Next", clickable: "false", "resource-id": "" });
        child.bounds = { left: 20, top: index * 100 + 10, right: 80, bottom: index * 100 + 40 };
        parent.node = [child];
        return parent;
      });
      const hierarchy = createMockViewHierarchy(parents);
      const elements = extractNavigationElements(hierarchy, elementParser);
      const selector = new ResolverElementSelector();
      for (const [index, element] of elements.entries()) {
        expect(tapSelectorFor(element, hierarchy)).toEqual({ text: "Next", index });
        expect(selector.selectByText(hierarchy, "Next", { index }).element?.bounds).toEqual(
          parents[index].bounds,
        );
        expect(getElementKey(element, hierarchy)).toBe(`sel-text:Next#${index}`);
      }
    });

    test("keeps Skip and Next independently tracked after enrichment", () => {
      const parents = ["Skip", "Next"].map((text, index) => {
        const parent = createMockNode({ text: "", class: "", "resource-id": "" });
        parent.bounds = { left: index * 100, top: 0, right: index * 100 + 100, bottom: 50 };
        parent.node = [createMockNode({ text, clickable: "false", "resource-id": "" })];
        return parent;
      });
      const hierarchy = createMockViewHierarchy(parents);
      const elements = extractNavigationElements(hierarchy, elementParser);
      expect(elements.map((element) => getElementKey(element, hierarchy))).toEqual([
        "sel-text:Skip",
        "sel-text:Next",
      ]);
      expect(getElementKey(elements[0])).not.toBe(getElementKey(elements[1]));
    });

    for (const own of [
      { text: "Own text", "resource-id": "" },
      { text: "", "resource-id": "own-id" },
      { text: "", "resource-id": "", "content-desc": "Own description" },
    ]) {
      test(`preserves own selector and key for ${JSON.stringify(own)}`, () => {
        const parent = createMockNode({ ...own, class: "" });
        const hierarchy = createMockViewHierarchy([parent]);
        const [before] = extractNavigationElements(hierarchy, elementParser);
        const originalSelector = tapSelectorFor(before, hierarchy);
        const originalKey = getElementKey(before, hierarchy);
        const originalUnscopedKey = getElementKey(before);
        parent.node = [
          createMockNode({ text: "Child text", clickable: "false", "resource-id": "" }),
        ];
        const [after] = extractNavigationElements(hierarchy, elementParser);
        expect(tapSelectorFor(after, hierarchy)).toEqual(originalSelector);
        expect(getElementKey(after, hierarchy)).toBe(originalKey);
        expect(getElementKey(after)).toBe(originalUnscopedKey);
      });
    }

    function screenHierarchy(nodes: ViewHierarchyNode[]): ViewHierarchyResult {
      return { ...createMockViewHierarchy(nodes), screenWidth: 1080, screenHeight: 2400 };
    }

    function boundedNode(
      overrides: Partial<ViewHierarchyNode["$"]>,
      bounds: ViewHierarchyNode["bounds"],
    ): ViewHierarchyNode {
      return { ...createMockNode({ ...overrides, bounds }), bounds };
    }

    test("does not hand an off-screen element a selector that only matches a visible twin", () => {
      const offscreen = { left: 0, top: 3000, right: 100, bottom: 3050 };
      const hierarchy = screenHierarchy([
        boundedNode({ text: "Save", "resource-id": "off" }, offscreen),
        boundedNode(
          { text: "Save", "resource-id": "visible" },
          { ...offscreen, top: 0, bottom: 50 },
        ),
        boundedNode({ text: "Save", "resource-id": "" }, { ...offscreen, top: 3100, bottom: 3150 }),
      ]);
      const [off, visible, unlabelled] = extractNavigationElements(hierarchy, elementParser);

      // Its own id has no on-screen match, so it cannot reach the visible control.
      expect(tapSelectorFor(off, hierarchy)).toEqual({ elementId: "off" });
      expect(tapSelectorFor(visible, hierarchy)).toEqual({ elementId: "visible" });
      // Only the text is left, and every on-screen match is another control.
      expect(tapSelectorFor(unlabelled, hierarchy)).toBeNull();
    });

    test("keeps occurrence indices for repeated scroll-only containers", () => {
      const list = { class: "android.widget.ListView", text: "List", "resource-id": "" };
      const scrollOnly = { clickable: "false", scrollable: "true" };
      const hierarchy = screenHierarchy([
        boundedNode({ ...list, ...scrollOnly }, { left: 0, top: 0, right: 500, bottom: 500 }),
        boundedNode({ ...list, ...scrollOnly }, { left: 0, top: 600, right: 500, bottom: 1100 }),
      ]);
      const containers = extractScrollableContainers(hierarchy, elementParser);

      expect(containers.map((container) => tapSelectorFor(container, hierarchy))).toEqual([
        { text: "List", index: 0 },
        { text: "List", index: 1 },
      ]);
      expect(new Set(containers.map((c) => getElementKey(c, hierarchy))).size).toBe(2);
    });

    test("keeps a unique occurrence unindexed", () => {
      const element = createMockElement();
      const selector = {
        selectByResourceId: () => ({
          element,
          indexInMatches: 0,
          totalMatches: 1,
          strategy: "first" as const,
        }),
        selectByText: () => ({
          element,
          indexInMatches: 0,
          totalMatches: 1,
          strategy: "first" as const,
        }),
      } as ElementSelector;

      expect(tapSelectorFor(element, createMockViewHierarchy(), selector)).toEqual({
        elementId: "com.test:id/button",
      });
    });

    test("finds an occurrence beyond the unindexed match count", () => {
      const occurrences = [
        createMockElement({ bounds: { left: 0, top: 0, right: 20, bottom: 20 } }),
        createMockElement({ bounds: { left: 0, top: 20, right: 20, bottom: 40 } }),
        createMockElement({ bounds: { left: 0, top: 40, right: 20, bottom: 60 } }),
      ];
      const selector = {
        selectByResourceId: (_hierarchy: unknown, _id: string, options?: { index?: number }) => ({
          element:
            options?.index === undefined ? occurrences[0] : (occurrences[options.index] ?? null),
          indexInMatches: options?.index ?? 0,
          totalMatches: options?.index === undefined ? 2 : 3,
          strategy: "first" as const,
        }),
        selectByText: (_hierarchy: unknown, _text: string) => ({
          element: null,
          indexInMatches: -1,
          totalMatches: 2,
          strategy: "first" as const,
        }),
      } as ElementSelector;

      expect(tapSelectorFor(occurrences[2], createMockViewHierarchy(), selector)).toEqual({
        elementId: "com.test:id/button",
        index: 2,
      });
    });

    test("keeps a simple repeated occurrence index", () => {
      const occurrences = [
        createMockElement({ bounds: { left: 0, top: 0, right: 20, bottom: 20 } }),
        createMockElement({ bounds: { left: 0, top: 20, right: 20, bottom: 40 } }),
      ];
      const selector = {
        selectByResourceId: (_hierarchy: unknown, _id: string, options?: { index?: number }) => ({
          element:
            options?.index === undefined ? occurrences[0] : (occurrences[options.index] ?? null),
          indexInMatches: options?.index ?? 0,
          totalMatches: 2,
          strategy: "first" as const,
        }),
        selectByText: (_hierarchy: unknown, _text: string) => ({
          element: null,
          indexInMatches: -1,
          totalMatches: 2,
          strategy: "first" as const,
        }),
      } as ElementSelector;

      expect(tapSelectorFor(occurrences[1], createMockViewHierarchy(), selector)).toEqual({
        elementId: "com.test:id/button",
        index: 1,
      });
    });
  });

  describe("isNavigationCandidate", () => {
    test("should accept clickable and enabled elements", () => {
      const element = createMockElement({
        clickable: true,
        enabled: true,
      });
      expect(isNavigationCandidate(element)).toBe(true);
    });

    test("should reject non-clickable elements", () => {
      const element = createMockElement({
        clickable: false,
      });
      expect(isNavigationCandidate(element)).toBe(false);
    });

    test("should reject disabled elements", () => {
      const element = createMockElement({
        enabled: false,
      });
      expect(isNavigationCandidate(element)).toBe(false);
    });

    test("should reject EditText elements", () => {
      const element = createMockElement({
        class: "android.widget.EditText",
      });
      expect(isNavigationCandidate(element)).toBe(false);
    });

    test("should reject Checkbox elements", () => {
      const element = createMockElement({
        class: "android.widget.CheckBox",
      });
      expect(isNavigationCandidate(element)).toBe(false);
    });

    test("should reject elements that are too small", () => {
      const element = createMockElement({
        bounds: { left: 0, top: 0, right: 5, bottom: 5 },
      });
      expect(isNavigationCandidate(element)).toBe(false);
    });

    test("should handle string boolean values from XML", () => {
      const element = {
        ...createMockElement(),
        clickable: "true",
        enabled: "true",
      };
      expect(isNavigationCandidate(element)).toBe(true);

      const disabledElement = {
        ...createMockElement(),
        clickable: "true",
        enabled: "false",
      };
      expect(isNavigationCandidate(disabledElement)).toBe(false);
    });
  });

  describe("extractNavigationElements", () => {
    test("should extract clickable buttons from view hierarchy", () => {
      const nodes = [
        createMockNode({ text: "Settings", clickable: "true" }),
        createMockNode({ text: "Profile", clickable: "true" }),
      ];
      const viewHierarchy = createMockViewHierarchy(nodes);

      const elements = extractNavigationElements(viewHierarchy, elementParser);

      expect(elements.length).toBe(2);
    });

    test("should filter out non-clickable elements", () => {
      const nodes = [
        createMockNode({ text: "Settings", clickable: "true" }),
        createMockNode({ text: "Label", clickable: "false" }),
      ];
      const viewHierarchy = createMockViewHierarchy(nodes);

      const elements = extractNavigationElements(viewHierarchy, elementParser);

      expect(elements.length).toBe(1);
      expect(elements[0].text).toBe("Settings");
    });

    test("should filter out EditText elements", () => {
      const nodes = [
        createMockNode({ text: "Submit", clickable: "true" }),
        createMockNode({ text: "", class: "android.widget.EditText", clickable: "true" }),
      ];
      const viewHierarchy = createMockViewHierarchy(nodes);

      const elements = extractNavigationElements(viewHierarchy, elementParser);

      expect(elements.length).toBe(1);
    });

    test("should filter out elements from different packages", () => {
      const nodes = [
        createMockNode({ text: "In-app", clickable: "true", package: "com.test.app" }),
        createMockNode({ text: "External", clickable: "true", package: "com.other.app" }),
      ];
      const viewHierarchy = createMockViewHierarchy(nodes, "com.test.app");

      const elements = extractNavigationElements(viewHierarchy, elementParser);

      // Only the in-app element should be extracted
      expect(elements.filter((e) => e.text === "External").length).toBe(0);
    });
  });

  describe("enrichElementWithChildProperties", () => {
    test.each([
      { text: 42 },
      { "content-desc": true },
      { className: { name: "android.widget.Button" } },
    ])("should drop non-string child attributes before login matching: %j", (child) => {
      const element = createMockElement({
        text: undefined,
        class: undefined,
        "content-desc": undefined,
      });
      element.node = [child];

      const enriched = enrichElementWithChildProperties(element);

      expect(() => isLoginScreen([enriched])).not.toThrow();
      expect(enriched.text).toBeUndefined();
      expect(enriched.class).toBeUndefined();
      expect(enriched["content-desc"]).toBeUndefined();
    });

    test("should use later string child attributes after non-string and empty values", () => {
      const element = createMockElement({ text: undefined, class: undefined });
      element.node = [
        { text: 42, "content-desc": true, className: { name: "invalid" } },
        { text: "", "content-desc": "", className: "" },
        { text: "Sign in", "content-desc": "Email", className: "android.widget.EditText" },
        { text: "Later", "content-desc": "Later", className: "android.widget.Button" },
      ];

      const enriched = enrichElementWithChildProperties(element);

      expect(enriched.text).toBe("Sign in");
      expect(enriched.class).toBe("android.widget.EditText");
      expect(enriched["content-desc"]).toBe("Email");
      expect(isLoginScreen([enriched])).toBe(true);
    });

    test("should preserve ordinary string attributes from a single child", () => {
      const element = createMockElement({ text: undefined, class: undefined });
      element.node = {
        text: "Sign in",
        className: "android.widget.EditText",
        "content-desc": "Email",
      };

      const enriched = enrichElementWithChildProperties(element);

      expect(enriched.text).toBe("Sign in");
      expect(enriched.class).toBe("android.widget.EditText");
      expect(enriched["content-desc"]).toBe("Email");
      expect(isLoginScreen([enriched])).toBe(true);
    });

    test("should copy text from child node if parent has none", () => {
      const element = createMockElement({ text: undefined });
      element.node = [{ text: "Child Text" }];

      const enriched = enrichElementWithChildProperties(element);

      expect(enriched.text).toBe("Child Text");
    });

    test("should not override existing text", () => {
      const element = createMockElement({ text: "Parent Text" });
      element.node = [{ text: "Child Text" }];

      const enriched = enrichElementWithChildProperties(element);

      expect(enriched.text).toBe("Parent Text");
    });

    test("should handle missing node property", () => {
      const element = createMockElement({ text: "Existing" });

      const enriched = enrichElementWithChildProperties(element);

      expect(enriched.text).toBe("Existing");
    });
  });

  describe("extractScrollableContainers", () => {
    test("should extract scrollable elements", () => {
      const nodes = [
        createMockNode({
          scrollable: "true",
          bounds: { left: 0, top: 0, right: 300, bottom: 500 },
        }),
      ];
      // Manually set bounds for the test
      nodes[0].bounds = { left: 0, top: 0, right: 300, bottom: 500 };
      const viewHierarchy = createMockViewHierarchy(nodes);

      const containers = extractScrollableContainers(viewHierarchy, elementParser);

      expect(containers.length).toBe(1);
    });

    test("should filter out small scrollable elements", () => {
      const nodes = [
        createMockNode({
          scrollable: "true",
          bounds: { left: 0, top: 0, right: 30, bottom: 30 },
        }),
      ];
      nodes[0].bounds = { left: 0, top: 0, right: 30, bottom: 30 };
      const viewHierarchy = createMockViewHierarchy(nodes);

      const containers = extractScrollableContainers(viewHierarchy, elementParser);

      expect(containers.length).toBe(0);
    });
  });

  describe("extractAllElements", () => {
    test("should extract all elements regardless of clickability", () => {
      const nodes = [
        createMockNode({ text: "Clickable", clickable: "true" }),
        createMockNode({ text: "NonClickable", clickable: "false" }),
      ];
      const viewHierarchy = createMockViewHierarchy(nodes);

      const elements = extractAllElements(viewHierarchy, elementParser);

      expect(elements.length).toBe(2);
    });
  });

  describe("getElementKey", () => {
    test("distinguishes identical siblings by selector index and stays stable", () => {
      const rows = [0, 1].map((index) => ({
        $: {
          class: "android.widget.TextView",
          text: "Same row",
          "resource-id": "com.test:id/row",
          clickable: "true",
          bounds: { left: 0, top: index * 50, right: 200, bottom: index * 50 + 40 },
        },
      }));
      const hierarchy1 = createMockViewHierarchy(rows);
      const hierarchy2 = createMockViewHierarchy(
        rows.map((row) => ({ $: { ...row.$, bounds: { ...row.$.bounds } } })),
      );
      const elements1 = extractAllElements(hierarchy1, elementParser);
      const elements2 = extractAllElements(hierarchy2, elementParser);

      expect(getElementKey(elements1[0]!, hierarchy1)).not.toBe(
        getElementKey(elements1[1]!, hierarchy1),
      );
      expect(getElementKey(elements1[0]!, hierarchy1)).toBe(
        getElementKey(elements2[0]!, hierarchy2),
      );
    });

    test("keeps unexhausted identical sibling rows independently available", () => {
      const nodes = [0, 1, 2].map((index) => ({
        $: {
          class: "android.widget.TextView",
          text: "Same row",
          "resource-id": "com.test:id/row",
          clickable: "true",
          bounds: { left: 0, top: index * 50, right: 200, bottom: index * 50 + 40 },
        },
      }));
      const hierarchy = createMockViewHierarchy(nodes);
      const elements = extractAllElements(hierarchy, elementParser);
      const tracked = new Map<string, TrackedElement>([
        [
          getElementKey(elements[0]!, hierarchy),
          {
            interactionCount: 2,
            lastInteractionScreen: "Screen1",
          },
        ],
      ]);

      const filtered = filterUnexhaustedElements(elements, tracked, "Screen1", hierarchy);
      expect(filtered).toHaveLength(2);
      expect(filtered.map((element) => element.bounds.top)).toEqual([50, 100]);
    });

    test("produces distinct keys for generated identical sibling rows", () => {
      fc.assert(
        fc.property(fc.integer({ min: 2, max: 5 }), (count) => {
          const nodes = Array.from({ length: count }, (_, index) => ({
            $: {
              class: "android.widget.TextView",
              text: "Same row",
              "resource-id": "com.test:id/row",
              clickable: "true",
              bounds: { left: 0, top: index * 50, right: 200, bottom: index * 50 + 40 },
            },
          }));
          const hierarchy = createMockViewHierarchy(nodes);
          const elements = extractAllElements(hierarchy, elementParser);
          expect(new Set(elements.map((element) => getElementKey(element, hierarchy))).size).toBe(
            count,
          );
        }),
        { seed: 1_234_567, numRuns: 20 },
      );
    });
    test("should generate key from resource-id and text", () => {
      const element = createMockElement({
        "resource-id": "com.test:id/btn",
        text: "Click Me",
      });

      const key = getElementKey(element);

      expect(key).toContain("id:com.test:id/btn");
      expect(key).toContain("text:Click Me");
    });

    test("should generate same key for identical elements", () => {
      const element1 = createMockElement({
        "resource-id": "com.test:id/btn",
        text: "Click",
      });
      const element2 = createMockElement({
        "resource-id": "com.test:id/btn",
        text: "Click",
      });

      expect(getElementKey(element1)).toBe(getElementKey(element2));
    });

    test("should generate different keys for different elements", () => {
      const element1 = createMockElement({ text: "Button A" });
      const element2 = createMockElement({ text: "Button B" });

      expect(getElementKey(element1)).not.toBe(getElementKey(element2));
    });

    test("uses bounds to distinguish elements with no identifying properties", () => {
      const element = {
        bounds: { left: 0, top: 0, right: 100, bottom: 50 },
        clickable: true,
      } as Element;

      expect(getElementKey(element)).toBe("bounds:0,0,100,50");
      const sibling = createMockElement({
        text: "",
        class: "",
        "resource-id": "",
        bounds: { left: 100, top: 0, right: 200, bottom: 50 },
      });
      expect(getElementKey(element)).not.toBe(getElementKey(sibling));
    });
  });

  describe("filterUnexhaustedElements", () => {
    test("should include elements not in tracked map", () => {
      const elements = [createMockElement({ text: "New Button" })];
      const tracked = new Map<string, TrackedElement>();

      const filtered = filterUnexhaustedElements(elements, tracked, "Screen1");

      expect(filtered.length).toBe(1);
    });

    test("should include elements tried on different screen", () => {
      const element = createMockElement({ text: "Button" });
      const tracked = new Map<string, TrackedElement>();
      tracked.set(getElementKey(element), {
        interactionCount: 2,
        lastInteractionScreen: "Screen1",
      });

      const filtered = filterUnexhaustedElements([element], tracked, "Screen2");

      expect(filtered.length).toBe(1);
    });

    test("should filter out elements tried twice on same screen", () => {
      const element = createMockElement({ text: "Button" });
      const tracked = new Map<string, TrackedElement>();
      tracked.set(getElementKey(element), {
        interactionCount: 2,
        lastInteractionScreen: "Screen1",
      });

      const filtered = filterUnexhaustedElements([element], tracked, "Screen1");

      expect(filtered.length).toBe(0);
    });

    test("should include elements tried only once on same screen", () => {
      const element = createMockElement({ text: "Button" });
      const tracked = new Map<string, TrackedElement>();
      tracked.set(getElementKey(element), {
        interactionCount: 1,
        lastInteractionScreen: "Screen1",
      });

      const filtered = filterUnexhaustedElements([element], tracked, "Screen1");

      expect(filtered.length).toBe(1);
    });
  });
});
