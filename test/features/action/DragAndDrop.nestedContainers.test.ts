import { scopedSelectionMatrix } from "../../helpers/scopedSelectionMatrix";
import { afterEach, expect, spyOn, test } from "bun:test";
import { DragAndDrop } from "../../../src/features/action/DragAndDrop";
import { AndroidCtrlProxyClient } from "../../../src/features/observe/android";
import { AndroidCtrlProxyManager } from "../../../src/ctrlProxy/CtrlProxyManager";
import { displayTransitions } from "../../../src/features/observe/DisplayTransition";
import type {
  BootedDevice,
  DragAndDropOptions,
  ObserveResult,
  ViewHierarchyResult,
} from "../../../src/models";
import type { AdbClient } from "../../../src/utils/android-cmdline-tools/AdbClient";
import { encodeAndroidFlat, type LogicalNode } from "../../fixtures/hierarchyArbitraries";
import { FakeAdbClient } from "../../fakes/FakeAdbClient";
import { FakeHierarchyCapture } from "../../fakes/FakeHierarchyCapture";
import { FakeObserveScreen } from "../../fakes/FakeObserveScreen";
import { FakeScreenshotCapturer } from "../../fakes/FakeScreenshotCapturer";
import { FakeVisionAnalyzer } from "../../fakes/FakeVisionAnalyzer";
import { FakeTimer } from "../../fakes/FakeTimer";

const scope = { elementId: "item_42", container: { elementId: "cart_A" } };
const scoped = { elementId: "remove", container: scope, selectionStrategy: "unique" as const };
const routes = ["default", "display-ctrlproxy", "display-adb"] as const;
type Route = (typeof routes)[number];
type Kind =
  | "success"
  | "container-missing"
  | "inner-missing"
  | "container-ambiguous"
  | "leaf-missing"
  | "leaf-ambiguous"
  | "source-label-ambiguous";

function node(id: string, children: LogicalNode[] = [], top = 0): LogicalNode {
  return {
    attrs: { "resource-id": id, text: id, class: "android.view.View" },
    bounds: { left: 0, top, right: 100, bottom: top + 20 },
    children,
  };
}
function hierarchy(kind: Kind): ViewHierarchyResult {
  const item = node("item_42", [node("", kind === "leaf-missing" ? [] : [node("remove", [], 40)])]);
  if (kind === "leaf-ambiguous" || kind === "source-label-ambiguous") {
    item.children.push(node("remove", [], 70));
  }
  if (kind === "source-label-ambiguous") {
    item.children[0].children[0].attrs.text = "source remove";
    item.children[1].attrs.text = "source remove";
  }
  const cart = node("cart_A", [node("", kind === "inner-missing" ? [] : [item])]);
  if (kind === "container-ambiguous") {
    cart.children.push(node("item_42"));
  }
  return {
    displayId: 2,
    screenWidth: 500,
    screenHeight: 500,
    hierarchy: {
      node: encodeAndroidFlat(
        node("", [
          node("cart_B", [node("item_42", [node("remove", [], 250)])], 300),
          ...(kind === "container-missing" ? [] : [cart]),
        ]),
      ),
    },
  };
}

const restorers: Array<() => void> = [];
afterEach(() => {
  for (const restore of restorers.splice(0).reverse()) {
    restore();
  }
});

