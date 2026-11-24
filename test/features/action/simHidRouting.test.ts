import { afterEach, describe, expect, test } from "bun:test";
import { ExecuteGesture } from "../../../src/features/action/ExecuteGesture";
import { InputKey } from "../../../src/features/action/InputKey";
import { PressButton } from "../../../src/features/action/PressButton";
import {
  SimHidCoordinateTapClient,
  simHidScreenFromObservation,
} from "../../../src/features/action/simHidRouting";
import type { IosCoordinateTapClient } from "../../../src/features/action/coordinateTapDispatch";
import type { BootedDevice } from "../../../src/models";
import type { AdbClientFactory } from "../../../src/utils/android-cmdline-tools/AdbClientFactory";
import type {
  IosSimulatorRawInput,
  SimHidRouteMode,
  SimHidRouteOptions,
} from "../../../src/utils/ios/simHid/IosSimulatorRawInput";
import type { SimHidOutcome } from "../../../src/utils/ios/simHid/SimHidProtocol";
import { SessionIosSimulatorRawInput } from "../../../src/utils/ios/simHid/IosSimulatorRawInput";
import { SimHidLaunchSettle } from "../../../src/utils/ios/simHid/SimHidLaunchSettle";
import { FakeSimHidClient, FakeSimHidSessionAccess } from "../../utils/ios/simHid/SimHidFakes";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeIOSCtrlProxy } from "../../fakes/FakeIOSCtrlProxy";
import { FakeTimer } from "../../fakes/FakeTimer";
import { createExecResult } from "../../../src/utils/execResult";
import { spyOnIosClientInstance } from "../../helpers/iosCtrlProxyClientSpies";

const simulator: BootedDevice = {
  deviceId: "A1B2C3D4-E5F6-7890-ABCD-EF1234567890",
  platform: "ios",
  name: "iPhone 17 Pro",
};
function createAdbFactory(adb: FakeAdbExecutor): AdbClientFactory {
  return { create: () => adb };
}
const SCREEN = { width: 402, height: 874 };
const UNREACHABLE = {
  success: false,
  error: "Not connected",
  dispatched: false,
  acknowledged: false,
};

/** Scripted HID route: one outcome per mode, recording every call. */
class FakeRawInput implements IosSimulatorRawInput {
  readonly calls: Array<{ kind: string; mode: SimHidRouteMode; args: unknown }> = [];
  constructor(private readonly outcomes: Partial<Record<SimHidRouteMode, SimHidOutcome>> = {}) {}
  private record(kind: string, args: unknown, options: SimHidRouteOptions): SimHidOutcome {
    this.calls.push({ kind, mode: options.mode, args });
    const outcome = this.outcomes[options.mode] ?? { status: "unavailable", reason: "not running" };
    if (outcome.status !== "unavailable") {
      options.onDispatch?.();
    }
    return outcome;
  }
  async tap(request: unknown, options: SimHidRouteOptions) {
    return this.record("tap", request, options);
  }
  async swipe(request: unknown, options: SimHidRouteOptions) {
    return this.record("swipe", request, options);
  }
  async key(key: string, modifiers: readonly string[], options: SimHidRouteOptions) {
    return this.record("key", { key, modifiers }, options);
  }
  async button(button: string, options: SimHidRouteOptions) {
    return this.record("button", button, options);
  }
}

type TapReply = Awaited<ReturnType<IosCoordinateTapClient["requestTapCoordinates"]>>;

class ScriptedTapClient implements IosCoordinateTapClient {
  taps = 0;
  doubleTaps = 0;
  constructor(private readonly reply: (onDispatch?: () => void) => Promise<TapReply>) {}
  async requestTapCoordinates(request: { onDispatch?: () => void }): Promise<TapReply> {
    this.taps++;
    return this.reply(request.onDispatch);
  }
  async requestDoubleTapCoordinates(): Promise<TapReply> {
    this.doubleTaps++;
    return { success: true };
  }
}

const delivered: SimHidOutcome = { status: "delivered", elapsedMs: 1 };

