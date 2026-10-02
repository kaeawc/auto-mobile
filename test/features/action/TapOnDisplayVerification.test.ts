import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { ActionableError } from "../../../src/models/ActionableError";
import { TapOnElement } from "../../../src/features/action/TapOnElement";
import { AndroidCtrlProxyClient } from "../../../src/features/observe/android";
import type {
  HierarchyCapture,
  HierarchyCaptureRequest,
  HierarchySnapshot,
} from "../../../src/features/observe/HierarchyCapture";
import type { BootedDevice, ObserveResult, ViewHierarchyResult } from "../../../src/models";
import type { TapOnElementOptions } from "../../../src/models/TapOnElementOptions";
import {
  POST_TAP_SETTLE_MS,
  PRE_RETRY_DELAY_MS,
} from "../../../src/features/action/androidGhostTapRetry";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeDisplayTransitionReader } from "../../fakes/FakeDisplayTransitionReader";
import { FakeObserveScreen } from "../../fakes/FakeObserveScreen";
import { FakeTimer } from "../../fakes/FakeTimer";

const device = {
  deviceId: "tap-display-verification",
  platform: "android",
  name: "Android",
  displays: {
    panels: [
      { key: "internal", role: "inner", sizePx: { width: 100, height: 100 } },
      { key: "external", role: "external", sizePx: { width: 200, height: 200 } },
    ],
    postures: [],
  },
} as BootedDevice;

function hierarchy(
  options: { checked?: boolean; left?: number; text?: string; displayId?: number } = {},
): ViewHierarchyResult {
  return {
    displayId: options.displayId ?? 2,
    screenWidth: 200,
    screenHeight: 200,
    hierarchy: {
      bounds: { left: 0, top: 0, right: 200, bottom: 200 },
      node: {
        text: options.text ?? "Wi-Fi",
        "resource-id": "app:id/toggle",
        class: "android.widget.Switch",
        clickable: true,
        checkable: options.checked !== undefined,
        checked: options.checked ?? false,
        bounds: { left: options.left ?? 20, top: 30, right: (options.left ?? 20) + 60, bottom: 90 },
      },
    },
  };
}

class PanelCapture implements HierarchyCapture {
  readonly requests: HierarchyCaptureRequest[] = [];
  read: (index: number) => ViewHierarchyResult = () => hierarchy();
  async capture(request: HierarchyCaptureRequest): Promise<HierarchySnapshot> {
    this.requests.push(request);
    return {
      captureId: `panel-${this.requests.length}`,
      platform: "android",
      requestedFreshness: request.freshness,
      receivedAt: 0,
      hierarchy: this.read(this.requests.length),
      nodes: [],
    };
  }
}

const restores: Array<() => void> = [];
afterEach(() => {
  for (const restore of restores.splice(0)) {
    restore();
  }
});

