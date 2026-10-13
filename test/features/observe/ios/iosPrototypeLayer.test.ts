import { beforeAll, describe, expect, test } from "bun:test";
import { CtrlProxyHierarchy } from "../../../../src/features/observe/ios/CtrlProxyHierarchy";
import type {
  CtrlProxyNode,
  HierarchyDelegateContext,
  XCTestHierarchy,
} from "../../../../src/features/observe/ios/types";
import {
  assertAppGestureNotUnderPrototype,
  hasOwnPrototype,
  ownPrototypeCoversPoint,
  scopeHierarchyForSelector,
  scopeHierarchyToLayer,
  scopeObserveResultToLayer,
} from "../../../../src/features/observe/hierarchyLayer";
import { SearchableHierarchy } from "../../../../src/features/utility/SearchableNode";
import type { ObserveResult } from "../../../../src/models/ObserveResult";
import {
  nodeAttributes,
  type ViewHierarchyResult,
} from "../../../../src/models/ViewHierarchyResult";
import { iosFloatingOverlayOverSettings } from "../../../fixtures/observe/iosOverlayWindow";

// Captured Settings with the prototype agent's floating card in a second UIWindow (iphone D2); see
// test/fixtures/observe-output/ios-overlay-window/README.txt.
const PROTOTYPE_IDS = [
  "automobile-prototype-dismiss",
  "like-button",
  "close-button",
  "floating-card",
];
const APP_IDS = ["Toolbar", "Settings"];

// Shared captures are read-only; scenario-specific window and marker edits use cloned inputs.
let captured: XCTestHierarchy;
let convertedCapture: ViewHierarchyResult;
beforeAll(() => {
  captured = iosFloatingOverlayOverSettings();
  convertedCapture = convert(captured);
});

function convert(raw?: XCTestHierarchy): ViewHierarchyResult {
  if (!raw) {
    return convertedCapture;
  }
  return new CtrlProxyHierarchy({} as HierarchyDelegateContext).convertToViewHierarchyResult(raw);
}

/** The captured tree with only the window at `index` (0 = Settings, 1 = the prototype agent's). */
function onlyWindow(index: number): ViewHierarchyResult {
  const raw = structuredClone(captured);
  raw.hierarchy.node = (raw.hierarchy.node as unknown[]).slice(
    index,
    index + 1,
  ) as typeof raw.hierarchy.node;
  return convert(raw);
}

/** The runner's unconverted tree, which keeps the UIWindow wrappers. */
function unconverted(): ViewHierarchyResult {
  return captured as unknown as ViewHierarchyResult;
}

/** Derived chromeless FULLSCREEN shape; a real capture of its root marker is still owed. */
function withWindowMarker(keepDismiss = false, markRoot = true): XCTestHierarchy {
  const raw = structuredClone(captured);
  const agentWindow = (raw.hierarchy.node as CtrlProxyNode[])[1];
  const root = (Array.isArray(agentWindow.node) ? agentWindow.node[0] : agentWindow.node)!;
  const attributes = root as CtrlProxyNode & { "resource-id"?: string };
  if (markRoot) {
    attributes["resource-id"] = "automobile-prototype-window";
  }
  const clearDismiss = (node: CtrlProxyNode): void => {
    const attributes = node as CtrlProxyNode & { "resource-id"?: string; "view-id"?: string };
    if (!keepDismiss && attributes["resource-id"] === "automobile-prototype-dismiss") {
      delete attributes["resource-id"];
      delete attributes["view-id"];
    }
    const children = node.node ? (Array.isArray(node.node) ? node.node : [node.node]) : [];
    children.forEach(clearDismiss);
  };
  clearDismiss(agentWindow);
  return raw;
}

function ids(hierarchy: ViewHierarchyResult): Set<string> {
  return new Set(
    new SearchableHierarchy()
      .project(hierarchy)
      .flatMap((entry) => (entry.nativeId ? [entry.nativeId] : [])),
  );
}

