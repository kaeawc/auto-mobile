import { spyOn } from "bun:test";
import { SwipeOn } from "../../../../src/features/action/swipeon/SwipeOn";
import { TalkBackSwipeExecutor } from "../../../../src/features/action/swipeon/TalkBackSwipeExecutor";
import { VoiceOverSwipeExecutor } from "../../../../src/features/action/swipeon/VoiceOverSwipeExecutor";
import { AndroidCtrlProxyClient } from "../../../../src/features/observe/android";
import type { DisplayTransitionReader } from "../../../../src/features/observe/DisplayTransition";
import type { BootedDevice, ObserveResult } from "../../../../src/models";
import { FakeAdbClient } from "../../../fakes/FakeAdbClient";
import { FakeCtrlProxy } from "../../../fakes/FakeCtrlProxy";
import { FakeObserveScreen } from "../../../fakes/FakeObserveScreen";
import { FakeGestureExecutor } from "../../../fakes/FakeGestureExecutor";
import { FakeTimer } from "../../../fakes/FakeTimer";
import { FakeAccessibilityDetector } from "../../../fakes/FakeAccessibilityDetector";
import { FakeIosVoiceOverDetector } from "../../../fakes/FakeIosVoiceOverDetector";

const device: BootedDevice = {
  deviceId: "swipe-display-search",
  platform: "android",
  name: "Search fake",
  displays: {
    panels: [{ key: "external", role: "external", sizePx: { width: 200, height: 200 } }],
    postures: [],
  },
};
const edges = { left: 30, top: 60, right: 10, bottom: 20 };
export function frame({
  text = "Start",
  key = "external",
  available = false,
  fresh = true,
}: {
  text?: string;
  key?: string;
  available?: boolean;
  fresh?: boolean;
} = {}): ObserveResult {
  return {
    observationId: text,
    timestamp: 1,
    displayRevision: 0,
    display: { key, role: "external", posture: "unknown", generation: 1 },
    screenSize: { width: 200, height: 200 },
    rotation: 0,
    systemInsets: edges,
    insets: {
      available,
      source: available ? "android-window-metrics" : "unavailable",
      units: "physical-pixels",
    },
    freshness: { isFresh: fresh },
    viewHierarchy: {
      hierarchy: {
        node: {
          $: {
            text,
            bounds: "[80,80][120,120]",
            "resource-id": "item",
            class: "android.widget.TextView",
          },
        },
      },
      displayId: key === "external" ? 2 : 0,
    },
  };
}
type Route = "ctrlproxy" | "adb";
export function harness({
  route = "ctrlproxy",
  platform = "android",
  available = false,
  foundAfter = 2,
  unchanged = false,
  stale = false,
  observationFor,
}: {
  route?: Route;
  platform?: "android" | "ios";
  available?: boolean;
  foundAfter?: number;
  unchanged?: boolean;
  stale?: boolean;
  observationFor?: (context: {
    display?: string;
    swipes: number;
    observation: ObserveResult;
  }) => ObserveResult;
} = {}) {
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const adb = new FakeAdbClient();
  adb.setCommandResult(
    "shell cmd display get-displays",
    'Display id 0: DisplayInfo{uniqueId "local:internal" type INTERNAL, real 100 x 100}\nDisplay id 2: DisplayInfo{uniqueId "local:external" type EXTERNAL, real 200 x 200}',
  );
  const ctrl = Object.assign(new FakeCtrlProxy(), {
    requestDeviceInfo: async () => ({ success: true, sdkInt: 36, totalTimeMs: 0 }),
  });
  ctrl.setSupportedCommands(route === "ctrlproxy" ? ["gesture_display_id_v1"] : []);
  spyOn(AndroidCtrlProxyClient, "getInstance").mockReturnValue(
    // @ts-expect-error -- Fake supplies the client methods exercised by this harness.
    ctrl,
  );
  const observe = new FakeObserveScreen();
  const detector = new FakeAccessibilityDetector();
  const talkback = spyOn(TalkBackSwipeExecutor.prototype, "executeSwipeGesture");
  const voiceover = spyOn(VoiceOverSwipeExecutor.prototype, "executeSwipeGesture");
  let revision = 0;
  let swipes = 0;
  let afterSwipe: (() => void) | undefined;
  let onObserve: ((count: number) => void) | undefined;
  let observeCount = 0;
  let wrongPanel = false;
  const transitions: DisplayTransitionReader = {
    revision: () => revision,
    identityRevision: () => revision + 1,
    sameIdentitySince: (_deviceId, stamp) => stamp === revision,
    currentObservedPanel: () => ({ key: revision ? "internal" : "external", role: "external" }),
  };
  const executeObserve = observe.execute.bind(observe);
  spyOn(observe, "execute").mockImplementation(async (options) => {
    observeCount++;
    onObserve?.(observeCount);
    const observation = frame({
      key: !options?.display || wrongPanel ? "internal" : "external",
      text:
        !options?.display || wrongPanel || swipes >= foundAfter
          ? "Found"
          : unchanged
            ? "Start"
            : `Page ${swipes}`,
      available,
      fresh: !stale,
    });
    observe.setObserveResult(
      observationFor?.({ display: options?.display, swipes, observation }) ?? observation,
    );
    return executeObserve(options);
  });
  const gesture = new FakeGestureExecutor();
  // @ts-expect-error -- Fake supplies the adb methods exercised by this harness.
  const action = new SwipeOn({ ...device, platform }, adb, {
    timer,
    observeScreen: observe,
    executeGesture: gesture,
    accessibilityDetector: detector,
    iosVoiceOverDetector: new FakeIosVoiceOverDetector(),
    lastRenderedObservation: () => frame(),
    displayTransitions: transitions,
  });
  const baseObservedInteraction = action.observedInteraction.bind(action);
  const interactions: Array<{ display?: string; previousObservation?: ObserveResult }> = [];
  // Model BaseVisualChange's post-action capture while keeping its unrelated polling out of this unit test.
  action.observedInteraction = async (run, options) => {
    interactions.push(options);
    const previous =
      options.previousObservation ??
      (observationFor ? await observe.execute({ display: options.display }) : frame());
    const result = await run(previous);
    const observation = await observe.execute({ display: options.display });
    return { ...result, observation, effect: "changed" };
  };
  const dispatched = () => {
    swipes++;
    timer.advanceTime(300);
    afterSwipe?.();
  };
  const { commands, legs } = trackDispatches({ ctrl, adb, dispatched });
  return {
    action,
    gesture,
    adb,
    ctrl,
    observe,
    timer,
    legs,
    commands,
    interactions,
    talkback,
    voiceover,
    useRealObservedInteraction: () => {
      action.observedInteraction = baseObservedInteraction;
    },
    flip: () => {
      revision++;
    },
    afterSwipe: (callback: () => void) => {
      afterSwipe = callback;
    },
    onObserve: (callback: (count: number) => void) => {
      onObserve = callback;
    },
    wrongPanel: (enabled = true) => {
      wrongPanel = enabled;
    },
  };
}

