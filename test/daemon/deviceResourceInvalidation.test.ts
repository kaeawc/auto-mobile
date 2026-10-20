import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  type DeviceResourceInvalidationHandlers,
  notifyBootedDeviceResourcesUpdated,
  registerDeviceResourceInvalidation,
  resetAndroidDeviceImageResourceCache,
  resetBootedDevicesResourceCache,
  isolateDeviceResourceInvalidationForTesting,
} from "../../src/daemon/deviceResourceInvalidation";

class FakeResourceInvalidation implements DeviceResourceInvalidationHandlers {
  bootedResets = 0;
  imageResets = 0;
  notifications = 0;

  resetBootedDevicesResourceCache = (): void => {
    this.bootedResets++;
  };
  resetAndroidDeviceImageResourceCache = (): void => {
    this.imageResets++;
  };
  notifyBootedDeviceResourcesUpdated = async (): Promise<void> => {
    this.notifications++;
  };
}

describe("device resource invalidation port", () => {
  let restoreIsolation: () => void;
  beforeEach(() => {
    restoreIsolation = isolateDeviceResourceInvalidationForTesting();
  });
  afterEach(() => restoreIsolation());

  test("defaults to no-op operations", async () => {
    expect(resetBootedDevicesResourceCache()).toBeUndefined();
    expect(resetAndroidDeviceImageResourceCache()).toBeUndefined();
    await expect(notifyBootedDeviceResourcesUpdated()).resolves.toBeUndefined();
  });

  test("separate booted and image registrations coexist and restore independently", async () => {
    const fake = new FakeResourceInvalidation();
    const restoreBooted = registerDeviceResourceInvalidation({
      resetBootedDevicesResourceCache: fake.resetBootedDevicesResourceCache,
      notifyBootedDeviceResourcesUpdated: fake.notifyBootedDeviceResourcesUpdated,
    });
    const restoreImage = registerDeviceResourceInvalidation({
      resetAndroidDeviceImageResourceCache: fake.resetAndroidDeviceImageResourceCache,
    });
    resetBootedDevicesResourceCache();
    resetAndroidDeviceImageResourceCache();
    await notifyBootedDeviceResourcesUpdated();
    expect([fake.bootedResets, fake.imageResets, fake.notifications]).toEqual([1, 1, 1]);

    restoreBooted();
    resetBootedDevicesResourceCache();
    await notifyBootedDeviceResourcesUpdated();
    resetAndroidDeviceImageResourceCache();
    expect([fake.bootedResets, fake.imageResets, fake.notifications]).toEqual([1, 2, 1]);
    restoreImage();
    resetAndroidDeviceImageResourceCache();
    expect(fake.imageResets).toBe(2);
  });

  test("replacement invokes only the latest handlers and restore reinstates the previous ones", async () => {
    const original = new FakeResourceInvalidation();
    const replacement = new FakeResourceInvalidation();
    registerDeviceResourceInvalidation(original);
    const restore = registerDeviceResourceInvalidation(replacement);
    resetBootedDevicesResourceCache();
    resetAndroidDeviceImageResourceCache();
    await notifyBootedDeviceResourcesUpdated();
    expect([original.bootedResets, original.imageResets, original.notifications]).toEqual([
      0, 0, 0,
    ]);
    expect([replacement.bootedResets, replacement.imageResets, replacement.notifications]).toEqual([
      1, 1, 1,
    ]);

    restore();
    restore();
    resetBootedDevicesResourceCache();
    resetAndroidDeviceImageResourceCache();
    await notifyBootedDeviceResourcesUpdated();
    expect([original.bootedResets, original.imageResets, original.notifications]).toEqual([
      1, 1, 1,
    ]);
    expect([replacement.bootedResets, replacement.imageResets, replacement.notifications]).toEqual([
      1, 1, 1,
    ]);
  });

  test("an older restore does not overwrite a newer registration", () => {
    const original = new FakeResourceInvalidation();
    const replacement = new FakeResourceInvalidation();
    const restore = registerDeviceResourceInvalidation(original);
    registerDeviceResourceInvalidation(replacement);
    restore();
    resetBootedDevicesResourceCache();
    expect(original.bootedResets).toBe(0);
    expect(replacement.bootedResets).toBe(1);
  });

  test("notification awaits its handler and propagates rejection", async () => {
    const notification = Promise.withResolvers<void>();
    registerDeviceResourceInvalidation({
      notifyBootedDeviceResourcesUpdated: () => notification.promise,
    });
    let completed = false;
    const pending = notifyBootedDeviceResourcesUpdated().then(() => {
      completed = true;
    });
    await Promise.resolve();
    expect(completed).toBe(false);
    notification.resolve();
    await pending;
    expect(completed).toBe(true);

    const failure = new Error("notification failed");
    registerDeviceResourceInvalidation({
      notifyBootedDeviceResourcesUpdated: async () => {
        throw failure;
      },
    });
    await expect(notifyBootedDeviceResourcesUpdated()).rejects.toBe(failure);
  });

  test("test reset clears every registered operation", async () => {
    const fake = new FakeResourceInvalidation();
    registerDeviceResourceInvalidation(fake);
    isolateDeviceResourceInvalidationForTesting();
    resetBootedDevicesResourceCache();
    resetAndroidDeviceImageResourceCache();
    await notifyBootedDeviceResourcesUpdated();
    expect([fake.bootedResets, fake.imageResets, fake.notifications]).toEqual([0, 0, 0]);
  });
});
