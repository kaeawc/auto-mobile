import { readFileSync } from "node:fs";
import { ActionableError } from "../../../src/models/ActionableError";
import { describe, expect, test } from "bun:test";
import type { BootedDevice } from "../../../src/models";
import {
  DisplayConfig,
  type DisplayConfigDependencies,
  parseFontScale,
  parseFontScaleSnapshot,
  parseNightMode,
  parseWmDensity,
} from "../../../src/features/utility/DisplayConfig";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { FakeSimCtlClient } from "../../fakes/FakeSimCtlClient";
import {
  getDeviceIncarnationListeners,
  notifyDeviceIdentityReplaced,
} from "../../../src/utils/deviceIncarnation";

const androidEmulator: BootedDevice = {
  name: "Pixel",
  platform: "android",
  deviceId: "emulator-5554",
};

const androidPhysical: BootedDevice = {
  name: "Pixel 8",
  platform: "android",
  deviceId: "39121FDJG000AA",
};

const iosSimulator: BootedDevice = {
  name: "iPhone 16",
  platform: "ios",
  deviceId: "12345678-1234-1234-1234-123456789ABC",
  iosVersion: "17.5",
};

const iosPhysical: BootedDevice = {
  name: "Jason's iPhone",
  platform: "ios",
  deviceId: "00008130-001234567890ABCD",
  iosVersion: "17.5",
};

/** Each test owns its store; session tests explicitly share one across instances. */
function createDisplayConfig(device: BootedDevice, dependencies: DisplayConfigDependencies) {
  return new DisplayConfig(device, { themeBaselines: new Map(), ...dependencies });
}

function captured(name: string): string {
  return readFileSync(
    new URL(`../../fixtures/android-display-config/${name}.txt`, import.meta.url),
    "utf8",
  );
}

const FONT_GET = "shell settings get system font_scale";
const DENSITY_GET = "shell wm density";
const NIGHT_GET = "shell cmd uimode night";

/** Seed the three read commands so getConfig/readValues resolve deterministically. */
function seedReads(
  factory: FakeAdbClientFactory,
  opts: { fontScale?: string; density?: string; night?: string } = {},
): void {
  const client = factory.getFakeClient();
  client.setCommandResult(FONT_GET, opts.fontScale ?? "1.0\n");
  client.setCommandResult(DENSITY_GET, opts.density ?? "Physical density: 440\n");
  client.setCommandResult(NIGHT_GET, opts.night ?? "Night mode: no\n");
}

describe("DisplayConfig parsers", () => {
  test("parseFontScale handles default, unset, and malformed", () => {
    expect(parseFontScale("1.3\n")).toBe(1.3);
    expect(parseFontScale("null")).toBe(1.0);
    expect(parseFontScale("")).toBeUndefined();
    expect(parseFontScale("1.2e0")).toBe(1.2);
    expect(parseFontScale("garbage")).toBeUndefined();
  });

  test("parseFontScaleSnapshot preserves unset separately from explicit 1", () => {
    expect(parseFontScaleSnapshot("null")).toBe("default");
    expect(parseFontScaleSnapshot("")).toBeUndefined();
    expect(parseFontScaleSnapshot("1.0")).toBe(1.0);
  });

  test("parseWmDensity prefers override over physical", () => {
    expect(parseWmDensity("Physical density: 440\nOverride density: 480\n")).toMatchObject({
      physical: 440,
      effective: 480,
      overridden: true,
    });
    expect(parseWmDensity("Physical density: 440\n")).toMatchObject({
      physical: 440,
      effective: 440,
      overridden: false,
    });
    expect(parseWmDensity("nonsense").effective).toBeUndefined();
    expect(parseWmDensity("nonsense").overridden).toBe(false);
  });

  test("parseNightMode maps yes/no/auto to theme", () => {
    expect(parseNightMode("Night mode: yes\n")).toBe("dark");
    expect(parseNightMode("Night mode: no\n")).toBe("light");
    expect(parseNightMode("Night mode: auto\n")).toBe("system");
    expect(parseNightMode("Night mode: bogus\n")).toBeUndefined();
  });

  test("parseNightMode keeps custom distinct from system so restore does not write auto", () => {
    // A device on a custom schedule must round-trip as "custom", not "system":
    // collapsing it would make a later restore emit `cmd uimode night auto` and
    // destroy the user's schedule (#6096 review).
    expect(parseNightMode("Night mode: custom\n")).toBe("custom");
  });
});

