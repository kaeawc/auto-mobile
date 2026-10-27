import { runBlockWithEnvelope } from "../../helpers/observedInteractionStub";
import { recordObservationRead } from "../../../src/features/observe/observationReadScope";
import { BaseVisualChange } from "../../../src/features/action/BaseVisualChange";
import { expect, spyOn } from "bun:test";
import { warmedTests } from "../../helpers/warmedTests";
import { readFileSync } from "node:fs";
import { TapAnyElement } from "../../../src/features/action/TapAnyElement";
import { runWithSelectedDisplayPin } from "../../../src/features/observe/SessionDisplayContext";
import { DisplaySelectionError } from "../../../src/features/observe/DisplaySelection";
import { AndroidCtrlProxyClient } from "../../../src/features/observe/android";
import type { BootedDevice, TapAnyElementOptions, ViewHierarchyNode } from "../../../src/models";
import { FakeAdbClient } from "../../fakes/FakeAdbClient";
import { FakeObserveScreen } from "../../fakes/FakeObserveScreen";
import { FakeHierarchyCapture } from "../../fakes/FakeHierarchyCapture";
import { FakeDisplayTransitionReader } from "../../fakes/FakeDisplayTransitionReader";
import { FakeAccessibilityDetector } from "../../fakes/FakeAccessibilityDetector";
import { FakeTimer } from "../../fakes/FakeTimer";
import { OPERATION_CANCELLED_MESSAGE } from "../../../src/utils/constants";
import { FakeTalkBackNavigationDriver } from "../../fakes/FakeTalkBackNavigationDriver";
import {
  TALKBACK_ACTIVATION_WARNING,
  TalkBackTapStrategy,
} from "../../../src/features/talkback/TalkBackTapStrategy";
import { TALKBACK_STATE_UNKNOWN_WARNING } from "../../../src/ctrlProxy/accessibility/interfaces/AccessibilityDetector";
import { loadAndroidHomeObserve } from "../../fixtures/observe/observeFixture";

const inner = "4619827259835644672";
const cover = "4619827259835644673";
const device: BootedDevice = {
  deviceId: "tap-any-display",
  name: "fake fold",
  platform: "android",
  displays: {
    panels: [
      { key: inner, role: "inner", sizePx: { width: 2076, height: 2152 } },
      { key: cover, role: "cover", sizePx: { width: 1080, height: 2364 } },
    ],
    postures: ["opened", "closed"],
  },
};
const restores: Array<() => void> = [];
// First-use costs are paid in beforeAll (outside CI's per-test time); this resets between runs.
const test = warmedTests(() => {
  for (const restore of restores.splice(0)) {
    restore();
  }
});

/** true: TalkBack on, null: state unknown; default off. */
function harness(
  ctrlProxy: boolean,
  targetDevice = device,
  talkBack: boolean | null = false,
  tappers: Pick<
    NonNullable<ConstructorParameters<typeof TapAnyElement>[2]>,
    "androidTapper" | "iosTapper"
  > = {},
) {
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const transitions = new FakeDisplayTransitionReader();
  transitions.panel = { key: cover, role: "cover" };
  const observation = structuredClone(loadAndroidHomeObserve().observe);
  observation.display = { key: cover, role: "cover", posture: "closed", generation: 0 };
  observation.viewHierarchy!.displayId = 3;
  const capture = new FakeHierarchyCapture(() => observation.viewHierarchy!);
  const adb = new FakeAdbClient();
  adb.setCommandResult(
    "shell cmd display get-displays",
    readFileSync(
      new URL("../../fixtures/android-display/fold-displays.txt", import.meta.url),
      "utf8",
    ),
  );
  const detector = new FakeAccessibilityDetector();
  if (talkBack === true) {
    detector.setDetectionResult(device.deviceId, true);
  } else if (talkBack === null) {
    detector.setDefaultResult(null);
  }
  const talkBackDriver = new FakeTalkBackNavigationDriver();
  const deps = {
    ...tappers,
    timer,
    hierarchyCapture: capture,
    displayTransitions: transitions,
    lastRenderedObservation: () => observation,
    accessibilityDetector: detector,
    talkBackStrategy: new TalkBackTapStrategy({ timer }),
    talkBackDriverFactory: { createDriver: () => talkBackDriver },
  };
  const action = new TapAnyElement(targetDevice, adb, deps);
  const observe = new FakeObserveScreen();
  observe.setObserveResult(observation);
  action.observeScreen = observe;
  // Keep post-observation bookkeeping out of the transport regression test.
  action.observedInteraction = async (block, options) => ({
    ...(await runBlockWithEnvelope(
      () => recordObservationRead(options.previousObservation ?? observation),
      {},
    )(block, options)),
    observation,
  });
  const client = AndroidCtrlProxyClient.getInstance(device);
  const capability = spyOn(client, "supportsCommand").mockResolvedValue(ctrlProxy);
  const dispatches: Array<number | undefined> = [];
  let onDispatch = () => {};
  const tap = spyOn(client, "requestTapCoordinates").mockImplementation(async (...args) => {
    args[0].beforeSend?.();
    dispatches.push(args[0].displayId);
    onDispatch();
    return { success: true, totalTimeMs: 0 };
  });
  restores.push(
    () => capability.mockRestore(),
    () => tap.mockRestore(),
  );
  return {
    action,
    adb,
    capture,
    observe,
    observation,
    transitions,
    dispatches,
    talkBackDriver,
    onDispatch: (callback: () => void) => {
      onDispatch = callback;
    },
  };
}

