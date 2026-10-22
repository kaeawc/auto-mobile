import { describe, expect, test } from "bun:test";
import type { BootedDevice } from "../../../src/models";
import { DisplayConfig } from "../../../src/features/utility/DisplayConfig";
import {
  DisplayProfileRestoreRegistry,
  type DisplayProfileRestoreAction,
} from "../../../src/features/utility/DisplayProfileRestore";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { FakeDisplayGeometryAdb } from "../../fakes/FakeDisplayGeometryAdb";
import { FakeSimctl } from "../../fakes/FakeSimctl";

const emulator: BootedDevice = { name: "Pixel", platform: "android", deviceId: "emulator-5554" };
const NAVBAR = "com.android.internal.systemui.navbar.";
const CUTOUT = "com.android.internal.display.cutout.emulation.";

/** The recorded restore of one facet, or undefined when nothing is recorded for it. */
function recorded(
  registry: DisplayProfileRestoreRegistry,
  facet: DisplayProfileRestoreAction["facet"],
) {
  const action = registry.pending(emulator.deviceId).find((candidate) => candidate.facet === facet);
  return action && "commands" in action ? action : undefined;
}

function setup(options: { owner?: string; displayId?: number; device?: BootedDevice } = {}) {
  const adb = new FakeDisplayGeometryAdb();
  adb.setCommandResult("shell settings get system font_scale", "1.0\n");
  adb.setCommandResult("shell wm density", "Physical density: 440\n");
  adb.setCommandResult("shell cmd uimode night", "Night mode: no\n");
  const registry = new DisplayProfileRestoreRegistry();
  const invalidations: string[] = [];
  const config = new DisplayConfig(options.device ?? emulator, {
    adbFactory: new FakeAdbClientFactory(adb),
    themeBaselines: new Map(),
    simctl: new FakeSimctl(),
    geometry: {
      registry,
      invalidate: (_deviceId, reason) => invalidations.push(reason),
      ...(options.owner ? { owner: options.owner } : {}),
      ...(options.displayId === undefined ? {} : { displayId: options.displayId }),
    },
  });
  const mutations = () =>
    adb
      .getAllCommands()
      .filter((command) =>
        / (enable|disable|enable-exclusive)| wm size [^-]|wm density \d/.test(command),
      );
  return { adb, registry, invalidations, config, mutations };
}

describe("displayConfig runtime geometry reads (#14101)", () => {
  test("reports size, navigation mode, cutout and the shipped overlay values", async () => {
    const { config } = setup();
    const result = await config.getConfig();
    expect(result.success).toBe(true);
    expect(result.current).toMatchObject({
      size: { width: 1080, height: 2400 },
      navigationMode: "gesture",
      displayCutout: "none",
    });
    expect(result.available).toEqual({
      navigationMode: ["default", "gesture", "threeButton"],
      displayCutout: ["none", "corner", "double", "hole", "tall", "waterfall"],
    });
    expect(result.supported).toMatchObject({
      size: true,
      navigationMode: true,
      displayCutout: true,
    });
  });

  test("an unreadable overlay list omits the overlay fields without failing the read", async () => {
    const { adb, config } = setup();
    adb.failing.add("shell cmd overlay list android");
    const result = await config.getConfig();
    expect(result.success).toBe(true);
    expect(result.current?.navigationMode).toBeUndefined();
    expect(result.available).toBeUndefined();
    expect(result.current?.size).toEqual({ width: 1080, height: 2400 });
  });
});

