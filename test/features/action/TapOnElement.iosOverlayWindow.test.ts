import { runBlockWithEnvelope } from "../../helpers/observedInteractionStub";
import { recordObservationRead } from "../../../src/features/observe/observationReadScope";
import { afterEach, describe, expect, test } from "bun:test";
import { TapOnElement } from "../../../src/features/action/TapOnElement";
import { AndroidCtrlProxyClient } from "../../../src/features/observe/android";
import { CtrlProxyHierarchy } from "../../../src/features/observe/ios/CtrlProxyHierarchy";
import { IOS_WINDOW_LAYER_EXTRA } from "../../../src/features/observe/ios/iosWindowLayer";
import type { HierarchyDelegateContext } from "../../../src/features/observe/ios/types";
import type { ObserveResult, ViewHierarchyResult } from "../../../src/models";
import { DEFAULT_VISION_CONFIG } from "../../../src/vision";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeTapStrategy } from "../../fakes/FakeTapStrategy";
import { FakeTimer } from "../../fakes/FakeTimer";
import { iosFloatingOverlayOverSettings } from "../../fixtures/observe/iosOverlayWindow";
import { createFlatNodeForTest } from "../observe/flatHierarchyBuilders";
import { PROTOTYPE_WINDOW_MARKER_ID } from "../../../src/features/prototype/prototypeHostControls";
import { tapOnHandler } from "../../../src/server/interactionTools/tapHandlers";
import { getStructuredField } from "../../../src/utils/toolUtils";
import { FakePrototypeAgentClient } from "../../fakes/FakePrototypeAgentClient";

afterEach(() => AndroidCtrlProxyClient.resetInstances());

function captured(): ViewHierarchyResult {
  return new CtrlProxyHierarchy({} as HierarchyDelegateContext).convertToViewHierarchyResult(
    iosFloatingOverlayOverSettings(),
  );
}

/** The same capture as a converter without window layers would have produced it. */
function withoutLayers(): ViewHierarchyResult {
  return JSON.parse(
    JSON.stringify(captured()).replaceAll(`"${IOS_WINDOW_LAYER_EXTRA}"`, '"unrelated"'),
  ) as ViewHierarchyResult;
}

async function tapElement(
  hierarchy: ViewHierarchyResult,
  elementId: string,
  agent?: FakePrototypeAgentClient,
) {
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const agentLookups: Array<{ deviceId: string; bundleId: string }> = [];
  const tap = new TapOnElement(
    { name: "prototype", platform: "ios", deviceId: "prototype" },
    new FakeAdbExecutor(),
    {
      timer,
      prototypeAgents: {
        get: (deviceId, bundleId) => {
          agentLookups.push({ deviceId, bundleId });
          return agent;
        },
      },
      tapStrategy: FakeTapStrategy.ios(),
      visionConfig: { ...DEFAULT_VISION_CONFIG, enabled: false },
      selectionStateTracker: { prepare: async () => null, finalize: async () => [] },
    },
  );
  const observation: ObserveResult = {
    display: { key: "default", role: "unknown", posture: "unknown", generation: 0 },
    observationId: "ios-overlay-window",
    updatedAt: 1,
    screenSize: { width: 402, height: 874 },
    viewHierarchy: hierarchy,
    systemInsets: hierarchy.systemInsets ?? { top: 0, right: 0, bottom: 0, left: 0 },
  };
  const points: Array<{ x: number; y: number }> = [];
  tap.observedInteraction = runBlockWithEnvelope(() => recordObservationRead(observation), {
    observation,
  });
  tap.refreshViewHierarchy = async () => hierarchy;
  tap.testHooks.setIosCoordinateTap(async (_action, x, y) => {
    points.push({ x, y });
  });
  tap.deriveTapEffectAfterPostTapObservation = async (_before, current) => ({
    effect: undefined,
    observation: current,
  });
  tap.prepareSelectionCapture = async () => null;
  tap.testHooks.setTerminalScreenshotCapture(async () => {});
  tap.testHooks.setDeferredPredictionRecorder(async () => {});
  tap.enforceFreshnessConsistencyWithEffect = () => {};
  const result = await tap.execute({ elementId, action: "tap", searchUntil: { duration: 200 } });
  return { result, points, command: tap, agentLookups, observation, timer };
}