function harness(
  ctrlProxy: boolean,
  options: { checked?: boolean; productionCapture?: boolean } = {},
) {
  const transitions = new FakeDisplayTransitionReader();
  transitions.panel = { key: "external", role: "external" };
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  timer.setCurrentTime(100);
  const capture = new PanelCapture();
  const executor = new FakeAdbExecutor();
  executor.setCommandResponse("cmd display get-displays", {
    stdout:
      'Display id 0: DisplayInfo{uniqueId "local:internal" type INTERNAL, real 100 x 100}\nDisplay id 2: DisplayInfo{uniqueId "local:external" type EXTERNAL, real 200 x 200}',
    stderr: "",
    toString: () => "",
    trim: () => "",
    includes: () => false,
  });
  const dispatches: Array<{ displayId?: number; x: number; y: number }> = [];
  let onDispatch = () => {};
  let current = hierarchy({ checked: options.checked });
  const observation = (): ObserveResult => ({
    observationId: "panel",
    timestamp: timer.now(),
    displayRevision: transitions.fullRevision,
    display: {
      key: "external",
      role: "external",
      posture: "unknown",
      generation: transitions.generation,
    },
    screenSize: { width: 200, height: 200 },
    rotation: 0,
    systemInsets: { left: 0, top: 0, right: 0, bottom: 0 },
    viewHierarchy: { ...current, updatedAt: timer.now() + 1 },
  });
  capture.read = () => ({ ...current });
  const observe = new FakeObserveScreen();
  observe.setObserveResult(observation);
  const action = new TapOnElement(device, executor, {
    timer,
    displayTransitions: transitions,
    lastRenderedObservation: () => observation(),
    ...(options.productionCapture ? {} : { hierarchyCapture: capture }),
  });
  action.observeScreen = observe;
  const client = AndroidCtrlProxyClient.getExistingInstance(device.deviceId)!;
  const capability = spyOn(client, "supportsCommand").mockResolvedValue(ctrlProxy);
  const tap = spyOn(client, "requestTapCoordinates").mockImplementation(async (...args) => {
    args[9]?.();
    dispatches.push({ x: args[0], y: args[1], displayId: args[8] });
    onDispatch();
    return { success: true, totalTimeMs: 0 };
  });
  const executeCommand = executor.executeCommand.bind(executor);
  const adbTap = spyOn(executor, "executeCommand").mockImplementation(async (...args) => {
    if (args[0].includes("touchscreen")) {
      expect(args[0]).toStartWith("shell input touchscreen -d 2 tap ");
      const words = args[0].split(" ");
      dispatches.push({ displayId: Number(words[4]), x: Number(words[6]), y: Number(words[7]) });
      onDispatch();
    }
    return executeCommand(...args);
  });
  restores.push(
    () => capability.mockRestore(),
    () => tap.mockRestore(),
    () => adbTap.mockRestore(),
  );
  return {
    action,
    capture,
    timer,
    transitions,
    dispatches,
    observe,
    client,
    observation,
    setCurrent: (next: ViewHierarchyResult) => {
      current = next;
    },
    onDispatch: (callback: () => void) => {
      onDispatch = callback;
    },
    execute: (extra: Partial<TapOnElementOptions>) =>
      action.execute({ text: "Wi-Fi", action: "tap", display: "external", ...extra }),
  };
}

function expectTargeted(capture: PanelCapture) {
  expect(capture.requests.length).toBeGreaterThan(0);
  expect(
    capture.requests.every((request) => request.displayId === 2 && request.freshness === "fresh"),
  ).toBe(true);
}

const stabilityError =
  "Android tap aborted: could not re-find the target in the accessibility hierarchy with stable bounds after repeated refreshes (refusing tap using pre-observe coordinates). The UI may still be updating (list, keyboard, loading overlay, or animation).";

