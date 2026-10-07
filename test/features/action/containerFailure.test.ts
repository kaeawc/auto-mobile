import { afterEach, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { ActionableError } from "../../../src/models/ActionableError";
import type { ViewHierarchyResult } from "../../../src/models";
import { ResolverElementSelector } from "../../../src/features/utility/ResolverElementSelector";
import type { ElementResolution } from "../../../src/features/utility/ElementResolver";
import { DragAndDrop } from "../../../src/features/action/DragAndDrop";
import { ScrollUntilVisible } from "../../../src/features/action/swipeon/ScrollUntilVisible";
import { DefaultElementGeometry } from "../../../src/features/utility/ElementGeometry";
import { shapeToolCallError } from "../../../src/server/shapeToolCallError";
import type { AdbClient } from "../../../src/utils/android-cmdline-tools/AdbClient";
import { AndroidCtrlProxyManager } from "../../../src/ctrlProxy/CtrlProxyManager";
import { AndroidCtrlProxyClient } from "../../../src/features/observe/android";
import { FakeHierarchyCapture } from "../../fakes/FakeHierarchyCapture";
import { FakeAdbClient } from "../../fakes/FakeAdbClient";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeObserveScreen } from "../../fakes/FakeObserveScreen";
import { FakeAccessibilityDetector } from "../../fakes/FakeAccessibilityDetector";
import { FakeScrollAccessibilityService } from "../../fakes/FakeScrollAccessibilityService";
import { FakeOverlayDetector } from "../../fakes/FakeOverlayDetector";
import { FakeTalkBackSwipeExecutor } from "../../fakes/FakeTalkBackSwipeExecutor";

const capture: ViewHierarchyResult = JSON.parse(
  readFileSync(
    `${import.meta.dir}/../../fixtures/android-focus/playground-text-field-pre-tap.json`,
    "utf8",
  ),
).viewHierarchy;
const device = { deviceId: "fake-container-failure", name: "Fake", platform: "android" } as const;
const missing = { elementId: "missing" };
const nested = { text: "inner", container: missing };
const empty: ElementResolution = { chosen: null, candidates: [], matchMode: "exact" };

afterEach(() => AndroidCtrlProxyClient.removeInstance(device.deviceId));

function thrown(action: () => unknown): ActionableError {
  try {
    action();
  } catch (error) {
    if (error instanceof ActionableError) {
      return error;
    }
    throw error;
  }
  throw new Error("Expected an ActionableError");
}

for (const [reason, message] of [
  ["not-found", "Container level 2 not found: inner"],
  ["ambiguous", "Container level 2 ambiguous: inner; Candidates: captured matches"],
] as const) {
  for (const tool of ["tapOn", "tapAny"] as const) {
    test(`${tool} selector carries nested ${reason} without returning an action target`, () => {
      const containerFailure = { level: 2, reason, selector: nested };
      const resolution = { ...empty, error: message, containerFailure };
      const selector = new ResolverElementSelector({ resolve: () => resolution });
      const error = thrown(() =>
        tool === "tapOn"
          ? selector.selectByText(capture, "target", { container: nested })
          : selector.selectClickable(capture, { container: nested }),
      );
      expect(error.message).toBe(message);
      expect(error).toHaveProperty("containerFailure", containerFailure);
      const wire = shapeToolCallError(error, { toolName: tool, source: "MCP" });
      expect(JSON.parse(wire.content[0].text)).toEqual({
        success: false,
        error: message,
        containerFailure,
      });
      expect(wire.isError).toBe(true);
    });
  }
}

test("ordinary selector errors keep their message and plain MCP envelope", () => {
  const selector = new ResolverElementSelector({
    resolve: () => ({ ...empty, error: "Target ambiguous: 2 matches" }),
  });
  const error = thrown(() => selector.selectByText(capture, "target"));
  expect(error.message).toBe("Target ambiguous: 2 matches");
  expect(error).not.toHaveProperty("containerFailure");
  expect(shapeToolCallError(error, { toolName: "tapOn", source: "MCP" })).toEqual({
    content: [{ type: "text", text: "Error: Target ambiguous: 2 matches" }],
    isError: true,
  });
});

function scroll(resolution: ElementResolution = empty) {
  const adb = new FakeAdbExecutor();
  const talkBack = new FakeTalkBackSwipeExecutor();
  const action = new ScrollUntilVisible({
    device,
    resolver: { resolve: () => resolution },
    geometry: new DefaultElementGeometry(),
    timer: new FakeTimer(),
    adb,
    observeScreen: new FakeObserveScreen(),
    accessibilityDetector: new FakeAccessibilityDetector(),
    accessibilityService: new FakeScrollAccessibilityService(),
    overlayDetector: new FakeOverlayDetector(),
    talkBackExecutor: talkBack,
    getDuration: () => 300,
    resolveBoomerangConfig: () => undefined,
    buildPredictionArgs: () => ({}),
    observedInteraction: async () => {
      throw new Error("Must not dispatch");
    },
  });
  return { action, adb };
}

test("swipeOn fallback carries its original single-level missing-container message", () => {
  const { action, adb } = scroll();
  const error = thrown(() => action.resolveSwipeContainer(capture, missing));
  expect(error.message).toBe("Container level 1 not found: missing");
  expect(error).toHaveProperty("containerFailure", {
    level: 1,
    reason: "not-found",
    selector: missing,
  });
  expect(adb.getExecutedCommands()).toEqual([]);
});

test("swipeOn preserves the resolver diagnostic instead of reconstructing its level", () => {
  const containerFailure = { level: 2, reason: "ambiguous" as const, selector: nested };
  const { action } = scroll({
    ...empty,
    error: "Container level 2 ambiguous: inner",
    ...{ containerFailure },
  });
  const error = thrown(() => action.resolveSwipeContainer(capture, nested));
  expect(error.message).toBe("Container level 2 ambiguous: inner");
  expect(error).toHaveProperty("containerFailure", containerFailure);
});

test("dragAndDrop preserves its fallback diagnostic through wrapping and result serialization", async () => {
  const adb = new FakeAdbClient();
  const manager = AndroidCtrlProxyManager.getInstance(device, new FakeAdbExecutor());
  const availability = spyOn(manager, "isAvailable").mockResolvedValue(true);
  const action = new DragAndDrop(device, adb as AdbClient, new FakeTimer(), {
    hierarchyCapture: new FakeHierarchyCapture(() => capture),
    visionConfig: {
      enabled: false,
      provider: "claude",
      confidenceThreshold: "high",
      maxCostUsd: 1,
      cacheResults: false,
      cacheTtlMinutes: 60,
    },
  });
  action.observedInteraction = async (callback) =>
    callback({ timestamp: 1, viewHierarchy: capture });
  const client = AndroidCtrlProxyClient.getExistingInstance(device.deviceId)!;
  const gesture = spyOn(client, "requestDrag").mockResolvedValue({ success: true, totalTimeMs: 0 });
  try {
    const result = await action.execute({
      source: { text: "target", container: missing },
      target: { text: "other" },
    });
    expect(result.error).toBe(
      "Failed to perform drag and drop: dragAndDrop source: Container level 1 not found: missing",
    );
    expect(result).toHaveProperty("containerFailure", {
      level: 1,
      reason: "not-found",
      selector: missing,
    });
    expect(gesture).not.toHaveBeenCalled();
    expect(adb.wasCommandExecuted("input")).toBe(false);
  } finally {
    gesture.mockRestore();
    availability.mockRestore();
  }
});
