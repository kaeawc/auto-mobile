import { BaseVisualChange } from "../../../../src/features/action/BaseVisualChange";
import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { DefaultElementGeometry } from "../../../../src/features/utility/ElementGeometry";
import {
  resolveSwipeDuration,
  resolveBoomerangConfig,
  getReturnDuration,
} from "../../../../src/features/action/swipeon/swipeTiming";
import { SwipeOn } from "../../../../src/features/action/swipeon/SwipeOn";
import { VoiceOverSwipeExecutor } from "../../../../src/features/action/swipeon/VoiceOverSwipeExecutor";
import { AndroidCtrlProxyClient } from "../../../../src/features/observe/android";
import type { DisplayTransitionReader } from "../../../../src/features/observe/DisplayTransition";
import type { AdbClient } from "../../../../src/utils/android-cmdline-tools/AdbClient";
import type { BootedDevice, ObserveResult, SwipeOnOptions } from "../../../../src/models";
import { FakeAdbClient } from "../../../fakes/FakeAdbClient";
import { FakeCtrlProxy } from "../../../fakes/FakeCtrlProxy";
import { FakeObserveScreen } from "../../../fakes/FakeObserveScreen";
import { FakeGestureExecutor } from "../../../fakes/FakeGestureExecutor";
import { FakeTimer } from "../../../fakes/FakeTimer";
import { FakeAccessibilityDetector } from "../../../fakes/FakeAccessibilityDetector";
import { FakeIosVoiceOverDetector } from "../../../fakes/FakeIosVoiceOverDetector";

const device: BootedDevice = {
  deviceId: "swipe-display-timing",
  platform: "android",
  name: "Timing fake",
  displays: {
    panels: [{ key: "external", role: "external", sizePx: { width: 200, height: 200 } }],
    postures: [],
  },
};
const observation: ObserveResult = {
  observationId: "timing",
  timestamp: 1,
  displayRevision: 0,
  display: { key: "external", role: "external", posture: "unknown", generation: 1 },
  screenSize: { width: 200, height: 200 },
  rotation: 0,
  systemInsets: { left: 0, top: 0, right: 0, bottom: 0 },
  viewHierarchy: { hierarchy: { node: { text: "Settings" } }, displayId: 2 },
};
type Route = "ctrlproxy" | "adb";

function harness({
  route = "ctrlproxy",
  platform = "android",
}: {
  route?: Route;
  platform?: "android" | "ios";
} = {}) {
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const adb = new FakeAdbClient();
  adb.setCommandResult(
    "shell cmd display get-displays",
    'Display id 0: DisplayInfo{uniqueId "local:internal" type INTERNAL, real 100 x 100}\nDisplay id 2: DisplayInfo{uniqueId "local:external" type EXTERNAL, real 200 x 200}',
  );
  const ctrl = new FakeCtrlProxy();
  ctrl.setSupportedCommands(route === "ctrlproxy" ? ["gesture_display_id_v1"] : []);
  spyOn(AndroidCtrlProxyClient, "getInstance").mockReturnValue(
    ctrl as unknown as AndroidCtrlProxyClient,
  );
  const observe = new FakeObserveScreen();
  // iOS captures do not carry Android logical display ids. Without this,
  // the canonical size resolver correctly refuses an unidentified size fallback.
  const platformObservation =
    platform === "ios"
      ? { ...observation, viewHierarchy: { ...observation.viewHierarchy!, displayId: undefined } }
      : observation;
  observe.setObserveResult(platformObservation);
  const gesture = new FakeGestureExecutor();
  let revision = 0;
  const transitions: DisplayTransitionReader = {
    revision: () => revision,
    identityRevision: () => revision + 1,
    sameIdentitySince: (_deviceId, stamp) => stamp === revision,
    currentObservedPanel: () => ({ key: revision ? "internal" : "external", role: "external" }),
  };
  const action = new SwipeOn({ ...device, platform }, adb as unknown as AdbClient, {
    timer,
    observeScreen: observe,
    executeGesture: gesture,
    accessibilityDetector: new FakeAccessibilityDetector(),
    iosVoiceOverDetector: new FakeIosVoiceOverDetector(),
    lastRenderedObservation: () => platformObservation,
    displayTransitions: transitions,
  });
  // Isolate dispatch timing from BaseVisualChange's unrelated post-observe polling.
  action.observedInteraction = async (run) => run(platformObservation);
  const commands = () => adb.getAllCommands().filter((command) => command.includes("touchscreen"));
  const legs = () =>
    route === "ctrlproxy"
      ? ctrl.getSwipeHistory().map(({ x1, y1, x2, y2, duration }) => ({ x1, y1, x2, y2, duration }))
      : commands().map((command) => {
          const [x1, y1, x2, y2, duration] = command.split(" ").slice(-5).map(Number);
          return { x1, y1, x2, y2, duration };
        });
  const afterForward = (callback: () => void) => {
    if (route === "ctrlproxy") {
      const request = ctrl.requestSwipe.bind(ctrl);
      spyOn(ctrl, "requestSwipe").mockImplementation(async (...args) => {
        const result = await request(...args);
        callback();
        return result;
      });
    } else {
      const execute = adb.execute.bind(adb);
      spyOn(adb, "execute").mockImplementation(async (...args) => {
        const result = await execute(...args);
        if (args[0].join(" ").includes("touchscreen")) {
          callback();
        }
        return result;
      });
    }
  };
  return {
    action,
    adb,
    ctrl,
    observe,
    gesture,
    timer,
    legs,
    commands,
    afterForward,
    flip: () => {
      revision++;
    },
  };
}