function harness(route: Route, kind: Kind = "success", vision = false) {
  const device: BootedDevice = {
    deviceId: `fake-nested-drag-${route}`,
    name: "Nested drag",
    platform: "android",
    displays: {
      panels: [{ key: "external", role: "external", sizePx: { width: 500, height: 500 } }],
      postures: [],
    },
  };
  displayTransitions.reset(device.deviceId);
  const capture = hierarchy(kind);
  const observation: ObserveResult = {
    observationId: "nested-drag",
    timestamp: 1,
    displayRevision: 0,
    display: { key: "external", role: "external", posture: "unknown", generation: 1 },
    screenSize: { width: 500, height: 500 },
    viewHierarchy: capture,
  };
  const adb = new FakeAdbClient();
  adb.setCommandResult(
    "shell cmd display get-displays",
    'Display id 2: DisplayInfo{uniqueId "local:external" type EXTERNAL, real 500 x 500}',
  );
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const capturer = new FakeScreenshotCapturer();
  capturer.setPaths(["/fake/drag.png"]);
  const analyzer = new FakeVisionAnalyzer();
  const action = new DragAndDrop(device, adb as AdbClient, timer, {
    hierarchyCapture: new FakeHierarchyCapture(() => capture),
    lastRenderedObservation: () => observation,
    visionConfig: {
      enabled: vision,
      provider: "claude",
      confidenceThreshold: "high",
      maxCostUsd: 1,
      cacheResults: false,
      cacheTtlMinutes: 60,
    },
    screenshotCapturer: capturer,
    visionAnalyzer: analyzer,
  });
  const observe = new FakeObserveScreen();
  observe.setObserveResult(observation);
  action.observeScreen = observe;
  const predictions: unknown[] = [];
  action.observedInteraction = (callback, options) => {
    predictions.push(options?.predictionContext?.toolArgs);
    return callback(observation);
  };
  const client = AndroidCtrlProxyClient.getExistingInstance(device.deviceId)!;
  const drag = spyOn(client, "requestDrag").mockResolvedValue({ success: true, totalTimeMs: 0 });
  const capability = spyOn(client, "supportsCommand").mockResolvedValue(route !== "display-adb");
  const available = spyOn(AndroidCtrlProxyManager.prototype, "isAvailable").mockResolvedValue(true);
  restorers.push(() => {
    available.mockRestore();
    capability.mockRestore();
    drag.mockRestore();
    AndroidCtrlProxyClient.removeInstance(device.deviceId);
    displayTransitions.reset(device.deviceId);
  });
  const execute = (endpoints: Pick<DragAndDropOptions, "source" | "target">) =>
    action.execute({ ...endpoints, display: route === "default" ? undefined : "external" });
  const noTouch = () => {
    expect(drag).not.toHaveBeenCalled();
    expect(adb.wasCommandExecuted("input")).toBe(false);
  };
  const coordinates = (start: number, end: number) => {
    if (route === "display-adb") {
      expect(adb.getAllCommands()).toContain(
        `shell input touchscreen -d 2 draganddrop 50 ${start} 50 ${end} 300`,
      );
      expect(drag).not.toHaveBeenCalled();
    } else {
      expect(drag).toHaveBeenCalledTimes(1);
      expect(drag.mock.calls[0]?.slice(0, 4)).toEqual([50, start, 50, end]);
      expect(adb.wasCommandExecuted("input")).toBe(false);
    }
  };
  return { execute, noTouch, coordinates, predictions, analyzer };
}