for (const ctrlProxy of [false, true]) {
  test(`tapAny explicit display routes and retries on selected panel via ${ctrlProxy ? "CtrlProxy" : "adb"}`, async () => {
    const h = harness(ctrlProxy);
    const options = { action: "tap" as const, display: "cover" };
    const result = await h.action.execute(options);
    expect(result.success).toBe(true);
    expect(h.observe.getExecuteOptions()).toEqual([expect.objectContaining({ display: "cover" })]);
    expect(h.capture.requests.length).toBeGreaterThan(0);
    expect(h.capture.requests.every((request) => request.displayId === 3)).toBe(true);
    if (ctrlProxy) {
      expect(h.dispatches).toEqual([3, 3]);
      expect(
        h.adb.getCommandCalls().some((call) => call.command.includes("input touchscreen")),
      ).toBe(false);
    } else {
      const taps = h.adb
        .getCommandCalls()
        .filter((call) => call.command.includes("input touchscreen"));
      expect(taps).toHaveLength(2);
      expect(taps.every((call) => call.command.includes("touchscreen -d 3 tap"))).toBe(true);
    }
  });
  test(`tapAny display fence changes before dispatch via ${ctrlProxy ? "CtrlProxy" : "adb"}`, async () => {
    const h = harness(ctrlProxy);
    const client = AndroidCtrlProxyClient.getExistingInstance(device.deviceId)!;
    const capability = spyOn(client, "supportsCommand").mockImplementation(async () => {
      h.transitions.transition();
      return ctrlProxy;
    });
    restores.push(() => capability.mockRestore());
    const result = await h.action.execute({ action: "tap", ...{ display: "cover" } });
    expect(result.staleDisplay?.retry).toBe("observe");
    expect(h.dispatches).toEqual([]);
    expect(h.adb.getCommandCalls().some((call) => call.command.includes("input touchscreen"))).toBe(
      false,
    );
  });
}

test("tapAny unreadable post-tap fingerprint skips second dispatch", async () => {
  const h = harness(true);
  h.onDispatch(() => {
    // JSON.stringify throws on a BigInt, so the fingerprint is unreadable. A self-referencing node
    // is also unreadable but walks the cycle on this path (~20 ms); that case is pinned by the
    // hierarchyFingerprint property test.
    const node: ViewHierarchyNode = {};
    (node as Record<string, unknown>).unserializable = 1n;
    h.observation.viewHierarchy!.hierarchy.node = node;
  });
  expect((await h.action.execute({ action: "tap", display: "cover" })).success).toBe(true);
  expect(h.dispatches).toEqual([3]);
});

test("tapAny wrong-panel retry capture fails stale without another dispatch", async () => {
  const h = harness(true);
  h.observation.viewHierarchy!.displayId = 0;
  const result = await h.action.execute({ action: "tap", ...{ display: "cover" } });
  expect(result.staleDisplay?.retry).toBe("observe");
  expect(h.dispatches).toEqual([3]);
});

test("tapAny single-display omitted display retains default dispatch path", async () => {
  const points: number[] = [];
  const h = harness(false, { ...device, displays: undefined }, false, {
    androidTapper: {
      executeAndroidTap: async (_action, x) => {
        points.push(x);
      },
      retryAndroidTapIfNoChange: async () => {},
    },
  });
  h.action.testHooks.setRefreshViewHierarchy(async () => null);
  expect((await h.action.execute({ action: "tap" })).success).toBe(true);
  expect(points).toHaveLength(1);
  expect(h.observe.getExecuteCallCount()).toBe(0);
  expect(h.capture.requests).toEqual([]);
  expect(h.adb.getCommandCalls()).toEqual([]);
});

