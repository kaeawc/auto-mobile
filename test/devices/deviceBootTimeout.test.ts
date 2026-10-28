import { describe, expect, it } from "bun:test";
import { DeviceBootService, DeviceBootTimeoutError } from "../../src/devices/deviceBootService";
import { DEFAULT_PROVISION_DEVICE_RETRYABILITY } from "../../src/devices/exactDeviceProvisioning";
import type { AndroidOrIosPlatform, DeviceInfo } from "../../src/models";
import { FakeDeviceMatcher } from "../fakes/FakeDeviceMatcher";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeTimer } from "../fakes/FakeTimer";

type BootableImage = DeviceInfo & { platform: AndroidOrIosPlatform };

const images: BootableImage[] = [
  { name: "Pixel_9_API_35", platform: "android", isRunning: false, osVersion: "35" },
  {
    name: "iPhone 16",
    platform: "ios",
    deviceId: "A1B2C3D4-0000-0000-0000-000000000001",
    isRunning: false,
    osVersion: "18.0",
  },
];

async function bootTimeout(image: BootableImage): Promise<unknown> {
  const devices = new FakeDeviceUtils();
  const matcher = new FakeDeviceMatcher();
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  devices.setDeviceImages(image.platform, [image]);
  matcher.setImageResult(image);
  devices.waitForDeviceReady = async (_device, _timeout, _handle, signal) =>
    new Promise((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  const service = new DeviceBootService({
    deviceManager: devices,
    deviceMatcher: matcher,
    deviceCreationGate: { isCreationAllowed: () => false, describeSource: () => "test" },
    deviceProvisioner: {
      provision: async () => {
        throw new Error("unexpected provision");
      },
    },
    matchingStrategy: "LATEST",
    timer,
  });
  return service
    .boot({ platform: image.platform, timeoutMs: 60_000 })
    .catch((error: unknown) => error);
}

describe("boot timeout contract", () => {
  for (const image of images) {
    it(`${image.platform}: a boot timeout names the device being booted`, async () => {
      const error = await bootTimeout(image);
      expect(error).toBeInstanceOf(DeviceBootTimeoutError);
      expect((error as Error).message).toContain(image.name);
    });

    it(`${image.platform}: a boot timeout is marked retryable like provisionDevice's`, async () => {
      const error = await bootTimeout(image);
      expect(DEFAULT_PROVISION_DEVICE_RETRYABILITY.timeout).toBe(true);
      expect((error as { retryable?: boolean }).retryable).toBe(true);
    });
  }
});
