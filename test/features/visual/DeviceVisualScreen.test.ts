import { describe, expect, test } from "bun:test";
import {
  readVisualDeviceProfile,
  systemBarRects,
} from "../../../src/features/visual/DeviceVisualScreen";
import type { BootedDevice } from "../../../src/models";
import type { DisplayConfigResult } from "../../../src/features/utility/DisplayConfig";
import { FakeImageBackend } from "../../fakes/FakeImageBackend";

const ANDROID: BootedDevice = { name: "Pixel", platform: "android", deviceId: "emulator-5554" };

describe("systemBarRects (#14083)", () => {
  test("prefers the visible system-bar insets and drops empty edges", () => {
    expect(
      systemBarRects(
        {
          insets: {
            available: true,
            source: "android-window-metrics",
            units: "physical-pixels",
            systemBars: {
              visible: { top: 50, right: 0, bottom: 100, left: 0 },
              stable: { top: 60, right: 0, bottom: 120, left: 0 },
            },
          },
          systemInsets: { top: 1, right: 1, bottom: 1, left: 1 },
        },
        { width: 1080, height: 2400 },
      ),
    ).toEqual([
      { left: 0, top: 0, right: 1080, bottom: 50 },
      { left: 0, top: 2300, right: 1080, bottom: 2400 },
    ]);
  });

  test("falls back to the legacy systemInsets, or nothing", () => {
    expect(
      systemBarRects(
        { systemInsets: { top: 0, right: 0, bottom: 0, left: 30 } },
        { width: 100, height: 200 },
      ),
    ).toEqual([{ left: 0, top: 0, right: 30, bottom: 200 }]);
    expect(systemBarRects({}, { width: 100, height: 200 })).toEqual([]);
  });
});

describe("readVisualDeviceProfile", () => {
  const settings = (current: DisplayConfigResult["current"]) => async () => ({
    success: true,
    deviceId: ANDROID.deviceId,
    platform: "android" as const,
    supported: { fontScale: true, density: true, theme: true },
    current,
  });
  const screen = {
    png: Buffer.from("png"),
    geometry: { platform: "android" as const, screenSize: { width: 1080, height: 2400 } },
    systemBars: [],
    resolveElement: () => ({ left: 0, top: 0, right: 1, bottom: 1 }),
    hierarchy: { density: 420 },
  };
  const backend = new FakeImageBackend();
  backend.setMetadataResult({ width: 1080, height: 2400, format: "png", size: 3 });

  test("records screenshot size, density, font scale and theme", async () => {
    expect(
      await readVisualDeviceProfile(
        ANDROID,
        screen,
        backend,
        settings({ fontScale: 1.3, theme: "dark" }),
      ),
    ).toEqual({
      platform: "android",
      width: 1080,
      height: 2400,
      density: 420,
      fontScale: 1.3,
      theme: "dark",
    });
  });

  test("a default font scale is 1 and unreadable settings are null", async () => {
    expect(
      await readVisualDeviceProfile(ANDROID, screen, backend, settings({ fontScale: "default" })),
    ).toMatchObject({ fontScale: 1, theme: null });
    expect(
      await readVisualDeviceProfile(
        ANDROID,
        { ...screen, hierarchy: {} },
        backend,
        settings(undefined),
      ),
    ).toMatchObject({ density: null, fontScale: null, theme: null });
  });
});