test("tapAny single-display pin targets logical zero through fake input and capture", async () => {
  const single = { ...device, displays: undefined };
  const h = harness(false, single);
  h.observation.display = { key: "0", role: "unknown", posture: "unknown", generation: 0 };
  h.observation.viewHierarchy!.displayId = 0;
  h.transitions.panel = { key: "0", role: "unknown" };
  const result = await runWithSelectedDisplayPin({ pin: "0", inventory: undefined }, () =>
    h.action.execute({ action: "tap", display: "0" }),
  );
  expect(result.success).toBe(true);
  expect(h.observe.getExecuteOptions()).toEqual([expect.objectContaining({ display: "0" })]);
  expect(h.capture.requests.length).toBeGreaterThan(0);
  expect(h.capture.requests.every((request) => request.displayId === 0)).toBe(true);
  // Logical zero retains CtrlProxy's ordinary default-display input contract.
  expect(h.dispatches).toEqual([undefined, undefined]);
  expect(h.adb.getCommandCalls()).toEqual([]);
});

for (const extra of [
  { scrollableContainer: true },
  { searchUntil: { duration: 100 } },
  { container: { elementId: "com.google.android.apps.nexuslauncher:id/workspace" } },
  { container: { text: "missing" }, searchUntil: { duration: 300 } },
] satisfies Partial<TapAnyElementOptions>[]) {
  test(`tapAny display keeps supported selection options on selected panel: ${JSON.stringify(extra)}`, async () => {
    const h = harness(true);
    const result = await h.action.execute({ action: "tap", ...{ display: "cover" }, ...extra });
    expect(result.error ?? "").not.toContain("is not supported with `display` yet");
    expect(h.observe.getExecuteOptions()[0]).toMatchObject({ display: "cover" });
    expect(h.capture.requests.length).toBeGreaterThan(0);
    expect(h.capture.requests.every((request) => request.displayId === 3)).toBe(true);
  });
}

test("tapAny live pinned panel disappearance preserves typed pin details without dispatch", async () => {
  const h = harness(true);
  h.adb.setCommandResult("shell cmd display get-displays", "");
  const result = await runWithSelectedDisplayPin({ pin: "cover", inventory: device.displays }, () =>
    h.action.execute({ action: "tap", display: "cover" }),
  );
  expect(result).toMatchObject({ success: false, pinnedDisplay: { pin: "cover" } });
  expect(h.dispatches).toEqual([]);
  expect(h.adb.getCommandCalls().some((call) => call.command.includes("input touchscreen"))).toBe(
    false,
  );
});

for (const unavailable of [false, true]) {
  test(`tapAny iOS display validates the live panel before input, unavailable=${unavailable}`, async () => {
    let taps = 0;
    const h = harness(false, { ...device, platform: "ios" }, false, {
      iosTapper: {
        executeIosTap: async () => {
          taps++;
        },
      },
    });
    const execute = spyOn(h.observe, "execute").mockImplementation(async (options) => {
      expect(options?.display).toBe("cover");
      if (unavailable) {
        throw new DisplaySelectionError("Selected iOS panel is not live");
      }
      return h.observation;
    });
    restores.push(() => execute.mockRestore());
    const result = await h.action.execute({ action: "tap", display: "cover" });
    expect(result.success).toBe(!unavailable);
    expect(taps).toBe(unavailable ? 0 : 1);
    expect(h.adb.getCommandCalls()).toEqual([]);
  });
}

test.each(["settle-throws", "throws", "settle-transition"] as const)(
  "confirmed display tapAny preserves delivery after %s",
  async (outcome) => {
    const h = harness(true);
    h.action.observedInteraction = BaseVisualChange.prototype.observedInteraction;
    let postReads = 0;
    h.observe.setObserveResult(() => {
      if (h.dispatches.length > 0) {
        postReads++;
        if (outcome === "throws" || postReads > 1) {
          if (outcome === "settle-transition") {
            h.transitions.transition();
          }
          throw new Error("display post-read unavailable");
        }
      }
      return h.observation;
    });
    const result = await h.action.execute({ action: "tap", display: "cover" });
    expect(h.dispatches.length).toBeGreaterThan(0);
    if (outcome === "throws") {
      expect(result.success).toBe(false);
      expect(result.error).toContain("Do not retry automatically");
      expect(result.observation).toBeUndefined();
    } else {
      expect(result.success).toBe(true);
      expect(result.observation?.viewHierarchy).toEqual(h.observation.viewHierarchy);
      expect(result.observation?.freshness?.warning).toContain("display settle");
      if (outcome === "settle-transition") {
        expect(result.staleDisplay?.retry).toBe("observe");
      }
    }
  },
);

