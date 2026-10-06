import {
  cancellationHandlers,
  cancellationTests,
  pausedSleep,
  cleanupDeadline,
} from "../helpers/interactionCancellation";
import { describe, expect, spyOn } from "bun:test";
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
import { getAbortSignal, runWithAbortSignal } from "../../src/utils/AbortContext";
import { FakeAwaitIdle } from "../fakes/FakeAwaitIdle";
import { createExecResult } from "../../src/utils/execResult";

const printStates = readFileSync(
  new URL("../fixtures/android-display/foldpf-print-states.txt", import.meta.url),
  "utf8",
);
const resetState = readFileSync(
  new URL("../fixtures/android-display/foldpf-5-after-reset-state.txt", import.meta.url),
  "utf8",
);

const device: BootedDevice = { name: "Foldable", deviceId: "emulator-cancel", platform: "android" };
const handler = cancellationHandlers(["selectAllText", "pressButton", "setPosture", "rotate"]);

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
  const test = cancellationTests(() => {
    observation.clearHistory();
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
    const { started, sleep } = pausedSleep(timer);
    try {
      adb.setCommandResponse(
        "shell cmd device_state print-states",
        createExecResult(printStates, ""),
      );
      adb.setCommandResponse("shell cmd device_state state", createExecResult(resetState, ""));
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
      await started;
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
      await pending.catch(() => {});
      expect(settled).toBe(true);
      await expect(pending).rejects.toThrow("device may still complete the change");
      expect(timer.now()).toBe(0);
      const commands = adb.getExecutedCommands();
      timer.advanceTime(3000);
      await sleep.mock.results[0]!.value;
      expect(adb.getExecutedCommands()).toEqual(commands);
    } finally {
      timer.resolveAll();
      sleep.mockRestore();
    }
  });

  test("rotate cancellation during waitForRotation restores auto-rotate without further reads", async () => {
    const adb = new FakeAdbExecutor();
    const timer = new FakeTimer();
    const { started, sleep } = pausedSleep(timer);
    adb.setCommandResponse("shell dumpsys window displays", createExecResult("mRotation=0", ""));
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
      await started;
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
      await pending.catch(() => {});
      expect(settled).toBe(true);
      await expect(pending).rejects.toThrow("device may still complete the change");
      expect(timer.now()).toBe(0);
      expect(adb.getExecutedCommands()).toContain(
        "shell settings put system accelerometer_rotation 1",
      );
      const commands = adb.getExecutedCommands();
      const puts = settingsPut.mock.calls.length;
      timer.advanceTime(5000);
      await sleep.mock.results[0]!.value;
      expect(adb.getExecutedCommands()).toEqual(commands);
      expect(settingsPut.mock.calls.length).toBe(puts);
    } finally {
      sleep.mockRestore();
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
        new SetPosture(
          { ...device, displays: { panels: [], postures: ["closed", "opened"] } },
          {
            timer,
            adbFactory: { create: () => adb },
            observeFactory: () => observe,
          },
        ),
    );
    await expect(
      handler("setPosture")(
        device,
        { posture: "opened", displayPreset: "tablet" },
        undefined,
        controller.signal,
      ),
    ).rejects.toThrow("posture command sent, display preset not applied");
    expect(adb.getExecutedCommands()).toEqual([
      "shell cmd device_state print-states",
      "emu unfold",
    ]);
    expect(observe.getExecuteCallCount()).toBe(0);
  });

  test("rotate cancellation after disabling auto-rotate skips target write and sends restore", async () => {
    const adb = new FakeAdbExecutor();
    const timer = new FakeTimer();
    const controller = new AbortController();
    adb.setCommandResponse("shell dumpsys window displays", createExecResult("mRotation=0", ""));
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
        "shell wm size",
        "shell dumpsys window displays",
        "shell settings put system accelerometer_rotation 0",
        "shell settings put system accelerometer_rotation 1",
      ]);
      expect(settingsPut.mock.calls).toHaveLength(2);
      expect(timer.getSleepHistory()).toEqual([]);
    } finally {
      observed.mockRestore();
      settingsGet.mockRestore();
      settingsPut.mockRestore();
      AndroidCtrlProxyClient.resetInstances();
    }
  });

  test("rotate cancellation after state reads but before a write sends no restore", async () => {
    const adb = new FakeAdbExecutor();
    const timer = new FakeTimer();
    const controller = new AbortController();
    const settingsGet = spyOn(
      AndroidCtrlProxyClient.prototype,
      "requestSettingsGet",
    ).mockImplementation(async () => {
      controller.abort();
      return { success: true, found: true, value: "1" };
    });
    const settingsPut = spyOn(
      AndroidCtrlProxyClient.prototype,
      "requestSettingsPut",
    ).mockResolvedValue({ success: false });
    setRotateFactory(() => new Rotate(device, adb, timer));
    const observed = bypassObservation();
    try {
      await expect(
        handler("rotate")(device, { orientation: "landscape" }, undefined, controller.signal),
      ).rejects.toThrow("Operation cancelled");
      expect(settingsPut.mock.calls).toHaveLength(0);
      expect(
        adb.getExecutedCommands().filter((command) => command.includes("settings put")),
      ).toEqual([]);
    } finally {
      observed.mockRestore();
      settingsGet.mockRestore();
      settingsPut.mockRestore();
      AndroidCtrlProxyClient.resetInstances();
    }
  });

  test.each([
    { state: "1", lockOrientation: true },
    { state: "0", lockOrientation: undefined },
    { state: "0", lockOrientation: false },
  ])(
    "rotate cancellation preserves an intended or unchanged lock: %j",
    async ({ state, lockOrientation }) => {
      const adb = new FakeAdbExecutor();
      const timer = new FakeTimer();
      const controller = new AbortController();
      adb.setCommandResponse("shell dumpsys window displays", createExecResult("mRotation=0", ""));
      adb.abortAfterCommand("shell settings put system accelerometer_rotation 0", controller);
      const settingsGet = spyOn(
        AndroidCtrlProxyClient.prototype,
        "requestSettingsGet",
      ).mockResolvedValue({ success: true, found: true, value: state });
      const settingsPut = spyOn(
        AndroidCtrlProxyClient.prototype,
        "requestSettingsPut",
      ).mockResolvedValue({ success: false });
      setRotateFactory(() => new Rotate(device, adb, timer));
      const observed = bypassObservation();
      try {
        await expect(
          handler("rotate")(
            device,
            {
              orientation: "landscape",
              ...(lockOrientation === undefined ? {} : { lockOrientation }),
            },
            undefined,
            controller.signal,
          ),
        ).rejects.toThrow("Operation cancelled");
        expect(
          adb.getExecutedCommands().filter((command) => command.includes("settings put")),
        ).toEqual(["shell settings put system accelerometer_rotation 0"]);
      } finally {
        observed.mockRestore();
        settingsGet.mockRestore();
        settingsPut.mockRestore();
        AndroidCtrlProxyClient.resetInstances();
      }
    },
  );

  test.each(["disable", "target", "restore"])(
    "rotate awaits a pending %s write before restoring on cancellation",
    async (phase) => {
      const adb = new FakeAdbExecutor();
      const timer = new FakeTimer();
      const cleanup = cleanupDeadline(timer);
      const controller = new AbortController();
      const heldWrite = Promise.withResolvers<ReturnType<typeof createExecResult>>();
      const started = Promise.withResolvers<void>();
      const writes: string[] = [];
      const heldCommand =
        phase === "disable"
          ? "shell settings put system accelerometer_rotation 0"
          : phase === "target"
            ? "shell settings put system user_rotation 1"
            : "shell settings put system accelerometer_rotation 1";
      const execute = spyOn(adb, "executeCommand").mockImplementation(async (command) => {
        if (command.startsWith("shell settings put")) {
          writes.push(command);
          if (command === heldCommand) {
            started.resolve();
            return heldWrite.promise;
          }
          if (command.endsWith("accelerometer_rotation 1")) {
            expect(getAbortSignal()).toBeUndefined();
          }
        }
        return createExecResult("mRotation=0", "");
      });
      const settingsGet = spyOn(
        AndroidCtrlProxyClient.prototype,
        "requestSettingsGet",
      ).mockResolvedValue({ success: true, found: true, value: "1" });
      const settingsPut = spyOn(
        AndroidCtrlProxyClient.prototype,
        "requestSettingsPut",
      ).mockResolvedValue({ success: false });
      const rotate = new Rotate(device, adb, timer);
      rotate.awaitIdle = new FakeAwaitIdle();
      setRotateFactory(() => rotate);
      const observed = bypassObservation();
      try {
        const pending = runWithAbortSignal(controller.signal, () =>
          handler("rotate")(device, { orientation: "landscape" }, undefined, controller.signal),
        );
        let settled = false;
        void pending.then(
          () => {
            settled = true;
          },
          () => {
            settled = true;
          },
        );
        await started.promise;
        controller.abort();
        await cleanup.started;
        expect(settled).toBe(false);
        expect(writes.at(-1)).toBe(heldCommand);
        expect(
          writes.filter((command) => command.endsWith("accelerometer_rotation 1")),
        ).toHaveLength(phase === "restore" ? 1 : 0);
        heldWrite.resolve(createExecResult("", ""));
        await expect(pending).rejects.toThrow("Operation cancelled");
        expect(writes.at(-1)).toBe("shell settings put system accelerometer_rotation 1");
        expect(timer.getPendingTimeoutCount()).toBe(0);
      } finally {
        cleanup.setTimeout.mockRestore();
        execute.mockRestore();
        observed.mockRestore();
        settingsGet.mockRestore();
        settingsPut.mockRestore();
        AndroidCtrlProxyClient.resetInstances();
      }
    },
  );

  test.each(["settled", "deadline"])(
    "rotate orders CtrlProxy restore after its pending disable write: %s",
    async (mode) => {
      const adb = new FakeAdbExecutor();
      const timer = new FakeTimer();
      const cleanup = cleanupDeadline(timer);
      const controller = new AbortController();
      const disable = Promise.withResolvers<{ success: boolean }>();
      const restored = Promise.withResolvers<void>();
      const restoreStarted = Promise.withResolvers<void>();
      const cleared = spyOn(timer, "clearTimeout").mockImplementation((handle) => {
        FakeTimer.prototype.clearTimeout.call(timer, handle);
        restored.resolve();
      });
      const started = Promise.withResolvers<void>();
      adb.setCommandResponse("shell dumpsys window displays", createExecResult("mRotation=0", ""));
      const settingsGet = spyOn(
        AndroidCtrlProxyClient.prototype,
        "requestSettingsGet",
      ).mockResolvedValue({ success: true, found: true, value: "1" });
      const settingsPut = spyOn(
        AndroidCtrlProxyClient.prototype,
        "requestSettingsPut",
      ).mockImplementation(async (_namespace, _key, value) => {
        if (value === "0") {
          started.resolve();
          return disable.promise;
        }
        restoreStarted.resolve();
        return { success: true };
      });
      setRotateFactory(() => new Rotate(device, adb, timer));
      const observed = bypassObservation();
      try {
        const pending = handler("rotate")(
          device,
          { orientation: "landscape" },
          undefined,
          controller.signal,
        );
        let settled = false;
        void pending.then(
          () => {
            settled = true;
          },
          () => {
            settled = true;
          },
        );
        await started.promise;
        controller.abort();
        await cleanup.started;
        expect(settled).toBe(false);
        expect(settingsPut.mock.calls.map((call) => call[2])).toEqual(["0"]);
        if (mode === "deadline") {
          timer.advanceTime(1000);
          await expect(pending).rejects.toThrow("accelerometer_rotation may be left changed");
          expect(settingsPut.mock.calls.map((call) => call[2])).toEqual(["0"]);
        }
        disable.resolve({ success: true });
        await restoreStarted.promise;
        await restored.promise;
        if (mode === "settled") {
          await expect(pending).rejects.toThrow("Operation cancelled");
        }
        expect(settingsPut.mock.calls.map((call) => call[2])).toEqual(["0", "1"]);
        expect(
          adb.getExecutedCommands().filter((command) => command.includes("settings put")),
        ).toEqual([]);
        expect(timer.getPendingTimeoutCount()).toBe(0);
      } finally {
        cleanup.setTimeout.mockRestore();
        cleared.mockRestore();
        observed.mockRestore();
        settingsGet.mockRestore();
        settingsPut.mockRestore();
        AndroidCtrlProxyClient.resetInstances();
      }
    },
  );

  test.each(["failure", "timeout"])(
    "rotate cancellation reports accelerometer_rotation when cleanup ends in %s",
    async (mode) => {
      const adb = new FakeAdbExecutor();
      const timer = new FakeTimer();
      const controller = new AbortController();
      const restoreStarted = Promise.withResolvers<void>();
      const restore = Promise.withResolvers<ReturnType<typeof createExecResult>>();
      adb.abortAfterCommand("shell settings put system accelerometer_rotation 0", controller);
      adb.setCommandResponse("shell dumpsys window displays", createExecResult("mRotation=0", ""));
      const originalExecute = adb.executeCommand.bind(adb);
      const execute = spyOn(adb, "executeCommand").mockImplementation(async (command) => {
        if (command === "shell settings put system accelerometer_rotation 1") {
          restoreStarted.resolve();
          if (mode === "failure") {
            throw new Error("settings provider refused write");
          }
          return restore.promise;
        }
        return originalExecute(command);
      });
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
        const pending = handler("rotate")(
          device,
          { orientation: "landscape" },
          undefined,
          controller.signal,
        );
        void pending.then(undefined, () => {});
        await restoreStarted.promise;
        if (mode === "timeout") {
          timer.advanceTime(1000);
        }
        await expect(pending).rejects.toThrow(
          "Rotation cancelled; accelerometer_rotation may be left changed",
        );
        expect(timer.getPendingTimeoutCount()).toBe(0);
        restore.resolve(createExecResult("", ""));
        await restore.promise;
      } finally {
        execute.mockRestore();
        observed.mockRestore();
        settingsGet.mockRestore();
        settingsPut.mockRestore();
        AndroidCtrlProxyClient.resetInstances();
      }
    },
  );

  test("rotate cancellation between restore transports still sends the ADB restore", async () => {
    const adb = new FakeAdbExecutor();
    const timer = new FakeTimer();
    const controller = new AbortController();
    adb.setCommandResponse("shell dumpsys window displays", createExecResult("mRotation=0", ""));
    const settingsGet = spyOn(
      AndroidCtrlProxyClient.prototype,
      "requestSettingsGet",
    ).mockResolvedValue({ success: true, found: true, value: "1" });
    const settingsPut = spyOn(
      AndroidCtrlProxyClient.prototype,
      "requestSettingsPut",
    ).mockImplementation(async (_namespace, key, value) => {
      if (key === "accelerometer_rotation" && value === "1") {
        controller.abort();
      }
      return { success: false };
    });
    const rotate = new Rotate(device, adb, timer);
    rotate.awaitIdle = new FakeAwaitIdle();
    setRotateFactory(() => rotate);
    const observed = bypassObservation();
    try {
      await expect(
        handler("rotate")(device, { orientation: "landscape" }, undefined, controller.signal),
      ).rejects.toThrow("Operation cancelled");
      expect(adb.getExecutedCommands().at(-1)).toBe(
        "shell settings put system accelerometer_rotation 1",
      );
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
    const { started, sleep } = pausedSleep(timer);
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
      await started;
      expect(timer.getSleepHistory().length).toBeGreaterThan(0);
      controller.abort();
      await expect(pending).rejects.toThrow("Operation cancelled");
      expect(timer.now()).toBe(0);
      expect(launches).toHaveLength(1);
      const readCount = reads.mock.calls.length;
      timer.advanceTime(5000);
      await sleep.mock.results[0]!.value;
      expect(reads.mock.calls).toHaveLength(readCount);
      expect(launches).toHaveLength(1);
    } finally {
      sleep.mockRestore();
      observed.mockRestore();
      reads.mockRestore();
      instance.mockRestore();
    }
  });
});