describe("tapOn display verification", () => {
  for (const ctrlProxy of [true, false]) {
    const route = ctrlProxy ? "CtrlProxy" : "adb input -d";
    for (const option of ["retryIfNoChange", "ensureTap"] as const) {
      for (const succeeds of [true, false]) {
        test(`${route} ${option}: unchanged first tap retries once, second ${succeeds ? "succeeds" : "stays unchanged"}`, async () => {
          const h = harness(ctrlProxy);
          h.onDispatch(() => {
            if (succeeds && h.dispatches.length === 2) {
              h.setCurrent(hierarchy({ text: "Done" }));
            }
          });
          const result = await h.execute({ [option]: true });
          expect(result.success).toBe(true);
          expect(result.error).toBeUndefined();
          expect(h.dispatches.map((dispatch) => dispatch.displayId)).toEqual([2, 2]);
          expectTargeted(h.capture);
          expect(h.timer.getSleepHistory()).toContain(POST_TAP_SETTLE_MS);
          expect(h.timer.getSleepHistory()).toContain(PRE_RETRY_DELAY_MS);
        });
      }
      for (const foldAt of ["refresh", "retry delay"] as const) {
        test(`${route} ${option}: fold during ${foldAt} refuses second dispatch`, async () => {
          const h = harness(ctrlProxy);
          if (foldAt === "refresh") {
            h.capture.read = () => {
              if (h.dispatches.length) {
                h.transitions.transition();
              }
              return hierarchy();
            };
          } else {
            const sleep = h.timer.sleep.bind(h.timer);
            h.timer.sleep = async (ms) => {
              await sleep(ms);
              if (ms === PRE_RETRY_DELAY_MS && h.dispatches.length) {
                h.transitions.transition();
              }
            };
          }
          const result = await h.execute({ [option]: true });
          expect(result.success).toBe(false);
          expect(result.staleDisplay?.retry).toBe("observe");
          expect(h.dispatches.length).toBe(1);
        });
      }
      test(`${route} ${option}: changed hierarchy skips retry`, async () => {
        const h = harness(ctrlProxy);
        h.onDispatch(() => h.setCurrent(hierarchy({ text: "Done" })));
        expect((await h.execute({ [option]: true })).success).toBe(true);
        expect(h.dispatches.length).toBe(1);
      });
    }
    test(`${route} preTapStability: waits for targeted bounds and taps refreshed point`, async () => {
      const h = harness(ctrlProxy);
      h.capture.read = (index) => hierarchy({ left: index === 1 ? 25 : 40 });
      expect((await h.execute({ preTapStability: true })).success).toBe(true);
      expect(h.capture.requests.length).toBeGreaterThanOrEqual(3);
      expect(h.dispatches).toEqual([{ displayId: 2, x: 70, y: 60 }]);
      expectTargeted(h.capture);
    });
    test(`${route} preTapStability: never stable returns default error with no tap`, async () => {
      const h = harness(ctrlProxy);
      h.capture.read = (index) => hierarchy({ left: index % 2 ? 20 : 40 });
      const result = await h.execute({ preTapStability: true });
      expect(result).toMatchObject({ success: false, error: stabilityError });
      expect(h.dispatches).toEqual([]);
      expectTargeted(h.capture);
    });
    test(`${route} preTapStability: fold during stability returns stale without tap`, async () => {
      const h = harness(ctrlProxy);
      h.capture.read = (index) => {
        if (index === 2) {
          h.transitions.transition();
        }
        return hierarchy();
      };
      const result = await h.execute({ preTapStability: true });
      expect(result.staleDisplay?.retry).toBe("observe");
      expect(h.dispatches).toEqual([]);
    });
    for (const outcome of [
      "already checked",
      "immediate match",
      "poll match",
      "mismatch",
      "not checkable",
      "fold during poll",
    ] as const) {
      test(`${route} ensureChecked: ${outcome}`, async () => {
        const h = harness(ctrlProxy, { checked: false });
        let postCaptures = 0;
        h.capture.read = () => {
          if (h.dispatches.length) {
            postCaptures++;
          }
          if (outcome === "fold during poll" && postCaptures) {
            h.transitions.transition();
          }
          return hierarchy({
            checked:
              outcome === "not checkable"
                ? undefined
                : outcome === "already checked" || (outcome === "poll match" && postCaptures >= 2),
          });
        };
        h.onDispatch(() => {
          if (outcome === "immediate match") {
            h.setCurrent(hierarchy({ checked: true }));
          }
        });
        const result = await h.execute({ ensureChecked: true });
        if (outcome === "fold during poll") {
          expect(result.staleDisplay?.retry).toBe("observe");
        } else if (outcome === "not checkable") {
          expect(result.error).toBe(
            "tapOn ensureChecked requires a toggle element; Wi-Fi has affordances: tap",
          );
        } else if (outcome === "mismatch") {
          expect(result).toMatchObject({
            success: false,
            error: "tapOn ensureChecked: tapped element but checked is now false (expected true)",
          });
        } else {
          expect(result.success).toBe(true);
        }
        expect(h.dispatches.length).toBe(
          outcome === "already checked" || outcome === "not checkable" ? 0 : 1,
        );
        if (outcome === "already checked") {
          expect(result.skipped).toBe("already-checked");
        }
        expectTargeted(h.capture);
      });
    }
    test(`${route} ensureChecked with retry: unchanged toggle retries on same panel`, async () => {
      const h = harness(ctrlProxy, { checked: false });
      h.onDispatch(() => {
        if (h.dispatches.length === 2) {
          h.setCurrent(hierarchy({ checked: true }));
        }
      });
      expect((await h.execute({ ensureChecked: true, retryIfNoChange: true })).success).toBe(true);
      expect(h.dispatches.map((dispatch) => dispatch.displayId)).toEqual([2, 2]);
      expectTargeted(h.capture);
    });
    for (const option of ["retryIfNoChange", "ensureTap"] as const) {
      test(`${route} ${option}: unavailable post-tap capture skips retry`, async () => {
        const h = harness(ctrlProxy);
        h.capture.read = () => {
          if (h.dispatches.length) {
            throw new ActionableError("capture unavailable");
          }
          return hierarchy();
        };
        expect((await h.execute({ [option]: true })).success).toBe(true);
        expect(h.dispatches.length).toBe(1);
      });
    }
    test(`${route} retry re-resolves moved target coordinates`, async () => {
      const h = harness(ctrlProxy);
      // Hash stays unchanged, but a new obstruction changes the visible target's point.
      // Returning an identical hash is the existing shared probe seam.
      h.action.hashViewHierarchy = () => "same";
      h.capture.read = () => hierarchy({ left: 120 });
      expect((await h.execute({ retryIfNoChange: true })).success).toBe(true);
      expect(h.dispatches).toEqual([
        { displayId: 2, x: 50, y: 60 },
        { displayId: 2, x: 150, y: 60 },
      ]);
    });
    test(`${route} ensureChecked with retry never succeeds uses default mismatch`, async () => {
      const h = harness(ctrlProxy, { checked: false });
      expect(await h.execute({ ensureChecked: true, retryIfNoChange: true })).toMatchObject({
        success: false,
        error: "tapOn ensureChecked: tapped element but checked is now false (expected true)",
      });
      expect(h.dispatches.map((dispatch) => dispatch.displayId)).toEqual([2, 2]);
    });
    test(`${route} ensureChecked retry fence refuses fold before second tap`, async () => {
      const h = harness(ctrlProxy, { checked: false });
      const sleep = h.timer.sleep.bind(h.timer);
      h.timer.sleep = async (ms) => {
        await sleep(ms);
        if (ms === PRE_RETRY_DELAY_MS) {
          h.transitions.transition();
        }
      };
      const result = await h.execute({ ensureChecked: true, retryIfNoChange: true });
      expect(result.staleDisplay?.retry).toBe("observe");
      expect(h.dispatches.length).toBe(1);
    });
    test(`${route} ensureChecked does not invert a toggle that reached the requested state`, async () => {
      const h = harness(ctrlProxy, { checked: false });
      h.action.hashViewHierarchy = () => "same";
      h.onDispatch(() => h.setCurrent(hierarchy({ checked: true })));
      expect((await h.execute({ ensureChecked: true, retryIfNoChange: true })).success).toBe(true);
      expect(h.dispatches.length).toBe(1);
    });
    test(`${route} ensureChecked false verifies the unchecked state`, async () => {
      const h = harness(ctrlProxy, { checked: true });
      h.onDispatch(() => h.setCurrent(hierarchy({ checked: false })));
      expect((await h.execute({ ensureChecked: false })).success).toBe(true);
      expect(h.dispatches.length).toBe(1);
    });
    for (const displayId of [0, undefined]) {
      test(`${route} preTapStability refuses ${displayId === undefined ? "missing" : "wrong"} captured display identity`, async () => {
        const h = harness(ctrlProxy);
        h.capture.read = () => ({ ...hierarchy(), displayId });
        const result = await h.execute({ preTapStability: true });
        expect(result.staleDisplay?.retry).toBe("observe");
        expect(h.dispatches).toEqual([]);
      });
    }
    test(`${route} production capture forwards target display id to existing hierarchy sync`, async () => {
      const h = harness(ctrlProxy, { productionCapture: true });
      const requests: Array<number | undefined> = [];
      const sync = spyOn(h.client, "requestHierarchySync").mockImplementation(async (...args) => {
        requests.push(args[5]);
        return { hierarchy: { updatedAt: h.timer.now() } };
      });
      const convert = spyOn(h.client, "convertToViewHierarchyResult").mockImplementation(() =>
        hierarchy(),
      );
      restores.push(
        () => sync.mockRestore(),
        () => convert.mockRestore(),
      );
      expect((await h.execute({ ensureTap: true })).success).toBe(true);
      expect(requests.length).toBeGreaterThanOrEqual(3);
      expect(requests.every((id) => id === 2)).toBe(true);
      expect(h.dispatches.map((dispatch) => dispatch.displayId)).toEqual([2, 2]);
    });
    test(`${route} ensureChecked with stability rechecks fresh toggle before tapping`, async () => {
      const h = harness(ctrlProxy, { checked: false });
      h.capture.read = (index) => hierarchy({ checked: index > 1 });
      expect(await h.execute({ ensureChecked: true, preTapStability: true })).toMatchObject({
        success: true,
        skipped: "already-checked",
      });
      expect(h.dispatches).toEqual([]);
    });
  }

  for (const [extra, error] of [
    [{ ensureChecked: true, action: "longPress" }, 'tapOn ensureChecked requires action "tap"'],
    [
      { ensureChecked: true, selectionStrategy: "random" },
      "tapOn ensureChecked cannot use random selection; use a unique selector or index",
    ],
  ] as const) {
    test(`display validates ${error}`, async () => {
      const h = harness(false);
      expect(await h.execute(extra)).toMatchObject({ success: false, error });
      expect(h.observe.getExecuteCallCount()).toBe(0);
      expect(h.dispatches).toEqual([]);
    });
  }

  test("ensureChecked observation floor follows the final display dispatch", async () => {
    const h = harness(true, { checked: false });
    let floor: number | undefined;
    h.onDispatch(() => {
      h.timer.setCurrentTime(200);
      h.setCurrent(hierarchy({ checked: true }));
    });
    h.action.observedInteraction = async (run, options) => {
      const result = await run(h.observation());
      floor = options.observationTimestampProvider?.();
      expect(options.display).toBe("external");
      return { ...result, observation: h.observation() };
    };
    expect((await h.execute({ ensureChecked: true })).success).toBe(true);
    expect(floor).toBe(200);
  });

  test("remaining display options reject before observation or dispatch in original order", async () => {
    const h = harness(false);
    const cases: Array<[Partial<TapOnElementOptions>, string]> = [
      [{ sibling: true }, "sibling"],
      [{ subtext: { text: "Link" } }, "subtext"],
      [{ searchUntil: { duration: 100 } }, "searchUntil"],
      [{ accessibilityLink: "Link" }, "accessibilityLink"],
      [{ focusFirst: true }, "focusFirst"],
      [{ screenReaderNavigation: true }, "screenReaderNavigation"],
      [{ textAny: ["One", "Two"] }, "textAny with multiple values"],
      [{ sibling: true, subtext: { text: "Link" }, ensureTap: true }, "sibling"],
      [{ screenReaderNavigation: true, textAny: ["One", "Two"] }, "screenReaderNavigation"],
    ];
    for (const [extra, name] of cases) {
      expect(await h.execute(extra)).toMatchObject({
        success: false,
        error: `${name} is not supported with \`display\` yet`,
      });
    }
    expect(h.observe.getExecuteCallCount()).toBe(0);
    expect(h.dispatches).toEqual([]);
    expect(h.capture.requests).toEqual([]);
  });

  test("default tap keeps refresh captures on the default path", async () => {
    const h = harness(false);
    const before = { ...hierarchy(), displayId: undefined };
    h.capture.read = () => before;
    h.action.observedInteraction = async (run) => ({
      ...(await run({ screenSize: { width: 200, height: 200 }, viewHierarchy: before })),
      observation: { viewHierarchy: before },
    });
    h.action.executeAndroidTap = async () => {};
    h.action.deriveTapEffectAfterPostTapObservation = async (_previous, observation) => ({
      observation,
    });
    h.action.captureTerminalObservationScreenshot = async () => {};
    h.action.recordDeferredPredictionOutcome = async () => {};
    h.action.enforceFreshnessConsistencyWithEffect = () => {};
    expect(
      (await h.action.execute({ text: "Wi-Fi", action: "tap", preTapStability: true })).success,
    ).toBe(true);
    expect(h.capture.requests.length).toBeGreaterThan(0);
    expect(h.capture.requests.every((request) => request.displayId === undefined)).toBe(true);
    expect(h.dispatches).toEqual([]);
  });
});
