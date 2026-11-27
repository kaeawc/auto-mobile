import { beforeEach, describe, expect, test } from "bun:test";
import { DisplayConfig } from "../../../src/features/utility/DisplayConfig";
import {
  applyDisplayProfile,
  resetDisplayProfile,
} from "../../../src/features/utility/DisplayProfile";
import { DisplayProfileRestoreRegistry } from "../../../src/features/utility/DisplayProfileRestore";
import { createExecResult } from "../../../src/utils/execResult";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { FakeDisplayGeometryAdb } from "../../fakes/FakeDisplayGeometryAdb";
import {
  createFakeDisplayProfilePorts,
  fakeEmulator as emulator,
} from "../../fakes/FakeDisplayProfilePorts";
import { FakeSimctl } from "../../fakes/FakeSimctl";

/**
 * displayConfig and displayProfile share one restore registry, so a size either tool sets on
 * display 0 must be restored once, to the first original, whichever tool resets it (#19404).
 */
describe("display 0 size shared by displayConfig and displayProfile (#19404)", () => {
  let registry: DisplayProfileRestoreRegistry;
  let ports: ReturnType<typeof createFakeDisplayProfilePorts>;
  let adb: FakeDisplayGeometryAdb;
  let config: DisplayConfig;

  beforeEach(() => {
    registry = new DisplayProfileRestoreRegistry();
    ports = createFakeDisplayProfilePorts();
    adb = new FakeDisplayGeometryAdb();
    adb.setCommandResult("shell settings get system font_scale", "1.0\n");
    adb.setCommandResult("shell wm density", "Physical density: 440\n");
    adb.setCommandResult("shell cmd uimode night", "Night mode: no\n");
    config = new DisplayConfig(emulator, {
      adbFactory: new FakeAdbClientFactory(adb),
      themeBaselines: new Map(),
      simctl: new FakeSimctl(),
      geometry: { registry, invalidate: () => {}, posture: ports.posture },
    });
  });

  const deps = () => ({ ...ports, registry });
  const profileSizeReads = (override: string | undefined) =>
    ports.shell.setCommandResponse(
      "shell wm size",
      createExecResult(
        `Physical size: 1080x2400\n${override ? `Override size: ${override}\n` : ""}`,
        "",
      ),
    );
  const profileWrites = () =>
    ports.shell.getExecutedCommands().filter((command) => /^shell wm size ./.test(command));
  const configSizeWrites = () =>
    adb.getAllCommands().filter((command) => /wm size ./.test(command));

  test("a foldable size displayProfile set is restored to its original by displayConfig reset", async () => {
    profileSizeReads("700x1500");
    await applyDisplayProfile(emulator, { screenSize: "900x2000" }, deps());
    adb.displays.set(0, { physical: "1080x2400", override: "900x2000" });

    const result = await config.setConfig({ reset: true });

    expect(result.success).toBe(true);
    expect(configSizeWrites()).toEqual(["shell wm size 700x1500"]);
    expect(adb.displays.get(0)?.override).toBe("700x1500");
    expect(registry.pending(emulator.deviceId)).toEqual([]);
  });

  test("displayConfig then displayProfile on a foldable keeps one restore: the first original", async () => {
    await config.setConfig({ size: { width: 720, height: 1600 } });
    profileSizeReads("720x1600");
    await applyDisplayProfile(emulator, { screenSize: "900x2000" }, deps());

    expect(registry.pending(emulator.deviceId)).toEqual([
      {
        facet: "screenSize",
        commands: ["shell wm size reset"],
        scopes: ["0"],
        postures: ["opened"],
      },
    ]);
    ports.shell.clearHistory();
    await resetDisplayProfile(emulator, deps());
    expect(profileWrites()).toEqual(["shell wm size reset"]);
    expect(registry.pending(emulator.deviceId)).toEqual([]);
  });

  test("displayProfile then displayConfig on a foldable keeps one restore: the first original", async () => {
    await applyDisplayProfile(emulator, { screenSize: "900x2000" }, deps());
    adb.displays.set(0, { physical: "1080x2400", override: "900x2000" });
    await config.setConfig({ size: { width: 720, height: 1600 } });

    expect(registry.pending(emulator.deviceId)).toEqual([
      {
        facet: "screenSize",
        commands: ["shell wm size reset"],
        scopes: ["0"],
        postures: ["opened"],
      },
    ]);
    ports.shell.clearHistory();
    await resetDisplayProfile(emulator, deps());
    expect(profileWrites()).toEqual(["shell wm size reset"]);
    expect(ports.posture.calls).toEqual([]);
    expect(registry.pending(emulator.deviceId)).toEqual([]);
  });

  test("on a device that does not fold, displayProfile then displayConfig behaves as before", async () => {
    ports.posture.current = undefined;
    profileSizeReads("700x1500");
    await applyDisplayProfile(emulator, { screenSize: "900x2000" }, deps());
    adb.displays.set(0, { physical: "1080x2400", override: "900x2000" });
    await config.setConfig({ size: { width: 720, height: 1600 } });

    expect(registry.pending(emulator.deviceId)).toEqual([
      { facet: "screenSize", commands: ["shell wm size 700x1500"] },
    ]);
    await config.setConfig({ reset: true });
    expect(adb.displays.get(0)?.override).toBe("700x1500");
    expect(registry.pending(emulator.deviceId)).toEqual([]);
  });
});