describe("SimHidCoordinateTapClient", () => {
  test("a running helper takes the tap and CtrlProxy is not called", async () => {
    const inner = new ScriptedTapClient(async () => ({ success: true }));
    const input = new FakeRawInput({ preferred: delivered });
    let dispatched = 0;
    const reply = await new SimHidCoordinateTapClient(
      inner,
      input,
      () => SCREEN,
    ).requestTapCoordinates({
      x: 10,
      y: 20,
      duration: 50,
      onDispatch: () => dispatched++,
    });
    expect(reply).toMatchObject({ success: true, tapDiagnostics: { route: "simulatorHid" } });
    expect(inner.taps).toBe(0);
    expect(dispatched).toBe(1);
    expect(input.calls[0]).toEqual({
      kind: "tap",
      mode: "preferred",
      args: { x: 10, y: 20, holdMs: 50, screen: SCREEN },
    });
  });

  test("a helper sent:false reply leaves the caller undispatched for the CtrlProxy fallback", async () => {
    const helper = new FakeSimHidClient({ status: "unavailable", reason: "no message" });
    const timer = new FakeTimer();
    const input = new SessionIosSimulatorRawInput(
      simulator.deviceId,
      new FakeSimHidSessionAccess(helper, helper),
      new SimHidLaunchSettle(timer, 0),
      0,
    );
    const ctrlProxy = new ScriptedTapClient(async () => UNREACHABLE);
    let dispatched = 0;
    const reply = await new SimHidCoordinateTapClient(
      ctrlProxy,
      input,
      () => SCREEN,
    ).requestTapCoordinates({ x: 1, y: 1, onDispatch: () => dispatched++ });
    expect(helper.commands.length).toBeGreaterThan(0);
    expect(ctrlProxy.taps).toBe(1);
    expect(reply).toEqual(UNREACHABLE);
    expect(dispatched).toBe(0);
  });

  test("without a helper CtrlProxy taps; an unreachable CtrlProxy falls back to the helper", async () => {
    const healthy = new ScriptedTapClient(async () => ({ success: true }));
    const idle = new FakeRawInput({ fallback: delivered });
    expect(
      (
        await new SimHidCoordinateTapClient(healthy, idle, () => SCREEN).requestTapCoordinates({
          x: 1,
          y: 1,
        })
      ).success,
    ).toBe(true);
    expect(healthy.taps).toBe(1);
    expect(idle.calls.map((call) => call.mode)).toEqual(["preferred"]);

    const down = new ScriptedTapClient(async () => UNREACHABLE);
    const rescue = new FakeRawInput({ fallback: delivered });
    const reply = await new SimHidCoordinateTapClient(
      down,
      rescue,
      () => SCREEN,
    ).requestTapCoordinates({ x: 1, y: 1 });
    expect(reply.success).toBe(true);
    expect(rescue.calls.map((call) => call.mode)).toEqual(["preferred", "fallback"]);
  });

  test("a runner refusal, a dispatched failure or a display tap never falls back", async () => {
    const refused = new ScriptedTapClient(async () => ({
      success: false,
      error: "stale frame",
      acknowledged: true,
    }));
    const input = new FakeRawInput({ fallback: delivered });
    expect(
      (
        await new SimHidCoordinateTapClient(refused, input, () => SCREEN).requestTapCoordinates({
          x: 1,
          y: 1,
        })
      ).success,
    ).toBe(false);
    const lost = new ScriptedTapClient(async (onDispatch) => {
      onDispatch?.();
      return { success: false, error: "timed out", dispatched: true, acknowledged: false };
    });
    expect(
      (
        await new SimHidCoordinateTapClient(lost, input, () => SCREEN).requestTapCoordinates({
          x: 1,
          y: 1,
        })
      ).success,
    ).toBe(false);
    const display = new ScriptedTapClient(async () => ({ success: true }));
    await new SimHidCoordinateTapClient(display, input, () => SCREEN).requestTapCoordinates({
      x: 1,
      y: 1,
      displayId: 2,
    });
    expect(input.calls.map((call) => call.mode)).toEqual(["preferred", "preferred"]);
  });

  test("a throw before dispatch falls back; an indeterminate HID tap reports dispatched-unconfirmed", async () => {
    const throwing = new ScriptedTapClient(async () => {
      throw new Error("socket closed");
    });
    const reply = await new SimHidCoordinateTapClient(
      throwing,
      new FakeRawInput({ fallback: { status: "indeterminate", reason: "helper exited" } }),
      () => SCREEN,
    ).requestTapCoordinates({ x: 1, y: 1 });
    expect(reply).toEqual({
      success: false,
      dispatched: true,
      acknowledged: false,
      error: "helper exited",
    });
    await expect(
      new SimHidCoordinateTapClient(
        throwing,
        new FakeRawInput(),
        () => SCREEN,
      ).requestTapCoordinates({ x: 1, y: 1 }),
    ).rejects.toThrow("socket closed");
  });

  test("double taps stay on CtrlProxy and pixel-sized screens are not used", async () => {
    const inner = new ScriptedTapClient(async () => ({ success: true }));
    const input = new FakeRawInput({ preferred: delivered });
    await new SimHidCoordinateTapClient(inner, input, () => SCREEN).requestDoubleTapCoordinates(
      1,
      1,
    );
    expect(inner.doubleTaps).toBe(1);
    expect(input.calls).toEqual([]);
    expect(
      simHidScreenFromObservation({
        screenSize: { width: 1206, height: 2622, units: "physical-pixels" },
      }),
    ).toBeUndefined();
    expect(simHidScreenFromObservation({ screenSize: { width: 402, height: 874 } })).toEqual(
      SCREEN,
    );
  });

  test("only an upright portrait rotation keeps the HID screen", () => {
    const screenSize = { width: 402, height: 874 };
    expect(simHidScreenFromObservation({ screenSize, rotation: 0 })).toEqual(SCREEN);
    expect(simHidScreenFromObservation({ screenSize, rotation: 2 })).toBeUndefined();
    expect(simHidScreenFromObservation({ screenSize, rotation: 1 })).toBeUndefined();
    expect(simHidScreenFromObservation({ screenSize, rotation: 3 })).toBeUndefined();
  });
});