describe("displayConfig navigation mode and cutout (#14101)", () => {
  test("overlay names that are not package-shaped never reach a shell command", async () => {
    const { adb, mutations, config } = setup();
    adb.overlays.push({
      target: "android",
      packageName: `${CUTOUT}evil;reboot`,
      state: "disabled",
    });
    const result = await config.setConfig({ displayCutout: "hole" });
    expect(result.success).toBe(true);
    expect(adb.getAllCommands().some((command) => command.includes(";"))).toBe(false);
    expect(mutations().join("\n")).not.toContain("evil");
  });

  test("switches to three-button navigation and back, recording the original once", async () => {
    const { adb, registry, invalidations, config } = setup({ owner: "session-a" });
    const toThree = await config.setConfig({ navigationMode: "threeButton" });
    expect(toThree).toMatchObject({
      success: true,
      previous: { navigationMode: "gesture" },
      applied: { navigationMode: "threeButton" },
    });
    expect(adb.getAllCommands()).toContain(
      `shell cmd overlay enable-exclusive --category ${NAVBAR}threebutton`,
    );
    expect(adb.enabled(NAVBAR)).toEqual([`${NAVBAR}threebutton`]);
    // The restore puts gesture back and disables every other navbar overlay.
    expect(recorded(registry, "navigationMode")?.commands).toEqual([
      `shell cmd overlay enable-exclusive --category ${NAVBAR}gestural`,
      `shell cmd overlay disable ${NAVBAR}gestural_extra_wide_back`,
      `shell cmd overlay disable ${NAVBAR}gestural_narrow_back`,
      `shell cmd overlay disable ${NAVBAR}gestural_wide_back`,
      `shell cmd overlay disable ${NAVBAR}threebutton`,
    ]);
    expect(registry.restoresOnRelease(emulator.deviceId)).toBe(true);
    expect(invalidations).toEqual(["Display geometry changed by displayConfig"]);

    const back = await config.setConfig({ navigationMode: "gesture" });
    expect(back).toMatchObject({ success: true, applied: { navigationMode: "gesture" } });
    expect(adb.enabled(NAVBAR)).toEqual([`${NAVBAR}gestural`]);
    // The original stays recorded (write-once), so a later release restores it idempotently.
    expect(recorded(registry, "navigationMode")).toBeDefined();
  });

  test("refuses a navigation mode the system image does not ship, before any write", async () => {
    const { mutations, invalidations, registry, config } = setup();
    const result = await config.setConfig({ navigationMode: "twoButton", fontScale: 1.3 });
    expect(result.success).toBe(false);
    expect(result.error).toContain("navigationMode 'twoButton' is not available");
    expect(result.error).toContain("default, gesture, threeButton");
    expect(result.previous).toBeUndefined();
    expect(mutations()).toEqual([]);
    expect(invalidations).toEqual([]);
    expect(registry.pending(emulator.deviceId)).toEqual([]);
  });

  test("refuses an overlay the image lists but cannot enable", async () => {
    const { adb, mutations, config } = setup();
    adb.overlays.push({ target: "android", packageName: `${CUTOUT}tall`, state: "unavailable" });
    adb.overlays = adb.overlays.filter(
      (overlay) => !(overlay.packageName === `${CUTOUT}tall` && overlay.state === "disabled"),
    );
    const result = await config.setConfig({ displayCutout: "tall" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("displayCutout 'tall' is not available");
    expect(mutations()).toEqual([]);
  });

  test("emulates a cutout and turns it off again", async () => {
    const { adb, config } = setup();
    const hole = await config.setConfig({ displayCutout: "hole" });
    expect(hole).toMatchObject({
      success: true,
      previous: { displayCutout: "none" },
      applied: { displayCutout: "hole" },
    });
    expect(adb.enabled(CUTOUT)).toEqual([`${CUTOUT}hole`]);
    const none = await config.setConfig({ displayCutout: "none" });
    expect(none).toMatchObject({ success: true, applied: { displayCutout: "none" } });
    expect(adb.getAllCommands()).toContain(`shell cmd overlay disable ${CUTOUT}hole`);
    expect(adb.enabled(CUTOUT)).toEqual([]);
  });

  test("a rejected overlay write keeps previous and the recorded original", async () => {
    const { adb, registry, config } = setup();
    adb.failing.add(`shell cmd overlay enable-exclusive --category ${CUTOUT}tall`);
    const result = await config.setConfig({ displayCutout: "tall" });
    expect(result.success).toBe(false);
    expect(result.previous).toMatchObject({ displayCutout: "none" });
    expect(result.error).toContain("displayCutout:");
    expect(result.error).toContain("Display cutout remained none after requesting tall.");
    // Recorded before the write: a rejected command can still leave the device changed.
    expect(recorded(registry, "cutout")?.commands).toHaveLength(5);
  });
});

describe("displayConfig runtime size (#14101)", () => {
  test("overrides the size, invalidates caches, and reports the restorable previous", async () => {
    const { adb, registry, invalidations, config } = setup();
    const result = await config.setConfig({ size: { width: 720, height: 1600 } });
    expect(result).toMatchObject({
      success: true,
      previous: { size: "default" },
      applied: { size: { width: 720, height: 1600 } },
    });
    expect(adb.getAllCommands()).toContain("shell wm size 720x1600");
    expect(adb.displays.get(0)?.override).toBe("720x1600");
    expect(invalidations).toHaveLength(1);
    expect(recorded(registry, "screenSize")).toEqual({
      facet: "screenSize",
      commands: ["shell wm size reset"],
      scopes: ["0"],
    });
    // Sessionless: kept for reset, but no release restores it.
    expect(registry.restoresOnRelease(emulator.deviceId)).toBe(false);

    const restored = await config.setConfig({ size: "default" });
    expect(restored).toMatchObject({
      success: true,
      applied: { size: { width: 1080, height: 2400 } },
    });
    expect(adb.getAllCommands()).toContain("shell wm size reset");
    expect(recorded(registry, "screenSize")?.commands).toEqual(["shell wm size reset"]);
  });

  test("targets a secondary display with -d", async () => {
    const { adb, config } = setup({ displayId: 2 });
    adb.displays.set(2, { physical: "1920x1080" });
    const result = await config.setConfig({ size: { width: 1280, height: 720 } });
    expect(result.success).toBe(true);
    expect(adb.getAllCommands()).toContain("shell wm size 1280x720 -d 2");
    expect(adb.displays.get(2)?.override).toBe("1280x720");
    expect(adb.displays.get(0)?.override).toBeUndefined();
  });

  test("a second display's original is recorded beside the first", async () => {
    const first = setup({ owner: "session-a" });
    const { adb, registry } = first;
    adb.displays.set(2, { physical: "1920x1080" });
    await first.config.setConfig({ size: { width: 720, height: 1600 } });
    const second = new DisplayConfig(emulator, {
      adbFactory: new FakeAdbClientFactory(adb),
      themeBaselines: new Map(),
      geometry: { registry, invalidate: () => {}, displayId: 2, owner: "session-a" },
    });
    await second.setConfig({ size: { width: 1280, height: 720 } });
    expect(recorded(registry, "screenSize")).toEqual({
      facet: "screenSize",
      commands: ["shell wm size reset", "shell wm size reset -d 2"],
      scopes: ["0", "2"],
    });
  });

  test("reset on one display restores only that display and keeps the other recorded", async () => {
    const first = setup({ owner: "session-a" });
    const { adb, registry } = first;
    adb.displays.set(2, { physical: "1920x1080" });
    await first.config.setConfig({ size: { width: 720, height: 1600 } });
    const second = new DisplayConfig(emulator, {
      adbFactory: new FakeAdbClientFactory(adb),
      themeBaselines: new Map(),
      geometry: { registry, invalidate: () => {}, displayId: 2, owner: "session-a" },
    });
    await second.setConfig({ size: { width: 1280, height: 720 } });

    const result = await second.setConfig({ reset: true });
    expect(result.success).toBe(true);
    expect(adb.displays.get(2)?.override).toBeUndefined();
    expect(adb.displays.get(0)?.override).toBe("720x1600");
    expect(recorded(registry, "screenSize")).toEqual({
      facet: "screenSize",
      commands: ["shell wm size reset"],
      scopes: ["0"],
    });

    await first.config.setConfig({ reset: true });
    expect(adb.displays.get(0)?.override).toBeUndefined();
    expect(registry.pending(emulator.deviceId)).toEqual([]);
  });

  test.each([
    { width: 2161, height: 1600 },
    { width: 720, height: 4801 },
  ])("refuses a size Android would clamp: %j", async (size) => {
    const { mutations, config } = setup();
    const result = await config.setConfig({ size });
    expect(result.success).toBe(false);
    expect(result.error).toContain("200-2160 x 200-4800 px");
    expect(mutations()).toEqual([]);
  });

  test("reports a size the device did not adopt", async () => {
    const { adb, config } = setup();
    adb.ignoreSizeWrites = true;
    const result = await config.setConfig({ size: { width: 720, height: 1600 } });
    expect(result.success).toBe(false);
    expect(result.error).toBe("Display size remained 1080x2400 after requesting 720x1600.");
    expect(result.previous).toMatchObject({ size: "default" });
  });

  test("a density change also invalidates cached observations", async () => {
    const { invalidations, config } = setup();
    await config.setConfig({ density: 480 });
    expect(invalidations).toEqual(["Display density changed by displayConfig"]);
  });
});

describe("displayConfig reset with runtime geometry (#14101)", () => {
  test("resets the size and restores the recorded navigation mode and cutout", async () => {
    const { adb, registry, config } = setup({ owner: "session-a" });
    await config.setConfig({
      size: { width: 720, height: 1600 },
      navigationMode: "threeButton",
      displayCutout: "tall",
    });
    const result = await config.setConfig({ reset: true });
    expect(result.success).toBe(true);
    expect(result.previous).toMatchObject({
      size: { width: 720, height: 1600 },
      navigationMode: "threeButton",
      displayCutout: "tall",
    });
    expect(result.applied).toMatchObject({
      size: "default",
      navigationMode: "gesture",
      displayCutout: "none",
    });
    expect(adb.enabled(NAVBAR)).toEqual([`${NAVBAR}gestural`]);
    expect(adb.enabled(CUTOUT)).toEqual([]);
    expect(adb.displays.get(0)?.override).toBeUndefined();
    expect(registry.pending(emulator.deviceId)).toEqual([]);
    expect(registry.restoresOnRelease(emulator.deviceId)).toBe(false);
  });

  test("reset leaves overlays nothing recorded untouched, but still clears a stray size", async () => {
    const { adb, config } = setup();
    adb.overlays.find((overlay) => overlay.packageName === `${CUTOUT}hole`)!.state = "enabled";
    adb.displays.get(0)!.override = "720x1600";
    const result = await config.setConfig({ reset: true });
    expect(result.success).toBe(true);
    expect(adb.enabled(CUTOUT)).toEqual([`${CUTOUT}hole`]);
    expect(adb.displays.get(0)?.override).toBeUndefined();
  });

  test("reset restores an original a displayProfile apply recorded", async () => {
    const { adb, registry, config } = setup();
    adb.displays.get(0)!.override = "720x1600";
    registry.record(
      emulator,
      { facet: "screenSize", commands: ["shell wm size 900x2000"] },
      undefined,
    );
    const result = await config.setConfig({ reset: true });
    expect(result.success).toBe(true);
    expect(adb.displays.get(0)?.override).toBe("900x2000");
    expect(registry.pending(emulator.deviceId)).toEqual([]);
  });

  test("a failed restore stays recorded for the next reset or release", async () => {
    const { adb, registry, config } = setup({ owner: "session-a" });
    await config.setConfig({ size: { width: 720, height: 1600 } });
    adb.failing.add("shell wm size reset");
    const result = await config.setConfig({ reset: true });
    expect(result.success).toBe(false);
    expect(recorded(registry, "screenSize")).toBeDefined();
  });

  test("reset cannot be combined with a geometry field", async () => {
    const { mutations, config } = setup();
    const result = await config.setConfig({ reset: true, size: "default" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("reset cannot be combined");
    expect(mutations()).toEqual([]);
  });
});

describe("displayConfig geometry on iOS (#14101)", () => {
  test("refuses size, navigation mode and cutout without running simctl", async () => {
    const simctl = new FakeSimctl();
    const device: BootedDevice = {
      name: "iPhone 16",
      platform: "ios",
      deviceId: "12345678-1234-1234-1234-123456789ABC",
      iosVersion: "17.5",
    };
    const config = new DisplayConfig(device, { simctl, themeBaselines: new Map() });
    const result = await config.setConfig({ displayCutout: "hole", theme: "dark" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("Android only");
    expect(simctl.wasMethodCalled("executeCommandArgs")).toBe(false);
  });
});
