import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SetPosture } from "../../../src/features/device/SetPosture";
import { InMemoryIosRequestedHingeAngleStore } from "../../../src/features/device/DuoHingeLayout";
import { DisplayTransitionTracker } from "../../../src/features/observe/DisplayTransition";
import type { DisplayTransitionSink } from "../../../src/features/observe/DisplayTransition";
import type { ObserveScreen } from "../../../src/features/observe/interfaces/ObserveScreen";
import { DeviceState } from "../../../src/features/utility/DeviceState";
import type { CurrentDisplayState } from "../../../src/features/utility/device-state/CurrentDisplayState";
import type { BootedDevice, ObserveResult } from "../../../src/models";
import { formatSetPostureMessage } from "../../../src/server/interactionTools/deviceHandlers";
import {
  getDeviceStateResultSchema,
  setPostureResultSchema,
} from "../../../src/server/toolOutputSchemas";
import { parseDevicectlDisplayInfo } from "../../../src/utils/ios-cmdline-tools/DevicectlDisplayInfo";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeDevicectlDisplayInfoSource } from "../../fakes/FakeDevicectlDisplayInfoSource";
import { FakeIOSCtrlProxy } from "../../fakes/FakeIOSCtrlProxy";
import { FakeNetworkFilterBridge } from "../../fakes/FakeNetworkFilterBridge";
import { FakeTimer } from "../../fakes/FakeTimer";
import { getStructuredPayload } from "../../../src/utils/toolUtils";

const fixtures = join(import.meta.dir, "../../fixtures");
const json = (path: string): unknown => JSON.parse(readFileSync(join(fixtures, path), "utf8"));

interface CapturedSetPosture {
  hingeAngle: number;
  observedHingeAngle?: number;
  posture: string;
}
interface CapturedDeviceState {
  deviceId: string;
  displays: NonNullable<BootedDevice["displays"]> & {
    current: CurrentDisplayState;
  };
}

/** A captured MCP tool-call envelope's structured payload. */
function captured<T>(path: string): T {
  const payload = getStructuredPayload<T>(
    json(path) as { structuredContent?: unknown; content?: unknown },
  );
  if (!payload) {
    throw new Error(`${path} has no structured payload`);
  }
  return payload;
}

const stuckSetPosture = captured<CapturedSetPosture>(
  "ios-duo-hinge/setposture-120-after-80-stuck.json",
);
const stuckState = captured<CapturedDeviceState>("ios-duo-hinge/getdevicestate-stuck.json");
const { current: stuckCurrent, ...inventory } = stuckState.displays;

const duo: BootedDevice = {
  name: "iPhone Duo",
  platform: "ios",
  deviceId: stuckState.deviceId,
  deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-Duo",
  displays: inventory,
};

function devicectl(panel: "inner" | "cover") {
  const parsed = parseDevicectlDisplayInfo(
    readFileSync(join(fixtures, `ios-devicectl/info-displays-duo-${panel}-active.json`), "utf8"),
  );
  if (parsed.kind !== "ok") {
    throw new Error(parsed.message);
  }
  return parsed.displays;
}

/** The runner's observation in the capture: no panel identity, the app window in points. */
function appWindow(panel: "inner" | "cover"): ObserveResult {
  return {
    display: { key: "0", role: "unknown", posture: "unknown", generation: 1 },
    screenSize: panel === "cover" ? { width: 386, height: 678 } : { width: 871, height: 669 },
  } as ObserveResult;
}