afterEach(() => mock.restore());

const timingCases: Array<{
  name: string;
  options: Partial<SwipeOnOptions>;
  durations: number[];
  pause: number;
}> = [
  {
    name: "maximum pause and speed",
    options: { boomerang: true, apexPause: 3000, returnSpeed: 3000 },
    durations: [300, 1],
    pause: 3000,
  },
  {
    name: "maximum return",
    options: { boomerang: true, apexPause: 0, returnSpeed: 0.1 },
    durations: [300, 3000],
    pause: 0,
  },
  {
    name: "maximum total",
    options: { boomerang: true, apexPause: 1700, returnSpeed: 0.1 },
    durations: [300, 3000],
    pause: 1700,
  },
  { name: "unset speed", options: {}, durations: [300], pause: 0 },
  { name: "slow", options: { speed: "slow" }, durations: [600], pause: 0 },
  { name: "normal", options: { speed: "normal" }, durations: [300], pause: 0 },
  { name: "fast", options: { speed: "fast" }, durations: [100], pause: 0 },
  { name: "duration wins", options: { speed: "slow", duration: 250 }, durations: [250], pause: 0 },
  { name: "boomerang defaults", options: { boomerang: true }, durations: [300, 300], pause: 100 },
  {
    name: "apex pause",
    options: { boomerang: true, apexPause: 75 },
    durations: [300, 300],
    pause: 75,
  },
  {
    name: "zero pause",
    options: { boomerang: true, apexPause: 0 },
    durations: [300, 300],
    pause: 0,
  },
  {
    name: "return speed 2",
    options: { boomerang: true, returnSpeed: 2 },
    durations: [300, 150],
    pause: 100,
  },
  {
    name: "return speed 0.1",
    options: { boomerang: true, returnSpeed: 0.1 },
    durations: [300, 3000],
    pause: 100,
  },
  {
    name: "return rounds",
    options: { boomerang: true, duration: 301, returnSpeed: 2 },
    durations: [301, 151],
    pause: 100,
  },
  {
    name: "return minimum",
    options: { boomerang: true, returnSpeed: 1000 },
    durations: [300, 1],
    pause: 100,
  },
  {
    name: "speed with boomerang",
    options: { speed: "slow", boomerang: true },
    durations: [600, 600],
    pause: 100,
  },
];

