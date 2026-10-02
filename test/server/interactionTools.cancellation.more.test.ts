import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { BootedDevice, ObserveResult } from "../../src/models";
import { SelectAllText } from "../../src/features/action/SelectAllText";
import { PressButton } from "../../src/features/action/PressButton";
import { Rotate } from "../../src/features/action/Rotate";
import { SetPosture } from "../../src/features/device/SetPosture";
import { AwaitIdle } from "../../src/features/observe/AwaitIdle";
import { BaseVisualChange } from "../../src/features/action/BaseVisualChange";
import { IOSCtrlProxyClient } from "../../src/features/observe/ios";
import { FakeIOSCtrlProxy } from "../fakes/FakeIOSCtrlProxy";
import { AndroidCtrlProxyClient } from "../../src/features/observe/android";
import { ToolRegistry } from "../../src/server/toolRegistry";
import {
  registerInteractionTools,
  setSelectAllTextFactory,
  resetSelectAllTextFactory,
  setPressButtonFactory,
  resetPressButtonFactory,
  setRotateFactory,
  resetRotateFactory,
  setSetPostureFactory,
  resetSetPostureFactory,
} from "../../src/server/interactionTools";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeObserveScreen } from "../fakes/FakeObserveScreen";
import { createExecResult } from "../../src/utils/execResult";

const device: BootedDevice = { name: "Foldable", deviceId: "emulator-cancel", platform: "android" };
const handler = (name: string) => {
  const registered = ToolRegistry.getTool(name)?.deviceAwareHandler;
  if (!registered) {
    throw new Error(`Missing registered handler: ${name}`);
  }
  return registered;
};

// Execute real command logic without the unrelated observation pipeline.
const observation = new FakeObserveScreen();
observation.setObserveResult({
  screenSize: { width: 100, height: 200 },
  display: { key: "default", role: "inner", posture: "opened", generation: 1 },
} as ObserveResult);
const bypassObservation = () =>
  spyOn(BaseVisualChange.prototype, "observedInteraction").mockImplementation(async (block) =>
    block(await observation.execute({})),
  );

