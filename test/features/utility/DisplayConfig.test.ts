import { describe, expect, test } from "bun:test";
import type { BootedDevice } from "../../../src/models";
import {
  DisplayConfig,
  parseFontScale,
  parseNightMode,
  parseWmDensity,
} from "../../../src/features/utility/DisplayConfig";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { FakeSimCtlClient } from "../../fakes/FakeSimCtlClient";

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
    expect(parseFontScale("")).toBe(1.0);
    expect(parseFontScale("garbage")).toBeUndefined();
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
  test("reads font scale, effective density, and theme", async () => {
    const adbFactory = new FakeAdbClientFactory();
    seedReads(adbFactory, {
      fontScale: "1.15\n",
      density: "Physical density: 440\nOverride density: 480\n",
      night: "Night mode: yes\n",
    });

    const result = await new DisplayConfig(androidEmulator, { adbFactory }).getConfig();

    expect(result.success).toBe(true);
    expect(result.current).toEqual({ fontScale: 1.15, density: 480, theme: "dark" });
    expect(result.supported).toEqual({ fontScale: true, density: true, theme: true });
    expect(result.previous).toBeUndefined();
    expect(result.applied).toBeUndefined();
  });

  test("reports density support as partial on a physical device", async () => {
    const adbFactory = new FakeAdbClientFactory();
    seedReads(adbFactory);

    const result = await new DisplayConfig(androidPhysical, { adbFactory }).getConfig();

    expect(result.success).toBe(true);
    expect(result.supported.density).toBe("partial");
  });
});

