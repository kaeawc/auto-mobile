import { DispatchedObservationError } from "../../../src/models/DispatchedObservationError";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { StaleDisplayError } from "../../../src/models/StaleDisplayError";
import { ActionableError } from "../../../src/models/ActionableError";
import { TapOnElement } from "../../../src/features/action/TapOnElement";
import { runWithToolDispatchReporter } from "../../../src/utils/ToolDispatchContext";
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
import { FakeScreenshotCapturer } from "../../fakes/FakeScreenshotCapturer";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeAccessibilityDetector } from "../../fakes/FakeAccessibilityDetector";
import { FakeTalkBackNavigationDriver } from "../../fakes/FakeTalkBackNavigationDriver";
import {
  TALKBACK_ACTIVATION_WARNING,
  TalkBackTapStrategy,
} from "../../../src/features/talkback/TalkBackTapStrategy";
import { TALKBACK_STATE_UNKNOWN_WARNING } from "../../../src/features/accessibility/interfaces/AccessibilityDetector";

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
  read: (index: number, request: HierarchyCaptureRequest) => ViewHierarchyResult = () =>
    hierarchy();
  async capture(request: HierarchyCaptureRequest): Promise<HierarchySnapshot> {
    this.requests.push(request);
    return {
      captureId: `panel-${this.requests.length}`,
      platform: "android",
      requestedFreshness: request.freshness,
      receivedAt: 0,
      hierarchy: this.read(this.requests.length, request),
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
  options: {
    checked?: boolean;
    productionCapture?: boolean;
    manualTimer?: boolean;
    vision?: boolean;
    /** true: TalkBack on, null: state unknown; default off. */
    talkBack?: boolean | null;
    /** Place the selected "external" panel on display 0 instead of display 2. */
    defaultDisplay?: boolean;
  } = {},
) {
  const transitions = new FakeDisplayTransitionReader();
  transitions.panel = { key: "external", role: "external" };
  const timer = new FakeTimer();
  if (!options.manualTimer) {
    timer.enableAutoAdvance();
  }
  timer.setCurrentTime(100);
  const capture = new PanelCapture();
  const screenshots = new FakeScreenshotCapturer();
  const executor = new FakeAdbExecutor();
  executor.setCommandResponse("cmd display get-displays", {
    stdout: options.defaultDisplay
      ? 'Display id 0: DisplayInfo{uniqueId "local:external" type EXTERNAL, real 200 x 200}\nDisplay id 2: DisplayInfo{uniqueId "local:internal" type INTERNAL, real 100 x 100}'
      : 'Display id 0: DisplayInfo{uniqueId "local:internal" type INTERNAL, real 100 x 100}\nDisplay id 2: DisplayInfo{uniqueId "local:external" type EXTERNAL, real 200 x 200}',
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
  let decoy = hierarchy({ displayId: 0, left: 120 });
  capture.read = (_index, request) => ({
    ...(request.displayId === 2 || options.defaultDisplay ? current : decoy),
  });
  const observe = new FakeObserveScreen();
  observe.setObserveResult(observation);
  const detector = new FakeAccessibilityDetector();
  if (options.talkBack === true) {
    detector.setDetectionResult(device.deviceId, true);
  } else if (options.talkBack === null) {
    detector.setDefaultResult(null);
  }
  const talkBackDriver = new FakeTalkBackNavigationDriver();
  const action = new TapOnElement(device, executor, {
    accessibilityDetector: detector,
    talkBackStrategy: new TalkBackTapStrategy({ timer }),
    talkBackDriverFactory: { createDriver: () => talkBackDriver },
    screenshotCapturer: screenshots,
    visionConfig: {
      enabled: options.vision ?? false,
      provider: "claude",
      confidenceThreshold: "high",
      maxCostUsd: 1,
      cacheResults: false,
      cacheTtlMinutes: 60,
    },
    timer,
    displayTransitions: transitions,
    lastRenderedObservation: () => observation(),
    ...(options.productionCapture ? {} : { hierarchyCapture: capture }),
  });
  const observeExecute = observe.execute.bind(observe);
  const observeSpy = spyOn(observe, "execute").mockImplementation(async (request) => {
    const result = await observeExecute(request);
    return request?.display === "external" ? result : { ...result, viewHierarchy: decoy };
  });
  restores.push(() => observeSpy.mockRestore());
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
    executor,
    capture,
    screenshots,
    timer,
    transitions,
    dispatches,
    observe,
    client,
    capability,
    observation,
    talkBackDriver,
    setDefault: (next: ViewHierarchyResult) => {
      decoy = next;
    },
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
  for (const extra of [{}, { action: "focus" }, { ensureChecked: true }] satisfies Array<
    Partial<TapOnElementOptions>
  >) {
    test(`post-dispatch revision change preserves only verified claims: ${JSON.stringify(extra)}`, async () => {
      const h = harness(true, { checked: false });
      if (extra.action === "focus") {
        const tree = hierarchy();
        tree.hierarchy.node = {
          text: "Wi-Fi",
          class: "android.widget.EditText",
          editable: true,
          clickable: true,
          focused: false,
          bounds: { left: 20, top: 30, right: 80, bottom: 90 },
        };
        h.setCurrent(tree);
        h.capture.read = () => tree;
      }
      h.action.observedInteraction = async (run, options) => {
        const result = await run(h.observation());
        h.transitions.transition();
        return { ...result, observation: h.observation() };
      };
      const result = await h.execute(extra);
      expect(h.dispatches).toHaveLength(1);
      expect(result.staleDisplay?.retry).toBe("observe");
      expect(result.observation?.settled).toBe(false);
      expect(result.observation?.freshness?.warning).toContain("display settle validation");
      if (extra.action === "focus" || extra.ensureChecked !== undefined) {
        expect(result.success).toBe(false);
        expect(result.error).toContain("gesture was dispatched");
        expect(result.error).toContain("Do not retry automatically");
      } else {
        expect(result.success).toBe(true);
        expect(result.error).toBeUndefined();
      }
    });
  }

  for (const extra of [
    {},
    { action: "longPress" },
    { action: "focus" },
    { ensureChecked: true },
  ] satisfies Array<Partial<TapOnElementOptions>>) {
    test(`legacy display path does not finalize invalidated post-state: ${JSON.stringify(extra)}`, async () => {
      const h = harness(true);
      h.action["executeOnDisplay"] = async () => undefined;
      h.action.observedInteraction = async () => ({
        success: true,
        action: extra.action ?? "tap",
        element: { text: "Wi-Fi", bounds: { left: 20, top: 30, right: 80, bottom: 90 } },
        observation: { ...h.observation(), settled: false },
        staleDisplay: { observedGeneration: 7, currentGeneration: 8, retry: "observe" },
      });
      const finalize = spyOn(h.action, "deriveTapEffectAfterPostTapObservation");
      restores.push(() => finalize.mockRestore());
      const result = await h.execute(extra);
      expect(result.staleDisplay?.retry).toBe("observe");
      expect(finalize).not.toHaveBeenCalled();
      if (extra.action === "focus" || extra.ensureChecked !== undefined) {
        expect(result.success).toBe(false);
        expect(result.error).toContain("Do not retry automatically");
      } else {
        expect(result.success).toBe(true);
        expect(result.contextMenuOpened).toBeUndefined();
        expect(result.selectionStarted).toBeUndefined();
        expect(result.pressRecognized).toBeUndefined();
      }
    });
  }

  for (const phase of ["first read", "checked verification"] as const) {
    test(`legacy display ${phase} preserves typed stale details and delivery`, async () => {
      const h = harness(true, { checked: false });
      h.action["executeOnDisplay"] = async () => undefined;
      const stale = new StaleDisplayError({
        observedGeneration: 7,
        currentGeneration: 8,
        retry: "observe",
      });
      h.action.observedInteraction = async () => {
        if (phase === "first read") {
          throw new DispatchedObservationError(stale);
        }
        return {
          success: true,
          action: "tap",
          element: { bounds: { left: 20, top: 30, right: 80, bottom: 90 } },
          observation: h.observation(),
        };
      };
      h.action.deriveTapEffectAfterPostTapObservation = async (_previous, observation) => ({
        observation,
      });
      h.action["applyEnsureCheckedResult"] = async () => {
        throw stale;
      };
      const result = await h.execute({ ensureChecked: true });
      expect(result.success).toBe(false);
      expect(result.staleDisplay).toEqual(stale.details);
      expect(result.error).toContain("gesture was dispatched");
      expect(result.error).toContain("Do not retry automatically");
    });
  }

  test.each(["settle-throws", "throws", "settle-transition"] as const)(
    "confirmed CtrlProxy tap preserves delivery after %s",
    async (outcome) => {
      const h = harness(true);
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
        return h.observation();
      });
      const result = await h.execute({});
      expect(h.dispatches).toHaveLength(1);
      if (outcome === "throws") {
        expect(result.success).toBe(false);
        expect(result.error).toContain("Do not retry automatically");
        expect(result.observation).toBeUndefined();
      } else {
        expect(result.success).toBe(true);
        expect(result.observation?.viewHierarchy?.hierarchy).toEqual(hierarchy().hierarchy);
        expect(result.observation?.settled).toBe(false);
        expect(result.observation?.freshness?.warning).toContain("display settle");
        if (outcome === "settle-transition") {
          expect(result.staleDisplay?.retry).toBe("observe");
        }
      }
    },
  );

  test("ensureChecked display verification read after delivery carries the dispatched marker", async () => {
    const h = harness(true, { checked: false });
    h.action.observedInteraction = async (run) => ({
      ...(await run(h.observation())),
      observation: h.observation(),
    });
    const sleep = h.timer.sleep.bind(h.timer);
    h.timer.sleep = async (ms) => {
      await sleep(ms);
      if (h.dispatches.length > 0) {
        h.transitions.transition();
      }
    };
    const result = await h.execute({ ensureChecked: true });
    expect(result.success).toBe(false);
    expect(result.staleDisplay?.retry).toBe("observe");
    expect(result.error).toContain("gesture was dispatched");
    expect(result.error).toContain("Do not retry automatically");
    expect(h.dispatches).toHaveLength(1);
  });

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
      test(`${route} ${option}: unreadable post-tap fingerprint skips retry`, async () => {
        const h = harness(ctrlProxy);
        const unreadable = hierarchy();
        const node = unreadable.hierarchy.node!;
        node.node = [node];
        h.capture.read = () => (h.dispatches.length ? unreadable : hierarchy());
        expect((await h.execute({ [option]: true })).success).toBe(true);
        expect(h.dispatches).toHaveLength(1);
        expect(h.timer.getSleepHistory()).toContain(POST_TAP_SETTLE_MS);
        expect(h.timer.getSleepHistory()).not.toContain(PRE_RETRY_DELAY_MS);
      });
    }
    test(`${route} reports its dispatch to the running tool call before the tap goes out (#10196)`, async () => {
      const h = harness(ctrlProxy);
      const order: string[] = [];
      h.onDispatch(() => order.push("tap"));
      const result = await runWithToolDispatchReporter(
        () => order.push("report"),
        () => h.execute({}),
      );
      expect(result.success).toBe(true);
      // A report made after the command returned could land past the navigation event the tap caused.
      expect(order[0]).toBe("report");
      expect(order).toContain("tap");
    });
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
      floor = options.observationHostTimestampProvider?.();
      expect(options.display).toBe("external");
      return { ...result, observation: h.observation() };
    };
    expect((await h.execute({ ensureChecked: true })).success).toBe(true);
    expect(floor).toBe(200);
  });

  for (const skewMs of [0, -20_000, 5_000]) {
    test(`ensureChecked floor is the tap time in the device clock with one device read (skew ${skewMs}ms, #9879)`, async () => {
      const h = harness(true, { checked: false });
      let deviceClockReads = 0;
      h.executor.getDeviceTimestampMs = async () => {
        deviceClockReads++;
        return h.timer.now() + skewMs;
      };
      let tapDeviceStamp = 0;
      h.onDispatch(() => {
        h.timer.setCurrentTime(200);
        tapDeviceStamp = h.timer.now() + skewMs;
        h.setCurrent(hierarchy({ checked: true }));
      });
      let floor: number | undefined;
      const interaction = h.action.observedInteraction.bind(h.action);
      h.action.observedInteraction = async (run, options) => {
        const result = await interaction(run, options);
        floor = options.observationHostTimestampProvider?.();
        return result;
      };
      const floorsBefore = h.observe.getExecuteMinTimestamps().length;

      expect((await h.execute({ ensureChecked: true })).success).toBe(true);

      // Exactly the action-start read: nothing is read from the device after the tap.
      expect(deviceClockReads).toBe(1);
      expect(floor).toBe(200);
      // The first post-action read is floored at the tap time in the device clock
      // (host tap time plus the skew measured at action start), so a push stamped
      // right after the tap (tap + 1) is accepted rather than forcing a fresh wait.
      const [, postActionFloor] = h.observe.getExecuteMinTimestamps().slice(floorsBefore);
      expect(postActionFloor).toBe(tapDeviceStamp);
    });
  }

  test("remaining display options reject before observation or dispatch in original order", async () => {
    const h = harness(false);
    const cases: Array<[Partial<TapOnElementOptions>, string]> = [
      [{ subtext: { text: "Link" } }, "subtext"],
      [{ accessibilityLink: "Link" }, "accessibilityLink"],
      [{ focusFirst: true }, "focusFirst"],
      [{ screenReaderNavigation: true }, "screenReaderNavigation"],
      [{ sibling: true, subtext: { text: "Link" }, ensureTap: true }, "subtext"],
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

  test("explicit display clips against the panel's captured size, not a stale observation size (#6523)", async () => {
    const h = harness(true);
    const wide = hierarchy({ left: 120 });
    h.setCurrent(wide);
    h.capture.read = () => wide;
    // The observation carries a stale 100x100 size, but the panel's capture is 200x200.
    h.observe.setObserveResult(() => ({
      ...h.observation(),
      screenSize: { width: 100, height: 100 },
    }));
    const result = await h.execute({});
    expect(result.success).toBe(true);
    // Centre of the 120..180 element on the 200-wide panel; the stale size would clip it away.
    expect(h.dispatches).toEqual([{ displayId: 2, x: 150, y: 60 }]);
  });

  test("explicit display ensureChecked refresh re-sizes the tap from the refreshed capture (#6523)", async () => {
    const h = harness(true, { checked: false });
    // The cached observation is a 100x100 capture; the pre-tap ensureChecked refresh
    // returns the panel's current 200x200 capture where the toggle sits at x=120..180.
    const stale = { ...hierarchy({ checked: false }), screenWidth: 100, screenHeight: 100 };
    const fresh = hierarchy({ checked: false, left: 120 });
    h.setCurrent(stale);
    h.capture.read = (index) => (index === 0 ? stale : fresh);
    const result = await h.execute({ ensureChecked: true, preTapStability: false });
    // Post-tap verification of the (static) fake toggle fails; delivery is what matters here.
    expect(result.error).not.toContain("no visible tap area");
    expect(h.dispatches[0]).toEqual({ displayId: 2, x: 150, y: 60 });
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

function siblingHierarchy(
  options: { left?: number; displayId?: number } = {},
): ViewHierarchyResult {
  const tree = hierarchy(options);
  tree.hierarchy.node = {
    bounds: { left: 0, top: 0, right: 200, bottom: 200 },
    node: [
      {
        text: "Wi-Fi",
        "resource-id": "app:id/label",
        class: "android.widget.TextView",
        bounds: { left: 10, top: 30, right: 50, bottom: 90 },
      },
      {
        clickable: true,
        class: "android.widget.Button",
        "resource-id": "app:id/button",
        bounds: { left: options.left ?? 80, top: 30, right: (options.left ?? 80) + 40, bottom: 90 },
      },
    ],
  };
  return tree;
}

// Yield only microtasks; all polling deadlines and sleeps use the injected FakeTimer.
async function drainMicrotasks() {
  for (let turn = 0; turn < 100; turn++) {
    await Promise.resolve();
  }
}

const resolutionCases: Array<[string, Partial<TapOnElementOptions>, ViewHierarchyResult, number]> =
  [
    ["sibling text", { sibling: true }, siblingHierarchy(), 100],
    [
      "sibling resource id",
      { text: undefined, elementId: "app:id/label", sibling: true },
      siblingHierarchy(),
      100,
    ],
    ["multi textAny", { text: undefined, textAny: ["Missing", "Wi-Fi"] }, hierarchy(), 50],
    ["searchUntil", { searchUntil: { duration: 150 } }, hierarchy(), 50],
  ];

describe("tapOn targeted display resolution", () => {
  for (const ctrlProxy of [true, false]) {
    const route = ctrlProxy ? "CtrlProxy" : "adb input -d";
    for (const [name, extra, tree, x] of resolutionCases) {
      test(`${route} resolves ${name} on target despite default display decoy`, async () => {
        const h = harness(ctrlProxy);
        h.setCurrent(tree);
        // A default-display read would resolve the same selectors at another point.
        const decoy = name.startsWith("sibling")
          ? siblingHierarchy({ displayId: 0, left: 140 })
          : hierarchy({ displayId: 0, left: 120 });
        h.setDefault(decoy);
        h.capture.read = (_index, request) => (request.displayId === 2 ? tree : decoy);
        const result = await h.execute(extra);
        expect(result.success).toBe(true);
        expect(h.dispatches).toEqual([{ displayId: 2, x, y: 60 }]);
        expect(
          h.observe.getExecuteOptions().every((request) => request.display === "external"),
        ).toBe(true);
        expect(result.searchUntil).toEqual({ durationMs: 0, requestCount: 0, changeCount: 0 });
      });
    }

    test(`${route} multi textAny skips off-screen first candidate`, async () => {
      const h = harness(ctrlProxy);
      const tree = hierarchy();
      tree.hierarchy.node = [
        {
          text: "Offscreen",
          clickable: true,
          class: "android.widget.Button",
          bounds: { left: 220, top: 30, right: 280, bottom: 90 },
        },
        {
          text: "Wi-Fi",
          clickable: true,
          class: "android.widget.Button",
          bounds: { left: 80, top: 30, right: 140, bottom: 90 },
        },
      ];
      h.setCurrent(tree);
      const result = await h.execute({ text: undefined, textAny: ["Offscreen", "Wi-Fi"] });
      expect(result.success).toBe(true);
      expect(h.dispatches).toEqual([{ displayId: 2, x: 110, y: 60 }]);
    });

    test(`${route} search polls only target and stops at third poll using manual FakeTimer`, async () => {
      const h = harness(ctrlProxy, { manualTimer: true });
      h.setCurrent(hierarchy({ text: "Loading" }));
      h.capture.read = (index, request) =>
        request.displayId !== 2
          ? hierarchy({ displayId: 0, left: 120 })
          : hierarchy({ text: index < 3 ? "Loading" : "Wi-Fi", left: 80 });
      const pending = h.execute({ searchUntil: { duration: 500 } });
      await drainMicrotasks();
      expect(h.capture.requests).toHaveLength(1);
      expect(h.timer.getPendingSleeps()).toEqual([50]);
      h.timer.advanceTime(50);
      await drainMicrotasks();
      expect(h.capture.requests).toHaveLength(2);
      h.timer.advanceTime(50);
      await drainMicrotasks();
      h.timer.enableAutoAdvance();
      h.timer.resolveAll();
      const result = await pending;
      expect(result.success).toBe(true);
      expect(result.searchUntil).toEqual({ durationMs: 100, requestCount: 3, changeCount: 2 });
      expect(h.capture.requests).toHaveLength(3);
      expectTargeted(h.capture);
      expect(h.dispatches).toEqual([{ displayId: 2, x: 110, y: 60 }]);
    });

    test(`${route} fence changing after search refuses dispatch`, async () => {
      const h = harness(ctrlProxy);
      h.setCurrent(hierarchy({ text: "Loading" }));
      h.capture.read = () => hierarchy({ left: 80 });
      h.capability.mockImplementation(async () => {
        h.transitions.transition();
        return ctrlProxy;
      });
      const result = await h.execute({ searchUntil: { duration: 100 } });
      expect(result.staleDisplay?.retry).toBe("observe");
      expect(h.capture.requests).toHaveLength(1);
      expect(h.dispatches).toEqual([]);
    });

    for (const failure of [
      "wrong display",
      "missing display",
      "fold during capture",
      "fold between polls",
      "stale capture error",
    ] as const) {
      test(`${route} search aborts on ${failure} without dispatch`, async () => {
        const h = harness(ctrlProxy);
        h.setCurrent(hierarchy({ text: "Loading" }));
        h.capture.read = (index) => {
          if (index === 2 && failure === "fold during capture") {
            h.transitions.transition();
          }
          if (index === 2 && failure === "stale capture error") {
            throw new StaleDisplayError({
              retry: "observe",
              observedGeneration: h.transitions.generation,
              currentGeneration: h.transitions.generation + 1,
            });
          }
          const tree = hierarchy({
            text: index === 2 ? "Wi-Fi" : "Loading",
            displayId: index === 2 && failure === "wrong display" ? 0 : 2,
          });
          return index === 2 && failure === "missing display"
            ? { ...tree, displayId: undefined }
            : tree;
        };
        if (failure === "fold between polls") {
          const sleep = h.timer.sleep.bind(h.timer);
          h.timer.sleep = async (ms) => {
            await sleep(ms);
            h.transitions.transition();
          };
        }
        const result = await h.execute({ searchUntil: { duration: 500 } });
        expect(result.success).toBe(false);
        expect(result.staleDisplay?.retry).toBe("observe");
        expect(h.dispatches).toEqual([]);
        expect(h.capture.requests).toHaveLength(failure === "fold between polls" ? 1 : 2);
        expectTargeted(h.capture);
      });
    }

    for (const [extra, error] of [
      [
        { text: undefined, textAny: ["Missing", "Absent"] },
        "Element not found with any provided text 'Missing', 'Absent'",
      ],
      [{ sibling: true }, "No clickable sibling found next to element with text 'Wi-Fi'"],
      [
        { container: { text: "Missing container" } },
        "Container element not found with provided text 'Missing container'",
      ],
      [
        { text: "Missing", container: { text: "Wi-Fi" } },
        "Element not found with provided text 'Missing' within container text 'Wi-Fi'",
      ],
    ] satisfies Array<[Partial<TapOnElementOptions>, string]>) {
      test(`${route} search timeout preserves base error without vision: ${error}`, async () => {
        const h = harness(ctrlProxy, { vision: true });
        const result = await h.execute({ searchUntil: { duration: 100 }, ...extra });
        expect(result.error).toBe(error);
        expect(result.searchUntil?.requestCount).toBe(2);
        expect(h.dispatches).toEqual([]);
        expect(h.capture.requests).toHaveLength(2);
        expectTargeted(h.capture);
        expect(h.screenshots.getCallCount()).toBe(0);
      });
    }

    test(`${route} search + sibling + textAny + ensureTap shares display stability and retry`, async () => {
      const h = harness(ctrlProxy);
      h.setCurrent(hierarchy({ text: "Loading" }));
      h.capture.read = (index) =>
        index === 1 ? hierarchy({ text: "Loading" }) : siblingHierarchy();
      h.action.hashViewHierarchy = () => "same";
      const result = await h.execute({
        text: undefined,
        textAny: ["Missing", "Wi-Fi"],
        sibling: true,
        searchUntil: { duration: 500 },
        ensureTap: true,
      });
      expect(result.success).toBe(true);
      expect(result.searchUntil?.requestCount).toBe(2);
      expect(h.dispatches).toEqual([
        { displayId: 2, x: 100, y: 60 },
        { displayId: 2, x: 100, y: 60 },
      ]);
      expectTargeted(h.capture);
      expect(h.timer.getSleepHistory()).toContain(POST_TAP_SETTLE_MS);
      expect(h.timer.getSleepHistory()).toContain(PRE_RETRY_DELAY_MS);
    });
  }

  for (const [extra, error] of [
    [{ searchUntil: { duration: 99 } }, "searchUntil.duration must be at least 100ms"],
    [{ searchUntil: { duration: 12001 } }, "searchUntil.duration must be at most 12000ms"],
    [{ searchUntil: { duration: NaN } }, "searchUntil.duration must be a number"],
    [{ text: undefined, textAny: [] }, "tapOn textAny selector must be non-empty"],
    [
      { sibling: true, elementId: "duplicate" },
      "tapOn requires exactly one of text, textAny, elementId, testTag, or accessibilityLink",
    ],
  ] satisfies Array<[Partial<TapOnElementOptions>, string]>) {
    test(`resolution validation before observation: ${error}`, async () => {
      const h = harness(false);
      expect((await h.execute(extra)).error).toBe(error);
      expect(h.observe.getExecuteCallCount()).toBe(0);
      expect(h.capture.requests).toEqual([]);
      expect(h.dispatches).toEqual([]);
    });
  }

  test("default multi textAny + searchUntil polls without displayId", async () => {
    const h = harness(false);
    const before = { ...hierarchy({ text: "Loading" }), displayId: undefined };
    h.capture.read = () => ({ ...hierarchy({ left: 120 }), displayId: undefined });
    h.action.observedInteraction = async (run) => ({
      ...(await run({ screenSize: { width: 200, height: 200 }, viewHierarchy: before })),
      observation: { viewHierarchy: before },
    });
    const points: Array<{ x: number; y: number }> = [];
    h.action.executeAndroidTap = async (_action, x, y) => {
      points.push({ x, y });
    };
    h.action.deriveTapEffectAfterPostTapObservation = async (_previous, observation) => ({
      observation,
    });
    h.action.captureTerminalObservationScreenshot = async () => {};
    h.action.recordDeferredPredictionOutcome = async () => {};
    h.action.enforceFreshnessConsistencyWithEffect = () => {};
    const result = await h.action.execute({
      action: "tap",
      textAny: ["Missing", "Wi-Fi"],
      searchUntil: { duration: 100 },
    });
    expect(result.success).toBe(true);
    expect(points).toEqual([{ x: 150, y: 60 }]);
    expect(result.searchUntil?.requestCount).toBe(1);
    expect(h.capture.requests).toHaveLength(1);
    expect(h.capture.requests[0].displayId).toBeUndefined();
    expect(h.dispatches).toEqual([]);
  });

  test("default sibling + multi textAny + searchUntil keeps stability refresh without displayId", async () => {
    const h = harness(false);
    const before = { ...siblingHierarchy(), displayId: undefined };
    h.capture.read = () => ({ ...siblingHierarchy({ left: 140 }), displayId: undefined });
    h.action.observedInteraction = async (run) => ({
      ...(await run({ screenSize: { width: 200, height: 200 }, viewHierarchy: before })),
      observation: { viewHierarchy: before },
    });
    const points: Array<{ x: number; y: number }> = [];
    h.action.executeAndroidTap = async (_action, x, y) => {
      points.push({ x, y });
    };
    h.action.deriveTapEffectAfterPostTapObservation = async (_previous, observation) => ({
      observation,
    });
    h.action.captureTerminalObservationScreenshot = async () => {};
    h.action.recordDeferredPredictionOutcome = async () => {};
    h.action.enforceFreshnessConsistencyWithEffect = () => {};
    const result = await h.action.execute({
      action: "tap",
      textAny: ["Wi-Fi", "Other"],
      sibling: true,
      searchUntil: { duration: 100 },
      preTapStability: true,
    });
    expect(result.error).toBeUndefined();
    expect(result.success).toBe(true);
    expect(points).toEqual([{ x: 160, y: 60 }]);
    expect(h.capture.requests.length).toBeGreaterThan(1);
    expect(h.capture.requests.every((request) => request.displayId === undefined)).toBe(true);
    expect(h.dispatches).toEqual([]);
  });
});

describe("tapOn explicit display with TalkBack (#9905)", () => {
  for (const ctrlProxy of [true, false]) {
    for (const action of ["tap", "doubleTap", "longPress"] as const) {
      test(`TalkBack on refuses ${action} on a non-default display before any gesture (${ctrlProxy ? "CtrlProxy" : "adb"})`, async () => {
        const h = harness(ctrlProxy, { talkBack: true });
        const result = await h.execute({ action });
        expect(result.success).toBe(false);
        expect(result.error).toContain("TalkBack coordinate activation cannot target display 2");
        expect(result.error).toContain("no gesture was dispatched");
        expect(h.dispatches).toEqual([]);
        expect(h.talkBackDriver.tapHistory).toEqual([]);
        expect(h.talkBackDriver.doubleTapHistory).toEqual([]);
        expect(
          h.executor.getExecutedCommands().some((command) => command.includes("touchscreen")),
        ).toBe(false);
      });
    }
  }

  test("TalkBack on, explicit display 0: a completed activation carries the unconfirmed warning", async () => {
    const h = harness(true, { talkBack: true, defaultDisplay: true });
    const result = await h.execute({});
    expect(result.error).toBeUndefined();
    expect(result.success).toBe(true);
    expect(result.warnings).toEqual([TALKBACK_ACTIVATION_WARNING]);
    expect(h.dispatches).toEqual([]);
    expect(h.talkBackDriver.doubleTapHistory).toHaveLength(1);
  });

  test("TalkBack on, explicit display 0: a long press carries no activation warning", async () => {
    const h = harness(true, { talkBack: true, defaultDisplay: true });
    const result = await h.execute({ action: "longPress" });
    expect(result.success).toBe(true);
    expect(result.warnings).toBeUndefined();
  });

  test("TalkBack on, non-default display: a missing element reports the refusal, not not-found", async () => {
    const h = harness(true, { talkBack: true });
    const result = await h.execute({ text: "Missing" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("TalkBack coordinate activation cannot target display 2");
    expect(result.error).not.toContain("not found");
    expect(h.dispatches).toEqual([]);
  });

  test("TalkBack on, non-default display: an already-satisfied ensureChecked still refuses", async () => {
    const h = harness(true, { talkBack: true, checked: true });
    const result = await h.execute({ ensureChecked: true });
    expect(result.success).toBe(false);
    expect(result.error).toContain("TalkBack coordinate activation cannot target display 2");
    expect(result.skipped).toBeUndefined();
    expect(h.dispatches).toEqual([]);
  });

  test("TalkBack off: a missing element keeps the not-found error", async () => {
    const h = harness(true, { talkBack: false });
    const result = await h.execute({ text: "Missing" });
    expect(result.success).toBe(false);
    expect(result.error).not.toContain("TalkBack");
  });

  test("TalkBack off keeps the raw display dispatch and carries no TalkBack warning", async () => {
    const h = harness(true, { talkBack: false });
    const result = await h.execute({});
    expect(result.success).toBe(true);
    expect(result.warnings).toBeUndefined();
    expect(h.dispatches).toHaveLength(1);
    expect(h.dispatches[0]).toMatchObject({ displayId: 2 });
    expect(h.talkBackDriver.tapHistory).toEqual([]);
  });

  test("TalkBack state unknown keeps the raw display dispatch with the unknown-state warning", async () => {
    const h = harness(true, { talkBack: null });
    const result = await h.execute({});
    expect(result.success).toBe(true);
    expect(result.warnings).toEqual([TALKBACK_STATE_UNKNOWN_WARNING]);
    expect(h.dispatches).toHaveLength(1);
    expect(h.talkBackDriver.tapHistory).toEqual([]);
  });
});