describe("registered interaction handlers honor cancellation", () => {
  beforeEach(() => {
    ToolRegistry.clearTools();
    registerInteractionTools();
  });
  afterEach(() => {
    resetSelectAllTextFactory();
    resetPressButtonFactory();
    resetRotateFactory();
    resetSetPostureFactory();
    ToolRegistry.clearTools();
  });

  test.each(["selectAllText", "pressButton", "setPosture", "rotate"])(
    "%s dispatches nothing for a pre-aborted request",
    async (name) => {
      const adb = new FakeAdbExecutor();
      const timer = new FakeTimer();
      timer.enableAutoAdvance();
      let selectAllDispatches = 0;
      setSelectAllTextFactory(
        () =>
          new SelectAllText(device, adb, () => ({
            requestSelectAll: async () => {
              selectAllDispatches++;
              return { success: true, totalTimeMs: 0 };
            },
          })),
      );
      setPressButtonFactory(() => new PressButton(device, adb, timer));
      setRotateFactory(() => {
        const rotate = new Rotate(device, adb, timer);
        rotate.awaitIdle = new AwaitIdle(device, { create: () => adb }, timer);
        return rotate;
      });
      setSetPostureFactory(
        () =>
          new SetPosture(device, {
            timer,
            adbFactory: { create: () => adb },
            observeFactory: () => observation,
          }),
      );
      const observed = bypassObservation();
      const settingsGet = spyOn(
        AndroidCtrlProxyClient.prototype,
        "requestSettingsGet",
      ).mockResolvedValue({ success: true, found: true, value: "0" });
      const settingsPut = spyOn(
        AndroidCtrlProxyClient.prototype,
        "requestSettingsPut",
      ).mockResolvedValue({ success: true });
      const controller = new AbortController();
      controller.abort();
      try {
        await expect(
          handler(name)(
            device,
            { button: "volume_up", posture: "opened", orientation: "landscape" },
            undefined,
            controller.signal,
          ),
        ).rejects.toThrow("Operation cancelled");
        expect(adb.getExecutedCommands()).toEqual([]);
        expect(selectAllDispatches).toBe(0);
        expect(settingsGet.mock.calls).toHaveLength(0);
        expect(settingsPut.mock.calls).toHaveLength(0);
      } finally {
        observed.mockRestore();
        settingsGet.mockRestore();
        settingsPut.mockRestore();
        AndroidCtrlProxyClient.resetInstances();
      }
    },
  );

  test("setPosture aborts its polling wait before another device command", async () => {
    const adb = new FakeAdbExecutor();
    const timer = new FakeTimer();
    adb.setCommandResponse(
      "shell cmd device_state print-states",
      createExecResult(
        readFileSync(
          new URL("../fixtures/android-display/foldpf-print-states.txt", import.meta.url),
          "utf8",
        ),
        "",
      ),
    );
    adb.setCommandResponse(
      "shell cmd device_state state",
      createExecResult(
        readFileSync(
          new URL("../fixtures/android-display/foldpf-5-after-reset-state.txt", import.meta.url),
          "utf8",
        ),
        "",
      ),
    );
    setSetPostureFactory(
      () =>
        new SetPosture(device, {
          timer,
          adbFactory: { create: () => adb },
          observeFactory: () => observation,
        }),
    );
    const controller = new AbortController();
    const pending = handler("setPosture")(
      device,
      { posture: "opened" },
      undefined,
      controller.signal,
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(timer.getSleepHistory().length).toBeGreaterThan(0);
    let settled = false;
    void pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    controller.abort();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(true);
    await expect(pending).rejects.toThrow("device may still complete the change");
    expect(timer.now()).toBe(0);
    const commands = adb.getExecutedCommands();
    timer.advanceTime(3000);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(adb.getExecutedCommands()).toEqual(commands);
  });

  test("rotate aborts its rotation wait without restoring settings or reading again", async () => {
    const adb = new FakeAdbExecutor();
    const timer = new FakeTimer();
    adb.setCommandResponse(
      'shell dumpsys window | grep -i "mRotation="',
      createExecResult("mRotation=0", ""),
    );
    const settingsGet = spyOn(
      AndroidCtrlProxyClient.prototype,
      "requestSettingsGet",
    ).mockResolvedValue({ success: true, found: true, value: "1" });
    const settingsPut = spyOn(
      AndroidCtrlProxyClient.prototype,
      "requestSettingsPut",
    ).mockResolvedValue({ success: false });
    const rotate = new Rotate(device, adb, timer);
    rotate.awaitIdle = new AwaitIdle(device, { create: () => adb }, timer);
    setRotateFactory(() => rotate);
    const observed = bypassObservation();
    const controller = new AbortController();
    try {
      const pending = handler("rotate")(
        device,
        { orientation: "landscape" },
        undefined,
        controller.signal,
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(timer.getSleepHistory().length).toBeGreaterThan(0);
      let settled = false;
      void pending.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      controller.abort();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(settled).toBe(true);
      await expect(pending).rejects.toThrow("device may still complete the change");
      expect(timer.now()).toBe(0);
      const commands = adb.getExecutedCommands();
      const puts = settingsPut.mock.calls.length;
      timer.advanceTime(5000);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(adb.getExecutedCommands()).toEqual(commands);
      expect(settingsPut.mock.calls.length).toBe(puts);
    } finally {
      observed.mockRestore();
      settingsGet.mockRestore();
      settingsPut.mockRestore();
      AndroidCtrlProxyClient.resetInstances();
    }
  });
  test("setPosture cancellation after fold dispatch skips display resize and observation", async () => {
    const adb = new FakeAdbExecutor();
    const timer = new FakeTimer();
    const controller = new AbortController();
    adb.abortAfterCommand("emu unfold", controller);
    const observe = new FakeObserveScreen();
    setSetPostureFactory(
      () =>
        new SetPosture(device, {
          timer,
          adbFactory: { create: () => adb },
          observeFactory: () => observe,
        }),
    );
    await expect(
      handler("setPosture")(
        device,
        { posture: "opened", displayPreset: "tablet" },
        undefined,
        controller.signal,
      ),
    ).rejects.toThrow("device may still complete the change");
    expect(adb.getExecutedCommands()).toEqual([
      "shell cmd device_state print-states",
      "emu unfold",
    ]);
    expect(observe.getExecuteCallCount()).toBe(0);
  });

  test("rotate cancellation after disabling auto-rotate skips target write and rollback", async () => {
    const adb = new FakeAdbExecutor();
    const timer = new FakeTimer();
    const controller = new AbortController();
    adb.setCommandResponse(
      'shell dumpsys window | grep -i "mRotation="',
      createExecResult("mRotation=0", ""),
    );
    adb.abortAfterCommand("shell settings put system accelerometer_rotation 0", controller);
    const settingsGet = spyOn(
      AndroidCtrlProxyClient.prototype,
      "requestSettingsGet",
    ).mockResolvedValue({ success: true, found: true, value: "1" });
    const settingsPut = spyOn(
      AndroidCtrlProxyClient.prototype,
      "requestSettingsPut",
    ).mockResolvedValue({ success: false });
    setRotateFactory(() => new Rotate(device, adb, timer));
    const observed = bypassObservation();
    try {
      await expect(
        handler("rotate")(device, { orientation: "landscape" }, undefined, controller.signal),
      ).rejects.toThrow("device may still complete the change");
      expect(adb.getExecutedCommands()).toEqual([
        'shell dumpsys window | grep -i "mRotation="',
        "shell settings put system accelerometer_rotation 0",
      ]);
      expect(settingsPut.mock.calls).toHaveLength(1);
      expect(timer.getSleepHistory()).toEqual([]);
    } finally {
      observed.mockRestore();
      settingsGet.mockRestore();
      settingsPut.mockRestore();
      AndroidCtrlProxyClient.resetInstances();
    }
  });

  test("pressButton simulator home cancellation stops foreground verification retries", async () => {
    const iosDevice: BootedDevice = {
      name: "iPhone",
      platform: "ios",
      deviceId: "A1B2C3D4-E5F6-7890-ABCD-EF1234567890",
    };
    const timer = new FakeTimer();
    const adb = new FakeAdbExecutor();
    const client = new FakeIOSCtrlProxy(timer);
    client.setHierarchyData({
      packageName: "com.example.app",
      updatedAt: 1,
      hierarchy: { className: "XCUIApplication" },
    });
    const instance = spyOn(IOSCtrlProxyClient, "getInstance").mockReturnValue(
      client as unknown as IOSCtrlProxyClient,
    );
    const reads = spyOn(client, "requestHierarchySync");
    const launches: string[][] = [];
    setPressButtonFactory(
      () =>
        new PressButton(iosDevice, adb, timer, {
          executeCommandArgs: async (args) => {
            launches.push(args);
            return createExecResult("", "");
          },
        }),
    );
    const observed = bypassObservation();
    const controller = new AbortController();
    try {
      const pending = handler("pressButton")(
        iosDevice,
        { button: "home" },
        undefined,
        controller.signal,
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(timer.getSleepHistory().length).toBeGreaterThan(0);
      controller.abort();
      await expect(pending).rejects.toThrow("Operation cancelled");
      expect(timer.now()).toBe(0);
      expect(launches).toHaveLength(1);
      const readCount = reads.mock.calls.length;
      timer.advanceTime(5000);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(reads.mock.calls).toHaveLength(readCount);
      expect(launches).toHaveLength(1);
    } finally {
      observed.mockRestore();
      reads.mockRestore();
      instance.mockRestore();
    }
  });
});
