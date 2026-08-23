import { afterEach, describe, expect, test } from "bun:test";
import { PlatformDeviceManagerFactory } from "../../src/utils/factories/PlatformDeviceManagerFactory";
import { FakeDeviceManager } from "../fakes/FakeDeviceManager";
import { BootedDevice, LocalizationSettingsResult } from "../../src/models";
import {
  getLocalizationResource,
  registerLocalizationResources,
  type LocalizationSettingsProvider,
} from "../../src/server/localizationResources";
import { ResourceRegistry } from "../../src/server/resourceRegistry";

function makeDevice(overrides: Partial<BootedDevice> = {}): BootedDevice {
  return {
    deviceId: "emulator-5554",
    name: "Pixel 8",
    platform: "android",
    ...overrides,
  } as BootedDevice;
}

function makeSettings(
  overrides: Partial<LocalizationSettingsResult> = {},
): LocalizationSettingsResult {
  return {
    success: true,
    locale: "en-US",
    timeZone: "America/Los_Angeles",
    textDirection: "ltr",
    timeFormat: "12",
    calendarSystem: "gregorian",
    ...overrides,
  };
}

class FakeLocalizationSettingsProvider implements LocalizationSettingsProvider {
  constructor(private readonly result: LocalizationSettingsResult) {}

  async getLocalizationSettings(): Promise<LocalizationSettingsResult> {
    return this.result;
  }
}

describe("localizationResources", () => {
  afterEach(() => {
    PlatformDeviceManagerFactory.reset();
  });

  describe("getLocalizationResource", () => {
    test("returns localization settings for a booted device", async () => {
      const device = makeDevice();
      const fakeManager = new FakeDeviceManager([], [device]);
      PlatformDeviceManagerFactory.setInstance(fakeManager);

      const content = await getLocalizationResource(
        device.deviceId,
        () => new FakeLocalizationSettingsProvider(makeSettings()),
      );

      const parsed = JSON.parse(content.text ?? "{}");
      expect(parsed.deviceId).toBe(device.deviceId);
      expect(parsed.locale).toBe("en-US");
      expect(parsed.timeZone).toBe("America/Los_Angeles");
      expect(parsed.textDirection).toBe("ltr");
      expect(parsed.success).toBe(true);
    });

    test("returns an error payload when the device is not booted", async () => {
      PlatformDeviceManagerFactory.setInstance(new FakeDeviceManager([], []));

      const content = await getLocalizationResource(
        "not-a-real-device",
        () => new FakeLocalizationSettingsProvider(makeSettings()),
      );

      const parsed = JSON.parse(content.text ?? "{}");
      expect(parsed.error).toContain("not-a-real-device");
    });

    test("surfaces a failed settings read", async () => {
      const device = makeDevice();
      PlatformDeviceManagerFactory.setInstance(new FakeDeviceManager([], [device]));

      const content = await getLocalizationResource(
        device.deviceId,
        () =>
          new FakeLocalizationSettingsProvider(
            makeSettings({ success: false, error: "adb shell failed", locale: null }),
          ),
      );

      const parsed = JSON.parse(content.text ?? "{}");
      expect(parsed.success).toBe(false);
      expect(parsed.error).toBe("adb shell failed");
      expect(parsed.locale).toBeNull();
    });
  });

  describe("resource registration", () => {
    afterEach(() => {
      ResourceRegistry.clearResources();
    });

    test("registers the device localization template", () => {
      registerLocalizationResources();

      const templates = ResourceRegistry.getAllTemplates();
      const template = templates.find(
        (t) => t.uriTemplate === "automobile:devices/{deviceId}/localization",
      );
      expect(template).toBeDefined();
    });
  });
});
