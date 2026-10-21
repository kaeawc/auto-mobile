import { buildObserveResult } from "../../../helpers/observeFixture";
import { convertIosHierarchy } from "../../../helpers/iosHierarchyConverter";
import { describe, expect, test } from "bun:test";
import { getHierarchyNodeSource } from "../../../../src/features/observe/output/elementProvenance";
import { normalizeIosHierarchy } from "../../../../src/features/observe/HierarchyNormalization";
import { CtrlProxyHierarchy } from "../../../../src/features/observe/ios/CtrlProxyHierarchy";
import type {
  CtrlProxyNode,
  HierarchyDelegateContext,
} from "../../../../src/features/observe/ios/types";
import { IOS_WINDOW_LAYER_EXTRA } from "../../../../src/features/observe/ios/iosWindowLayer";
import {
  hasOwnPrototype,
  layerGestureRefusal,
  ownPrototypeCoversPoint,
  scopeHierarchyForSelector,
  scopeHierarchyToLayer,
  scopeObserveResultToLayer,
} from "../../../../src/features/observe/hierarchyLayer";
import {
  SearchableHierarchy,
  type SearchableEntry,
} from "../../../../src/features/utility/SearchableNode";
import type { ObserveResult, ViewHierarchyResult } from "../../../../src/models";
import {
  iosPrototypeSheetRaw,
  iosPrototypeSheetWire,
} from "../../../fixtures/observe/iosPrototypeSheet";

function withoutWindowStamps(node: CtrlProxyNode): CtrlProxyNode {
  const extras = Object.fromEntries(
    Object.entries(node.extras ?? {}).filter(([key]) => key !== IOS_WINDOW_LAYER_EXTRA),
  );
  const children = node.node === undefined ? [] : [node.node].flat().map(withoutWindowStamps);
  return {
    ...node,
    ...(node.extras === undefined ? {} : { extras }),
    ...(node.node === undefined ? {} : { node: Array.isArray(node.node) ? children : children[0] }),
  };
}

const converter = new CtrlProxyHierarchy({} as HierarchyDelegateContext);
const normalized = normalizeIosHierarchy(convertIosHierarchy(iosPrototypeSheetWire()));
const convertedWire = converter.convertToViewHierarchyResult(iosPrototypeSheetWire());
const convertedRaw = converter.convertToViewHierarchyResult(iosPrototypeSheetRaw());
// Derive the pre-fix capture by removing the stamp from every node, without editing the fixture.
const unstamped = normalizeIosHierarchy(
  convertIosHierarchy({
    ...iosPrototypeSheetWire(),
    hierarchy: withoutWindowStamps(iosPrototypeSheetWire().hierarchy),
  }),
);
const project = (h: ViewHierarchyResult) => new SearchableHierarchy().project(h);
const signature = (n: SearchableEntry) => [n.className, n.nativeId, n.label, n.bounds];
const paths = [
  ["production normalization", normalized],
  ["converter on stamped wire", convertedWire],
  ["converter on raw windows", convertedRaw],
] as const;
// Parse and project once; assertions compare every descendant, including unlabelled nodes.
const captures = paths.map(([name, hierarchy]) => ({ name, hierarchy, nodes: project(hierarchy) }));

