import { beforeEach, describe, expect, test } from "bun:test";
import { registerKillProfileSessionCleanup } from "../../src/daemon/killProfileSessionCleanup";
import { applyKillProfile } from "../../src/features/utility/ApplyKillProfile";
import { KillProfileRestoreRegistry } from "../../src/features/utility/KillProfileRestore";
import type { BootedDevice } from "../../src/models";
import { createExecResult } from "../../src/utils/execResult";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import { FakeSessionCleanupManager } from "../fakes/FakeSessionCleanupManager";
import { FakeTimer } from "../fakes/FakeTimer";

const emulator: BootedDevice = { name: "emu", platform: "android", deviceId: "emulator-5554" };
const APP = "com.example.app";

describe("registerKillProfileSessionCleanup (#14051)", () => {
  let adb: FakeAdbExecutor;
  let registry: KillProfileRestoreRegistry;
  let manager: FakeSessionCleanupManager;

  beforeEach(() => {
    adb = new FakeAdbExecutor();
    adb.setAndroidApiLevel(34);
    adb.setCommandResponse("shell pm path", createExecResult("package:/data/app/base.apk\n", ""));
    adb.setCommandResponse("shell am get-standby-bucket", createExecResult("20\n", ""));
    adb.setCommandResponse("shell appops get", createExecResult("No operations.\n", ""));
    registry = new KillProfileRestoreRegistry();
    manager = new FakeSessionCleanupManager();
    registerKillProfileSessionCleanup(manager, {
      registry,
      shellFor: () => adb,
      timer: new FakeTimer(),
    });
  });

  const apply = (profile: "samsung-sleeping" | "user-restricted", owner?: string) =>
    applyKillProfile(emulator, APP, profile, { shell: adb, registry, owner });

  test("release restores every facet the session changed, once", async () => {
    await apply("samsung-sleeping", "session-1");
    await apply("user-restricted", "session-1");
    adb.clearHistory();

    manager.release("session-1", emulator.deviceId);

    expect(manager.pendingCleanups).toHaveLength(1);
    expect(manager.pendingCleanups[0].bound).toMatchObject({ name: "restore kill profile" });
    expect(await manager.pendingCleanups[0].cleanup).toEqual([]);
    expect(adb.getExecutedCommands()).toEqual([
      "shell dumpsys battery reset",
      `shell am set-standby-bucket '${APP}' 20`,
      `shell appops set '${APP}' RUN_ANY_IN_BACKGROUND default`,
    ]);
    manager.release("session-1", emulator.deviceId);
    expect(manager.pendingCleanups).toHaveLength(1);
  });

  test("rebinding off the device restores like a release", async () => {
    await apply("user-restricted", "session-1");
    adb.clearHistory();
    manager.unbound("session-1", emulator.deviceId);
    await manager.settle();
    expect(adb.getExecutedCommands()).toEqual([
      `shell appops set '${APP}' RUN_ANY_IN_BACKGROUND default`,
    ]);
  });

  test("another session's release, a terminal upgrade and sessionless changes restore nothing", async () => {
    await apply("user-restricted");
    manager.release("session-1", emulator.deviceId);
    registry.retireDevice(emulator.deviceId);
    await apply("user-restricted", "session-2");
    manager.release("session-1", emulator.deviceId);
    manager.release("session-2", emulator.deviceId, true);
    expect(manager.pendingCleanups).toEqual([]);
  });

  test("a replaced serial drops the record without writing to the new device", async () => {
    await apply("user-restricted", "session-1");
    adb.clearHistory();
    manager.release("session-1", emulator.deviceId, false, true);
    expect(manager.pendingCleanups).toEqual([]);
    expect(adb.getExecutedCommands()).toEqual([]);
    expect(registry.pendingFor(emulator.deviceId, APP)).toEqual([]);
  });

  test("a facet the device refuses to restore is reported and the rest still run", async () => {
    await apply("samsung-sleeping", "session-1");
    adb.setCommandResponse(
      "shell dumpsys battery reset",
      createExecResult("", "Error: battery service unavailable\n"),
    );
    manager.release("session-1", emulator.deviceId);
    expect(await manager.pendingCleanups[0].cleanup).toEqual(["battery"]);
    expect(adb.getExecutedCommands()).toContain(`shell am set-standby-bucket '${APP}' 20`);
  });
});