function trackDispatches({
  ctrl,
  adb,
  dispatched,
}: {
  ctrl: FakeCtrlProxy;
  adb: FakeAdbClient;
  dispatched: () => void;
}) {
  const request = ctrl.requestSwipe.bind(ctrl);
  spyOn(ctrl, "requestSwipe").mockImplementation(async (...args) => {
    const result = await request(...args);
    dispatched();
    return result;
  });
  const drag = ctrl.requestDrag.bind(ctrl);
  spyOn(ctrl, "requestDrag").mockImplementation(async (...args) => {
    const result = await drag(...args);
    dispatched();
    return result;
  });
  const execute = adb.execute.bind(adb);
  spyOn(adb, "execute").mockImplementation(async (...args) => {
    const result = await execute(...args);
    if (args[0].join(" ").includes("touchscreen")) {
      dispatched();
    }
    return result;
  });
  const commands = () => adb.getAllCommands().filter((command) => command.includes("touchscreen"));
  const legs = () => [
    ...ctrl.getSwipeHistory(),
    ...ctrl.getDragHistory().map((leg) => ({ ...leg, duration: leg.dragDurationMs })),
    ...commands().map((command) => {
      const [x1, y1, x2, y2, duration] = command.split(" ").slice(-5).map(Number);
      return { x1, y1, x2, y2, duration };
    }),
  ];
  return { commands, legs };
}