for (const route of routes) {
  for (const text of [false, true]) {
    test(`${route}: nested ${text ? "text" : "ID"} source resolves across wrappers before drag`, async () => {
      const h = harness(route);
      const source = text
        ? { text: "remove", container: scope, selectionStrategy: "unique" as const }
        : scoped;
      const endpoints = { source, target: { elementId: "cart_B" } };
      expect((await h.execute(endpoints)).success).toBe(true);
      h.coordinates(50, 310);
      if (route === "default") {
        expect(h.predictions).toContainEqual(expect.objectContaining(endpoints));
      }
    });
  }
  test(`${route}: plain source defaults to first while target has its own nested scope`, async () => {
    const h = harness(route);
    expect((await h.execute({ source: { elementId: "remove" }, target: scoped })).success).toBe(
      true,
    );
    h.coordinates(260, 50);
  });
  test(`${route}: both endpoints have independent scopes and strategies`, async () => {
    const h = harness(route);
    expect(
      (
        await h.execute({
          source: scoped,
          target: {
            text: "remove",
            container: { elementId: "cart_B" },
            selectionStrategy: "random",
          },
        })
      ).success,
    ).toBe(true);
    h.coordinates(50, 260);
  });
  for (const endpoint of ["source", "target"] as const) {
    for (const [kind, message] of [
      ["container-missing", "Container level 1 not found: cart_A"],
      ["inner-missing", "Container level 2 not found: item_42"],
      ["container-ambiguous", "Container level 2 ambiguous"],
      ["leaf-missing", "Target not found within container"],
      ["leaf-ambiguous", "Target ambiguous: 2 matches; Candidates:"],
    ] as const) {
      test(`${route}: ${endpoint} ${kind} prevents every gesture`, async () => {
        const h = harness(route, kind);
        const endpoints = {
          source: { elementId: "cart_B" },
          target: { elementId: "cart_B" },
          [endpoint]: scoped,
        };
        const result = await h.execute(endpoints);
        expect(result.success).toBe(false);
        expect(result.error).toContain(`dragAndDrop ${endpoint}: ${message}`);
        if (kind.endsWith("ambiguous")) {
          expect(result.error).toContain("Candidates:");
          expect(result.error).toContain("bounds=");
        }
        h.noTouch();
      });
    }
  }
  test(`${route}: one-level scope miss with default strategy never selects globally`, async () => {
    const h = harness(route);
    const result = await h.execute({
      source: { elementId: "remove", container: { elementId: "missing" } },
      target: { elementId: "cart_B" },
    });
    expect(result.error).toContain("dragAndDrop source: Container level 1 not found: missing");
    h.noTouch();
  });
  test(`${route}: unscoped unique target ambiguity still identifies the endpoint`, async () => {
    const h = harness(route);
    const result = await h.execute({
      source: { elementId: "cart_B" },
      target: { text: "remove", selectionStrategy: "unique" },
    });
    expect(result.error).toContain("dragAndDrop target: Target ambiguous: 2 matches; Candidates:");
    h.noTouch();
  });
  test(`${route}: default first still honors a nested scope`, async () => {
    const h = harness(route);
    expect(
      (
        await h.execute({
          source: { elementId: "remove", container: scope },
          target: { elementId: "cart_B" },
        })
      ).success,
    ).toBe(true);
    h.coordinates(50, 310);
  });
  test(`${route}: one-level leaf miss retains the shared scoped failure`, async () => {
    const h = harness(route);
    const result = await h.execute({
      source: { elementId: "remove", container: { elementId: "cart_A" } },
      target: { elementId: "cart_A", container: { elementId: "cart_B" } },
    });
    expect(result.error).toContain("dragAndDrop target: Target not found within container");
    h.noTouch();
  });
}

for (const endpoint of ["source", "target"] as const) {
  test(`vision enrichment uses the failed scoped ${endpoint} criteria`, async () => {
    const h = harness("default", "leaf-missing", true);
    const result = await h.execute({
      source: { elementId: "cart_B" },
      target: { elementId: "cart_B" },
      [endpoint]: scoped,
    });
    expect(result.success).toBe(false);
    expect(h.analyzer.getCalls()).toHaveLength(1);
    expect(h.analyzer.getCalls()[0]?.searchCriteria).toMatchObject({
      resourceId: "remove",
      description: endpoint === "source" ? "Source element for drag" : "Target element for drop",
    });
    h.noTouch();
  });
}

test("target ambiguity candidates mentioning source do not misroute vision enrichment", async () => {
  const h = harness("default", "source-label-ambiguous", true);
  const result = await h.execute({ source: { elementId: "cart_B" }, target: scoped });
  expect(result.error).toContain("dragAndDrop target: Target ambiguous");
  expect(result.error).toContain("source remove");
  expect(h.analyzer.getCalls()).toHaveLength(1);
  expect(h.analyzer.getCalls()[0]?.searchCriteria).toMatchObject({
    resourceId: "remove",
    description: "Target element for drop",
  });
  h.noTouch();
});

for (const row of scopedSelectionMatrix) {
  test(`drag strict diagnostics matrix: ${row.name}`, async () => {
    const h = harness("default");
    const result = await h.execute({
      source: {
        elementId: "remove",
        container: row.container,
        selectionStrategy: row.selectionStrategy,
      },
      target: { elementId: "cart_B" },
    });
    if (row.anyContainer) {
      expect(result.error).toContain("dragAndDrop source: ");
    } else {
      expect(result.success).toBe(true);
    }
  });
}