describe("DisplayConfig setConfig", () => {
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

    const result = await new DisplayConfig(androidEmulator, { adbFactory }).setConfig({
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

    await new DisplayConfig(androidEmulator, { adbFactory }).setConfig({ density: 560 });

    const commands = adbFactory
      .getFakeClient()
      .getCommandCalls()
      .map((c) => c.command);
    expect(commands).toContain("shell wm density 560");
  });

  test("resolves a relative density bucket against physical density", async () => {
    const adbFactory = new FakeAdbClientFactory();
    seedReads(adbFactory, { density: "Physical density: 440\n" });

    await new DisplayConfig(androidEmulator, { adbFactory }).setConfig({ density: "larger" });

    const commands = adbFactory
      .getFakeClient()
      .getCommandCalls()
      .map((c) => c.command);
    // 440 * 1.15 = 506
    expect(commands).toContain("shell wm density 506");
  });

  test("resolves a relative density bucket against physical density, not a prior override", async () => {
    const adbFactory = new FakeAdbClientFactory();
    // The device already carries an override (506 = 440 * 1.15) from a previous
    // `larger` request; a second `larger` request must still scale from the
    // PHYSICAL density (440), not compound onto the effective override (#6096).
    seedReads(adbFactory, { density: "Physical density: 440\nOverride density: 506\n" });

    await new DisplayConfig(androidEmulator, { adbFactory }).setConfig({ density: "larger" });

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

    await new DisplayConfig(androidEmulator, { adbFactory }).setConfig({ theme: "dark" });

    const commands = adbFactory
      .getFakeClient()
      .getCommandCalls()
      .map((c) => c.command);
    expect(commands).toContain("shell cmd uimode night yes");
  });

  test("maps system theme to night mode auto", async () => {
    const adbFactory = new FakeAdbClientFactory();
    seedReads(adbFactory);

    await new DisplayConfig(androidEmulator, { adbFactory }).setConfig({ theme: "system" });

    const commands = adbFactory
      .getFakeClient()
      .getCommandCalls()
      .map((c) => c.command);
    expect(commands).toContain("shell cmd uimode night auto");
  });

  test("reset restores font scale, density, and theme to defaults", async () => {
    const adbFactory = new FakeAdbClientFactory();
    seedReads(adbFactory);

    const result = await new DisplayConfig(androidEmulator, { adbFactory }).setConfig({
      reset: true,
    });

    expect(result.success).toBe(true);
    const commands = adbFactory
      .getFakeClient()
      .getCommandCalls()
      .map((c) => c.command);
    expect(commands).toContain("shell settings put system font_scale 1");
    expect(commands).toContain("shell wm density reset");
    expect(commands).toContain("shell cmd uimode night no");
  });

  test("restores a custom night-mode schedule via cmd uimode night custom, not auto", async () => {
    const adbFactory = new FakeAdbClientFactory();
    seedReads(adbFactory);

    await new DisplayConfig(androidEmulator, { adbFactory }).setConfig({ theme: "custom" });

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

    const result = await new DisplayConfig(androidEmulator, { adbFactory }).setConfig({
      fontScale: 2.0,
    });

    // The device was on a custom schedule before the change; previous must
    // preserve that as "custom" (not "system") so the client can restore it.
    expect(result.previous?.theme).toBe("custom");
  });

  test("rejects reset combined with an explicit theme (contradictory request)", async () => {
    const adbFactory = new FakeAdbClientFactory();
    seedReads(adbFactory);

    const result = await new DisplayConfig(androidEmulator, { adbFactory }).setConfig({
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

    const result = await new DisplayConfig(androidEmulator, { adbFactory }).setConfig({
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

    const result = await new DisplayConfig(androidEmulator, { adbFactory }).setConfig({
      fontScale: 2.0,
    });

    expect(result.previous?.density).toBe("default");
  });

  test("replaying a captured 'default' density issues wm density reset, not a forced override", async () => {
    const adbFactory = new FakeAdbClientFactory();
    seedReads(adbFactory, { density: "Physical density: 440\n" });

    const first = await new DisplayConfig(androidEmulator, { adbFactory }).setConfig({
      fontScale: 2.0,
    });
    const restorableDensity = first.previous?.density;
    expect(restorableDensity).toBe("default");

    await new DisplayConfig(androidEmulator, { adbFactory }).setConfig({
      density: restorableDensity,
    });

    const commands = adbFactory
      .getFakeClient()
      .getCommandCalls()
      .map((c) => c.command);
    expect(commands).toContain("shell wm density reset");
    expect(commands).not.toContain("shell wm density 440");
  });

  test("still captures an overridden density as its explicit dpi number", async () => {
    const adbFactory = new FakeAdbClientFactory();
    seedReads(adbFactory, { density: "Physical density: 440\nOverride density: 480\n" });

    const result = await new DisplayConfig(androidEmulator, { adbFactory }).setConfig({
      fontScale: 2.0,
    });

    expect(result.previous?.density).toBe(480);
  });

  test("rejects an empty set request", async () => {
    const adbFactory = new FakeAdbClientFactory();
    seedReads(adbFactory);

    const result = await new DisplayConfig(androidEmulator, { adbFactory }).setConfig({});

    expect(result.success).toBe(false);
    expect(result.error).toContain("At least one");
  });

  test("surfaces a shell failure from a mutating command", async () => {
    const adbFactory = new FakeAdbClientFactory();
    seedReads(adbFactory);
    adbFactory
      .getFakeClient()
      .setCommandResult("shell wm density 560", "", "Exception: bad density");

    const result = await new DisplayConfig(androidEmulator, { adbFactory }).setConfig({
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
    const result = await new DisplayConfig(iosPhysical, { simctl }).getConfig();

    expect(result.success).toBe(false);
    expect(result.platform).toBe("ios");
    expect(result.supported).toEqual({ fontScale: false, density: false, theme: false });
    expect(result.error).toContain("iOS");
    expect(simctlArgvCalls(simctl)).toEqual([]);
  });

  test("reports physical iOS as fully unsupported for writes without issuing commands", async () => {
    const simctl = new FakeSimCtlClient();
    const result = await new DisplayConfig(iosPhysical, { simctl }).setConfig({
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
    const result = await new DisplayConfig(iosSimulator, { simctl }).getConfig();

    expect(result.supported).toEqual({ fontScale: false, density: false, theme: true });
  });

  test("reads the current appearance through the SimCtlClient seam", async () => {
    const simctl = new FakeSimCtlClient();
    simctl.setCommandArgsResult(["ui", iosSimulator.deviceId, "appearance"], "dark\n");

    const result = await new DisplayConfig(iosSimulator, { simctl }).getConfig();

    expect(result.success).toBe(true);
    expect(result.current).toEqual({ theme: "dark" });
    // The read is issued as an argv array via the seam, not a raw simctl spawn.
    expect(simctlArgvCalls(simctl)).toContainEqual(["ui", iosSimulator.deviceId, "appearance"]);
  });

  test("sets the appearance through the SimCtlClient seam", async () => {
    const simctl = new FakeSimCtlClient();
    simctl.setCommandArgsResult(["ui", iosSimulator.deviceId, "appearance"], "light\n");

    const result = await new DisplayConfig(iosSimulator, { simctl }).setConfig({
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

  test("reset restores light appearance", async () => {
    const simctl = new FakeSimCtlClient();
    simctl.setCommandArgsResult(["ui", iosSimulator.deviceId, "appearance"], "dark\n");

    const result = await new DisplayConfig(iosSimulator, { simctl }).setConfig({
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

    const result = await new DisplayConfig(iosSimulator, { simctl }).setConfig({
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

    const result = await new DisplayConfig(iosSimulator, { simctl }).setConfig({
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

    const result = await new DisplayConfig(iosSimulator, { simctl }).setConfig({
      density: 480,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("density");
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

    const result = await new DisplayConfig(iosSimulator, { simctl }).setConfig({
      theme: "dark",
    });

    expect(result.success).toBe(false);
    expect(result.previous).toEqual({ theme: "light" });
    expect(result.applied).toBeUndefined();
    expect(result.error).toContain("failed to read applied theme");
  });
});
