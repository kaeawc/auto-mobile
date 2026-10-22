import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { SessionManager } from "../../src/daemon/sessionManager";
import { registerDisplayProfileSessionCleanup } from "../../src/daemon/displayProfileSessionCleanup";
import { DisplayProfileRestoreRegistry } from "../../src/features/utility/DisplayProfileRestore";
import type { DisplayProfilePorts } from "../../src/features/utility/DisplayProfile";
import { DisplayConfig } from "../../src/features/utility/DisplayConfig";
import {
  createDisplayConfigHandler,
  displayConfigSchema,
} from "../../src/server/displayConfigTool";
import { displayConfigResultSchema } from "../../src/server/utilityToolOutputSchemas";
import type { BootedDevice } from "../../src/models";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeDbWriteBarrier } from "../fakes/FakeDbWriteBarrier";
import { FakeAdbClientFactory } from "../fakes/FakeAdbClientFactory";
import { FakeDisplayGeometryAdb } from "../fakes/FakeDisplayGeometryAdb";

const emulator: BootedDevice = { name: "emu", platform: "android", deviceId: "emulator-5554" };
const NAVBAR = "com.android.internal.systemui.navbar.";
const CUTOUT = "com.android.internal.display.cutout.emulation.";

function structured(response: unknown): unknown {
  return (response as { structuredContent?: unknown }).structuredContent;
}

describe("displayConfig geometry schema (#14101)", () => {
  test("accepts size, navigation mode, cutout and display", () => {
    expect(
      displayConfigSchema.safeParse({
        size: { width: 720, height: 1600 },
        navigationMode: "threeButton",
        displayCutout: "hole",
        display: "inner",
      }).success,
    ).toBe(true);
    expect(
      displayConfigSchema.safeParse({ size: "default", navigationMode: "default" }).success,
    ).toBe(true);
  });

  test.each([
    { size: { width: 199, height: 1600 } },
    { size: { width: 720.5, height: 1600 } },
    { size: { width: 720, height: 1600, depth: 1 } },
    { navigationMode: "threebutton" },
    { displayCutout: "notch" },
    { reset: true, size: "default" },
    { reset: true, displayCutout: "none" },
  ])("rejects %j", (args) => {
    expect(displayConfigSchema.safeParse(args).success).toBe(false);
  });
});

describe("displayConfig geometry handler (#14101)", () => {
  let timer: FakeTimer;
  let manager: SessionManager;
  let registry: DisplayProfileRestoreRegistry;
  let adb: FakeDisplayGeometryAdb;
  let resolved: string[];
  let handler: ReturnType<typeof createDisplayConfigHandler>;

  beforeEach(() => {
    timer = new FakeTimer();
    manager = new SessionManager(timer, new FakeDeviceSessionPersistence(), {
      barrier: () => new FakeDbWriteBarrier(),
    });
    registry = new DisplayProfileRestoreRegistry();
    adb = new FakeDisplayGeometryAdb();
    adb.setCommandResult("shell settings get system font_scale", "1.0\n");
    adb.setCommandResult("shell wm density", "Physical density: 440\n");
    adb.setCommandResult("shell cmd uimode night", "Night mode: no\n");
    adb.displays.set(2, { physical: "1920x1080" });
    resolved = [];
    const invalidate = () => {};
    const ports: DisplayProfilePorts = {
      shell: adb,
      displayConfig: new DisplayConfig(emulator),
      posture: {
        read: async () => undefined,
        set: async () => ({ status: "unsupported" as const }),
      },
    };
    registerDisplayProfileSessionCleanup(manager, {
      registry,
      portsFor: () => ports,
      timer,
      invalidate,
    });
    handler = createDisplayConfigHandler({
      sessionManager: () => manager,
      resolveDisplayId: async (_device, display) => {
        resolved.push(display);
        return 2;
      },
      displayConfig: {
        adbFactory: new FakeAdbClientFactory(adb),
        themeBaselines: new Map(),
        geometry: { registry, invalidate },
      },
    });
  });

  afterEach(() => {
    manager.stopCleanupTimer();
  });

  test("session release restores size, navigation mode and cutout", async () => {
    await manager.createSession("session-1", emulator.deviceId, "android");
    const response = await handler(emulator, {
      sessionUuid: "session-1",
      size: { width: 720, height: 1600 },
      navigationMode: "threeButton",
      displayCutout: "hole",
    });
    const result = displayConfigResultSchema.parse(structured(response));
    expect(result).toMatchObject({
      success: true,
      previous: { size: "default", navigationMode: "gesture", displayCutout: "none" },
      applied: {
        size: { width: 720, height: 1600 },
        navigationMode: "threeButton",
        displayCutout: "hole",
      },
    });
    expect(registry.restoresOnRelease(emulator.deviceId)).toBe(true);

    await manager.releaseSession("session-1", "explicit-release");
    await manager.getPendingDeviceCleanup(emulator.deviceId);
    expect(adb.displays.get(0)?.override).toBeUndefined();
    expect(adb.enabled(NAVBAR)).toEqual([`${NAVBAR}gestural`]);
    expect(adb.enabled(CUTOUT)).toEqual([]);
  });

  test("a released session cannot change the display geometry", async () => {
    await manager.createSession("session-1", emulator.deviceId, "android");
    await manager.releaseSession("session-1", "explicit-release");
    await expect(
      handler(emulator, { sessionUuid: "session-1", navigationMode: "threeButton" }),
    ).rejects.toThrow("Cannot change a display profile");
    expect(adb.enabled(NAVBAR)).toEqual([`${NAVBAR}gestural`]);
  });

  test("a sessionless change persists past release", async () => {
    await handler(emulator, { displayCutout: "tall" });
    expect(registry.restoresOnRelease(emulator.deviceId)).toBe(false);
    expect(registry.pending(emulator.deviceId).map((action) => action.facet)).toEqual(["cutout"]);
  });

  test("display targets size on the resolved logical display", async () => {
    const response = await handler(emulator, {
      size: { width: 1280, height: 720 },
      display: "external",
    });
    expect(displayConfigResultSchema.parse(structured(response)).success).toBe(true);
    expect(resolved).toEqual(["external"]);
    expect(adb.getAllCommands()).toContain("shell wm size 1280x720 -d 2");
    expect(adb.displays.get(0)?.override).toBeUndefined();
  });

  test("display is not resolved when no size is read or written", async () => {
    await handler(emulator, { navigationMode: "threeButton", display: "external" });
    await handler(emulator, { fontScale: 1.3, display: "external" });
    expect(resolved).toEqual([]);
    const read = displayConfigResultSchema.parse(
      structured(await handler(emulator, { display: "external" })),
    );
    expect(resolved).toEqual(["external"]);
    expect(read.current?.size).toEqual({ width: 1920, height: 1080 });
  });

  test("an unshipped value is an error response with no writes", async () => {
    const response = (await handler(emulator, { navigationMode: "twoButton" })) as {
      isError?: boolean;
    };
    expect(response.isError).toBe(true);
    expect(adb.getAllCommands().some((command) => command.includes("enable"))).toBe(false);
  });
});
