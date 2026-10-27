import { beforeEach, describe, expect, test } from "bun:test";
import { registerEmulatorSensorSessionCleanup } from "../../src/daemon/emulatorSensorSessionCleanup";
import { EmulatorSensorRestoreRegistry } from "../../src/features/utility/EmulatorSensorRestore";
import { AdbEmulatorSensorConsole } from "../../src/features/utility/EmulatorSensors";
import { setEmulatorSensor } from "../../src/features/utility/SetSensor";
import type { BootedDevice } from "../../src/models";
import { createExecResult } from "../../src/utils/execResult";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import { FakeSessionCleanupManager } from "../fakes/FakeSessionCleanupManager";
import { FakeTimer } from "../fakes/FakeTimer";

const emulator: BootedDevice = { name: "emu", platform: "android", deviceId: "emulator-5554" };

describe("registerEmulatorSensorSessionCleanup (#14114)", () => {
  let adb: FakeAdbExecutor;
  let registry: EmulatorSensorRestoreRegistry;
  let manager: FakeSessionCleanupManager;

  beforeEach(() => {
    adb = new FakeAdbExecutor();
    adb.setCommandResponse("emu sensor get light", createExecResult("light = 0\nOK\n", ""));
    adb.setCommandResponse("emu sensor get proximity", createExecResult("proximity = 1\nOK\n", ""));
    adb.setCommandResponse(
      "emu sensor get acceleration",
      createExecResult("acceleration = 0:9.77622:0\nOK\n", ""),
    );
    adb.setDefaultResponse(createExecResult("OK\n", ""));
    registry = new EmulatorSensorRestoreRegistry();
    manager = new FakeSessionCleanupManager();
    registerEmulatorSensorSessionCleanup(manager, {
      registry,
      consoleFor: () => new AdbEmulatorSensorConsole(adb),
      timer: new FakeTimer(),
    });
  });

  const set = (sensor: "light" | "proximity" | "acceleration", value: number[], owner?: string) =>
    setEmulatorSensor(
      emulator,
      { sensor, value },
      { console: new AdbEmulatorSensorConsole(adb), registry, owner },
    );

  const sensorSets = () =>
    adb.getExecutedCommands().filter((command) => command.startsWith("emu sensor set"));

  test("release restores every sensor the session changed to its value before the first change", async () => {
    await set("light", [500], "session-1");
    await set("light", [20], "session-1");
    await set("proximity", [0], "session-1");
    await set("acceleration", [0, 0, 9.8], "session-1");
    adb.clearHistory();

    manager.release("session-1", emulator.deviceId);

    expect(manager.pendingCleanups.map((entry) => entry.deviceId)).toEqual([emulator.deviceId]);
    expect(manager.pendingCleanups[0].bound).toMatchObject({ name: "restore emulator sensors" });
    expect(await manager.pendingCleanups[0].cleanup).toEqual([]);
    expect(sensorSets()).toEqual([
      "emu sensor set light 0",
      "emu sensor set proximity 1",
      "emu sensor set acceleration 0:9.77622:0",
    ]);
    // The slot is consumed: a second release has nothing left to restore.
    manager.release("session-1", emulator.deviceId);
    expect(manager.pendingCleanups).toHaveLength(1);
  });

  test("rebinding off the device restores like a release", async () => {
    await set("proximity", [0], "session-1");
    adb.clearHistory();
    manager.unbound("session-1", emulator.deviceId);
    await manager.settle();
    expect(sensorSets()).toEqual(["emu sensor set proximity 1"]);
  });

  test("another session's release, a terminal upgrade, and sessionless changes restore nothing", async () => {
    await set("light", [500]);
    manager.release("session-1", emulator.deviceId);
    await set("proximity", [0], "session-2");
    manager.release("session-1", emulator.deviceId);
    manager.release("session-2", emulator.deviceId, true);
    expect(manager.pendingCleanups).toEqual([]);
  });

  test("a replaced serial drops the slot without writing to the new emulator", async () => {
    await set("light", [500], "session-1");
    adb.clearHistory();
    manager.release("session-1", emulator.deviceId, false, true);
    expect(manager.pendingCleanups).toEqual([]);
    expect(sensorSets()).toEqual([]);
    expect(registry.original(emulator.deviceId, "light")).toBeUndefined();
  });

  test("a sensor the console refuses to restore is reported and the rest still run", async () => {
    await set("light", [500], "session-1");
    await set("proximity", [0], "session-1");
    adb.setCommandResponse(
      "emu sensor set light 0",
      createExecResult("KO: 'light' is disabled.\n", ""),
    );
    manager.release("session-1", emulator.deviceId);
    expect(await manager.pendingCleanups[0].cleanup).toEqual(["light"]);
    expect(sensorSets()).toContain("emu sensor set proximity 1");
  });
});