/**
 * On a foldable `wm size` keeps one override per fold panel of display 0, so displayConfig records
 * the panel its size lands on and its reset restores each panel's entry there (#19452). One fake
 * device serves both tools: the size a command reaches follows the fake posture.
 */
describe("displayConfig size restore per fold panel (#19452)", () => {
  let registry: DisplayProfileRestoreRegistry;
  let ports: ReturnType<typeof createFakeDisplayProfilePorts>;
  let adb: FakeDisplayGeometryAdb;
  let config: DisplayConfig;

  beforeEach(() => {
    registry = new DisplayProfileRestoreRegistry();
    ports = createFakeDisplayProfilePorts();
    adb = new FakeDisplayGeometryAdb();
    adb.foldPosture = () => ports.posture.current;
    adb.displays.set(0, { physical: "2076x2152" });
    adb.cover.physical = "1080x2424";
    adb.setCommandResult("shell settings get system font_scale", "1.0\n");
    adb.setCommandResult("shell wm density", "Physical density: 440\n");
    adb.setCommandResult("shell cmd uimode night", "Night mode: no\n");
    config = new DisplayConfig(emulator, {
      adbFactory: new FakeAdbClientFactory(adb),
      themeBaselines: new Map(),
      simctl: new FakeSimctl(),
      geometry: { registry, invalidate: () => {}, posture: ports.posture },
    });
  });

  const deps = () => ({ ...ports, shell: adb, registry });
  const inner = () => adb.displays.get(0)?.override;
  const cover = () => adb.cover.override;

  async function configInnerThenProfileCover(): Promise<void> {
    await config.setConfig({ size: { width: 1600, height: 1700 } });
    await applyDisplayProfile(emulator, { posture: "closed", screenSize: "900x2000" }, deps());
    expect([inner(), cover()]).toEqual(["1600x1700", "900x2000"]);
  }

  test("displayConfig size then displayProfile size on the other panel: displayProfile reset restores both", async () => {
    await configInnerThenProfileCover();
    expect(registry.pending(emulator.deviceId)).toEqual([
      { facet: "posture", posture: "opened" },
      {
        facet: "screenSize",
        commands: ["shell wm size reset", "shell wm size reset"],
        scopes: ["0", "0"],
        postures: ["opened", "closed"],
      },
    ]);

    await resetDisplayProfile(emulator, deps());

    expect([inner(), cover()]).toEqual([undefined, undefined]);
    expect(ports.posture.current).toBe("opened");
    expect(registry.pending(emulator.deviceId)).toEqual([]);
  });

  test("displayConfig size then displayProfile size on the other panel: displayConfig reset restores both", async () => {
    await configInnerThenProfileCover();

    const result = await config.setConfig({ reset: true });

    expect(result.success).toBe(true);
    expect([inner(), cover()]).toEqual([undefined, undefined]);
    // displayConfig puts back the posture it found; displayProfile's posture record stays for its reset.
    expect(ports.posture.current).toBe("closed");
    expect(ports.posture.calls).toEqual(["closed", "opened", "closed"]);
    expect(registry.pending(emulator.deviceId)).toEqual([{ facet: "posture", posture: "opened" }]);
  });

  test("displayConfig reset runs each per-panel displayProfile entry on its own panel", async () => {
    adb.displays.set(0, { physical: "2076x2152", override: "1800x1900" });
    await applyDisplayProfile(emulator, { screenSize: "1600x1700" }, deps());
    await applyDisplayProfile(emulator, { posture: "closed", screenSize: "900x2000" }, deps());
    expect([inner(), cover()]).toEqual(["1600x1700", "900x2000"]);

    await config.setConfig({ reset: true });

    // Each original lands on its own panel: the inner panel's override, the cover panel's none.
    expect([inner(), cover()]).toEqual(["1800x1900", undefined]);
    expect(ports.posture.current).toBe("closed");
    expect(registry.pending(emulator.deviceId)).toEqual([{ facet: "posture", posture: "opened" }]);
  });

  test("a panel whose restore fails stays recorded and the posture still goes back", async () => {
    adb.displays.set(0, { physical: "2076x2152", override: "1800x1900" });
    await config.setConfig({ size: { width: 1600, height: 1700 } });
    ports.posture.current = "closed";
    await config.setConfig({ size: { width: 900, height: 2000 } });
    ports.posture.current = "opened";
    adb.failing.add("shell wm size reset");

    const result = await config.setConfig({ reset: true });

    expect(result.success).toBe(false);
    expect([inner(), cover()]).toEqual(["1800x1900", "900x2000"]);
    expect(ports.posture.calls).toEqual(["closed", "opened"]);
    expect(registry.pending(emulator.deviceId)).toEqual([
      {
        facet: "screenSize",
        commands: ["shell wm size reset"],
        scopes: ["0"],
        postures: ["closed"],
      },
    ]);
  });

  test("a refused switch back keeps the posture recorded after every panel is restored", async () => {
    await config.setConfig({ size: { width: 1600, height: 1700 } });
    ports.posture.current = "closed";
    await config.setConfig({ size: { width: 900, height: 2000 } });
    ports.posture.current = "opened";
    expect([inner(), cover()]).toEqual(["1600x1700", "900x2000"]);
    // Reset restores the inner panel in place, switches to the cover panel, and the switch back
    // to the posture it found is refused.
    ports.posture.onSet = () => {
      if (ports.posture.calls.length === 1) {
        ports.posture.unsupported = "posture service busy";
      }
    };

    const result = await config.setConfig({ reset: true });

    expect(result.success).toBe(false);
    expect(result.error).toContain("posture service busy");
    expect([inner(), cover()]).toEqual([undefined, undefined]);
    expect(ports.posture.calls).toEqual(["closed", "opened"]);
    expect(await ports.posture.read()).toBe("closed");
    expect(registry.pending(emulator.deviceId)).toEqual([{ facet: "posture", posture: "opened" }]);

    ports.posture.unsupported = undefined;
    ports.posture.onSet = undefined;
    await resetDisplayProfile(emulator, deps());
    expect(ports.posture.current).toBe("opened");
    expect(registry.pending(emulator.deviceId)).toEqual([]);
  });

  test("a device that does not fold records and resets displayConfig's size without a panel", async () => {
    ports.posture.current = undefined;
    await config.setConfig({ size: { width: 1600, height: 1700 } });
    expect(registry.pending(emulator.deviceId)).toEqual([
      { facet: "screenSize", commands: ["shell wm size reset"], scopes: ["0"] },
    ]);

    await config.setConfig({ reset: true });

    expect(inner()).toBeUndefined();
    expect(ports.posture.calls).toEqual([]);
    expect(registry.pending(emulator.deviceId)).toEqual([]);
  });
});