test("tapAny block refusal before dispatch never receives the dispatched marker", async () => {
  const h = harness(true);
  h.action.observedInteraction = (block, options) => {
    h.transitions.transition();
    const observation = { ...h.observation, viewHierarchy: undefined };
    return runBlockWithEnvelope(observation, { observation })(block, options);
  };
  const result = await h.action.execute({ action: "tap", display: "cover" });
  expect(result.success).toBe(false);
  expect(result.error).not.toContain("gesture was dispatched");
  expect(result.error).not.toContain("Do not retry automatically");
  expect(h.dispatches).toEqual([]);
});

for (const ctrlProxy of [true, false]) {
  for (const action of ["tap", "doubleTap", "longPress"] as const) {
    test(`tapAny TalkBack on refuses ${action} on a non-default display before any gesture via ${ctrlProxy ? "CtrlProxy" : "adb"}`, async () => {
      const h = harness(ctrlProxy, device, true);
      const result = await h.action.execute({ action, display: "cover" });
      expect(result.success).toBe(false);
      expect(result.error).toContain("TalkBack coordinate activation cannot target display 3");
      expect(result.error).toContain("no gesture was dispatched");
      expect(h.dispatches).toEqual([]);
      expect(h.talkBackDriver.tapHistory).toEqual([]);
      expect(h.talkBackDriver.doubleTapHistory).toEqual([]);
      expect(
        h.adb.getCommandCalls().some((call) => call.command.includes("input touchscreen")),
      ).toBe(false);
    });
  }
}

test("tapAny TalkBack on refuses a session-pinned display the same way", async () => {
  const h = harness(true, device, true);
  const result = await runWithSelectedDisplayPin({ pin: "cover", inventory: device.displays }, () =>
    h.action.execute({ action: "tap", display: "cover" }),
  );
  expect(result.success).toBe(false);
  expect(result.error).toContain("TalkBack coordinate activation cannot target display 3");
  expect(h.dispatches).toEqual([]);
});

test("tapAny TalkBack on, explicit display 0: a completed activation carries the unconfirmed warning", async () => {
  const h = harness(true, device, true);
  h.transitions.panel = { key: inner, role: "inner" };
  h.observation.display = { key: inner, role: "inner", posture: "opened", generation: 0 };
  h.observation.viewHierarchy!.displayId = 0;
  const result = await h.action.execute({ action: "tap", display: "inner" });
  expect(result.error).toBeUndefined();
  expect(result.success).toBe(true);
  expect(result.warnings).toEqual([TALKBACK_ACTIVATION_WARNING]);
  expect(h.dispatches).toEqual([]);
  // The unchanged-hierarchy retry re-dispatches through the same TalkBack strategy.
  expect(h.talkBackDriver.doubleTapHistory.length).toBeGreaterThan(0);
});

test("tapAny TalkBack on, display 0: a cancellation after a completed double tap rethrows", async () => {
  const h = harness(true, device, true);
  h.transitions.panel = { key: inner, role: "inner" };
  h.observation.display = { key: inner, role: "inner", posture: "opened", generation: 0 };
  h.observation.viewHierarchy!.displayId = 0;
  const controller = new AbortController();
  const requestDoubleTap = h.talkBackDriver.requestDoubleTapCoordinates.bind(h.talkBackDriver);
  h.talkBackDriver.requestDoubleTapCoordinates = async (...args) => {
    const result = await requestDoubleTap(...args);
    controller.abort();
    return result;
  };
  await expect(
    h.action.execute({ action: "doubleTap", display: "inner" }, { signal: controller.signal }),
  ).rejects.toThrow(OPERATION_CANCELLED_MESSAGE);
  // One atomic request delivered both touches; no partial-application error result.
  expect(h.talkBackDriver.doubleTapHistory).toHaveLength(1);
});

test("tapAny TalkBack state unknown keeps the raw display dispatch and warns", async () => {
  const h = harness(true, device, null);
  const result = await h.action.execute({ action: "tap", display: "cover" });
  expect(result.success).toBe(true);
  expect(result.warnings).toContain(TALKBACK_STATE_UNKNOWN_WARNING);
  expect(h.dispatches).toEqual([3, 3]);
  expect(h.talkBackDriver.tapHistory).toEqual([]);
});
