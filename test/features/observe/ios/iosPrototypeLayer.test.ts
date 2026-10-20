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
  hasOwnRunnerPrototype,
  ownPrototypeCoversPoint,
  runnerPrototypeCoversPoint,
  scopeRunnerHierarchyToLayer,
  scopeHierarchyForSelector,
  scopeHierarchyToLayer,
  scopeObserveResultToLayer,
} from "../../../../src/features/observe/hierarchyLayer";
import { runnerLayerTree } from "../../../../src/features/observe/layerTree";
import type { HierarchyLayer } from "../../../../src/models/HierarchyLayer";
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

/** What the layer assertions read from a capture, spelled the way that capture carries it. */
interface LayerForm<C> {
  hasPrototype(capture: C): boolean;
  idsIn(capture: C, layer: HierarchyLayer): Set<string>;
  rootAttributes(capture: C, layer: HierarchyLayer): Record<string, unknown>[];
  covers(capture: C, point: { x: number; y: number }): boolean;
}

/** Attributes that identify a root independent of the ids conversion generates. */
function stableAttributes(attributes: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(attributes).filter(([key]) => key !== "view-id" && key !== "node"),
  );
}

const convertedForm: LayerForm<ViewHierarchyResult> = {
  hasPrototype: hasOwnPrototype,
  idsIn: (capture, layer) => ids(scopeHierarchyToLayer(capture, layer)),
  rootAttributes: (capture, layer) =>
    [scopeHierarchyToLayer(capture, layer).hierarchy.node ?? []]
      .flat()
      .map((node) => stableAttributes(nodeAttributes(node))),
  covers: ownPrototypeCoversPoint,
};

/** Every node of the runner's tree, front to back. */
function runnerNodes(node: CtrlProxyNode): CtrlProxyNode[] {
  return [node, ...[node.node ?? []].flat().flatMap(runnerNodes)];
}

const runnerForm: LayerForm<XCTestHierarchy> = {
  hasPrototype: hasOwnRunnerPrototype,
  idsIn: (capture, layer) =>
    new Set(
      runnerNodes(scopeRunnerHierarchyToLayer(capture, layer).hierarchy).flatMap((node) =>
        runnerLayerTree.resourceId(node) ? [String(runnerLayerTree.resourceId(node))] : [],
      ),
    ),
  rootAttributes: (capture, layer) =>
    [scopeRunnerHierarchyToLayer(capture, layer).hierarchy.node ?? []]
      .flat()
      .map((node) => stableAttributes({ ...node })),
  covers: runnerPrototypeCoversPoint,
};

describe("iOS prototype agent window with layer (iphone D2)", () => {
  /** The same assertions run against each capture spelling that carries the prototype window. */
  function defineFormTests<C>(
    form: string,
    spelling: LayerForm<C>,
    build: (keepDismiss: boolean) => C,
  ): void {
    test(`fullscreen root marker alone owns the whole window (${form})`, () => {
      const hierarchy = build(false);
      expect(spelling.hasPrototype(hierarchy)).toBe(true);
      const prototype = spelling.idsIn(hierarchy, "prototype");
      const app = spelling.idsIn(hierarchy, "app");
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
        expect(spelling.covers(hierarchy, point)).toBe(true);
      }
    });

    test(`revealing the dismiss pill keeps the fullscreen roots (${form})`, () => {
      const hiddenPill = build(false);
      const revealedPill = build(true);
      expect(spelling.hasPrototype(revealedPill)).toBe(true);
      for (const layer of ["app", "prototype"] as const) {
        // Conversion generates fresh view ids; compare the roots' stable attributes and node ownership.
        expect(spelling.rootAttributes(revealedPill, layer)).toEqual(
          spelling.rootAttributes(hiddenPill, layer),
        );
        const expected = spelling.idsIn(hiddenPill, layer);
        if (layer === "prototype") {
          expected.add("automobile-prototype-dismiss");
        }
        expect(spelling.idsIn(revealedPill, layer)).toEqual(expected);
      }
      expect(spelling.covers(revealedPill, { x: 200, y: 300 })).toBe(true);
    });
  }

  const withoutAppWindow = (keepDismiss: boolean): XCTestHierarchy => {
    const raw = withWindowMarker(keepDismiss);
    raw.hierarchy.node = [raw.hierarchy.node ?? []].flat().slice(1);
    return raw;
  };
  defineFormTests("stamped layers", convertedForm, (keepDismiss) =>
    convert(withWindowMarker(keepDismiss)),
  );
  defineFormTests("single window", convertedForm, (keepDismiss) =>
    convert(withoutAppWindow(keepDismiss)),
  );
  defineFormTests("UIWindow wrappers", runnerForm, (keepDismiss) => withWindowMarker(keepDismiss));

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
    expect(runnerForm.hasPrototype(captured)).toBe(true);
    expect(runnerForm.idsIn(captured, "prototype").has("like-button")).toBe(true);
    expect(runnerForm.idsIn(captured, "prototype").has("Toolbar")).toBe(false);
    expect(runnerForm.idsIn(captured, "app").has("like-button")).toBe(false);
    expect(runnerForm.idsIn(captured, "app").has("Toolbar")).toBe(true);
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
      observationId: "prototype-layer",
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
