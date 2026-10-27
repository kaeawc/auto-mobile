import { beforeEach, describe, expect, test } from "bun:test";
import {
  applyDisplayProfile,
  parseOverlayList,
  parseWmSizeOverride,
  resetDisplayProfile,
} from "../../../src/features/utility/DisplayProfile";
import { DisplayProfileRestoreRegistry } from "../../../src/features/utility/DisplayProfileRestore";
import type { BootedDevice } from "../../../src/models";
import { createExecResult } from "../../../src/utils/execResult";
import {
  createFakeDisplayProfilePorts,
  fakeEmulator as emulator,
} from "../../fakes/FakeDisplayProfilePorts";

describe("display profiles (#14052)", () => {
  let ports: ReturnType<typeof createFakeDisplayProfilePorts>;
  let registry: DisplayProfileRestoreRegistry;

  beforeEach(() => {
    ports = createFakeDisplayProfilePorts();
    registry = new DisplayProfileRestoreRegistry();
  });

  const deps = (owner?: string) => ({ ...ports, registry, owner });
  const writes = () =>
    ports.shell
      .getExecutedCommands()
      .filter((command) => !/^shell (cmd overlay list|getprop)|^shell wm size$/.test(command));

  test("one call applies every facet and reports each step", async () => {
    const result = await applyDisplayProfile(
      emulator,
      {
        screenSize: "900x2000",
        density: 480,
        fontScale: 1.3,
        cutout: "hole",
        navigationMode: "threebutton",
        forceDark: true,
        posture: "half_opened",
      },
      deps(),
    );
    expect(result.status).toBe("applied");
    expect(result.steps.map((step) => [step.step, step.status])).toEqual([
      ["screenSize", "applied"],
      ["display", "applied"],
      ["cutout", "applied"],
      ["navigationMode", "applied"],
      ["forceDark", "applied"],
      ["posture", "applied"],
    ]);
    expect(writes()).toEqual([
      "shell wm size 900x2000",
      "shell cmd overlay enable-exclusive --category com.android.internal.display.cutout.emulation.hole",
      "shell cmd overlay enable-exclusive --category com.android.internal.systemui.navbar.threebutton",
      "shell setprop debug.hwui.force_dark true",
    ]);
    expect(ports.displayConfig.calls).toEqual([{ fontScale: 1.3, density: 480, theme: "dark" }]);
    expect(ports.posture.calls).toEqual(["half_opened"]);
  });

  test("reset restores every changed setting, latest first, and a second reset changes nothing", async () => {
    await applyDisplayProfile(
      emulator,
      {
        screenSize: "900x2000",
        fontScale: 1.3,
        cutout: "hole",
        navigationMode: "threebutton",
        forceDark: true,
        posture: "closed",
      },
      deps(),
    );
    ports.shell.clearHistory();
    ports.displayConfig.calls = [];

    const reset = await resetDisplayProfile(emulator, deps());
    expect(reset.steps.map((step) => step.step)).toEqual([
      "posture",
      "forceDark",
      "navigationMode",
      "cutout",
      "display",
      "screenSize",
    ]);
    expect(ports.posture.current).toBe("opened");
    expect(ports.displayConfig.calls).toEqual([{ fontScale: "default", theme: "light" }]);
    expect(writes()).toEqual([
      "shell setprop debug.hwui.force_dark ''",
      "shell cmd overlay enable-exclusive --category com.android.internal.systemui.navbar.gestural",
      "shell cmd overlay disable com.android.internal.display.cutout.emulation.hole",
      "shell wm size reset",
    ]);

    ports.shell.clearHistory();
    const second = await resetDisplayProfile(emulator, deps());
    expect(second.steps).toEqual([]);
    expect(ports.shell.getExecutedCommands()).toEqual([]);
  });

  test("a second profile keeps the state found before the first", async () => {
    await applyDisplayProfile(emulator, { fontScale: 1.3, screenSize: "900x2000" }, deps());
    ports.shell.setCommandResponseSequence("shell wm size", [
      createExecResult("Physical size: 1080x2400\nOverride size: 900x2000\n", ""),
    ]);
    await applyDisplayProfile(
      emulator,
      { fontScale: 1.5, density: 400, screenSize: "800x1800" },
      deps(),
    );
    ports.displayConfig.calls = [];
    ports.shell.clearHistory();

    await resetDisplayProfile(emulator, deps());
    // fontScale from the first profile, density first changed by the second.
    expect(ports.displayConfig.calls).toEqual([{ fontScale: "default", density: "default" }]);
    expect(ports.shell.getExecutedCommands()).toContain("shell wm size reset");
  });

  test("an existing size override is restored rather than reset", async () => {
    ports.shell.setCommandResponseSequence("shell wm size", [
      createExecResult("Physical size: 1080x2400\nOverride size: 1000x2200\n", ""),
    ]);
    await applyDisplayProfile(emulator, { screenSize: "default" }, deps());
    ports.shell.clearHistory();
    await resetDisplayProfile(emulator, deps());
    expect(ports.shell.getExecutedCommands()).toEqual(["shell wm size 1000x2200"]);
  });

  test("overlays missing from the image and features below API 29 are unsupported", async () => {
    ports.shell.setAndroidApiLevel(28);
    const old = await applyDisplayProfile(
      emulator,
      { navigationMode: "gestural", forceDark: true, fontScale: 1.2 },
      deps(),
    );
    expect(old.status).toBe("partial");
    expect(old.steps.map((step) => step.status)).toEqual(["applied", "unsupported", "unsupported"]);
    expect(old.steps[1].detail).toContain("API 29+");

    ports.shell.setAndroidApiLevel(34);
    const missing = await applyDisplayProfile(emulator, { cutout: "waterfall" }, deps());
    expect(missing.status).toBe("unsupported");
    expect(missing.steps[0].detail).toContain("not on this system image");
  });

  test("cutout none disables whichever cutout overlay is enabled and reset re-enables it", async () => {
    ports.shell.setCommandResponseSequence("shell cmd overlay list android", [
      createExecResult("[x] com.android.internal.display.cutout.emulation.corner\n", ""),
    ]);
    await applyDisplayProfile(emulator, { cutout: "none" }, deps());
    expect(writes()).toEqual([
      "shell cmd overlay disable com.android.internal.display.cutout.emulation.corner",
    ]);
    ports.shell.clearHistory();
    await resetDisplayProfile(emulator, deps());
    expect(ports.shell.getExecutedCommands()).toEqual([
      "shell cmd overlay enable-exclusive --category com.android.internal.display.cutout.emulation.corner",
    ]);
  });

  test("density on a physical device and an unreadable posture are partial", async () => {
    const physical: BootedDevice = { name: "phone", platform: "android", deviceId: "R5CT1234" };
    ports.displayConfig.densitySupport = "partial";
    ports.posture.current = undefined;
    const result = await applyDisplayProfile(
      physical,
      { density: 400, screenSize: "900x2000", posture: "closed" },
      deps(),
    );
    expect(result.steps.map((step) => step.status)).toEqual(["partial", "partial", "partial"]);
    expect(result.status).toBe("partial");
    expect(registry.has(physical.deviceId, "posture")).toBe(false);
  });

  test("a refused write keeps no record and a profile that changed nothing throws", async () => {
    ports.shell.setCommandResponse(
      "shell cmd overlay enable-exclusive",
      createExecResult("", "Error: java.lang.SecurityException\n"),
    );
    await expect(applyDisplayProfile(emulator, { cutout: "hole" }, deps())).rejects.toThrow(
      "changed nothing",
    );
    expect(registry.pending(emulator.deviceId)).toEqual([]);
  });

  test("a failed facet does not stop the others", async () => {
    ports.displayConfig.failWith = "settings put failed";
    const result = await applyDisplayProfile(
      emulator,
      { fontScale: 1.4, forceDark: false },
      deps(),
    );
    expect(result.status).toBe("partial");
    expect(result.steps.map((step) => step.status)).toEqual(["failed", "applied"]);
  });

  test("a restore the device refuses stays recorded", async () => {
    await applyDisplayProfile(emulator, { posture: "closed" }, deps());
    ports.posture.unsupported = "not foldable";
    await expect(resetDisplayProfile(emulator, deps())).rejects.toThrow("failed");
    expect(registry.has(emulator.deviceId, "posture")).toBe(true);
  });

  test("input is validated before anything runs, and iOS is refused", async () => {
    await expect(applyDisplayProfile(emulator, { screenSize: "big" }, deps())).rejects.toThrow(
      "WIDTHxHEIGHT",
    );
    await expect(applyDisplayProfile(emulator, {}, deps())).rejects.toThrow("at least one");
    const ios: BootedDevice = { name: "sim", platform: "ios", deviceId: "SIM-1" };
    await expect(applyDisplayProfile(ios, { fontScale: 1.2 }, deps())).rejects.toThrow(
      "Android-only",
    );
    expect(ports.shell.getExecutedCommands()).toEqual([]);
  });

  test("a session owner makes the receipt restore on release", async () => {
    const result = await applyDisplayProfile(emulator, { forceDark: true }, deps("session-1"));
    expect(result.restore).toEqual({ facets: ["forceDark", "display"], onSessionRelease: true });
  });

  test("wm size and overlay listings parse", () => {
    expect(parseWmSizeOverride("Physical size: 1080x2400\n")).toBeUndefined();
    expect(parseWmSizeOverride("Physical size: 1080x2400\nOverride size: 900x2000\n")).toBe(
      "900x2000",
    );
    expect(parseOverlayList("android\n[x] a.b\n[ ] c.d\n--- e.f\n")).toEqual([
      { name: "a.b", enabled: true },
      { name: "c.d", enabled: false },
    ]);
  });
});