describe("iOS prototype agent window with layer (iphone D2)", () => {
  for (const form of ["stamped layers", "single window", "UIWindow wrappers"] as const) {
    const hierarchyForForm = (keepDismiss: boolean): ViewHierarchyResult => {
      const raw = withWindowMarker(keepDismiss);
      if (form === "single window") {
        raw.hierarchy.node = (raw.hierarchy.node as CtrlProxyNode[]).slice(1);
      }
      return form === "UIWindow wrappers" ? (raw as unknown as ViewHierarchyResult) : convert(raw);
    };

    test(`fullscreen root marker alone owns the whole window (${form})`, () => {
      const hierarchy = hierarchyForForm(false);
      expect(hasOwnPrototype(hierarchy)).toBe(true);
      const prototype = ids(scopeHierarchyToLayer(hierarchy, "prototype"));
      const app = ids(scopeHierarchyToLayer(hierarchy, "app"));
      for (const id of ["automobile-prototype-window", ...PROTOTYPE_IDS.slice(1)]) {
        expect(prototype.has(id)).toBe(true);
        expect(app.has(id)).toBe(false);
      }
      expect(prototype.has("automobile-prototype-dismiss")).toBe(false);
      for (const id of APP_IDS) {
        expect(prototype.has(id)).toBe(false);
        expect(app.has(id)).toBe(form !== "single window");
      }
      // The marked root fills the FULLSCREEN window; the floating fixture remains unchanged below.
      for (const point of [
        { x: 1, y: 1 },
        { x: 200, y: 300 },
        { x: 401, y: 873 },
      ]) {
        expect(ownPrototypeCoversPoint(hierarchy, point)).toBe(true);
      }
    });

    test(`revealing the dismiss pill keeps the fullscreen roots (${form})`, () => {
      const hiddenPill = hierarchyForForm(false);
      const revealedPill = hierarchyForForm(true);
      expect(hasOwnPrototype(revealedPill)).toBe(true);
      for (const layer of ["app", "prototype"] as const) {
        const hiddenRoots = scopeHierarchyToLayer(hiddenPill, layer).hierarchy.node;
        const revealedRoots = scopeHierarchyToLayer(revealedPill, layer).hierarchy.node;
        // Conversion generates fresh view ids; compare the roots' stable attributes and node ownership.
        const rootAttributes = (nodes: typeof hiddenRoots) =>
          (Array.isArray(nodes) ? nodes : nodes ? [nodes] : []).map((node) =>
            Object.fromEntries(
              Object.entries(nodeAttributes(node)).filter(
                ([key]) => key !== "view-id" && key !== "node",
              ),
            ),
          );
        expect(rootAttributes(revealedRoots)).toEqual(rootAttributes(hiddenRoots));
        const expected = ids(scopeHierarchyToLayer(hiddenPill, layer));
        if (layer === "prototype") {
          expected.add("automobile-prototype-dismiss");
        }
        expect(ids(scopeHierarchyToLayer(revealedPill, layer))).toEqual(expected);
      }
      expect(ownPrototypeCoversPoint(revealedPill, { x: 200, y: 300 })).toBe(true);
    });
  }

  test("the captured agent window with neither marker is not an own prototype", () => {
    const hierarchy = convert(withWindowMarker(false, false));
    expect(hasOwnPrototype(hierarchy)).toBe(false);
    expect(scopeHierarchyToLayer(hierarchy, "app")).toBe(hierarchy);
  });
  test("the converted capture has the prototype and both layers split it from Settings", () => {
    const hierarchy = convert();
    expect(hasOwnPrototype(hierarchy)).toBe(true);

    const prototype = ids(scopeHierarchyForSelector(hierarchy, "prototype"));
    const app = ids(scopeHierarchyForSelector(hierarchy, "app"));
    for (const id of PROTOTYPE_IDS) {
      expect(prototype.has(id)).toBe(true);
      expect(app.has(id)).toBe(false);
    }
    for (const id of APP_IDS) {
      expect(app.has(id)).toBe(true);
      expect(prototype.has(id)).toBe(false);
    }
  });

  test("the unconverted runner tree is split at the agent's UIWindow", () => {
    const hierarchy = unconverted();
    expect(hasOwnPrototype(hierarchy)).toBe(true);
    expect(ids(scopeHierarchyToLayer(hierarchy, "prototype")).has("like-button")).toBe(true);
    expect(ids(scopeHierarchyToLayer(hierarchy, "prototype")).has("Toolbar")).toBe(false);
    expect(ids(scopeHierarchyToLayer(hierarchy, "app")).has("like-button")).toBe(false);
    expect(ids(scopeHierarchyToLayer(hierarchy, "app")).has("Toolbar")).toBe(true);
  });

  test("when only the agent's window contributes nodes, all of them are the prototype's", () => {
    const hierarchy = onlyWindow(1);
    expect(hasOwnPrototype(hierarchy)).toBe(true);
    expect(ids(scopeHierarchyToLayer(hierarchy, "prototype")).has("like-button")).toBe(true);
    expect(ids(scopeHierarchyToLayer(hierarchy, "app")).has("like-button")).toBe(false);
  });

  test("Settings alone has no prototype, so layer prototype is the actionable error", () => {
    const hierarchy = onlyWindow(0);
    expect(hasOwnPrototype(hierarchy)).toBe(false);
    expect(scopeHierarchyToLayer(hierarchy, "app")).toBe(hierarchy);
    expect(() => scopeHierarchyForSelector(hierarchy, "prototype")).toThrow(
      /no AutoMobile prototype is showing/,
    );
  });

  test("an app gesture is refused only where the agent's content or dismiss control is", () => {
    const hierarchy = convert();
    const like = { x: 96, y: 802 };
    const dismiss = { x: 372, y: 84 };
    const settingsRow = { x: 200, y: 213 };
    expect(ownPrototypeCoversPoint(hierarchy, like)).toBe(true);
    expect(ownPrototypeCoversPoint(hierarchy, dismiss)).toBe(true);
    expect(ownPrototypeCoversPoint(hierarchy, settingsRow)).toBe(false);
    expect(ownPrototypeCoversPoint(hierarchy, { x: 200, y: 300 })).toBe(false);
    expect(() => assertAppGestureNotUnderPrototype(hierarchy, "app", like, "tap")).toThrow(
      /prototype window covers that point/,
    );
    expect(() =>
      assertAppGestureNotUnderPrototype(hierarchy, "app", settingsRow, "tap"),
    ).not.toThrow();
  });

  test("observe with layer prototype returns the agent's controls", () => {
    const viewHierarchy = convert();
    const result: ObserveResult = {
      updatedAt: 1,
      display: { key: "default", role: "unknown", posture: "unknown", generation: 0 },
      screenSize: { width: 402, height: 874 },
      systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
      viewHierarchy,
    };
    const scoped = scopeObserveResultToLayer(result, "prototype", "ios");
    const labels = (scoped.elements?.clickable ?? []).map((element) => element.text);
    expect(labels).toEqual(expect.arrayContaining(["Like", "Close", "Dismiss prototype"]));
    expect(labels).not.toContain("Search");
  });
});
