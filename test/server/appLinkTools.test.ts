import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { SessionManager } from "../../src/daemon/sessionManager";
import { registerAppLinksSessionCleanup } from "../../src/daemon/appLinksSessionCleanup";
import { AppLinksRestoreRegistry } from "../../src/features/utility/appLinks/AppLinkRestore";
import { createSetAppLinksHandler, setAppLinksSchema } from "../../src/server/appLinkTools";
import { setAppLinksResultSchema } from "../../src/server/deepLinkToolOutputSchemas";
import type { BootedDevice } from "../../src/models";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeDbWriteBarrier } from "../fakes/FakeDbWriteBarrier";
import { FakeAppLinksDevice, fakeAppLinksTarget } from "../fakes/FakeAppLinksDevice";

const emulator: BootedDevice = { name: "emu", platform: "android", deviceId: "emulator-5554" };
const PKG = "com.example.shop";

function structured(response: unknown): unknown {
  return (response as { structuredContent?: unknown }).structuredContent;
}

describe("setAppLinks tool (#14110)", () => {
  let manager: SessionManager;
  let registry: AppLinksRestoreRegistry;
  let appLinks: FakeAppLinksDevice;
  let handler: ReturnType<typeof createSetAppLinksHandler>;

  beforeEach(() => {
    manager = new SessionManager(new FakeTimer(), new FakeDeviceSessionPersistence(), {
      barrier: () => new FakeDbWriteBarrier(),
    });
    registry = new AppLinksRestoreRegistry();
    appLinks = new FakeAppLinksDevice().install(PKG, {
      verification: { "shop.example.com": "none" },
    });
    registerAppLinksSessionCleanup(manager, { registry, appLinksFor: () => appLinks });
    handler = createSetAppLinksHandler({
      sessionManager: () => manager,
      targetFor: () => fakeAppLinksTarget(appLinks),
      registry,
    });
  });

  afterEach(() => {
    manager.stopCleanupTimer();
  });

  test("the schema is strict and only accepts host names as domains", () => {
    const parse = (args: Record<string, unknown>) => setAppLinksSchema.safeParse(args).success;
    expect(parse({ appId: PKG, action: "approve" })).toBe(true);
    expect(parse({ appId: PKG, action: "approve", domains: ["*.example.com"] })).toBe(true);
    expect(parse({ appId: PKG, action: "approve", domains: ["a.com; reboot"] })).toBe(false);
    expect(parse({ appId: PKG, action: "deny" })).toBe(false);
    expect(parse({ appId: PKG, action: "approve", extra: 1 })).toBe(false);
  });

  test("a session's approval is restored when the session is released", async () => {
    await manager.createSession("session-1", emulator.deviceId, "android");
    const result = setAppLinksResultSchema.parse(
      structured(
        await handler(emulator, { appId: PKG, action: "approve", sessionUuid: "session-1" }),
      ),
    );
    expect(result).toMatchObject({
      success: true,
      message: `setAppLinks approve: 1 domain changed for ${PKG}`,
      restore: { onSessionRelease: true },
    });
    expect(appLinks.state(PKG, "shop.example.com")).toBe("approved");

    await manager.releaseSession("session-1", "explicit-release");
    await manager.getPendingDeviceCleanup(emulator.deviceId);
    expect(appLinks.state(PKG, "shop.example.com")).toBe("none");
  });

  test("a released session cannot change App Links state", async () => {
    await manager.createSession("session-1", emulator.deviceId, "android");
    await manager.releaseSession("session-1", "explicit-release");
    await expect(
      handler(emulator, { appId: PKG, action: "approve", sessionUuid: "session-1" }),
    ).rejects.toThrow("Cannot change App Links state");
    expect(appLinks.calls).toEqual([]);
  });

  test("a sessionless change has no release restore", async () => {
    const result = setAppLinksResultSchema.parse(
      structured(await handler(emulator, { appId: PKG, action: "approve" })),
    );
    expect(result.restore?.onSessionRelease).toBe(false);
  });

  test("iOS is refused", async () => {
    await expect(
      handler({ ...emulator, platform: "ios" }, { appId: PKG, action: "approve" }),
    ).rejects.toThrow("Android 12+ only");
  });
});