/** A simulator whose active panel follows a script, like the path-dependent Duo. */
function harness() {
  const client = new FakeIOSCtrlProxy();
  client.supportedCommands = ["set_hinge_angle"];
  const displays = new FakeDevicectlDisplayInfoSource();
  const store = new InMemoryIosRequestedHingeAngleStore();
  const tracker = new DisplayTransitionTracker(() => {});
  const transitionSink: DisplayTransitionSink = {
    revision: (deviceId) => tracker.revision(deviceId),
    identityRevision: (deviceId) => tracker.identityRevision(deviceId),
    rememberIosPosture: (device, display, posture) =>
      tracker.rememberIosPosture(device, display, posture),
    notifyAndroidTransition: () => {},
    notifyTransition: (deviceId, reason) => tracker.notifyTransition(deviceId, reason),
  };
  let active: "inner" | "cover" = "cover";
  // A pending panel switch the simulator applies only after this many more observations.
  let pending: { panel: "inner" | "cover"; afterObserves: number } | undefined;
  let observes = 0;
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const setPosture = new SetPosture(duo, {
    iosClientProvider: () => client,
    iosDisplayInfoSource: displays,
    iosHingeAngleStore: store,
    observeFactory: () =>
      ({
        execute: async () => {
          observes += 1;
          if (pending && pending.afterObserves-- <= 0) {
            active = pending.panel;
            displays.displays = devicectl(pending.panel);
            pending = undefined;
          }
          return {
            ...appWindow(active),
            displayRevision: tracker.revision(duo.deviceId),
          };
        },
      }) as ObserveScreen,
    timer,
    transitionSink,
  });
  const adb = new FakeAdbExecutor();
  const deviceState = new DeviceState(duo, {
    iosDisplayInfoSource: displays,
    iosHingeAngleStore: store,
    adbFactory: new FakeAdbClientFactory(adb),
    timer: new FakeTimer(),
    simctl: null,
    // The networkCondition read goes to the filter bridge; the real one spawns simctl.
    networkFilterBridge: new FakeNetworkFilterBridge(),
  });
  return {
    client,
    adb,
    timer,
    observeCount: () => observes,
    /** Request an angle; the simulator switches to `panel` only after `afterObserves` observations. */
    async hingeDelayed(angle: number, panel: "inner" | "cover", afterObserves: number) {
      pending = { panel, afterObserves };
      const result = await setPosture.executeHingeAngle(angle);
      if ("status" in result) {
        throw new Error(result.message);
      }
      return result;
    },
    /** Request an angle; the simulator then shows `panel` (devicectl names none for "unread"). */
    async hinge(angle: number, panel: "inner" | "cover" | "unread") {
      active = panel === "unread" ? "cover" : panel;
      displays.displays = panel === "unread" ? [] : devicectl(panel);
      const result = await setPosture.executeHingeAngle(angle);
      if ("status" in result) {
        throw new Error(result.message);
      }
      setPostureResultSchema.parse({ message: formatSetPostureMessage(result), ...result });
      return result;
    },
    showPanel(panel: "inner" | "cover") {
      displays.displays = devicectl(panel);
    },
    async current() {
      const state = await deviceState.getState(["networkCondition"]);
      getDeviceStateResultSchema.parse({ message: "Read device state", ...state });
      return state.displays?.current;
    },
  };
}