for (const { name, hierarchy, nodes } of captures) {
  describe(name, () => {
    test("splits every captured node into its originating window", () => {
      expect(hasOwnPrototype(hierarchy)).toBe(true);
      for (const [layer, rank] of [
        ["prototype", 0],
        ["app", 1],
      ] as const) {
        const scoped = project(scopeHierarchyToLayer(hierarchy, layer));
        expect(
          scoped.filter((n) => n.className && n.className !== "XCUIApplication").map(signature),
        ).toEqual(nodes.filter((n) => n.iosWindowLayer === rank).map(signature));
        const ids = scoped.map((n) => n.nativeId);
        for (const id of ["s6", "b6", "tf6", "automobile-prototype-dismiss"]) {
          expect(ids.includes(id)).toBe(layer === "prototype");
        }
        for (const id of ["Discover", "Toolbar"]) {
          expect(ids.includes(id)).toBe(layer === "app");
        }
        expect(scoped.some((n) => n.className === "UICollectionView")).toBe(layer === "app");
        expect(scoped.some((n) => n.label === "Tab Bar")).toBe(layer === "app");
      }
    });

    test("app selectors find Demos while prototype selectors find SheetBtn", () => {
      const app = project(scopeHierarchyForSelector(hierarchy, "app"));
      const prototype = project(scopeHierarchyForSelector(hierarchy, "prototype"));
      expect(app.some((n) => n.element?.text === "Demos")).toBe(true);
      expect(prototype.some((n) => n.element?.text === "Demos")).toBe(false);
      expect(prototype.some((n) => n.element?.text === "SheetBtn")).toBe(true);
      expect(app.some((n) => n.element?.text === "SheetBtn")).toBe(false);
    });

    test("observe rebuilds elements using only the selected window", () => {
      const result: ObserveResult = buildObserveResult({
        updatedAt: 1,
        systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
        display: { key: "default", role: "unknown", posture: "unknown", generation: 0 },
        screenSize: { width: 390, height: 844 },
        viewHierarchy: hierarchy,
        // Deliberately stale elements: layer scoping must replace them.
        elements: scopeObserveResultToLayer(
          buildObserveResult({
            updatedAt: 1,
            screenSize: { width: 390, height: 844 },
            systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
            viewHierarchy: hierarchy,
          }),
          "app",
          "ios",
        ).elements,
      });
      for (const layer of ["prototype", "app"] as const) {
        const scoped = scopeObserveResultToLayer(result, layer, "ios");
        const projected = project(scoped.viewHierarchy!);
        const allowed = new Set(
          projected
            .filter(
              (n) =>
                n.iosWindowLayer === (layer === "prototype" ? 0 : 1) ||
                (layer === "app" && n.className === "XCUIApplication"),
            )
            .map((n) => n.source),
        );
        const collections = scoped.elements!;
        const elements = [...collections.clickable, ...collections.scrollable, ...collections.text];
        expect(elements.length).toBeGreaterThan(0);
        // Check every emitted descriptor, including app rows without native identifiers.
        for (const element of elements) {
          expect(allowed.has(getHierarchyNodeSource(element)!)).toBe(true);
        }
        for (const media of collections.media) {
          expect(
            projected.some(
              (n) =>
                allowed.has(n.source) &&
                n.className === media.className &&
                JSON.stringify(n.bounds) === JSON.stringify(media.bounds),
            ),
          ).toBe(true);
        }
        const labels = elements.map((e) => e.text);
        expect(labels.includes("SheetBtn")).toBe(layer === "prototype");
        expect(labels.includes("Demos")).toBe(layer === "app");
      }
    });

    test("only prototype content covers the button centre and refuses app taps", () => {
      const bounds = nodes.find((n) => n.nativeId === "b6")!.bounds!;
      const button = { x: (bounds.left + bounds.right) / 2, y: (bounds.top + bounds.bottom) / 2 };
      const title = nodes.find((n) => n.label === "Discover" && n.className === "UILabel")!.bounds!;
      const titlePoint = { x: (title.left + title.right) / 2, y: (title.top + title.bottom) / 2 };
      expect(ownPrototypeCoversPoint(hierarchy, button)).toBe(true);
      expect(ownPrototypeCoversPoint(hierarchy, titlePoint)).toBe(false);
      expect(layerGestureRefusal(hierarchy, "app", [button], "tap")).toContain(
        "prototype window covers",
      );
      expect(layerGestureRefusal(hierarchy, "prototype", [button], "tap")).toBeUndefined();
    });
  });
}

test("converter preserves runner stamps and stamps raw windows with the same top-level split", () => {
  for (const hierarchy of [normalized, convertedWire, convertedRaw]) {
    const nodes = project(hierarchy);
    expect(
      nodes
        .filter(
          (n) => n.parentIndex === nodes.find((n) => n.className === "XCUIApplication")?.index,
        )
        .map((n) => n.source.extras?.[IOS_WINDOW_LAYER_EXTRA]),
    ).toEqual(["1", "1", "1", "1", "0", "0", "0", "0"]);
  }
});

test("a capture from a runner that predates window stamps cannot be split", () => {
  expect(hasOwnPrototype(unstamped)).toBe(true);
  const prototype = project(scopeHierarchyToLayer(unstamped, "prototype"));
  expect(
    prototype.filter(
      (n) => n.parentIndex === prototype.find((n) => n.className === "XCUIApplication")?.index,
    ),
  ).toHaveLength(8);
  // Only the empty application root remains: every window child belongs to the prototype layer.
  expect(project(scopeHierarchyToLayer(unstamped, "app")).map((n) => n.className)).toEqual([
    "XCUIApplication",
  ]);
});
