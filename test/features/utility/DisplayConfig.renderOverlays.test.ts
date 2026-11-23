import { describe, expect, test } from "bun:test";
import type { BootedDevice } from "../../../src/models";
import { DisplayConfig } from "../../../src/features/utility/DisplayConfig";
import {
  ALL_RENDER_OVERLAYS_OFF,
  RENDER_OVERLAYS_SIMULATOR_ONLY_ERROR,
} from "../../../src/features/utility/displayRenderOverlays";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { FakeSimctl } from "../../fakes/FakeSimctl";
import { FakeSimulatorRenderOverlayControl } from "../../fakes/FakeSimulatorRenderOverlayControl";

const simulator: BootedDevice = {
  name: "iPhone 17 Pro",
  platform: "ios",
  deviceId: "12345678-1234-1234-1234-123456789ABC",
};

const physical: BootedDevice = {
  name: "iPhone",
  platform: "ios",
  deviceId: "00008130-001234567890ABCD",
};

const android: BootedDevice = { name: "Pixel", platform: "android", deviceId: "emulator-5554" };

function setup(device: BootedDevice = simulator) {
  const overlays = new FakeSimulatorRenderOverlayControl();
  const simctl = new FakeSimctl();
  simctl.setCommandArgsResult(["ui", device.deviceId, "appearance"], "light\n");
  const config = new DisplayConfig(device, {
    simctl,
    renderOverlays: overlays,
    adbFactory: new FakeAdbClientFactory(),
    themeBaselines: new Map(),
    accessibilityBaselines: new Map(),
    contentSizeBaselines: new Map(),
  });
  return { overlays, simctl, config };
}

describe("displayConfig render overlays on the iOS Simulator (#19016)", () => {
  test("turns overlays on and reports every overlay before and after", async () => {
    const { overlays, config } = setup();

    const result = await config.setConfig({
      renderOverlays: { blendedLayers: true, offscreenRendered: true },
    });

    expect(result.success).toBe(true);
    expect(result.previous?.renderOverlays).toEqual(ALL_RENDER_OVERLAYS_OFF);
    expect(result.applied?.renderOverlays).toEqual({
      ...ALL_RENDER_OVERLAYS_OFF,
      blendedLayers: true,
      offscreenRendered: true,
    });
    expect(overlays.writes).toEqual([
      { udid: simulator.deviceId, values: { blendedLayers: true, offscreenRendered: true } },
    ]);
  });

  test("reads the overlay state with the other display values", async () => {
    const { overlays, config } = setup();
    overlays.states.set(simulator.deviceId, { ...ALL_RENDER_OVERLAYS_OFF, misalignedImages: true });

    const result = await config.getConfig();

    expect(result.success).toBe(true);
    expect(result.supported.renderOverlays).toBe(true);
    expect(result.current?.renderOverlays?.misalignedImages).toBe(true);
    expect(result.current?.theme).toBe("light");
  });

  test("a read whose overlay state is unreadable fails instead of reporting success", async () => {
    const { overlays, config } = setup();
    overlays.failure = new Error("CoreSimulator unavailable");

    const result = await config.getConfig();

    expect(result.success).toBe(false);
    expect(result.error).toContain("CoreSimulator unavailable");
    expect(result.current).toBeUndefined();
  });

  test("reset turns every overlay off", async () => {
    const { overlays, config } = setup();
    overlays.states.set(simulator.deviceId, { ...ALL_RENDER_OVERLAYS_OFF, blendedLayers: true });

    const result = await config.setConfig({ reset: true });

    expect(result.success).toBe(true);
    expect(result.previous?.renderOverlays?.blendedLayers).toBe(true);
    expect(result.applied?.renderOverlays).toEqual(ALL_RENDER_OVERLAYS_OFF);
    expect(result.applied?.theme).toBe("light");
    expect(overlays.writes).toEqual([
      { udid: simulator.deviceId, values: ALL_RENDER_OVERLAYS_OFF },
    ]);
  });

  test("applies a theme and overlays in one call", async () => {
    const { overlays, simctl, config } = setup();
    simctl.setCommandArgsResultSequence(
      ["ui", simulator.deviceId, "appearance"],
      [{ stdout: "light\n" }, { stdout: "dark\n" }],
    );

    const result = await config.setConfig({ theme: "dark", renderOverlays: { cacheHits: true } });

    expect(result.success).toBe(true);
    expect(result.previous?.theme).toBe("light");
    expect(result.applied?.renderOverlays?.cacheHits).toBe(true);
    expect(overlays.writes).toHaveLength(1);
    expect(
      simctl.getMethodCalls("executeCommandArgs").map((call) => call.args as string[]),
    ).toContainEqual(["ui", simulator.deviceId, "appearance", "dark"]);
  });

  test("an overlay that does not read back as requested fails the call", async () => {
    const { overlays, config } = setup();
    overlays.stuck.add("blendedLayers");

    const result = await config.setConfig({ renderOverlays: { blendedLayers: true } });

    expect(result.success).toBe(false);
    expect(result.error).toContain("blendedLayers read back off after requesting on");
    expect(result.applied?.renderOverlays?.blendedLayers).toBe(false);
  });

  test("a failed write reports the error without values", async () => {
    const { overlays, config } = setup();
    overlays.failure = new Error("osascript failed");

    const result = await config.setConfig({ renderOverlays: { blendedLayers: true } });

    expect(result.success).toBe(false);
    expect(result.error).toContain("osascript failed");
    expect(result.applied?.renderOverlays).toBeUndefined();
  });

  test("reset cannot be combined with overlays", async () => {
    const { overlays, config } = setup();

    const result = await config.setConfig({ reset: true, renderOverlays: { blendedLayers: true } });

    expect(result.success).toBe(false);
    expect(result.error).toContain("renderOverlays");
    expect(overlays.writes).toEqual([]);
  });

  for (const [label, device] of [
    ["an Android device", android],
    ["a physical iOS device", physical],
  ] as const) {
    test(`refuses overlays on ${label} before any write`, async () => {
      const { overlays, config } = setup(device);

      const result = await config.setConfig({ renderOverlays: { blendedLayers: true } });

      expect(result.success).toBe(false);
      expect(result.error).toBe(RENDER_OVERLAYS_SIMULATOR_ONLY_ERROR);
      expect(overlays.writes).toEqual([]);
    });
  }
});
