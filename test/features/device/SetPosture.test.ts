import { describe, expect, spyOn, test } from "bun:test";
import type { BootedDevice, ObserveResult, Posture } from "../../../src/models";
import { classifyIosPostureObservation, SetPosture } from "../../../src/features/device/SetPosture";
import type { DisplayPanel } from "../../../src/models/DisplayPanel";
import {
  DisplayTransitionTracker,
  type DisplayTransitionSink,
} from "../../../src/features/observe/DisplayTransition";
import type { ObserveScreen } from "../../../src/features/observe/interfaces/ObserveScreen";
import type { AdbClientFactory } from "../../../src/utils/android-cmdline-tools/AdbClientFactory";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeIOSCtrlProxy } from "../../fakes/FakeIOSCtrlProxy";
import { createExecResult } from "../../../src/utils/execResult";
import { FakeTimer } from "../../fakes/FakeTimer";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ActionableError } from "../../../src/models/ActionableError";
import { parseAndroidCommittedStateIdentifier } from "../../../src/utils/android-cmdline-tools/AndroidDisplayInventory";

const fixture = (name: string): string =>
  readFileSync(join(import.meta.dir, "../../fixtures/android-display", name), "utf8");
const foldStates = fixture("foldpf-print-states.txt");
const phoneStates = fixture("phone-states.txt");
const closedState = fixture("foldpf-5-after-reset-state.txt");
const openedState = fixture("foldpf-1-default-state.txt");
const rearState = fixture("foldpf-2-rear-display-override-state.txt");
import { logger } from "../../../src/utils/logger";
import { loadDuoEnumerate } from "../../fixtures/loadDuoEnumerate";
import {
  parseSimulatorDisplays,
  simulatorDeviceDisplays,
} from "../../../src/utils/ios-cmdline-tools/SimulatorDisplays";

const display = {
  key: "panel-inner",
  role: "inner",
  posture: "half_opened",
  generation: 4,
} as const;
const observation = {
  display,
  screenSize: { width: 200, height: 300 },
  deviceLock: { locked: true, keyguardShowing: true },
} as ObserveResult;

function makeDevice(
  deviceId = "emulator-5554",
  postures: Posture[] = ["closed", "half_opened", "opened", "rear_display", "flipped", "tent"],
): BootedDevice {
  return {
    name: "Test foldable",
    platform: "android",
    deviceId,
    displays: { panels: [], postures },
  };
}

function makeFeature(device: BootedDevice, adb: FakeAdbExecutor, timer = new FakeTimer()) {
  timer.enableAutoAdvance();
  const adbFactory: AdbClientFactory = { create: () => adb };
  const tracker = new DisplayTransitionTracker(() => {});
  let observeCount = 0;
  const observeFactory = () =>
    ({
      execute: async () => {
        observeCount += 1;
        tracker.notifyTransition(device.deviceId, "fake observed identity change");
        return observation;
      },
    }) as ObserveScreen;
  return {
    feature: new SetPosture(device, {
      adbFactory,
      observeFactory,
      timer,
      transitionSink: tracker,
    }),
    getObserveCount: () => observeCount,
    tracker,
    timer,
  };
}

