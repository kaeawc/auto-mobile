import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { SessionManager } from "../../src/daemon/sessionManager";
import { registerDisplayProfileSessionCleanup } from "../../src/daemon/displayProfileSessionCleanup";
import { DisplayProfileRestoreRegistry } from "../../src/features/utility/DisplayProfileRestore";
import {
  createDisplayProfileHandler,
  displayProfileSchema,
} from "../../src/server/displayProfileTools";
import { displayProfileResultSchema } from "../../src/server/displayProfileToolOutputSchemas";
import type { DeviceSettingKey } from "../../src/models/DeviceSettingDefaults";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeDbWriteBarrier } from "../fakes/FakeDbWriteBarrier";
import {
  createFakeDisplayProfilePorts,
  fakeEmulator as emulator,
} from "../fakes/FakeDisplayProfilePorts";

function structured(response: unknown): unknown {
  return (response as { structuredContent?: unknown }).structuredContent;
}

describe("displayProfile tool (#14052)", () => {
  let timer: FakeTimer;
  let manager: SessionManager;
  let registry: DisplayProfileRestoreRegistry;
  let ports: ReturnType<typeof createFakeDisplayProfilePorts>;
  let recorded: DeviceSettingKey[][];
  let handler: ReturnType<typeof createDisplayProfileHandler>;

  beforeEach(() => {
    timer = new FakeTimer();
    manager = new SessionManager(timer, new FakeDeviceSessionPersistence(), {
      barrier: () => new FakeDbWriteBarrier(),
    });
    registry = new DisplayProfileRestoreRegistry();
    ports = createFakeDisplayProfilePorts();
    recorded = [];
    registerDisplayProfileSessionCleanup(manager, { registry, portsFor: () => ports, timer });
    handler = createDisplayProfileHandler({
      sessionManager: () => manager,
      portsFor: () => ports,
      registry,
      recordSettingDefaults: async (_device, keys) => {
        recorded.push([...keys]);
      },
    });
  });

  afterEach(() => {
    manager.stopCleanupTimer();
  });

  test("the schema is strict and validates each facet", () => {
    expect(displayProfileSchema.safeParse({ action: "apply", cutout: "hole" }).success).toBe(true);
    expect(displayProfileSchema.safeParse({ action: "apply", cutout: "notch" }).success).toBe(
      false,
    );
    expect(displayProfileSchema.safeParse({ action: "apply", screenSize: "big" }).success).toBe(
      false,
    );
    expect(displayProfileSchema.safeParse({ action: "reset", extra: 1 }).success).toBe(false);
  });

  test("a session's profile is restored when the session is released", async () => {
    await manager.createSession("session-1", emulator.deviceId, "android");
    const result = displayProfileResultSchema.parse(
      structured(
        await handler(emulator, {
          action: "apply",
          fontScale: 1.3,
          forceDark: true,
          sessionUuid: "session-1",
        }),
      ),
    );
    expect(result).toMatchObject({ status: "applied", restore: { onSessionRelease: true } });
    expect(recorded).toEqual([["fontScale", "nightMode"]]);
    ports.shell.clearHistory();

    await manager.releaseSession("session-1", "explicit-release");
    await manager.getPendingDeviceCleanup(emulator.deviceId);
    expect(ports.displayConfig.values).toMatchObject({ fontScale: "default", theme: "light" });
    expect(ports.shell.getExecutedCommands()).toEqual(["shell setprop debug.hwui.force_dark ''"]);
  });

  test("a released session cannot apply a profile", async () => {
    await manager.createSession("session-1", emulator.deviceId, "android");
    await manager.releaseSession("session-1", "explicit-release");
    await expect(
      handler(emulator, { action: "apply", fontScale: 1.3, sessionUuid: "session-1" }),
    ).rejects.toThrow("Cannot change a display profile");
    expect(ports.displayConfig.calls).toEqual([]);
  });

  test("reset through the tool restores a sessionless apply", async () => {
    await handler(emulator, { action: "apply", navigationMode: "threebutton" });
    const result = displayProfileResultSchema.parse(
      structured(await handler(emulator, { action: "reset" })),
    );
    expect(result.steps).toEqual([{ step: "navigationMode", status: "applied" }]);
  });
});