describe("iOS Simulator HID routing in actions", () => {
  let restore: (() => void) | undefined;
  afterEach(() => {
    restore?.();
    restore = undefined;
  });

  test("InputKey sends a key through a running helper, and falls back to it when CtrlProxy is down", async () => {
    const client = new FakeIOSCtrlProxy();
    const viaHelper = new FakeRawInput({ preferred: delivered });
    const key = new InputKey(simulator, {
      adbFactory: createAdbFactory(new FakeAdbExecutor()),
      timer: new FakeTimer(),
      iosClientFactory: () => client,
      iosRawInput: viaHelper,
    });
    expect(
      await key.press("enter", undefined, undefined, { modifiers: ["shift", "shift"] }),
    ).toEqual({
      success: true,
      key: "enter",
      keyCode: "enter",
    });
    expect(viaHelper.calls[0]!.args).toEqual({ key: "enter", modifiers: ["shift"] });
    expect(client.getPressKeyHistory()).toEqual([]);

    client.setPressKeyResult({ ...UNREACHABLE, totalTimeMs: 0 });
    const rescue = new FakeRawInput({ fallback: delivered });
    const fallbackKey = new InputKey(simulator, {
      adbFactory: createAdbFactory(new FakeAdbExecutor()),
      timer: new FakeTimer(),
      iosClientFactory: () => client,
      iosRawInput: rescue,
    });
    expect((await fallbackKey.press("tab")).success).toBe(true);
    expect(rescue.calls.map((call) => call.mode)).toEqual(["preferred", "fallback"]);
    expect(client.getPressKeyHistory()).toEqual([{ key: "tab", modifiers: [] }]);
  });

  test("InputKey keeps the verified meta+h home shortcut on CtrlProxy", async () => {
    const client = new FakeIOSCtrlProxy();
    const input = new FakeRawInput({ preferred: delivered });
    await new InputKey(simulator, {
      adbFactory: createAdbFactory(new FakeAdbExecutor()),
      timer: new FakeTimer(),
      iosClientFactory: () => client,
      iosRawInput: input,
    }).press("h", undefined, undefined, { modifiers: ["meta"] });
    expect(input.calls).toEqual([]);
    expect(client.getPressKeyHistory()).toEqual([{ key: "h", modifiers: ["meta"] }]);
  });

  test("PressButton power presses the simulator lock button through the helper", async () => {
    const client = new FakeIOSCtrlProxy();
    const spy = spyOnIosClientInstance(client);
    restore = () => spy.mockRestore();
    const input = new FakeRawInput({ preferred: delivered });
    const result = await new PressButton(simulator, null, new FakeTimer(), {
      iosRawInput: input,
    }).press("power");
    expect(result).toMatchObject({ success: true, button: "power" });
    expect(input.calls).toEqual([{ kind: "button", mode: "preferred", args: "lock" }]);
  });

  test("PressButton home presses the HID Home button instead of launching SpringBoard", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const client = new FakeIOSCtrlProxy(timer);
    client.setHierarchyData({
      packageName: "com.apple.springboard",
      updatedAt: 1,
      hierarchy: { className: "XCUIApplication" },
    });
    const spy = spyOnIosClientInstance(client);
    restore = () => spy.mockRestore();
    const launches: string[][] = [];
    const input = new FakeRawInput({ preferred: delivered });
    const result = await new PressButton(simulator, null, timer, {
      iosRawInput: input,
      simctl: {
        executeCommandArgs: async (args) => {
          launches.push(args);
          return createExecResult("", "");
        },
      },
    }).press("home");
    expect(result.success).toBe(true);
    expect(input.calls).toEqual([{ kind: "button", mode: "preferred", args: "home" }]);
    expect(launches).toEqual([]);
    expect(client.getPressHomeRequestCount()).toBe(0);
  });

  test("ExecuteGesture swipes through the helper, and through it again when CtrlProxy is down", async () => {
    const client = new FakeIOSCtrlProxy();
    const spy = spyOnIosClientInstance(client);
    restore = () => spy.mockRestore();
    const preferred = new FakeRawInput({ preferred: delivered });
    const swiped = await new ExecuteGesture(simulator).swipe(
      { x1: 10, y1: 700, x2: 10, y2: 100 },
      { duration: 300, simulatorHid: { input: preferred, screen: SCREEN } },
    );
    expect(swiped).toMatchObject({ success: true, dispatchRoute: "simulatorHid" });
    expect(preferred.calls[0]!.args).toEqual({
      from: { x: 10, y: 700 },
      to: { x: 10, y: 100 },
      durationMs: 300,
      screen: SCREEN,
    });

    client.setSwipeResult({ ...UNREACHABLE, totalTimeMs: 0 });
    const rescue = new FakeRawInput({ fallback: delivered });
    const rescued = await new ExecuteGesture(simulator).swipe(
      { x1: 10, y1: 700, x2: 10, y2: 100 },
      { duration: 300, simulatorHid: { input: rescue, screen: SCREEN } },
    );
    expect(rescued.success).toBe(true);
    expect(rescue.calls.map((call) => call.mode)).toEqual(["preferred", "fallback"]);
  });
});