describe("setPosture hingeAngle on iPhone Duo compares the hinge with the layout (#17726)", () => {
  test("the capture echoed the request as observedHingeAngle and reported unknown", () => {
    // Before #17726: posture unknown, observedHingeAngle 120 while the app read 118.3.
    expect(stuckSetPosture).toMatchObject({
      hingeAngle: 120,
      observedHingeAngle: 120,
      posture: "unknown",
    });
    expect(stuckCurrent).toMatchObject({
      posture: "closed",
      activePanel: { key: "primary", role: "cover" },
    });
  });

  test("0 -> 80 -> 120 left on the cover layout warns instead of echoing the angle", async () => {
    const h = harness();
    expect(await h.hinge(0, "cover")).not.toHaveProperty("warnings");
    expect(await h.hinge(80, "cover")).not.toHaveProperty("warnings");
    const stuck = await h.hinge(120, "cover");
    expect(stuck).toMatchObject({ hingeAngle: 120, posture: "closed" });
    expect(stuck).not.toHaveProperty("observedHingeAngle");
    expect(stuck).not.toHaveProperty("postureReason");
    expect(stuck.warnings).toEqual([
      expect.stringContaining("requested 120 degrees, but the cover panel is still active"),
    ]);
    expect(stuck.warnings?.[0]).toContain("hingeAngle 180, then the target angle again");
    expect(formatSetPostureMessage(stuck)).toBe(
      "Requested hinge angle 120 degrees; the resulting angle could not be verified (posture closed)",
    );
    expect(h.client.getHingeAngleHistory()).toEqual([0, 80, 120]);
    // getDeviceState matches the captured stuck state and adds the requested angle.
    expect(await h.current()).toEqual({
      ...stuckCurrent,
      postureSource: "inferred_from_active_panel",
      requestedHingeAngle: 120,
    });
  });

  test("a delayed but successful cover -> inner switch settles without a warning", async () => {
    const h = harness();
    await h.hinge(0, "cover");
    const before = h.observeCount();
    const startedAt = h.timer.now();
    const opened = await h.hingeDelayed(120, "inner", 3);
    expect(opened).toMatchObject({ hingeAngle: 120, posture: "half_opened" });
    expect(opened).not.toHaveProperty("warnings");
    // Polled past the stale cover reads, well inside the settle window.
    expect(h.observeCount() - before).toBeGreaterThanOrEqual(4);
    expect(h.timer.now() - startedAt).toBeLessThan(3000);
  });

  test("the stuck 0 -> 80 -> 120 layout warns only after the bounded settle window", async () => {
    const h = harness();
    await h.hinge(0, "cover");
    await h.hinge(80, "cover");
    const startedAt = h.timer.now();
    const stuck = await h.hinge(120, "cover");
    expect(h.timer.now() - startedAt).toBeGreaterThanOrEqual(3000);
    expect(stuck.warnings).toEqual([
      expect.stringContaining("requested 120 degrees, but the cover panel is still active"),
    ]);
  });

  test("0 -> 120 on the inner layout is half_opened without a warning", async () => {
    const h = harness();
    await h.hinge(0, "cover");
    const opened = await h.hinge(120, "inner");
    expect(opened).toMatchObject({ hingeAngle: 120, posture: "half_opened" });
    expect(opened).not.toHaveProperty("warnings");
    expect(opened).not.toHaveProperty("observedHingeAngle");
    expect(await h.current()).toEqual({
      posture: "half_opened",
      postureSource: "requested_hinge_angle",
      activePanel: { key: "primary-1", role: "inner" },
      requestedHingeAngle: 120,
    });
  });

  test("180 recovers the stuck state and reads opened", async () => {
    const h = harness();
    await h.hinge(80, "cover");
    expect((await h.hinge(120, "cover")).warnings).toHaveLength(1);
    const recovered = await h.hinge(180, "inner");
    expect(recovered).toMatchObject({ hingeAngle: 180, posture: "opened" });
    expect(recovered).not.toHaveProperty("warnings");
    expect(await h.current()).toMatchObject({
      posture: "opened",
      postureSource: "inferred_from_active_panel",
      requestedHingeAngle: 180,
    });
  });

  test("90 from 0 on the cover layout is the captured healthy state", async () => {
    const h = harness();
    await h.hinge(0, "cover");
    const result = await h.hinge(90, "cover");
    expect(result).toMatchObject({ hingeAngle: 90, posture: "closed" });
    expect(result).not.toHaveProperty("warnings");
  });

  test("an undeterminable panel stays unknown with a reason and no layout warning", async () => {
    const result = await harness().hinge(120, "unread");
    expect(result).toMatchObject({ posture: "unknown", postureReason: expect.any(String) });
    expect(result).not.toHaveProperty("warnings");
    expect(result).not.toHaveProperty("observedHingeAngle");
  });

  test("getDeviceState without a requested angle keeps the inner panel as opened", async () => {
    const h = harness();
    h.showPanel("inner");
    expect(await h.current()).toEqual({
      posture: "opened",
      postureSource: "inferred_from_active_panel",
      activePanel: { key: "primary-1", role: "inner" },
    });
    expect(h.adb.getExecutedCommands()).toEqual([]);
  });
});