describe("tapOn controls in a captured in-app iOS prototype window", () => {
  test("taps the prototype dismiss control drawn over the app's navigation bar", async () => {
    const { result, points } = await tapElement(captured(), "automobile-prototype-dismiss");
    expect(result.success).toBe(true);
    expect(points).toEqual([{ x: 372, y: 84 }]);
  });

  test("taps the centre of prototype buttons drawn over the app's toolbar", async () => {
    const close = await tapElement(captured(), "close-button");
    expect(close.result.success).toBe(true);
    expect(close.points).toEqual([{ x: 171, y: 802 }]);
  });

  test("without window layers the toolbar clips the close button to its exposed strip", async () => {
    // The dismiss control in the navigation-bar band no longer depends on the layer: a
    // non-scrolling control wholly inside the bar is bar-level content (#10635).
    const { result, points } = await tapElement(withoutLayers(), "close-button");
    expect(result.success).toBe(true);
    expect(points).toEqual([{ x: 171, y: 784 }]);
  });
});

function fullscreenPrototype(top: number, bottom: number): ViewHierarchyResult {
  return {
    packageName: "dev.jasonpearson.ProtoViewer",
    screenWidth: 402,
    screenHeight: 874,
    systemInsets: { top: 59, bottom: 34, left: 0, right: 0 },
    insets: {
      available: true,
      source: "ios-sdk-safe-area",
      units: "points",
      safeArea: { top: 59, bottom: 34, left: 0, right: 0 },
      systemChrome: {
        visibility: "visible",
        statusBar: "visible",
        source: "ios-status-bar-manager",
      },
    },
    hierarchy: {
      node: createFlatNodeForTest({
        class: "XCUIApplication",
        bounds: { left: 0, top: 0, right: 402, bottom: 874 },
        node: [
          createFlatNodeForTest({
            class: "UIView",
            "resource-id": PROTOTYPE_WINDOW_MARKER_ID,
            bounds: { left: 0, top: 0, right: 402, bottom: 874 },
            node: [
              createFlatNodeForTest({
                class: "UIButton",
                "resource-id": "emit-control",
                text: "Emit",
                clickable: true,
                enabled: true,
                bounds: { left: 100, top, right: 200, bottom },
              }),
            ],
          }),
        ],
      }),
    },
  };
}

