import { beforeEach, describe, expect, test } from "bun:test";
import { registerDisplayProfileSessionCleanup } from "../../src/daemon/displayProfileSessionCleanup";
import { applyDisplayProfile } from "../../src/features/utility/DisplayProfile";
import { DisplayProfileRestoreRegistry } from "../../src/features/utility/DisplayProfileRestore";
import { createExecResult } from "../../src/utils/execResult";
import {
  createFakeDisplayProfilePorts,
  fakeEmulator as emulator,
} from "../fakes/FakeDisplayProfilePorts";
import { FakeSessionCleanupManager } from "../fakes/FakeSessionCleanupManager";
import { FakeTimer } from "../fakes/FakeTimer";

describe("registerDisplayProfileSessionCleanup (#14052)", () => {
  let ports: ReturnType<typeof createFakeDisplayProfilePorts>;
  let registry: DisplayProfileRestoreRegistry;
  let manager: FakeSessionCleanupManager;

  beforeEach(() => {
    ports = createFakeDisplayProfilePorts();
    registry = new DisplayProfileRestoreRegistry();
    manager = new FakeSessionCleanupManager();
    registerDisplayProfileSessionCleanup(manager, {
      registry,
      portsFor: () => ports,
      timer: new FakeTimer(),
    });
  });

  const apply = (owner?: string) =>
    applyDisplayProfile(
      emulator,
      { screenSize: "900x2000", fontScale: 1.3, posture: "closed" },
      { ...ports, registry, owner },
    );

  test("release restores every facet the session changed, once", async () => {
    await apply("session-1");
    ports.shell.clearHistory();

    manager.release("session-1", emulator.deviceId);

    expect(manager.pendingCleanups).toHaveLength(1);
    expect(manager.pendingCleanups[0].bound).toMatchObject({ name: "restore display profile" });
    expect(await manager.pendingCleanups[0].cleanup).toEqual([]);
    expect(ports.posture.current).toBe("opened");
    expect(ports.displayConfig.values.fontScale).toBe("default");
    expect(ports.shell.getExecutedCommands()).toEqual(["shell wm size reset"]);
    manager.release("session-1", emulator.deviceId);
    expect(manager.pendingCleanups).toHaveLength(1);
  });

  test("rebinding off the device restores like a release", async () => {
    await apply("session-1");
    manager.unbound("session-1", emulator.deviceId);
    await manager.settle();
    expect(ports.posture.current).toBe("opened");
  });

  test("another session's release, a terminal upgrade and sessionless changes restore nothing", async () => {
    await apply();
    manager.release("session-1", emulator.deviceId);
    registry.retireDevice(emulator.deviceId);
    await apply("session-2");
    manager.release("session-1", emulator.deviceId);
    manager.release("session-2", emulator.deviceId, true);
    expect(manager.pendingCleanups).toEqual([]);
  });

  test("a replaced serial drops the record without writing to the new device", async () => {
    await apply("session-1");
    ports.shell.clearHistory();
    manager.release("session-1", emulator.deviceId, false, true);
    expect(manager.pendingCleanups).toEqual([]);
    expect(ports.shell.getExecutedCommands()).toEqual([]);
    expect(registry.pending(emulator.deviceId)).toEqual([]);
  });

  test("a facet the device refuses is reported and the rest still run", async () => {
    await apply("session-1");
    // Sequences take precedence over the catch-all `shell wm size` response.
    ports.shell.setCommandResponseSequence("shell wm size reset", [
      createExecResult("", "Error: permission denied\n"),
    ]);
    manager.release("session-1", emulator.deviceId);
    expect(await manager.pendingCleanups[0].cleanup).toEqual(["screenSize"]);
    expect(ports.posture.current).toBe("opened");
  });
});
