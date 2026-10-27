import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { SessionManager } from "../../src/daemon/sessionManager";
import { registerKillProfileSessionCleanup } from "../../src/daemon/killProfileSessionCleanup";
import { KillProfileRestoreRegistry } from "../../src/features/utility/KillProfileRestore";
import { createKillProfileHandler, killProfileSchema } from "../../src/server/killProfileTools";
import { killProfileResultSchema } from "../../src/server/killProfileToolOutputSchemas";
import type { BootedDevice } from "../../src/models";
import { createExecResult } from "../../src/utils/execResult";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeDbWriteBarrier } from "../fakes/FakeDbWriteBarrier";

const emulator: BootedDevice = { name: "emu", platform: "android", deviceId: "emulator-5554" };
const APP = "com.example.app";

function structured(response: unknown): unknown {
  return (response as { structuredContent?: unknown }).structuredContent;
}

describe("killProfile tool (#14051)", () => {
  let timer: FakeTimer;
  let manager: SessionManager;
  let registry: KillProfileRestoreRegistry;
  let adb: FakeAdbExecutor;
  let handler: ReturnType<typeof createKillProfileHandler>;

  beforeEach(() => {
    timer = new FakeTimer();
    manager = new SessionManager(timer, new FakeDeviceSessionPersistence(), {
      barrier: () => new FakeDbWriteBarrier(),
    });
    registry = new KillProfileRestoreRegistry();
    adb = new FakeAdbExecutor();
    adb.setAndroidApiLevel(34);
    adb.setCommandResponse("shell pm path", createExecResult("package:/data/app/base.apk\n", ""));
    adb.setCommandResponse("shell appops get", createExecResult("No operations.\n", ""));
    registerKillProfileSessionCleanup(manager, { registry, shellFor: () => adb, timer });
    handler = createKillProfileHandler({
      sessionManager: () => manager,
      shellFor: () => adb,
      registry,
    });
  });

  afterEach(() => {
    manager.stopCleanupTimer();
  });

  test("the schema is strict and names every profile", () => {
    expect(
      killProfileSchema.safeParse({ action: "apply", appId: APP, profile: "user-restricted" })
        .success,
    ).toBe(true);
    expect(
      killProfileSchema.safeParse({ action: "apply", appId: APP, profile: "nokia-evenwell" })
        .success,
    ).toBe(false);
    expect(killProfileSchema.safeParse({ action: "list", extra: 1 }).success).toBe(false);
  });

  test("list returns the catalog and the non-emulatable behaviour without touching the device", async () => {
    const result = killProfileResultSchema.parse(
      structured(await handler(emulator, { action: "list" })),
    );
    expect(result.profiles?.map((profile) => profile.id)).toContain("samsung-sleeping");
    expect(result.nonEmulatable?.map((entry) => entry.id)).toContain("xiaomi-proprietary-appops");
    expect(adb.getExecutedCommands()).toEqual([]);
  });

  test("apply needs appId and profile", async () => {
    await expect(
      handler(emulator, { action: "apply", profile: "user-restricted" }),
    ).rejects.toThrow("needs appId");
    await expect(handler(emulator, { action: "apply", appId: APP })).rejects.toThrow(
      "needs profile",
    );
  });

  test("a session's profile is restored when the session is released", async () => {
    await manager.createSession("session-1", emulator.deviceId, "android");
    const result = killProfileResultSchema.parse(
      structured(
        await handler(emulator, {
          action: "apply",
          appId: APP,
          profile: "user-restricted",
          sessionUuid: "session-1",
        }),
      ),
    );
    expect(result).toMatchObject({
      status: "applied",
      restore: { onSessionRelease: true },
    });
    adb.clearHistory();

    await manager.releaseSession("session-1", "explicit-release");
    await manager.getPendingDeviceCleanup(emulator.deviceId);
    expect(adb.getExecutedCommands()).toEqual([
      `shell appops set '${APP}' RUN_ANY_IN_BACKGROUND default`,
    ]);
  });

  test("a released session cannot apply a profile", async () => {
    await manager.createSession("session-1", emulator.deviceId, "android");
    await manager.releaseSession("session-1", "explicit-release");
    await expect(
      handler(emulator, {
        action: "apply",
        appId: APP,
        profile: "user-restricted",
        sessionUuid: "session-1",
      }),
    ).rejects.toThrow("Cannot change a kill profile");
    expect(adb.getExecutedCommands()).toEqual([]);
  });

  test("reset through the tool restores a sessionless apply", async () => {
    await handler(emulator, { action: "apply", appId: APP, profile: "user-restricted" });
    const result = killProfileResultSchema.parse(
      structured(await handler(emulator, { action: "reset", appId: APP })),
    );
    expect(result).toMatchObject({ action: "reset", source: "recorded", status: "applied" });
  });
});
