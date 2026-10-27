import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { SessionManager } from "../../src/daemon/sessionManager";
import { registerEmulatorSensorSessionCleanup } from "../../src/daemon/emulatorSensorSessionCleanup";
import { EmulatorSensorRestoreRegistry } from "../../src/features/utility/EmulatorSensorRestore";
import { createSetSensorHandler, setSensorSchema } from "../../src/server/sensorTools";
import { setSensorResultSchema } from "../../src/server/sensorToolOutputSchemas";
import type { BootedDevice } from "../../src/models";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeDbWriteBarrier } from "../fakes/FakeDbWriteBarrier";
import { FakeEmulatorSensorConsole } from "../fakes/FakeEmulatorSensorConsole";

const emulator: BootedDevice = { name: "emu", platform: "android", deviceId: "emulator-5554" };

function structured(response: unknown): unknown {
  return (response as { structuredContent?: unknown }).structuredContent;
}

describe("setSensor tool (#14114)", () => {
  let timer: FakeTimer;
  let manager: SessionManager;
  let registry: EmulatorSensorRestoreRegistry;
  let sensors: FakeEmulatorSensorConsole;
  let handler: ReturnType<typeof createSetSensorHandler>;

  beforeEach(() => {
    timer = new FakeTimer();
    manager = new SessionManager(timer, new FakeDeviceSessionPersistence(), {
      barrier: () => new FakeDbWriteBarrier(),
    });
    registry = new EmulatorSensorRestoreRegistry();
    sensors = new FakeEmulatorSensorConsole({ light: [0], proximity: [1] });
    registerEmulatorSensorSessionCleanup(manager, { registry, consoleFor: () => sensors, timer });
    handler = createSetSensorHandler({
      sessionManager: () => manager,
      consoleFor: () => sensors,
      registry,
    });
  });

  afterEach(() => {
    manager.stopCleanupTimer();
  });

  test("the schema is strict and names every emulator sensor", () => {
    expect(setSensorSchema.safeParse({ sensor: "light", value: [5] }).success).toBe(true);
    expect(setSensorSchema.safeParse({ sensor: "hinge-angle0", value: [5] }).success).toBe(false);
    expect(setSensorSchema.safeParse({ sensor: "light", value: [5], extra: 1 }).success).toBe(
      false,
    );
    expect(setSensorSchema.safeParse({ sensor: "light", value: [] }).success).toBe(false);
  });

  test("a session's change is restored when the session is released", async () => {
    await manager.createSession("session-1", emulator.deviceId, "android");
    const response = await handler(emulator, {
      sensor: "proximity",
      value: [0],
      sessionUuid: "session-1",
    });
    const result = setSensorResultSchema.parse(structured(response));
    expect(result).toMatchObject({
      sensor: "proximity",
      applied: [0],
      previous: [1],
      restore: { value: [1], onSessionRelease: true },
    });
    expect(sensors.values.get("proximity")).toEqual([0]);

    await manager.releaseSession("session-1", "explicit-release");
    await manager.getPendingDeviceCleanup(emulator.deviceId);
    expect(sensors.values.get("proximity")).toEqual([1]);
    expect(sensors.calls.at(-1)).toBe("set proximity 1");
  });

  test("a released session cannot change a sensor", async () => {
    await manager.createSession("session-1", emulator.deviceId, "android");
    await manager.releaseSession("session-1", "explicit-release");
    await expect(
      handler(emulator, { sensor: "light", value: [5], sessionUuid: "session-1" }),
    ).rejects.toThrow("Cannot change an emulator sensor");
    expect(sensors.calls).toEqual([]);
  });

  test("a session bound to another device cannot change this one's sensors", async () => {
    await manager.createSession("session-1", "emulator-5556", "android");
    await expect(
      handler(emulator, { sensor: "light", value: [5], sessionUuid: "session-1" }),
    ).rejects.toThrow("Cannot change an emulator sensor");
  });

  test("a sessionless change has no release restore", async () => {
    const result = setSensorResultSchema.parse(
      structured(await handler(emulator, { sensor: "light", value: [5] })),
    );
    expect(result.restore).toEqual({ value: [0], onSessionRelease: false });
  });
});
