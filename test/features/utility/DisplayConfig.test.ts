import { describe, expect, test } from "bun:test";
import type { BootedDevice, ExecResult } from "../../../src/models";
import {
  DisplayConfig,
  parseFontScale,
  parseNightMode,
  parseWmDensity,
} from "../../../src/features/utility/DisplayConfig";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { FakeProcessExecutor } from "../../fakes/FakeProcessExecutor";

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

function execResult(stdout: string, stderr = ""): ExecResult {
  return {
    stdout,
    stderr,
    toString: () => stdout,
    trim: () => stdout.trim(),
    includes: (s: string) => stdout.includes(s),
  };
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
    expect(parseFontScale("")).toBe(1.0);
    expect(parseFontScale("garbage")).toBeUndefined();
  });

  test("parseWmDensity prefers override over physical", () => {
    expect(parseWmDensity("Physical density: 440\nOverride density: 480\n")).toMatchObject({
      physical: 440,
      effective: 480,
    });
    expect(parseWmDensity("Physical density: 440\n")).toMatchObject({
      physical: 440,
      effective: 440,
    });
    expect(parseWmDensity("nonsense").effective).toBeUndefined();
  });

  test("parseNightMode maps yes/no/auto to theme", () => {
    expect(parseNightMode("Night mode: yes\n")).toBe("dark");
    expect(parseNightMode("Night mode: no\n")).toBe("light");
    expect(parseNightMode("Night mode: auto\n")).toBe("system");
    expect(parseNightMode("Night mode: bogus\n")).toBeUndefined();
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

describe("DisplayConfig platform gating", () => {
  test("reports physical iOS as fully unsupported for reads without issuing commands", async () => {
    const processExecutor = new FakeProcessExecutor();
    const result = await new DisplayConfig(iosPhysical, { processExecutor }).getConfig();

    expect(result.success).toBe(false);
    expect(result.platform).toBe("ios");
    expect(result.supported).toEqual({ fontScale: false, density: false, theme: false });
    expect(result.error).toContain("iOS");
    expect(processExecutor.getExecutedCommands()).toEqual([]);
  });

  test("reports physical iOS as fully unsupported for writes without issuing commands", async () => {
    const processExecutor = new FakeProcessExecutor();
    const result = await new DisplayConfig(iosPhysical, { processExecutor }).setConfig({
      fontScale: 2.0,
    });

    expect(result.success).toBe(false);
    expect(result.platform).toBe("ios");
    expect(result.error).toContain("iOS");
    expect(processExecutor.getExecutedCommands()).toEqual([]);
  });
});

describe("DisplayConfig iOS Simulator theme support", () => {
  test("reports theme (only) as supported on an iOS Simulator", async () => {
    const processExecutor = new FakeProcessExecutor();
    const result = await new DisplayConfig(iosSimulator, { processExecutor }).getConfig();

    expect(result.supported).toEqual({ fontScale: false, density: false, theme: true });
  });

  test("reads the current appearance via simctl ui appearance", async () => {
    const processExecutor = new FakeProcessExecutor();
    processExecutor.setCommandResponse(
      `ui ${iosSimulator.deviceId} appearance`,
      execResult("dark\n"),
    );

    const result = await new DisplayConfig(iosSimulator, { processExecutor }).getConfig();

    expect(result.success).toBe(true);
    expect(result.current).toEqual({ theme: "dark" });
  });

  test("sets the appearance via simctl ui appearance <value>", async () => {
    const processExecutor = new FakeProcessExecutor();
    processExecutor.setCommandResponse(
      `ui ${iosSimulator.deviceId} appearance`,
      execResult("light\n"),
    );

    const result = await new DisplayConfig(iosSimulator, { processExecutor }).setConfig({
      theme: "dark",
    });

    expect(result.success).toBe(true);
    expect(result.previous).toEqual({ theme: "light" });
    expect(
      processExecutor.wasCommandExecuted(
        `xcrun simctl ui ${iosSimulator.deviceId} appearance dark`,
      ),
    ).toBe(true);
  });

  test("reset restores light appearance", async () => {
    const processExecutor = new FakeProcessExecutor();
    processExecutor.setCommandResponse(
      `ui ${iosSimulator.deviceId} appearance`,
      execResult("dark\n"),
    );

    const result = await new DisplayConfig(iosSimulator, { processExecutor }).setConfig({
      reset: true,
    });

    expect(result.success).toBe(true);
    expect(
      processExecutor.wasCommandExecuted(
        `xcrun simctl ui ${iosSimulator.deviceId} appearance light`,
      ),
    ).toBe(true);
  });

  test("rejects theme 'system' as an honest per-field refusal, issuing no command", async () => {
    const processExecutor = new FakeProcessExecutor();
    processExecutor.setCommandResponse(
      `ui ${iosSimulator.deviceId} appearance`,
      execResult("light\n"),
    );

    const result = await new DisplayConfig(iosSimulator, { processExecutor }).setConfig({
      theme: "system",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("'system'");
    expect(processExecutor.wasCommandExecuted("appearance system")).toBe(false);
  });

  test("rejects fontScale on the iOS Simulator without issuing a simctl appearance write", async () => {
    const processExecutor = new FakeProcessExecutor();

    const result = await new DisplayConfig(iosSimulator, { processExecutor }).setConfig({
      fontScale: 1.3,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("fontScale");
    expect(processExecutor.getExecutedCommands().some((c) => c.includes("appearance "))).toBe(
      false,
    );
  });

  test("rejects density on the iOS Simulator", async () => {
    const processExecutor = new FakeProcessExecutor();

    const result = await new DisplayConfig(iosSimulator, { processExecutor }).setConfig({
      density: 480,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("density");
  });
});