describe("tapOn in a fullscreen iOS prototype under the status bar (#16175)", () => {
  test("returns an actionable error without dispatching a touch swallowed by the status bar", async () => {
    const { result, points, command } = await tapElement(
      fullscreenPrototype(0, 40),
      "emit-control",
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("under the status bar");
    expect(result.error).toContain("safeAreaPadding");
    expect(points).toEqual([]);
    const response = await tapOnHandler(
      { name: "prototype", platform: "ios", deviceId: "prototype" },
      { selector: { elementId: "emit-control" }, action: "tap" },
      { deps: { tapOnElementFactory: () => command } },
    );
    expect(response.isError).toBe(true);
    expect(getStructuredField(response, "message")).toContain("Failed to tap:");
    expect(getStructuredField(response, "message")).not.toContain("Tapped on element");
    expect(points).toEqual([]);
  });

  test("taps the reachable part of a control straddling the status-bar edge", async () => {
    const { result, points } = await tapElement(fullscreenPrototype(40, 70), "emit-control");
    expect(result.success).toBe(true);
    expect(points).toEqual([{ x: 150, y: 64 }]);
  });

  test("a control 160 points below the top keeps its original tap point", async () => {
    const { result, points } = await tapElement(fullscreenPrototype(160, 200), "emit-control");
    expect(result.success).toBe(true);
    expect(result.warnings).toBeUndefined();
    expect(points).toEqual([{ x: 150, y: 180 }]);
  });

  test("without captured visibility it taps with the existing unverified warning", async () => {
    const hierarchy = fullscreenPrototype(0, 40);
    delete hierarchy.insets?.systemChrome;
    const { result, points } = await tapElement(hierarchy, "emit-control");
    expect(result.success).toBe(true);
    expect(result.warnings?.join(" ")).toContain("does not say whether the bars are showing");
    expect(points).toEqual([{ x: 150, y: 20 }]);
  });
});

function viewerWithoutSdk(top: number, bottom: number): ViewHierarchyResult {
  const hierarchy = fullscreenPrototype(top, bottom);
  hierarchy.insets = { available: false, source: "unavailable", units: "unknown" };
  delete hierarchy.systemInsets;
  return hierarchy;
}

describe("tapOn reads the iOS prototype agent's safe area", () => {
  test("59 points refuses the top row and surfaces an MCP error without dispatch", async () => {
    const hierarchy = viewerWithoutSdk(0, 44);
    const agent = new FakePrototypeAgentClient();
    agent.queueReplies({ status: { safeAreaTop: 59 } }, { status: { safeAreaTop: 59 } });
    const { result, points, command, agentLookups, observation, timer } = await tapElement(
      hierarchy,
      "emit-control",
      agent,
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("under the status bar");
    expect(points).toEqual([]);
    expect(agentLookups).toEqual([
      { deviceId: "prototype", bundleId: "dev.jasonpearson.ProtoViewer" },
    ]);
    expect(agent.requests).toEqual([{ type: "get_prototype_status", body: {} }]);
    expect(observation.viewHierarchy?.insets).toEqual({
      available: false,
      source: "unavailable",
      units: "unknown",
    });
    expect(timer.getSleepHistory()).toEqual([]);
    const response = await tapOnHandler(
      { name: "prototype", platform: "ios", deviceId: "prototype" },
      { selector: { elementId: "emit-control" }, action: "tap" },
      { deps: { tapOnElementFactory: () => command } },
    );
    expect(response.isError).toBe(true);
    expect(getStructuredField(response, "message")).not.toContain("Tapped on element");
    expect(points).toEqual([]);
  });

  test("59 points leaves a control at y 160 unchanged", async () => {
    const agent = new FakePrototypeAgentClient();
    agent.queueReplies({ status: { safeAreaTop: 59 } });
    const { result, points } = await tapElement(viewerWithoutSdk(160, 204), "emit-control", agent);
    expect(result.success).toBe(true);
    expect(result.warnings).toBeUndefined();
    expect(points).toEqual([{ x: 150, y: 182 }]);
  });

  test("59 points re-points a straddling control below the bar", async () => {
    const agent = new FakePrototypeAgentClient();
    agent.queueReplies({ status: { safeAreaTop: 59 } });
    const { result, points } = await tapElement(viewerWithoutSdk(40, 70), "emit-control", agent);
    expect(result.success).toBe(true);
    expect(points).toEqual([{ x: 150, y: 64 }]);
  });

  test("zero means hidden, overriding stale observation insets", async () => {
    const agent = new FakePrototypeAgentClient();
    agent.queueReplies({ status: { safeAreaTop: 0 } });
    const { result, points } = await tapElement(fullscreenPrototype(0, 44), "emit-control", agent);
    expect(result.success).toBe(true);
    expect(result.warnings).toBeUndefined();
    expect(points).toEqual([{ x: 150, y: 22 }]);
  });

  test("an unreachable agent proceeds with the unverified warning", async () => {
    const agent = new FakePrototypeAgentClient();
    agent.queueReplies(new Error("connection closed"));
    const { result, points, timer } = await tapElement(
      viewerWithoutSdk(0, 44),
      "emit-control",
      agent,
    );
    expect(result.success).toBe(true);
    expect(result.warnings?.join(" ")).toContain("does not say whether the bars are showing");
    expect(points).toEqual([{ x: 150, y: 22 }]);
    expect(timer.getSleepHistory()).toEqual([]);
  });

  test("an older status reply proceeds with the unverified warning", async () => {
    const agent = new FakePrototypeAgentClient();
    agent.queueReplies({ status: { shown: true } });
    const hierarchy = viewerWithoutSdk(0, 44);
    hierarchy.systemInsets = { top: 0, left: 0, right: 0, bottom: 0 };
    const { result, points } = await tapElement(hierarchy, "emit-control", agent);
    expect(result.success).toBe(true);
    expect(result.warnings?.join(" ")).toContain("does not say whether the bars are showing");
    expect(points).toEqual([{ x: 150, y: 22 }]);
  });

  test("no connected agent proceeds with the unverified warning", async () => {
    const { result, points } = await tapElement(viewerWithoutSdk(0, 44), "emit-control");
    expect(result.success).toBe(true);
    expect(result.warnings?.join(" ")).toContain("does not say whether the bars are showing");
    expect(points).toEqual([{ x: 150, y: 22 }]);
  });
});
