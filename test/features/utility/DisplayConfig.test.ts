import { describe, expect, test } from "bun:test";
import type { BootedDevice } from "../../../src/models";
import {
  DisplayConfig,
  parseFontScale,
  parseNightMode,
  parseWmDensity,
} from "../../../src/features/utility/DisplayConfig";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";

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
  test("reports iOS as unsupported for reads without issuing commands", async () => {
    const result = await new DisplayConfig(iosSimulator).getConfig();

    expect(result.success).toBe(false);
    expect(result.platform).toBe("ios");
    expect(result.supported).toEqual({ fontScale: false, density: false, theme: false });
    expect(result.error).toContain("iOS");
  });

  test("reports iOS as unsupported for writes without issuing commands", async () => {
    const result = await new DisplayConfig(iosSimulator).setConfig({ fontScale: 2.0 });

    expect(result.success).toBe(false);
    expect(result.platform).toBe("ios");
    expect(result.error).toContain("iOS");
  });
});