describe("displayProfile reset posture switch-back (#19404)", () => {
  test("a failed switch back keeps the posture recorded, so a later reset retries it", async () => {
    const registry = new DisplayProfileRestoreRegistry();
    const ports = createFakeDisplayProfilePorts();
    const deps = () => ({ ...ports, registry });
    await applyDisplayProfile(emulator, { screenSize: "900x2000" }, deps());
    await applyDisplayProfile(emulator, { posture: "closed", screenSize: "800x1800" }, deps());
    // Calls so far: apply closed, then reset's posture restore and its switch to the cover panel;
    // the fourth, the switch back, is refused.
    ports.posture.onSet = () => {
      if (ports.posture.calls.length === 3) {
        ports.posture.unsupported = "posture service busy";
      }
    };

    await expect(resetDisplayProfile(emulator, deps())).rejects.toThrow("posture service busy");
    expect(ports.posture.current).toBe("closed");
    expect(registry.pending(emulator.deviceId)).toEqual([{ facet: "posture", posture: "opened" }]);

    ports.posture.unsupported = undefined;
    ports.posture.onSet = undefined;
    await resetDisplayProfile(emulator, deps());
    expect(ports.posture.current).toBe("opened");
    expect(registry.pending(emulator.deviceId)).toEqual([]);
  });
});