describe("DisplayConfig getConfig", () => {
  test.each(["1.2garbage", "1.2.3", "1e", "Infinity", "-1", "", "  ", "0x1", "0b1"])(
    "rejects malformed font baseline %s before mutation",
    async (fontScale) => {
      const adbFactory = new FakeAdbClientFactory();
      seedReads(adbFactory, { fontScale });
      const result = await createDisplayConfig(androidEmulator, { adbFactory }).setConfig({
        fontScale: 2,
      });
      expect(result.success).toBe(false);
      expect(result.previous).toBeUndefined();
      expect(
        adbFactory
          .getFakeClient()
          .getCommandCalls()
          .some((call) => call.command.includes("settings put")),
      ).toBe(false);
    },
  );

  test.each(["440junk", "440.5", "0", "-440"])(
    "rejects malformed density baseline %s",
    async (density) => {
      const adbFactory = new FakeAdbClientFactory();
      seedReads(adbFactory, { density: `Physical density: 440\nOverride density: ${density}\n` });
      const result = await createDisplayConfig(androidEmulator, { adbFactory }).getConfig();
      expect(result.success).toBe(false);
      expect(result.current).toBeUndefined();
    },
  );

  test.each([{ fontScale: "default" as const }, { reset: true }])(
    "confirms font reset with the captured explicit scale of one",
    async (input) => {
      const adbFactory = new FakeAdbClientFactory();
      seedReads(adbFactory, { fontScale: captured("font-scale-after-reset") });
      const result = await createDisplayConfig(androidEmulator, { adbFactory }).setConfig(input);
      expect(result.success).toBe(true);
      expect(result.previous?.fontScale).toBe(1);
      expect(result.applied?.fontScale).toBe(1);
      expect(result.error).toBeUndefined();
    },
  );

  test("reads font scale, effective density, and theme", async () => {
    const adbFactory = new FakeAdbClientFactory();
    seedReads(adbFactory, {
      fontScale: "1.15\n",
      density: "Physical density: 440\nOverride density: 480\n",
      night: "Night mode: yes\n",
    });

    const result = await createDisplayConfig(androidEmulator, { adbFactory }).getConfig();

    expect(result.success).toBe(true);
    expect(result.current).toEqual({ fontScale: 1.15, density: 480, theme: "dark" });
    expect(result.supported).toEqual({ fontScale: true, density: true, theme: true });
    expect(result.previous).toBeUndefined();
    expect(result.applied).toBeUndefined();
  });

  test("reports density support as partial on a physical device", async () => {
    const adbFactory = new FakeAdbClientFactory();
    seedReads(adbFactory);

    const result = await createDisplayConfig(androidPhysical, { adbFactory }).getConfig();

    expect(result.success).toBe(true);
    expect(result.supported.density).toBe("partial");
  });

  test("reports the physical effective density when Android has no override", async () => {
    const adbFactory = new FakeAdbClientFactory();
    seedReads(adbFactory, { density: "Physical density: 440\n" });

    const result = await createDisplayConfig(androidEmulator, { adbFactory }).getConfig();

    expect(result.success).toBe(true);
    expect(result.current?.density).toBe(440);
  });

  test("reports the effective font scale (not the restoration token) when unset", async () => {
    // With no override, `settings get system font_scale` returns "null"/empty,
    // which parseFontScaleSnapshot represents as the restoration token
    // "default". `current` is observational, not a restore payload, so it must
    // report the effective AOSP default scale (1.0), matching how density
    // already reports its effective number rather than a token (#6303 review).
    const adbFactory = new FakeAdbClientFactory();
    seedReads(adbFactory, { fontScale: "null\n" });

    const result = await createDisplayConfig(androidEmulator, { adbFactory }).getConfig();

    expect(result.success).toBe(true);
    expect(result.current?.fontScale).toBe(1.0);
  });

  test("fails an iOS Simulator read when simctl does not report an appearance", async () => {
    const simctl = new FakeSimCtlClient();
    simctl.setCommandResult(["ui", iosSimulator.deviceId, "appearance"], { stdout: "\n" });

    const result = await createDisplayConfig(iosSimulator, { simctl }).getConfig();

    expect(result.success).toBe(false);
    expect(result.current).toBeUndefined();
  });

  test("rejects an unparseable Android baseline instead of reporting partial success", async () => {
    const adbFactory = new FakeAdbClientFactory();
    seedReads(adbFactory, { fontScale: "garbage\n" });

    const result = await createDisplayConfig(androidEmulator, { adbFactory }).getConfig();

    expect(result.success).toBe(false);
    expect(result.current).toBeUndefined();
    expect(result.error).toContain("font scale");
  });
});