for (const route of ["ctrlproxy", "adb"] as const) {
  describe(`display timing via ${route}`, () => {
    for (const entry of timingCases) {
      test(entry.name, async () => {
        const h = harness({ route });
        const result = await h.action.execute({
          direction: "up",
          display: "external",
          ...entry.options,
        });
        expect(result.success).toBe(true);
        const duration = resolveSwipeDuration({
          ...entry.options,
          geometry: new DefaultElementGeometry(),
        });
        const boomerang = resolveBoomerangConfig(entry.options);
        expect(duration).toBe(entry.durations[0]);
        expect(h.legs().map((leg) => leg.duration)).toEqual(
          boomerang
            ? [
                duration,
                getReturnDuration({
                  forwardDuration: duration,
                  returnSpeed: boomerang.returnSpeed,
                }),
              ]
            : [duration],
        );
        expect(boomerang?.apexPauseMs ?? 0).toBe(entry.pause);
        const forward = { x1: 100, y1: 160, x2: 100, y2: 40, duration: entry.durations[0] };
        expect(h.legs()).toEqual(
          entry.durations.length === 1
            ? [forward]
            : [forward, { x1: 100, y1: 40, x2: 100, y2: 160, duration: entry.durations[1] }],
        );
        expect(result).toMatchObject({
          ...forward,
          duration: entry.durations.reduce((a, b) => a + b, entry.pause),
        });
        expect(h.timer.getSleepHistory()).toEqual(entry.pause > 0 ? [entry.pause] : []);
        if (route === "ctrlproxy") {
          expect(h.ctrl.getSwipeHistory().every((leg) => leg.displayId === 2)).toBe(true);
          expect(h.commands()).toEqual([]);
        } else {
          expect(
            h
              .commands()
              .every((command) => command.startsWith("shell input touchscreen -d 2 swipe ")),
          ).toBe(true);
          expect(h.ctrl.getSwipeHistory()).toEqual([]);
        }
      });
    }
    for (const [options, error] of [
      [{ apexPause: 10 }, "apexPause/returnSpeed require boomerang=true"],
      [{ returnSpeed: 2 }, "apexPause/returnSpeed require boomerang=true"],
      [
        { boomerang: true, apexPause: -1 },
        "apexPause must be finite and >= 0 and <= 3000ms; shorten the apex pause",
      ],
      [
        { boomerang: true, returnSpeed: 0 },
        "returnSpeed must be finite, > 0 and <= 3000, and produce a finite return duration <= 3000ms; increase returnSpeed or shorten the forward duration",
      ],
      [
        { boomerang: true, returnSpeed: -1 },
        "returnSpeed must be finite, > 0 and <= 3000, and produce a finite return duration <= 3000ms; increase returnSpeed or shorten the forward duration",
      ],
    ] satisfies Array<[Partial<SwipeOnOptions>, string]>) {
      test(`invalid ${JSON.stringify(options)}`, async () => {
        const h = harness({ route });
        const result = await h.action.execute({ direction: "up", display: "external", ...options });
        expect(result).toMatchObject({
          success: false,
          error,
          targetType: "screen",
          x1: 0,
          y1: 0,
          x2: 0,
          y2: 0,
          duration: 0,
        });
        expect(h.adb.getAllCommands()).toEqual([]);
        expect(h.legs()).toEqual([]);
        expect(h.observe.getExecuteCallCount()).toBe(0);
      });
    }
    for (const moment of ["after forward", "during pause", "before return send"] as const) {
      test(`transition ${moment} stops return`, async () => {
        const h = harness({ route });
        if (moment === "after forward") {
          h.afterForward(h.flip);
        }
        if (moment === "during pause") {
          const sleep = h.timer.sleep.bind(h.timer);
          spyOn(h.timer, "sleep").mockImplementation(async (ms) => {
            h.flip();
            await sleep(ms);
          });
        }
        if (moment === "before return send") {
          if (route === "ctrlproxy") {
            const request = h.ctrl.requestSwipe.bind(h.ctrl);
            spyOn(h.ctrl, "requestSwipe").mockImplementation(async (...args) => {
              if (h.legs().length === 1) {
                h.flip();
              }
              return request(...args);
            });
          } else {
            const execute = h.adb.execute.bind(h.adb);
            spyOn(h.adb, "execute").mockImplementation(async (...args) => {
              if (h.legs().length === 1) {
                h.flip();
              }
              return execute(...args);
            });
          }
        }
        const result = await h.action.execute({
          direction: "up",
          display: "external",
          boomerang: true,
          apexPause: moment === "after forward" ? 0 : 100,
        });
        expect(h.legs()).toHaveLength(1);
        expect(result.success).toBe(false);
        expect(result.staleDisplay).toEqual({
          observedGeneration: 1,
          currentGeneration: 2,
          currentDisplayKey: "internal",
          retry: "observe",
        });
      });
    }
    test("forward failure stops return", async () => {
      const h = harness({ route });
      if (route === "ctrlproxy") {
        h.ctrl.setSwipeResult({ success: false, error: "forward failed" });
      } else {
        h.adb.setCommandResult(
          "shell input touchscreen -d 2 swipe 100 160 100 40 300",
          "Error: forward failed",
        );
      }
      const result = await h.action.execute({
        direction: "up",
        display: "external",
        boomerang: true,
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain("forward failed");
      expect(h.legs()).toHaveLength(1);
      expect(h.timer.getSleepHistory()).toEqual([]);
    });
    for (const options of [{ focusTarget: false }] satisfies Array<Partial<SwipeOnOptions>>) {
      test(`still rejects ${Object.keys(options)[0]}`, async () => {
        const h = harness({ route });
        const result = await h.action.execute({ direction: "up", display: "external", ...options });
        expect(result.success).toBe(false);
        expect(result.error).toBe(
          `${Object.keys(options)[0]} is not supported with \`display\` yet`,
        );
        expect(h.adb.getAllCommands()).toEqual([]);
        expect(h.legs()).toEqual([]);
        expect(h.observe.getExecuteCallCount()).toBe(0);
      });
    }
  });
}

for (const entry of timingCases) {
  test(`default path unchanged: ${entry.name}`, async () => {
    const h = harness();
    const result = await h.action.execute({ direction: "up", autoTarget: false, ...entry.options });
    expect(result.success).toBe(true);
    expect(h.gesture.getSwipeCalls().map((leg) => leg.options?.duration)).toEqual(entry.durations);
    expect(h.timer.getSleepHistory()).toEqual(entry.pause > 0 ? [entry.pause] : []);
    expect(result.duration).toBe(entry.durations.reduce((a, b) => a + b, entry.pause));
  });
}

test("iOS display boomerang falls through with config to the existing default executor", async () => {
  const h = harness({ platform: "ios" });
  const executor = spyOn(VoiceOverSwipeExecutor.prototype, "executeSwipeGesture");
  const result = await h.action.execute({
    direction: "up",
    display: "external",
    speed: "fast",
    boomerang: true,
    apexPause: 25,
    returnSpeed: 2,
  });
  expect(result.success).toBe(true);
  expect(executor.mock.calls[0]?.[8]).toEqual({ apexPauseMs: 25, returnSpeed: 2 });
  expect(h.gesture.getSwipeCalls().map((leg) => leg.options?.duration)).toEqual([100, 50]);
  expect(h.timer.getSleepHistory()).toEqual([25]);
});

for (const display of [undefined, "external"]) {
  for (const timing of [
    { apexPause: 3001 },
    { apexPause: Infinity },
    { apexPause: NaN },
    { returnSpeed: 1e-320 },
    { returnSpeed: 0.02 },
    { returnSpeed: 3001 },
    { duration: 1500, apexPause: 3000, returnSpeed: 1 },
    { duration: Infinity },
    { duration: NaN },
    { speed: "slow", returnSpeed: 0.1 },
  ] satisfies Array<Partial<SwipeOnOptions>>) {
    test(`unsafe boomerang dispatches zero legs: ${display} ${JSON.stringify(timing)}`, async () => {
      const h = harness({ route: "adb" });
      const result = await h.action.execute({
        direction: "up",
        autoTarget: false,
        display,
        boomerang: true,
        ...timing,
      });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/apexPause|returnSpeed|duration/);
      expect(h.commands()).toEqual([]);
      expect(h.gesture.getSwipeCalls()).toEqual([]);
      expect(h.timer.getSleepHistory()).toEqual([]);
    });
  }
}
test("shared return duration rejects non-finite and over-budget results", () => {
  for (const returnSpeed of [1e-320, 0.02, Infinity, NaN, 0, -1]) {
    expect(() => getReturnDuration({ forwardDuration: 300, returnSpeed })).toThrow(/returnSpeed/);
  }
});

test("action preflight uses the injected geometry preset duration", async () => {
  const h = harness({ route: "adb" });
  spyOn(DefaultElementGeometry.prototype, "getSwipeDurationFromSpeed").mockReturnValue(2000);
  const result = await h.action.execute({
    direction: "up",
    display: "external",
    boomerang: true,
    returnSpeed: 0.5,
  });
  expect(result.success).toBe(false);
  expect(result.error).toContain("return duration <= 3000ms");
  expect(h.commands()).toEqual([]);
  expect(h.gesture.getSwipeCalls()).toEqual([]);
});

test.each(["settle-throws", "throws"] as const)(
  "confirmed display swipe preserves delivery after %s",
  async (outcome) => {
    const h = harness();
    h.action.observedInteraction = BaseVisualChange.prototype.observedInteraction;
    const destination = {
      ...observation,
      viewHierarchy: { hierarchy: { node: { text: "Destination" } }, displayId: 2 },
    };
    let postReads = 0;
    h.observe.setObserveResult(() => {
      if (!h.legs().length) {
        return observation;
      }
      postReads++;
      if (outcome === "throws" || postReads > 1) {
        throw new Error("display post-read unavailable");
      }
      return destination;
    });
    const result = await h.action.execute({ direction: "up", display: "external" });
    expect(h.legs()).toHaveLength(1);
    if (outcome === "throws") {
      expect(result.success).toBe(false);
      expect(result.error).toContain("Do not retry automatically");
      expect(result.observation).toBeUndefined();
    } else {
      expect(result.success).toBe(true);
      expect(result.observation?.viewHierarchy).toEqual(destination.viewHierarchy);
      expect(result.observation?.freshness?.warning).toContain("display settle");
    }
  },
);