describe("SetPosture", () => {
  test("returns the real tracker generation after the fake observation notifies", async () => {
    const device = makeDevice();
    const { feature, tracker } = makeFeature(device, new FakeAdbExecutor());
    const result = await feature.execute("closed");
    expect(tracker.identityRevision(device.deviceId)).toBe(1);
    expect("display" in result && result.display.generation).toBe(
      tracker.identityRevision(device.deviceId),
    );
  });

  test("parses only the committed state, even when base and override differ", () => {
    expect(parseAndroidCommittedStateIdentifier(rearState)).toBe(3);
    expect(
      parseAndroidCommittedStateIdentifier(
        fixture("foldpf-6-fold-from-closed-base-while-override-state.txt"),
      ),
    ).toBe(3);
    expect(
      parseAndroidCommittedStateIdentifier(
        fixture("foldpf-2-rear-display-override-print-state.txt"),
      ),
    ).toBe(3);
  });

  test("maps each emulator posture to its console command and returns fresh display state", async () => {
    const mappings = [
      ["closed", ["shell cmd device_state state reset", "emu fold"]],
      ["half_opened", ["emu posture 2"]],
      ["opened", ["shell cmd device_state state reset", "emu unfold"]],
      ["flipped", ["emu posture 4"]],
      ["tent", ["emu posture 5"]],
    ] as const;

    for (const [posture, commands] of mappings) {
      const adb = new FakeAdbExecutor();
      adb.setCommandResponse(
        "shell cmd device_state print-states",
        createExecResult(phoneStates, ""),
      );
      const { feature, getObserveCount } = makeFeature(makeDevice(), adb);
      const result = await feature.execute(posture);
      expect(adb.getExecutedCommands()).toEqual([
        "shell cmd device_state print-states",
        ...commands,
      ]);
      expect(getObserveCount()).toBe(1);
      expect(result).toEqual({ posture, display: { ...display, generation: 1 }, locked: true });
    }
  });

  test("sets the Resizable emulator display preset", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse(
      "shell cmd device_state print-states",
      createExecResult(phoneStates, ""),
    );
    const { feature } = makeFeature(makeDevice("emulator-5554", ["closed", "opened"]), adb);
    await feature.execute("opened", "tablet");
    expect(adb.getExecutedCommands()).toEqual([
      "shell cmd device_state print-states",
      "emu unfold",
      "emu resize-display 2",
    ]);
  });

  test("non-foldable emulator proceeds when device_state service is absent", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandError(
      "shell cmd device_state print-states",
      new Error("Can't find service: device_state"),
    );
    const { feature } = makeFeature(makeDevice("emulator-5554", ["closed", "opened"]), adb);
    await feature.execute("closed");
    expect(adb.getExecutedCommands()).toEqual(["shell cmd device_state print-states", "emu fold"]);
  });

  test("uses the emulator rear display device state instead of closing its hinge", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse("shell cmd device_state print-states", createExecResult(foldStates, ""));
    adb.setCommandResponse("shell cmd device_state state", createExecResult(rearState, ""));
    const { feature } = makeFeature(makeDevice(), adb);
    await feature.execute("rear_display");
    expect(adb.getExecutedCommands()).toEqual([
      "shell cmd device_state print-states",
      "shell cmd device_state state 3",
      "shell cmd device_state state",
    ]);
  });

  test("resets rear display state before unfolding the emulator", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse("shell cmd device_state print-states", createExecResult(foldStates, ""));
    adb.setCommandResponseSequence("shell cmd device_state state", [
      createExecResult(rearState, ""),
      createExecResult(rearState, ""),
      createExecResult(openedState, ""),
      createExecResult(openedState, ""),
    ]);
    const { feature } = makeFeature(makeDevice(), adb);
    await feature.execute("rear_display");
    await feature.execute("opened");
    expect(adb.getExecutedCommands()).toEqual([
      "shell cmd device_state print-states",
      "shell cmd device_state state 3",
      "shell cmd device_state state",
      "shell cmd device_state print-states",
      "shell cmd device_state state reset",
      "emu unfold",
      "shell cmd device_state state",
    ]);
  });

  test("resets before closing and completes rear display to opened to closed", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse("shell cmd device_state print-states", createExecResult(foldStates, ""));
    adb.setCommandResponseSequence("shell cmd device_state state", [
      createExecResult(rearState, ""),
      createExecResult(rearState, ""),
      createExecResult(openedState, ""),
      createExecResult(openedState, ""),
      createExecResult(closedState, ""),
      createExecResult(closedState, ""),
    ]);
    const { feature } = makeFeature(makeDevice(), adb);
    await feature.execute("rear_display");
    await feature.execute("opened");
    await feature.execute("closed");
    expect(adb.getExecutedCommands()).toEqual([
      "shell cmd device_state print-states",
      "shell cmd device_state state 3",
      "shell cmd device_state state",
      "shell cmd device_state print-states",
      "shell cmd device_state state reset",
      "emu unfold",
      "shell cmd device_state state",
      "shell cmd device_state print-states",
      "shell cmd device_state state reset",
      "emu fold",
      "shell cmd device_state state",
    ]);
  });

  test("polls committed state until opened is applied", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse("shell cmd device_state print-states", createExecResult(foldStates, ""));
    adb.setCommandResponseSequence("shell cmd device_state state", [
      createExecResult(rearState, ""),
      createExecResult(fixture("foldpf-7-unfold-from-closed-base-while-override-state.txt"), ""),
      createExecResult(rearState, ""),
      createExecResult(openedState, ""),
    ]);
    const { feature, timer } = makeFeature(makeDevice(), adb);
    await feature.execute("opened");
    expect(timer.getSleepHistory()).toEqual([250, 250]);
    expect(
      adb.getExecutedCommands().filter((command) => command === "shell cmd device_state state"),
    ).toHaveLength(3);
  });

  test("reports the actual committed override when readback times out", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse("shell cmd device_state print-states", createExecResult(foldStates, ""));
    adb.setCommandResponse(
      "shell cmd device_state state",
      createExecResult(fixture("foldpf-6-fold-from-closed-base-while-override-state.txt"), ""),
    );
    const { feature, timer } = makeFeature(makeDevice(), adb);
    const attempt = feature.execute("closed");
    await expect(attempt).rejects.toBeInstanceOf(ActionableError);
    await expect(attempt).rejects.toThrow(
      "'closed' after 3000 ms; committed state is 'rear_display' (REAR_DISPLAY_MODE, 3)",
    );
    expect(timer.now()).toBe(3000);
  });

  test("rejects rear display when it is absent from print-states", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse(
      "shell cmd device_state print-states",
      createExecResult(phoneStates, ""),
    );
    const { feature } = makeFeature(makeDevice(), adb);
    await expect(feature.execute("rear_display")).rejects.toThrow(
      "Posture 'rear_display' is not supported by this device. Supported postures: none.",
    );
    expect(adb.getExecutedCommands()).toEqual(["shell cmd device_state print-states"]);
  });

  test("parses physical print-states and sets the matching state identifier", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse("shell cmd device_state print-states", createExecResult(foldStates, ""));
    adb.setCommandResponse("shell cmd device_state state", createExecResult(closedState, ""));
    const { feature } = makeFeature(makeDevice("R5CT123"), adb);
    const result = await feature.execute("closed");
    expect(adb.getExecutedCommands()).toEqual([
      "shell cmd device_state print-states",
      "shell cmd device_state state reset",
      "shell cmd device_state state 0",
      "shell cmd device_state state",
    ]);
    expect(result).toEqual({
      posture: "closed",
      display: { ...display, generation: 1 },
      locked: true,
    });
  });

  test("sets the matching physical device state for opened posture", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse("shell cmd device_state print-states", createExecResult(foldStates, ""));
    adb.setCommandResponse("shell cmd device_state state", createExecResult(openedState, ""));
    const { feature } = makeFeature(makeDevice("R5CT123"), adb);
    await feature.execute("opened");
    expect(adb.getExecutedCommands()).toEqual([
      "shell cmd device_state print-states",
      "shell cmd device_state state reset",
      "shell cmd device_state state 2",
      "shell cmd device_state state",
    ]);
  });

  test("resets physical device state for opened posture when no opened state exists", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse(
      "shell cmd device_state print-states",
      createExecResult(phoneStates, ""),
    );
    const { feature } = makeFeature(makeDevice("R5CT123"), adb);
    await feature.execute("opened");
    expect(adb.getExecutedCommands()).toEqual([
      "shell cmd device_state print-states",
      "shell cmd device_state state reset",
    ]);
  });

  test("rejects a posture absent from device inventory with supported postures", async () => {
    const adb = new FakeAdbExecutor();
    const { feature } = makeFeature(makeDevice("emulator-5554", ["closed", "opened"]), adb);
    await expect(feature.execute("tent")).rejects.toThrow(
      "Posture 'tent' is not supported by this device. Supported postures: closed, opened.",
    );
    expect(adb.getExecutedCommands()).toEqual([]);
  });

  const duo: BootedDevice = {
    name: "iPhone Duo",
    platform: "ios",
    deviceId: "34C35F33-224C-4E74-B8C0-668FF03E49F5",
    deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-Duo",
    displays: simulatorDeviceDisplays(
      parseSimulatorDisplays(loadDuoEnumerate()),
      "com.apple.CoreSimulator.SimDeviceType.iPhone-Duo",
    ),
  };

  function makeIosFeature(
    device: BootedDevice = duo,
    observations: ObserveResult[] = [observation],
  ) {
    const client = new FakeIOSCtrlProxy();
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const sequence: string[] = [];
    const tracker = new DisplayTransitionTracker(() => {});
    const transitionSink: DisplayTransitionSink = {
      identityRevision: (deviceId) => tracker.identityRevision(deviceId),
      notifyAndroidTransition: () => {},
      notifyTransition: (deviceId, reason) => {
        tracker.notifyTransition(deviceId, reason);
        sequence.push(`transition:${deviceId}:${reason}`);
      },
    };
    let observeCount = 0;
    const feature = new SetPosture(device, {
      iosClientProvider: () => client,
      observeFactory: () =>
        ({
          execute: async () => {
            observeCount += 1;
            sequence.push("observe");
            return observations[Math.min(observeCount - 1, observations.length - 1)]!;
          },
        }) as ObserveScreen,
      timer,
      transitionSink,
    });
    return { feature, client, timer, sequence, getObserveCount: () => observeCount };
  }

  test("sets each iPhone Duo simulator posture and observes its display", async () => {
    for (const [posture, angle] of [
      ["closed", 0],
      ["half_opened", 130],
      ["opened", 180],
    ] as const) {
      const expectedDisplay = {
        ...display,
        key: posture === "closed" ? "primary" : "primary-1",
        role: posture === "closed" ? "cover" : "inner",
      };
      const { feature, client, getObserveCount } = makeIosFeature(duo, [
        {
          ...observation,
          display: expectedDisplay,
          screenSize:
            posture === "closed" ? { width: 466, height: 678 } : { width: 951, height: 669 },
        },
      ]);
      expect(await feature.execute(posture)).toEqual({
        posture,
        display: { ...expectedDisplay, generation: 2 },
        locked: true,
      });
      expect(client.getHingeAngleHistory()).toEqual([angle]);
      expect(getObserveCount()).toBe(1);
    }
  });

  test("polls until the iPhone Duo active display matches the requested posture", async () => {
    const laterDisplay = { ...display, key: "primary", role: "cover" };
    const oldObservation = { ...observation, screenSize: { width: 669, height: 951 } };
    const { feature, getObserveCount } = makeIosFeature(duo, [
      oldObservation,
      oldObservation,
      { ...observation, display: laterDisplay, screenSize: { width: 466, height: 678 } },
    ]);
    expect(await feature.execute("closed")).toEqual({
      posture: "closed",
      display: { ...laterDisplay, generation: 2 },
      locked: true,
    });
    expect(getObserveCount()).toBe(3);
  });

  test("opened accepts either orientation of the inner panel geometry", async () => {
    const cover = {
      ...observation,
      display: { ...display, key: "primary", role: "cover" as const },
      screenSize: { width: 466, height: 678 },
    };
    const swapped = {
      ...observation,
      display: { ...display, key: "primary-1" },
      screenSize: { width: 669, height: 951 },
    };
    const inner = {
      ...observation,
      display: { ...display, key: "primary-1" },
      screenSize: { width: 951, height: 669 },
    };
    const { feature, getObserveCount, timer } = makeIosFeature(duo, [cover, swapped, inner]);
    expect(await feature.execute("opened")).toMatchObject({
      display: { ...inner.display, generation: 2 },
    });
    expect(getObserveCount()).toBe(2);
    expect(timer.getSleepHistory()).toEqual([250]);
  });

  test("polls when an unknown role still has the old panel size, then succeeds at the expected size", async () => {
    const unknownRoleAtOldSize = {
      ...observation,
      display: { ...display, role: "unknown" },
      screenSize: { width: 669, height: 951 },
    } as ObserveResult;
    const expectedPanelSize = {
      ...unknownRoleAtOldSize,
      screenSize: { width: 466, height: 678 },
    };
    const { feature, getObserveCount, timer } = makeIosFeature(duo, [
      unknownRoleAtOldSize,
      expectedPanelSize,
    ]);
    expect(await feature.execute("closed")).toMatchObject({
      display: { ...unknownRoleAtOldSize.display, generation: 2 },
    });
    expect(getObserveCount()).toBe(2);
    expect(timer.getSleepHistory()).toEqual([250]);
  });

  test("throws when an unknown role keeps the old panel size until timeout", async () => {
    const unknownRoleAtOldSize = {
      ...observation,
      display: { ...display, role: "unknown" },
      screenSize: { width: 669, height: 951 },
    } as ObserveResult;
    const { feature, getObserveCount, timer } = makeIosFeature(duo, [unknownRoleAtOldSize]);
    await expect(feature.execute("closed")).rejects.toThrow(
      "hinge event was accepted, but the active display is still the inner panel after 3000 ms",
    );
    expect(getObserveCount()).toBe(13);
    expect(timer.now()).toBe(3000);
    expect(timer.getSleepHistory()).toEqual(Array(12).fill(250));
  });

  test("returns after one observe without panel inventory", async () => {
    const unknownRoleObservation = {
      ...observation,
      display: { ...display, role: "unknown" },
      screenSize: { width: 669, height: 951 },
    } as ObserveResult;
    const { feature, getObserveCount, timer } = makeIosFeature({ ...duo, displays: undefined }, [
      unknownRoleObservation,
    ]);
    expect(await feature.execute("closed")).toMatchObject({
      display: { ...unknownRoleObservation.display, generation: 2 },
    });
    expect(getObserveCount()).toBe(1);
    expect(timer.getSleepHistory()).toEqual([]);
  });

  test("notifies before observing and after the new panel settles", async () => {
    const expectedDisplay = { ...display, role: "cover" };
    const { feature, sequence } = makeIosFeature(duo, [
      { ...observation, display: expectedDisplay, screenSize: { width: 466, height: 678 } },
    ]);
    expect(await feature.execute("closed")).toEqual({
      posture: "closed",
      display: { ...expectedDisplay, generation: 2 },
      locked: true,
    });
    expect(sequence).toEqual([
      `transition:${duo.deviceId}:setPosture changed the iPhone Duo hinge angle`,
      "observe",
      `transition:${duo.deviceId}:setPosture settled on the iPhone Duo display`,
    ]);
  });

  test("returns an indeterminate observation with a warning instead of polling or throwing", async () => {
    const unknownObservation = {
      ...observation,
      display: { ...display, role: "unknown" },
      screenSize: { width: 777, height: 888 },
    };
    const settled = { ...unknownObservation, screenSize: { width: 466, height: 678 } };
    const { feature, getObserveCount, timer } = makeIosFeature(duo, [unknownObservation, settled]);
    const warning = spyOn(logger, "warn").mockImplementation(() => undefined);
    try {
      expect(await feature.execute("closed")).toMatchObject({
        display: { ...unknownObservation.display, generation: 2 },
      });
      expect(getObserveCount()).toBe(1);
      expect(timer.getSleepHistory()).toEqual([]);
      expect(warning).toHaveBeenCalledWith(
        "[SetPosture] Could not determine the active iPhone Duo panel after the hinge event",
      );
    } finally {
      warning.mockRestore();
    }
  });

  test("throws when the old panel remains after polling to timeout", async () => {
    const { feature, getObserveCount, timer } = makeIosFeature(duo, [
      { ...observation, screenSize: { width: 669, height: 951 } },
    ]);
    await expect(feature.execute("closed")).rejects.toThrow(
      "hinge event was accepted, but the active display is still the inner panel after 3000 ms",
    );
    expect(getObserveCount()).toBe(13);
    expect(timer.now()).toBe(3000);
    expect(timer.getSleepHistory()).toEqual(Array(12).fill(250));
  });

  test("classifies Duo panels in either orientation and derives point scale when available", () => {
    const panels: DisplayPanel[] = [
      { key: "primary-1", role: "inner", sizePx: { width: 2007, height: 2853 }, scale: 3 },
      { key: "primary", role: "cover", sizePx: { width: 1398, height: 2034 }, scale: 3 },
    ];
    const classifySize = (width: number, height: number) =>
      classifyIosPostureObservation(
        { ...observation, display: { ...display, role: "unknown" }, screenSize: { width, height } },
        panels,
        "cover",
      );
    expect(classifySize(1398, 2034)).toBe("expected");
    expect(classifySize(466, 678)).toBe("expected");
    expect(classifySize(2034, 1398)).toBe("expected");
    expect(
      classifyIosPostureObservation(
        { ...observation, screenSize: { width: 669, height: 951 } },
        panels,
        "inner",
      ),
    ).toBe("expected");
    const panelWithoutScale: DisplayPanel = {
      key: "primary",
      role: "cover",
      sizePx: { width: 1398, height: 2034 },
    };
    expect(
      classifyIosPostureObservation(
        {
          ...observation,
          display: { ...display, role: "unknown" },
          screenSize: { width: 678, height: 466 },
          viewHierarchy: { hierarchy: {}, pixelWidth: 1398, pixelHeight: 2034 },
        },
        [panelWithoutScale, panels[0]!],
        "cover",
      ),
    ).toBe("expected");
  });

  test("rejects unsupported Duo postures and display presets", async () => {
    const { feature, client } = makeIosFeature();
    await expect(feature.execute("tent")).rejects.toThrow("closed, half_opened, opened");
    await expect(feature.execute("opened", "tablet")).rejects.toThrow("displayPreset");
    expect(client.getHingeAngleHistory()).toEqual([]);
  });

  test("runner failure reports its error without a redundant runner update sentence", async () => {
    const { feature, client, getObserveCount } = makeIosFeature();
    client.setHingeAngleResult({
      success: false,
      error: "Unknown command type: set_hinge_angle",
      totalTimeMs: 0,
    });
    await expect(feature.execute("opened")).rejects.toMatchObject({
      message: "Could not set iPhone Duo posture: Unknown command type: set_hinge_angle",
    });
    expect(getObserveCount()).toBe(0);
  });

  test("physical iOS and non-Duo simulators report unsupported", async () => {
    const physical = makeIosFeature({ ...duo, deviceId: "00008120-001C191E0E99003A" });
    expect(await physical.feature.execute("opened")).toMatchObject({ status: "unsupported" });
    const ordinary = makeIosFeature({
      ...duo,
      deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-17",
    });
    expect(await ordinary.feature.execute("opened")).toMatchObject({ status: "unsupported" });
    expect(physical.client.getHingeAngleHistory()).toEqual([]);
    expect(ordinary.client.getHingeAngleHistory()).toEqual([]);
  });

  test("omits locked when the fresh observation has no lock signal", async () => {
    const adb = new FakeAdbExecutor();
    const adbFactory: AdbClientFactory = { create: () => adb };
    const unlockedObservation = {
      display,
      screenSize: { width: 200, height: 300 },
    } as ObserveResult;
    const observeFactory = () => ({ execute: async () => unlockedObservation }) as ObserveScreen;
    const feature = new SetPosture(makeDevice(), {
      adbFactory,
      observeFactory,
      transitionSink: new DisplayTransitionTracker(() => {}),
    });
    expect(await feature.execute("closed")).toEqual({
      posture: "closed",
      display: { ...display, generation: 0 },
    });
  });
});