describe("DisplayConfig setConfig", () => {
  test("does not mutate after a shell-reported unreadable baseline", async () => {
    const adbFactory = new FakeAdbClientFactory();
    const client = adbFactory.getFakeClient();
    client.setCommandResult(FONT_GET, { stdout: "", stderr: "Error: permission denied" });
    client.setCommandResult(DENSITY_GET, "Physical density: 440\n");
    client.setCommandResult(NIGHT_GET, "Night mode: no\n");

    const result = await createDisplayConfig(androidEmulator, { adbFactory }).setConfig({
      fontScale: 2,
    });

    expect(result.success).toBe(false);
    expect(client.getCommandCalls().map((call) => call.command)).not.toContain(
      "shell settings put system font_scale 2",
    );
  });

  test("does not mutate after an unparseable baseline", async () => {
    const adbFactory = new FakeAdbClientFactory();
    const client = adbFactory.getFakeClient();
    seedReads(adbFactory, { fontScale: "garbage\n" });

    const result = await createDisplayConfig(androidEmulator, { adbFactory }).setConfig({
      fontScale: 2,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("font scale");
    expect(client.getCommandCalls().map((call) => call.command)).not.toContain(
      "shell settings put system font_scale 2",
    );
  });
  test("sets font scale via settings put and returns applied + previous", async () => {
    const adbFactory = new FakeAdbClientFactory();
    const client = adbFactory.getFakeClient();
    // Previous read = default; after put, the read reflects the new scale.
    client.setCommandResultSequence(FONT_GET, [
      { stdout: "1.0\n", stderr: "" },
      { stdout: "2.0\n", stderr: "" },
    ]);
    client.setCommandResult(DENSITY_GET, "Physical density: 440\n");
    client.setCommandResult(NIGHT_GET, "Night mode: no\n");

    const result = await createDisplayConfig(androidEmulator, { adbFactory }).setConfig({
      fontScale: 2.0,
    });

    expect(result.success).toBe(true);
    expect(result.previous?.fontScale).toBe(1.0);
    expect(result.applied?.fontScale).toBe(2.0);
    const commands = client.getCommandCalls().map((c) => c.command);
    expect(commands).toContain("shell settings put system font_scale 2");
  });

  test("sets an explicit density via wm density", async () => {
    const adbFactory = new FakeAdbClientFactory();
    seedReads(adbFactory);

    await createDisplayConfig(androidEmulator, { adbFactory }).setConfig({ density: 560 });

    const commands = adbFactory
      .getFakeClient()
      .getCommandCalls()
      .map((c) => c.command);
    expect(commands).toContain("shell wm density 560");
  });

  test("fails closed when Android accepts a density command but retains the old value", async () => {
    const adbFactory = new FakeAdbClientFactory();
    // The OEM shell accepts the write but clamps or ignores it. Both snapshots
    // still report the physical density, so success must not be inferred from
    // command completion alone.
    seedReads(adbFactory, { density: "Physical density: 440\n" });

    const result = await createDisplayConfig(androidPhysical, { adbFactory }).setConfig({
      density: 560,
    });

    expect(result.success).toBe(false);
    expect(result.applied?.density).toBe(440);
    expect(result.error).toContain("Display density remained 440");
  });

  test("resolves a relative density bucket against physical density", async () => {
    const adbFactory = new FakeAdbClientFactory();
    seedReads(adbFactory, { density: "Physical density: 440\n" });

    await createDisplayConfig(androidEmulator, { adbFactory }).setConfig({ density: "larger" });

    const commands = adbFactory
      .getFakeClient()
      .getCommandCalls()
      .map((c) => c.command);
    // 440 * 1.15 = 506
    expect(commands).toContain("shell wm density 506");
  });

  test("rejects a relative density bucket below Android's supported floor", async () => {
    const adbFactory = new FakeAdbClientFactory();
    seedReads(adbFactory, { density: "Physical density: 80\n" });

    const result = await createDisplayConfig(androidEmulator, { adbFactory }).setConfig({
      density: "smaller",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("68 dpi is below Android's 72 dpi minimum");
    // The rejected bucket never dispatched a `wm density` command, so
    // verification must not recompute an "expected" density from the input and
    // report a second, misleading "Display density remained" failure alongside
    // the resolution error above (#6303 review).
    expect(result.error).not.toContain("Display density remained");
    const commands = adbFactory
      .getFakeClient()
      .getCommandCalls()
      .map((c) => c.command);
    expect(commands).not.toContain("shell wm density 68");
  });

  test("resolves a relative density bucket against physical density, not a prior override", async () => {
    const adbFactory = new FakeAdbClientFactory();
    // The device already carries an override (506 = 440 * 1.15) from a previous
    // `larger` request; a second `larger` request must still scale from the
    // PHYSICAL density (440), not compound onto the effective override (#6096).
    seedReads(adbFactory, { density: "Physical density: 440\nOverride density: 506\n" });

    await createDisplayConfig(androidEmulator, { adbFactory }).setConfig({ density: "larger" });

    const commands = adbFactory
      .getFakeClient()
      .getCommandCalls()
      .map((c) => c.command);
    expect(commands).toContain("shell wm density 506");
    expect(commands).not.toContain("shell wm density 582");
  });

  test("sets dark theme via cmd uimode night", async () => {
    const adbFactory = new FakeAdbClientFactory();
    seedReads(adbFactory);

    await createDisplayConfig(androidEmulator, { adbFactory }).setConfig({ theme: "dark" });

    const commands = adbFactory
      .getFakeClient()
      .getCommandCalls()
      .map((c) => c.command);
    expect(commands).toContain("shell cmd uimode night yes");
  });

  test("maps system theme to night mode auto", async () => {
    const adbFactory = new FakeAdbClientFactory();
    seedReads(adbFactory);

    await createDisplayConfig(androidEmulator, { adbFactory }).setConfig({ theme: "system" });

    const commands = adbFactory
      .getFakeClient()
      .getCommandCalls()
      .map((c) => c.command);
    expect(commands).toContain("shell cmd uimode night auto");
  });

  test("reset restores font scale and density without writing an unrecorded theme", async () => {
    const adbFactory = new FakeAdbClientFactory();
    seedReads(adbFactory, { fontScale: "null\n" });

    const result = await createDisplayConfig(androidEmulator, { adbFactory }).setConfig({
      reset: true,
    });

    expect(result.success).toBe(true);
    const commands = adbFactory
      .getFakeClient()
      .getCommandCalls()
      .map((c) => c.command);
    expect(commands).toContain("shell settings delete system font_scale");
    expect(commands).toContain("shell wm density reset");
    expect(commands).not.toContain("shell cmd uimode night no");
  });

  test("restores a custom night-mode schedule via cmd uimode night custom, not auto", async () => {
    const adbFactory = new FakeAdbClientFactory();
    seedReads(adbFactory);

    await createDisplayConfig(androidEmulator, { adbFactory }).setConfig({ theme: "custom" });

    const commands = adbFactory
      .getFakeClient()
      .getCommandCalls()
      .map((c) => c.command);
    expect(commands).toContain("shell cmd uimode night custom");
    expect(commands).not.toContain("shell cmd uimode night auto");
  });

  test("captures a custom device's theme as custom in previous, so a restore is faithful", async () => {
    const adbFactory = new FakeAdbClientFactory();
    seedReads(adbFactory, { night: "Night mode: custom\n" });

    const result = await createDisplayConfig(androidEmulator, { adbFactory }).setConfig({
      fontScale: 2.0,
    });

    // The device was on a custom schedule before the change; previous must
    // preserve that as "custom" (not "system") so the client can restore it.
    expect(result.previous?.theme).toBe("custom");
  });

  test("rejects reset combined with an explicit theme (contradictory request)", async () => {
    const adbFactory = new FakeAdbClientFactory();
    seedReads(adbFactory);

    const result = await createDisplayConfig(androidEmulator, { adbFactory }).setConfig({
      reset: true,
      theme: "dark",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("reset cannot be combined");
    // No mutation should have run — the contradiction is caught before any write.
    const commands = adbFactory
      .getFakeClient()
      .getCommandCalls()
      .map((c) => c.command);
    expect(commands.some((c) => c.startsWith("shell cmd uimode night"))).toBe(false);
    expect(commands.some((c) => c.startsWith("shell settings put"))).toBe(false);
    expect(commands.some((c) => c.startsWith("shell wm density"))).toBe(false);
  });

  test("preserves previous + applied state when a later mutation rejects mid-sequence", async () => {
    const adbFactory = new FakeAdbClientFactory();
    const client = adbFactory.getFakeClient();
    // Pre-read reflects the starting state; the font write succeeds, but the
    // density write rejects at the ADB layer. The already-applied font change
    // must not sink the restoration bookkeeping (#6096 review).
    client.setCommandResultSequence(FONT_GET, [
      { stdout: "1.0\n", stderr: "" },
      { stdout: "2.0\n", stderr: "" },
    ]);
    client.setCommandResult(DENSITY_GET, "Physical density: 440\n");
    client.setCommandResult(NIGHT_GET, "Night mode: no\n");
    client.setCommandError("shell wm density 560", new Error("adb: device offline"));

    const result = await createDisplayConfig(androidEmulator, { adbFactory }).setConfig({
      fontScale: 2.0,
      density: 560,
    });

    expect(result.success).toBe(false);
    // Restoration state is retained despite the mid-sequence failure.
    expect(result.previous?.fontScale).toBe(1.0);
    expect(result.applied?.fontScale).toBe(2.0);
    expect(result.error).toContain("wm density 560");
    // The earlier (successful) font mutation was still issued.
    const commands = client.getCommandCalls().map((c) => c.command);
    expect(commands).toContain("shell settings put system font_scale 2");
  });

  test("captures a no-override density as the restorable 'default' bucket, not the physical number", async () => {
    const adbFactory = new FakeAdbClientFactory();
    // No "Override density" line: the device is at its unmodified physical
    // default. Reporting `previous.density: 440` here would let a later restore
    // take the numeric branch and force an override that never existed (#6096).
    seedReads(adbFactory, { density: "Physical density: 440\n" });

    const result = await createDisplayConfig(androidEmulator, { adbFactory }).setConfig({
      fontScale: 2.0,
    });

    expect(result.previous?.density).toBe("default");
  });

  test("replaying a captured 'default' density issues wm density reset, not a forced override", async () => {
    const adbFactory = new FakeAdbClientFactory();
    seedReads(adbFactory, { density: "Physical density: 440\n" });

    const first = await createDisplayConfig(androidEmulator, { adbFactory }).setConfig({
      fontScale: 2.0,
    });
    const restorableDensity = first.previous?.density;
    expect(restorableDensity).toBe("default");

    await createDisplayConfig(androidEmulator, { adbFactory }).setConfig({
      density: restorableDensity,
    });

    const commands = adbFactory
      .getFakeClient()
      .getCommandCalls()
      .map((c) => c.command);
    expect(commands).toContain("shell wm density reset");
    expect(commands).not.toContain("shell wm density 440");
  });

  test("replaying an unset font scale deletes the override instead of writing explicit 1", async () => {
    const adbFactory = new FakeAdbClientFactory();
    seedReads(adbFactory, { fontScale: "null\n" });

    const first = await createDisplayConfig(androidEmulator, { adbFactory }).setConfig({
      theme: "dark",
    });
    const restorableFontScale = first.previous?.fontScale;
    expect(restorableFontScale).toBe("default");

    await createDisplayConfig(androidEmulator, { adbFactory }).setConfig({
      fontScale: restorableFontScale,
    });

    const commands = adbFactory
      .getFakeClient()
      .getCommandCalls()
      .map((c) => c.command);
    expect(commands).toContain("shell settings delete system font_scale");
    expect(commands).not.toContain("shell settings put system font_scale 1");
  });

  test("still captures an overridden density as its explicit dpi number", async () => {
    const adbFactory = new FakeAdbClientFactory();
    seedReads(adbFactory, { density: "Physical density: 440\nOverride density: 480\n" });

    const result = await createDisplayConfig(androidEmulator, { adbFactory }).setConfig({
      fontScale: 2.0,
    });

    expect(result.previous?.density).toBe(480);
  });

  test("rejects an empty set request", async () => {
    const adbFactory = new FakeAdbClientFactory();
    seedReads(adbFactory);

    const result = await createDisplayConfig(androidEmulator, { adbFactory }).setConfig({});

    expect(result.success).toBe(false);
    expect(result.error).toContain("At least one");
  });

  test("surfaces a shell failure from a mutating command", async () => {
    const adbFactory = new FakeAdbClientFactory();
    seedReads(adbFactory);
    adbFactory
      .getFakeClient()
      .setCommandResult("shell wm density 560", "", "Exception: bad density");

    const result = await createDisplayConfig(androidEmulator, { adbFactory }).setConfig({
      density: 560,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("wm density 560");
  });
});

/** Argv arrays actually issued to simctl (each recorded call's `args`). */
function simctlArgvCalls(simctl: FakeSimCtlClient): string[][] {
  return simctl.getMethodCalls("executeCommandArgs").map((c) => c.args as string[]);
}

describe("DisplayConfig platform gating", () => {
  test("reports physical iOS as fully unsupported for reads without issuing commands", async () => {
    const simctl = new FakeSimCtlClient();
    const result = await createDisplayConfig(iosPhysical, { simctl }).getConfig();

    expect(result.success).toBe(false);
    expect(result.platform).toBe("ios");
    expect(result.supported).toEqual({ fontScale: false, density: false, theme: false });
    expect(result.error).toContain("iOS");
    expect(simctlArgvCalls(simctl)).toEqual([]);
  });

  test("reports physical iOS as fully unsupported for writes without issuing commands", async () => {
    const simctl = new FakeSimCtlClient();
    const result = await createDisplayConfig(iosPhysical, { simctl }).setConfig({
      fontScale: 2.0,
    });

    expect(result.success).toBe(false);
    expect(result.platform).toBe("ios");
    expect(result.error).toContain("iOS");
    expect(simctlArgvCalls(simctl)).toEqual([]);
  });
});

describe("DisplayConfig iOS Simulator theme support", () => {
  test("reports theme (only) as supported on an iOS Simulator", async () => {
    const simctl = new FakeSimCtlClient();
    const result = await createDisplayConfig(iosSimulator, { simctl }).getConfig();

    expect(result.supported).toEqual({ fontScale: false, density: false, theme: true });
  });

  test("reads the current appearance through the SimCtlClient seam", async () => {
    const simctl = new FakeSimCtlClient();
    simctl.setCommandArgsResult(["ui", iosSimulator.deviceId, "appearance"], "dark\n");

    const result = await createDisplayConfig(iosSimulator, { simctl }).getConfig();

    expect(result.success).toBe(true);
    expect(result.current).toEqual({ theme: "dark" });
    // The read is issued as an argv array via the seam, not a raw simctl spawn.
    expect(simctlArgvCalls(simctl)).toContainEqual(["ui", iosSimulator.deviceId, "appearance"]);
  });

  test("sets the appearance through the SimCtlClient seam", async () => {
    const simctl = new FakeSimCtlClient();
    simctl.setCommandArgsResultSequence(
      ["ui", iosSimulator.deviceId, "appearance"],
      [{ stdout: "light\n" }, { stdout: "dark\n" }],
    );

    const result = await createDisplayConfig(iosSimulator, { simctl }).setConfig({
      theme: "dark",
    });

    expect(result.success).toBe(true);
    expect(result.previous).toEqual({ theme: "light" });
    expect(simctlArgvCalls(simctl)).toContainEqual([
      "ui",
      iosSimulator.deviceId,
      "appearance",
      "dark",
    ]);
  });

  test("fails when the Simulator does not apply the requested appearance", async () => {
    const simctl = new FakeSimCtlClient();
    simctl.setCommandArgsResultSequence(
      ["ui", iosSimulator.deviceId, "appearance"],
      [{ stdout: "light\n" }, { stdout: "light\n" }],
    );

    const result = await createDisplayConfig(iosSimulator, { simctl }).setConfig({ theme: "dark" });

    expect(result.success).toBe(false);
    expect(result.applied).toEqual({ theme: "light" });
    expect(result.previous).toEqual({ theme: "light" });
    expect(result.error).toContain("remained light");
  });

  test("reset restores light appearance", async () => {
    const simctl = new FakeSimCtlClient();
    simctl.setCommandArgsResultSequence(
      ["ui", iosSimulator.deviceId, "appearance"],
      [{ stdout: "dark\n" }, { stdout: "light\n" }],
    );

    const result = await createDisplayConfig(iosSimulator, { simctl }).setConfig({
      reset: true,
    });

    expect(result.success).toBe(true);
    expect(simctlArgvCalls(simctl)).toContainEqual([
      "ui",
      iosSimulator.deviceId,
      "appearance",
      "light",
    ]);
  });

  test("rejects theme 'system' as an honest per-field refusal, issuing no appearance write", async () => {
    const simctl = new FakeSimCtlClient();
    simctl.setCommandArgsResult(["ui", iosSimulator.deviceId, "appearance"], "light\n");

    const result = await createDisplayConfig(iosSimulator, { simctl }).setConfig({
      theme: "system",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("'system'");
    expect(simctlArgvCalls(simctl)).not.toContainEqual([
      "ui",
      iosSimulator.deviceId,
      "appearance",
      "system",
    ]);
  });

  test("rejects fontScale on the iOS Simulator without issuing a simctl appearance write", async () => {
    const simctl = new FakeSimCtlClient();

    const result = await createDisplayConfig(iosSimulator, { simctl }).setConfig({
      fontScale: 1.3,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("fontScale");
    expect(
      simctlArgvCalls(simctl).some((args) => args.length >= 4 && args[2] === "appearance"),
    ).toBe(false);
  });

  test("rejects density on the iOS Simulator", async () => {
    const simctl = new FakeSimCtlClient();

    const result = await createDisplayConfig(iosSimulator, { simctl }).setConfig({
      density: 480,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("density");
  });

  test("fails closed when the iOS Simulator snapshot is unreadable before mutation", async () => {
    const simctl = new FakeSimCtlClient();
    simctl.setCommandArgsResult(["ui", iosSimulator.deviceId, "appearance"], "unknown\n");

    const result = await createDisplayConfig(iosSimulator, { simctl }).setConfig({ theme: "dark" });

    expect(result.success).toBe(false);
    expect(result.error).toContain("readable Simulator appearance");
    expect(simctlArgvCalls(simctl)).not.toContainEqual([
      "ui",
      iosSimulator.deviceId,
      "appearance",
      "dark",
    ]);
  });

  test("preserves previous state when the post-mutation appearance read fails", async () => {
    const simctl = new FakeSimCtlClient();
    // The pre-read (before the write) succeeds ("light"), the write itself
    // succeeds, but the read used to verify what actually landed rejects
    // afterward — e.g. a transient failure or cancellation after dispatch. The
    // Simulator is left modified, so the response must still carry `previous`
    // (#6096 review).
    const appearanceArgs = ["ui", iosSimulator.deviceId, "appearance"];
    simctl.setCommandArgsResultSequence(appearanceArgs, [
      { stdout: "light\n" },
      new Error("simctl: operation cancelled"),
    ]);

    const result = await createDisplayConfig(iosSimulator, { simctl }).setConfig({
      theme: "dark",
    });

    expect(result.success).toBe(false);
    expect(result.previous).toEqual({ theme: "light" });
    expect(result.applied).toBeUndefined();
    expect(result.error).toContain("failed to read applied theme");
  });
});

describe("DisplayConfig default night-mode baseline lifecycle", () => {
  async function recordBaseline(deviceId: string) {
    const adbFactory = new FakeAdbClientFactory();
    const client = adbFactory.getFakeClient();
    seedReads(adbFactory, { night: captured("night-mode-no") });
    client.setCommandResultSequence(NIGHT_GET, [
      { stdout: captured("night-mode-yes"), stderr: "" },
      { stdout: captured("night-mode-no"), stderr: "" },
    ]);
    // Omit themeBaselines to exercise the process-wide store across instances.
    const config = () => new DisplayConfig({ ...androidEmulator, deviceId }, { adbFactory });
    expect((await config().setConfig({ theme: "light" })).success).toBe(true);
    return { client, config };
  }

  test("identity replacement drops the serial's default night-mode baseline", async () => {
    const deviceId = "display-config-identity-drop-A";
    try {
      const { client, config } = await recordBaseline(deviceId);
      notifyDeviceIdentityReplaced(deviceId);
      const result = await config().setConfig({ reset: true });
      expect(client.getCommandCalls().map((call) => call.command)).not.toContain(
        `${NIGHT_GET} yes`,
      );
      expect(result.success).toBe(true);
      expect(result.message).toContain("night mode left unchanged");
      expect(result.applied?.theme).toBe("light");
    } finally {
      notifyDeviceIdentityReplaced(deviceId);
    }
  });

  test("identity replacement preserves another serial's default night-mode baseline", async () => {
    const deviceIdA = "display-config-identity-isolation-A";
    const deviceIdB = "display-config-identity-isolation-B";
    try {
      await recordBaseline(deviceIdA);
      const { client, config } = await recordBaseline(deviceIdB);
      notifyDeviceIdentityReplaced(deviceIdA);
      client.setCommandResultSequence(NIGHT_GET, [
        { stdout: captured("night-mode-no"), stderr: "" },
        { stdout: captured("night-mode-yes"), stderr: "" },
      ]);
      const result = await config().setConfig({ reset: true });
      expect(result.success).toBe(true);
      expect(result.message).toContain("night mode restored to dark");
      expect(result.applied?.theme).toBe("dark");
      expect(client.getCommandCalls().map((call) => call.command)).toContain(`${NIGHT_GET} yes`);
    } finally {
      notifyDeviceIdentityReplaced(deviceIdA);
      notifyDeviceIdentityReplaced(deviceIdB);
    }
  });

  test("snapshot restore preserves the serial's default night-mode baseline", async () => {
    const deviceId = "display-config-snapshot-baseline-A";
    try {
      const { client, config } = await recordBaseline(deviceId);
      const listener = getDeviceIncarnationListeners().find(
        ({ name }) => name === "android-display-config-theme-baselines",
      );
      expect(listener).toBeDefined();
      await listener!.onDeviceIncarnationChanged(deviceId);
      client.setCommandResultSequence(NIGHT_GET, [
        { stdout: captured("night-mode-no"), stderr: "" },
        { stdout: captured("night-mode-yes"), stderr: "" },
      ]);
      const result = await config().setConfig({ reset: true });
      expect(result.success).toBe(true);
      expect(result.message).toContain("night mode restored to dark");
      expect(result.applied?.theme).toBe("dark");
      expect(client.getCommandCalls().map((call) => call.command)).toContain(`${NIGHT_GET} yes`);
    } finally {
      notifyDeviceIdentityReplaced(deviceId);
    }
  });
});

describe("DisplayConfig Android reset regression captures", () => {
  test("non-reset success omits an undefined message key", async () => {
    const adbFactory = new FakeAdbClientFactory();
    seedReads(adbFactory, { fontScale: "1.3\n" });
    const result = await createDisplayConfig(androidEmulator, { adbFactory }).setConfig({
      fontScale: 1.3,
    });
    expect(result.success).toBe(true);
    expect(Object.hasOwn(result, "message")).toBe(false);
  });

  function setup() {
    const adbFactory = new FakeAdbClientFactory();
    const themeBaselines = new Map<string, "light" | "dark" | "system" | "custom">();
    seedReads(adbFactory, {
      fontScale: captured("font-scale-after-reset"),
      density: captured("density-physical-420"),
      night: captured("night-mode-yes"),
    });
    const config = () => createDisplayConfig(androidEmulator, { adbFactory, themeBaselines });
    return { adbFactory, client: adbFactory.getFakeClient(), themeBaselines, config };
  }

  test("reset leaves captured dark night mode unchanged when the tool never changed it", async () => {
    const { client, config } = setup();
    const result = await config().setConfig({ reset: true });
    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.applied?.theme).toBe("dark");
    expect(result.message).toContain("night mode left unchanged");
    expect(result.message).toBe(
      "Reset font scale and density to device defaults; night mode left unchanged (no night-mode baseline was recorded by displayConfig).",
    );
    expect(result.message).not.toContain("did not change it");
    expect(client.getCommandCalls().some((call) => call.command.startsWith(`${NIGHT_GET} `))).toBe(
      false,
    );
  });

  test("reset restores the first theme baseline across instances and clears it after confirmation", async () => {
    const { client, config, themeBaselines } = setup();
    // Synthetic post-write state for 1.3; all baseline/reset shell reads use real captures.
    client.setCommandResultSequence(FONT_GET, [
      { stdout: captured("font-scale-after-reset"), stderr: "" },
      { stdout: "1.3\n", stderr: "" },
    ]);
    expect((await config().setConfig({ fontScale: 1.3, density: 420 })).success).toBe(true);
    expect(themeBaselines.size).toBe(0);
    client.setCommandResultSequence(NIGHT_GET, [
      { stdout: captured("night-mode-yes"), stderr: "" },
      { stdout: captured("night-mode-no"), stderr: "" },
    ]);
    expect((await config().setConfig({ theme: "light" })).success).toBe(true);
    expect(themeBaselines.get(androidEmulator.deviceId)).toBe("dark");
    // A later write must retain the original dark baseline, even with light as previous.
    client.setCommandResultSequence(NIGHT_GET, [{ stdout: captured("night-mode-no"), stderr: "" }]);
    expect((await config().setConfig({ theme: "light" })).success).toBe(true);
    expect(themeBaselines.get(androidEmulator.deviceId)).toBe("dark");
    client.setCommandResultSequence(FONT_GET, [
      { stdout: captured("font-scale-1.15"), stderr: "" },
      { stdout: captured("font-scale-after-reset"), stderr: "" },
    ]);
    client.setCommandResultSequence(NIGHT_GET, [
      { stdout: captured("night-mode-no"), stderr: "" },
      { stdout: captured("night-mode-yes"), stderr: "" },
    ]);
    const result = await config().setConfig({ reset: true });
    expect(result.success).toBe(true);
    expect(result.message).toContain("night mode restored to dark");
    expect(result.previous?.theme).toBe("light");
    expect(result.applied).toEqual({ fontScale: 1, density: 420, theme: "dark" });
    const commands = client.getCommandCalls().map((call) => call.command);
    expect(commands).toContain("shell settings delete system font_scale");
    expect(commands).toContain("shell wm density reset");
    expect(commands).toContain("shell cmd uimode night yes");
    expect(themeBaselines.has(androidEmulator.deviceId)).toBe(false);
  });

  test.each([{ reset: true }, { fontScale: "default" as const }])(
    "rejects a font reset whose captured 1.15 scale remains: %j",
    async (input) => {
      const { client, config } = setup();
      client.setCommandResult(FONT_GET, captured("font-scale-1.15"));
      const result = await config().setConfig(input);
      expect(result.success).toBe(false);
      expect(result.error).toBe("Font scale remained 1.15 after requesting default.");
      expect(result.message).toBe(result.error);
    },
  );

  test.each(["shell", "executor"])(
    "density reset %s failure preserves previous and still resets font scale",
    async (failure) => {
      const { client, config } = setup();
      client.setCommandResultSequence(FONT_GET, [
        { stdout: captured("font-scale-1.15"), stderr: "" },
        { stdout: captured("font-scale-after-reset"), stderr: "" },
      ]);
      if (failure === "shell") {
        client.setCommandResult("shell wm density reset", "Error: density refused");
      } else {
        client.setCommandError("shell wm density reset", new Error("device offline"));
      }
      const result = await config().setConfig({ reset: true });
      expect(result.success).toBe(false);
      expect(result.error).toStartWith("density:");
      expect(result.message).toBe(result.error);
      expect(result.previous).toEqual({ fontScale: 1.15, density: "default", theme: "dark" });
      expect(result.applied?.fontScale).toBe(1);
      expect(client.getCommandCalls().map((call) => call.command)).toContain(
        "shell settings delete system font_scale",
      );
    },
  );

  test("failed night-mode restore retains the original baseline", async () => {
    const { client, config, themeBaselines } = setup();
    themeBaselines.set(androidEmulator.deviceId, "dark");
    client.setCommandResult(NIGHT_GET, captured("night-mode-no"));
    client.setCommandError("shell cmd uimode night yes", new Error("device offline"));
    const result = await config().setConfig({ reset: true });
    expect(result.success).toBe(false);
    expect(result.error).toStartWith("night mode:");
    expect(result.message).toBe(result.error);
    expect(themeBaselines.get(androidEmulator.deviceId)).toBe("dark");
  });

  test("an accepted but unapplied night-mode restore retains the baseline", async () => {
    const { client, config, themeBaselines } = setup();
    themeBaselines.set(androidEmulator.deviceId, "dark");
    client.setCommandResult(NIGHT_GET, captured("night-mode-no"));
    const result = await config().setConfig({ reset: true });
    expect(result.success).toBe(false);
    expect(result.error).toBe("Night mode remained light after requesting dark.");
    expect(themeBaselines.get(androidEmulator.deviceId)).toBe("dark");
  });

  test("reset cannot restore another device's recorded baseline", async () => {
    const { client, config, themeBaselines } = setup();
    themeBaselines.set("another-device", "light");
    expect((await config().setConfig({ reset: true })).success).toBe(true);
    expect(themeBaselines.get("another-device")).toBe("light");
    expect(client.getCommandCalls().some((call) => call.command.startsWith(`${NIGHT_GET} `))).toBe(
      false,
    );
  });

  test.each(["font scale", "density", "night mode"])("read failures name %s", async (setting) => {
    const { client, config } = setup();
    const command =
      setting === "font scale" ? FONT_GET : setting === "density" ? DENSITY_GET : NIGHT_GET;
    client.setCommandError(command, new Error("device offline"));
    const result = await config().setConfig({ reset: true });
    expect(result.success).toBe(false);
    expect(result.error).toContain(setting);
  });

  test.each([
    { theme: "light" as const, raw: captured("night-mode-no"), arg: "no" },
    { theme: "dark" as const, raw: captured("night-mode-yes"), arg: "yes" },
    { theme: "system" as const, raw: "Night mode: auto\n", arg: "auto" },
    { theme: "custom" as const, raw: "Night mode: custom\n", arg: "custom" },
  ])("reset restores the recorded $theme baseline exactly", async ({ theme, raw, arg }) => {
    const { client, config, themeBaselines } = setup();
    themeBaselines.set(androidEmulator.deviceId, theme);
    client.setCommandResult(NIGHT_GET, raw);
    const result = await config().setConfig({ reset: true });
    expect(result.success).toBe(true);
    expect(result.applied?.theme).toBe(theme);
    expect(client.getCommandCalls().map((call) => call.command)).toContain(`${NIGHT_GET} ${arg}`);
    expect(themeBaselines.has(androidEmulator.deviceId)).toBe(false);
  });

  test("a structured read failure retains its setting context", async () => {
    const { client, config } = setup();
    client.setCommandError(FONT_GET, new ActionableError("device offline"));
    const result = await config().setConfig({ reset: true });
    expect(result.success).toBe(false);
    expect(result.error).toContain("font scale");
    expect(result.message).toBe(result.error);
  });

  test("a rejected first theme write keeps the pre-change baseline for reset", async () => {
    const { client, config, themeBaselines } = setup();
    client.setCommandError(`${NIGHT_GET} no`, new Error("device offline"));
    expect((await config().setConfig({ theme: "light" })).success).toBe(false);
    expect(themeBaselines.get(androidEmulator.deviceId)).toBe("dark");
    expect((await config().setConfig({ reset: true })).success).toBe(true);
    expect(themeBaselines.has(androidEmulator.deviceId)).toBe(false);
  });
});
