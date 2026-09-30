import { describe, expect, test } from "bun:test";
import type { BootedDevice, ObserveResult, Posture } from "../../../src/models";
import { SetPosture } from "../../../src/features/device/SetPosture";
import type { ObserveScreen } from "../../../src/features/observe/interfaces/ObserveScreen";
import type { AdbClientFactory } from "../../../src/utils/android-cmdline-tools/AdbClientFactory";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeIOSCtrlProxy } from "../../fakes/FakeIOSCtrlProxy";
import { createExecResult } from "../../../src/utils/execResult";

const display = {
  key: "panel-inner",
  role: "inner",
  posture: "half_opened",
  generation: 4,
} as const;
const observation = {
  display,
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

function makeFeature(device: BootedDevice, adb: FakeAdbExecutor) {
  const adbFactory: AdbClientFactory = { create: () => adb };
  let observeCount = 0;
  const observeFactory = () =>
    ({
      execute: async () => {
        observeCount += 1;
        return observation;
      },
    }) as ObserveScreen;
  return {
    feature: new SetPosture(device, { adbFactory, observeFactory }),
    getObserveCount: () => observeCount,
  };
}

describe("SetPosture", () => {
  test("maps each emulator posture to its console command and returns fresh display state", async () => {
    const mappings = [
      ["closed", "emu fold"],
      ["half_opened", "emu posture 2"],
      ["opened", "emu unfold"],
      ["rear_display", "emu posture 1"],
      ["flipped", "emu posture 4"],
      ["tent", "emu posture 5"],
    ] as const;

    for (const [posture, command] of mappings) {
      const adb = new FakeAdbExecutor();
      const { feature, getObserveCount } = makeFeature(makeDevice(), adb);
      const result = await feature.execute(posture);
      expect(adb.getExecutedCommands()).toEqual([command]);
      expect(getObserveCount()).toBe(1);
      expect(result).toEqual({ posture, display, locked: true });
    }
  });

  test("sets the Resizable emulator display preset", async () => {
    const adb = new FakeAdbExecutor();
    const { feature } = makeFeature(makeDevice(), adb);
    await feature.execute("opened", "tablet");
    expect(adb.getExecutedCommands()).toEqual(["emu unfold", "emu resize-display 2"]);
  });

  test("parses physical print-states and sets the matching state identifier", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse(
      "shell cmd device_state print-states",
      createExecResult(
        "Supported states: [\nDeviceState{identifier=0, name='CLOSED'}\nDeviceState{identifier=8, name='HALF_OPENED'}\nDeviceState{identifier=2, name='OPENED'}\n]",
        "",
      ),
    );
    const { feature } = makeFeature(makeDevice("R5CT123"), adb);
    const result = await feature.execute("half_opened");
    expect(adb.getExecutedCommands()).toEqual([
      "shell cmd device_state print-states",
      "shell cmd device_state state 8",
    ]);
    expect(result).toEqual({ posture: "half_opened", display, locked: true });
  });

  test("sets the matching physical device state for opened posture", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse(
      "shell cmd device_state print-states",
      createExecResult("DeviceState{identifier=2, name='OPENED'}", ""),
    );
    const { feature } = makeFeature(makeDevice("R5CT123"), adb);
    await feature.execute("opened");
    expect(adb.getExecutedCommands()).toEqual([
      "shell cmd device_state print-states",
      "shell cmd device_state state 2",
    ]);
  });

  test("resets physical device state for opened posture when no opened state exists", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse(
      "shell cmd device_state print-states",
      createExecResult(
        "DeviceState{identifier=0, name='CLOSED'}\nDeviceState{identifier=8, name='HALF_OPENED'}",
        "",
      ),
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
  };

  function makeIosFeature(device: BootedDevice = duo) {
    const client = new FakeIOSCtrlProxy();
    let observeCount = 0;
    const feature = new SetPosture(device, {
      iosClientProvider: () => client,
      observeFactory: () =>
        ({
          execute: async () => {
            observeCount += 1;
            return observation;
          },
        }) as ObserveScreen,
    });
    return { feature, client, getObserveCount: () => observeCount };
  }

  test("sets each iPhone Duo simulator posture and observes its display", async () => {
    for (const [posture, angle] of [
      ["closed", 0],
      ["half_opened", 130],
      ["opened", 180],
    ] as const) {
      const { feature, client, getObserveCount } = makeIosFeature();
      expect(await feature.execute(posture)).toEqual({ posture, display, locked: true });
      expect(client.getHingeAngleHistory()).toEqual([angle]);
      expect(getObserveCount()).toBe(1);
    }
  });

  test("rejects unsupported Duo postures and display presets", async () => {
    const { feature, client } = makeIosFeature();
    await expect(feature.execute("tent")).rejects.toThrow("closed, half_opened, opened");
    await expect(feature.execute("opened", "tablet")).rejects.toThrow("displayPreset");
    expect(client.getHingeAngleHistory()).toEqual([]);
  });

  test("runner failure points to the runner update", async () => {
    const { feature, client, getObserveCount } = makeIosFeature();
    client.setHingeAngleResult({
      success: false,
      error: "Unknown command type: set_hinge_angle",
      totalTimeMs: 0,
    });
    await expect(feature.execute("opened")).rejects.toThrow("Update the iOS runner");
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
    const unlockedObservation = { display } as ObserveResult;
    const observeFactory = () => ({ execute: async () => unlockedObservation }) as ObserveScreen;
    const feature = new SetPosture(makeDevice(), { adbFactory, observeFactory });
    expect(await feature.execute("closed")).toEqual({ posture: "closed", display });
  });
});
