import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  invalidateInstalledAppsCache,
  queryInstalledApps,
  setListInstalledAppsFactoryForTests,
} from "../../src/server/appResources";
import { PlatformDeviceManagerFactory } from "../../src/utils/factories/PlatformDeviceManagerFactory";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import type { BootedDevice } from "../../src/models";

const device: BootedDevice = {
  deviceId: "emulator-5554",
  name: "Pixel 8",
  platform: "android",
};

describe("queryInstalledApps honest-failure contract (#6155)", () => {
  let fakeDeviceUtils: FakeDeviceUtils;

  beforeEach(() => {
    fakeDeviceUtils = new FakeDeviceUtils();
    fakeDeviceUtils.setBootedDevices("android", [device]);
    fakeDeviceUtils.setBootedDevices("ios", []);
    PlatformDeviceManagerFactory.setInstance(fakeDeviceUtils);
  });

  afterEach(() => {
    setListInstalledAppsFactoryForTests(null);
    PlatformDeviceManagerFactory.setInstance(null);
    invalidateInstalledAppsCache(device.deviceId);
  });

  test("a failed listing command (successful:false) rejects instead of reporting an empty success", async () => {
    setListInstalledAppsFactoryForTests(() => ({
      executeDetailedResult: async () => ({
        apps: { profiles: {}, system: [] },
        successful: false,
      }),
      executeIosDetailedResult: async () => {
        throw new Error("not exercised on android");
      },
    }));

    await expect(queryInstalledApps({ deviceId: device.deviceId })).rejects.toThrow(
      `Failed to list installed apps for device ${device.deviceId}`,
    );
  });

  test("a successful listing with zero apps installed is reported as success, not an error", async () => {
    setListInstalledAppsFactoryForTests(() => ({
      executeDetailedResult: async () => ({
        apps: { profiles: {}, system: [] },
        successful: true,
      }),
      executeIosDetailedResult: async () => {
        throw new Error("not exercised on android");
      },
    }));

    const content = await queryInstalledApps({ deviceId: device.deviceId });
    expect(content.observationComplete).toBe(true);
    expect(content.totalCount).toBe(0);
  });

  test("uses the device resolved for the query instead of rediscovering it on an uncached call", async () => {
    setListInstalledAppsFactoryForTests(() => ({
      executeDetailedResult: async () => ({
        apps: { profiles: {}, system: [] },
        successful: true,
      }),
      executeIosDetailedResult: async () => {
        throw new Error("not exercised on android");
      },
    }));

    await queryInstalledApps({ deviceId: device.deviceId });

    const discoveryCalls = fakeDeviceUtils
      .getExecutedOperations()
      .filter((operation) => operation === "getBootedDevices:android");
    expect(discoveryCalls).toHaveLength(1);
  });

  test("forwards cancellation to Android catalog enrichment", async () => {
    const controller = new AbortController();
    let capturedSignal: AbortSignal | undefined;
    setListInstalledAppsFactoryForTests(() => ({
      executeDetailedResult: async (signal) => {
        capturedSignal = signal;
        controller.abort();
        signal?.throwIfAborted();
        return { apps: { profiles: {}, system: [] }, successful: true };
      },
      executeIosDetailedResult: async () => {
        throw new Error("not exercised on android");
      },
    }));

    await expect(
      queryInstalledApps({ deviceId: device.deviceId }, controller.signal),
    ).rejects.toThrow(/abort/i);
    expect(capturedSignal).toBe(controller.signal);
  });

  test("forwards cancellation to initial device discovery", async () => {
    fakeDeviceUtils.getBootedDevicesDetailed = async (_platform, options) => {
      const signal = options?.signal;
      return new Promise<never>((_, reject) => {
        if (!signal) {
          reject(new Error("expected an abort signal"));
          return;
        }
        signal.throwIfAborted();
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    };

    const controller = new AbortController();
    const promise = queryInstalledApps({ deviceId: device.deviceId }, controller.signal);
    controller.abort();

    await expect(promise).rejects.toThrow(/abort/i);
  });
});

describe("queryInstalledApps rejects an unsupported type filter on a physical iOS device (#6216 review, round 5)", () => {
  // A physical-device UDID (8 hex + '-' + 16 hex) so isIosPhysicalUdid routes
  // through the devicectl path, which reports no ApplicationType-equivalent
  // field — see isIosApplicationTypeUnclassified.
  const physicalIosDevice: BootedDevice = {
    deviceId: "00008130-001C2D3E1234567A",
    name: "Jason's iPhone",
    platform: "ios",
  };

  beforeEach(() => {
    const fakeDeviceUtils = new FakeDeviceUtils();
    fakeDeviceUtils.setBootedDevices("android", []);
    fakeDeviceUtils.setBootedDevices("ios", [physicalIosDevice]);
    PlatformDeviceManagerFactory.setInstance(fakeDeviceUtils);
    setListInstalledAppsFactoryForTests(() => ({
      executeDetailedResult: async () => {
        throw new Error("not exercised on iOS");
      },
      executeIosDetailedResult: async () => ({
        apps: [
          { bundleIdentifier: "com.example.myapp", name: "My App" },
          { bundleIdentifier: "com.apple.mobilesafari", name: "Safari" },
        ],
        successful: true,
      }),
    }));
  });

  afterEach(() => {
    setListInstalledAppsFactoryForTests(null);
    PlatformDeviceManagerFactory.setInstance(null);
    invalidateInstalledAppsCache(physicalIosDevice.deviceId);
  });

  test("an explicit type=system is rejected rather than silently returning an empty result", async () => {
    await expect(
      queryInstalledApps({ deviceId: physicalIosDevice.deviceId, type: "system" }),
    ).rejects.toThrow(/classification is not available on this transport/);
  });

  test("an explicit type=user is also rejected (classification, not just 'system', is unreliable)", async () => {
    await expect(
      queryInstalledApps({ deviceId: physicalIosDevice.deviceId, type: "user" }),
    ).rejects.toThrow(/classification is not available on this transport/);
  });

  test("type=all still returns every app (no rejection)", async () => {
    const content = await queryInstalledApps({
      deviceId: physicalIosDevice.deviceId,
      type: "all",
    });
    expect(content.totalCount).toBe(2);
  });

  test("an omitted type filter also still returns every app (no rejection)", async () => {
    // Every unclassified physical-device app already defaults to "user"
    // (round 4), so the documented "user" default is a no-op filter here —
    // over-inclusive, not misleadingly empty — and must not be rejected.
    const content = await queryInstalledApps({ deviceId: physicalIosDevice.deviceId });
    expect(content.totalCount).toBe(2);
  });

  test('an omitted type filter reports query.type as "all", not the misleading "user" default (#6216 review, round 6)', async () => {
    // devicectl's --include-all-apps listing (DeviceAppManager) already
    // includes system records, and every unclassified app defaults to type
    // "user" (round 4) — so applying the normal "user" default filter here
    // would let system apps straight through while the response still
    // claimed `query.type: "user"`. That is the over-inclusive-but-mislabeled
    // result Codex flagged: report the effective type honestly as "all".
    const content = await queryInstalledApps({ deviceId: physicalIosDevice.deviceId });
    expect(content.query.type).toBe("all");
    expect(content.totalCount).toBe(2);
  });
});

describe("queryInstalledApps still honors type filters on the iOS simulator (#6216 review, round 5)", () => {
  // A simulator UDID (standard 8-4-4-4-12 UUID) so isIosPhysicalUdid is false
  // and simctl's ApplicationType classification is trusted normally.
  const simulatorDevice: BootedDevice = {
    deviceId: "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE",
    name: "iPhone 15 Simulator",
    platform: "ios",
  };

  beforeEach(() => {
    const fakeDeviceUtils = new FakeDeviceUtils();
    fakeDeviceUtils.setBootedDevices("android", []);
    fakeDeviceUtils.setBootedDevices("ios", [simulatorDevice]);
    PlatformDeviceManagerFactory.setInstance(fakeDeviceUtils);
    setListInstalledAppsFactoryForTests(() => ({
      executeDetailedResult: async () => {
        throw new Error("not exercised on iOS");
      },
      executeIosDetailedResult: async () => ({
        apps: [
          { bundleIdentifier: "com.example.myapp", ApplicationType: "User" },
          { bundleIdentifier: "com.apple.mobilesafari", ApplicationType: "System" },
        ],
        successful: true,
      }),
    }));
  });

  afterEach(() => {
    setListInstalledAppsFactoryForTests(null);
    PlatformDeviceManagerFactory.setInstance(null);
    invalidateInstalledAppsCache(simulatorDevice.deviceId);
  });

  test("an explicit type=system is honored, not rejected, when classification is reliable", async () => {
    const content = await queryInstalledApps({
      deviceId: simulatorDevice.deviceId,
      type: "system",
    });
    expect(content.totalCount).toBe(1);
  });

  test("an explicit type=launchable reports missing simctl classification", async () => {
    setListInstalledAppsFactoryForTests(() => ({
      executeDetailedResult: async () => {
        throw new Error("not exercised on iOS");
      },
      executeIosDetailedResult: async () => ({
        apps: [
          { bundleIdentifier: "com.example.myapp" },
          { bundleIdentifier: "com.apple.mobilesafari" },
        ],
        successful: true,
      }),
    }));

    const promise = queryInstalledApps({
      deviceId: simulatorDevice.deviceId,
      type: "launchable",
    });

    await expect(promise).rejects.toThrow(/ApplicationType.*simctl/is);
    await promise.catch((error: Error) => {
      expect(error.message).not.toMatch(/CtrlProxy/i);
      expect(error.message).not.toMatch(/cmd package/i);
    });
  });

  test('an omitted type filter reports and applies the documented "launchable" default (#6798)', async () => {
    // Control case: reliable classification (simulator ApplicationType) keeps
    // reporting the effective type honestly — only the physical-device,
    // unreliable-classification case reports "all". Since #6798 the default is
    // "launchable", which on the simulator selects both the User app and the
    // System app (Safari launches; only "Hidden" bundles do not).
    const content = await queryInstalledApps({ deviceId: simulatorDevice.deviceId });
    expect(content.query.type).toBe("launchable");
    expect(content.totalCount).toBe(2);
  });

  test("a Hidden simulator bundle is excluded by the launchable default (#6798)", async () => {
    setListInstalledAppsFactoryForTests(() => ({
      executeDetailedResult: async () => {
        throw new Error("not exercised on iOS");
      },
      executeIosDetailedResult: async () => ({
        apps: [
          { bundleIdentifier: "com.example.myapp", ApplicationType: "User" },
          { bundleIdentifier: "com.apple.springboard", ApplicationType: "Hidden" },
        ],
        successful: true,
      }),
    }));
    invalidateInstalledAppsCache(simulatorDevice.deviceId);

    const content = await queryInstalledApps({ deviceId: simulatorDevice.deviceId });
    expect(content.devices[0].apps.map((app) => app.packageName)).toEqual(["com.example.myapp"]);
    expect(content.installedCount).toBe(2);
  });

  test("a System simulator bundle with a hidden SpringBoard tag is excluded by the launchable default", async () => {
    setListInstalledAppsFactoryForTests(() => ({
      executeDetailedResult: async () => {
        throw new Error("not exercised on iOS");
      },
      executeIosDetailedResult: async () => ({
        apps: [
          { bundleIdentifier: "com.example.myapp", ApplicationType: "User" },
          {
            bundleIdentifier: "com.apple.some.hidden.agent",
            ApplicationType: "System",
            SBAppTags: ["hidden"],
          },
        ],
        successful: true,
      }),
    }));
    invalidateInstalledAppsCache(simulatorDevice.deviceId);

    const content = await queryInstalledApps({ deviceId: simulatorDevice.deviceId });

    expect(content.devices[0].apps.map((app) => app.packageName)).toEqual(["com.example.myapp"]);
  });

  test("reports an individually unclassified simulator app excluded by the launchable default", async () => {
    setListInstalledAppsFactoryForTests(() => ({
      executeDetailedResult: async () => {
        throw new Error("not exercised on iOS");
      },
      executeIosDetailedResult: async () => ({
        apps: [
          { bundleIdentifier: "com.example.launchable", ApplicationType: "User" },
          { bundleIdentifier: "com.apple.mobilesafari", ApplicationType: "System" },
          { bundleIdentifier: "com.example.incomplete" },
        ],
        successful: true,
      }),
    }));
    invalidateInstalledAppsCache(simulatorDevice.deviceId);

    const content = await queryInstalledApps({ deviceId: simulatorDevice.deviceId });

    expect(content.query.type).toBe("launchable");
    expect(content.devices[0].apps.map((app) => app.packageName)).toEqual([
      "com.example.launchable",
      "com.apple.mobilesafari",
    ]);
    expect(content.launchabilityUnknownApps).toEqual(["com.example.incomplete"]);
  });

  test("does not report individually unknown launchability when type is all", async () => {
    setListInstalledAppsFactoryForTests(() => ({
      executeDetailedResult: async () => {
        throw new Error("not exercised on iOS");
      },
      executeIosDetailedResult: async () => ({
        apps: [
          { bundleIdentifier: "com.example.launchable", ApplicationType: "User" },
          { bundleIdentifier: "com.example.incomplete" },
        ],
        successful: true,
      }),
    }));
    invalidateInstalledAppsCache(simulatorDevice.deviceId);

    const content = await queryInstalledApps({ deviceId: simulatorDevice.deviceId, type: "all" });

    expect(content.launchabilityUnknownApps).toBeUndefined();
  });
});

describe("queryInstalledApps launchable default on Android (#6798)", () => {
  const androidDevice: BootedDevice = {
    deviceId: "emulator-5558",
    name: "Pixel 6 API 31",
    platform: "android",
  };

  beforeEach(() => {
    const fakeDeviceUtils = new FakeDeviceUtils();
    fakeDeviceUtils.setBootedDevices("android", [androidDevice]);
    fakeDeviceUtils.setBootedDevices("ios", []);
    PlatformDeviceManagerFactory.setInstance(fakeDeviceUtils);
  });

  afterEach(() => {
    setListInstalledAppsFactoryForTests(null);
    PlatformDeviceManagerFactory.setInstance(null);
    invalidateInstalledAppsCache(androidDevice.deviceId);
  });

  function setAndroidApps(
    system: Array<Record<string, unknown>>,
    user: Array<Record<string, unknown>>,
  ) {
    setListInstalledAppsFactoryForTests(() => ({
      executeDetailedResult: async () => ({
        apps: {
          profiles: {
            0: user.map((app) => ({
              userId: 0,
              profileType: "primary" as const,
              foreground: false,
              recent: false,
              ...app,
            })),
          },
          system: system.map((app) => ({
            userIds: [0],
            foreground: false,
            recent: false,
            ...app,
          })),
        } as never,
        successful: true,
      }),
      executeIosDetailedResult: async () => {
        throw new Error("not exercised on android");
      },
    }));
  }

  test("the dogfood case: Contacts is returned by default and carries its label", async () => {
    setAndroidApps(
      [
        { packageName: "com.android.contacts", label: "Contacts", launchable: true },
        {
          packageName: "com.android.providers.contacts",
          label: "Contacts Storage",
          launchable: false,
        },
      ],
      [{ packageName: "com.example.myapp", label: "My App", launchable: true }],
    );

    const content = await queryInstalledApps({ deviceId: androidDevice.deviceId });

    expect(content.query.type).toBe("launchable");
    expect(content.devices[0].apps.map((app) => app.packageName)).toEqual([
      "com.example.myapp",
      "com.android.contacts",
    ]);
    const contacts = content.devices[0].apps.find(
      (app) => app.packageName === "com.android.contacts",
    );
    expect(contacts?.label).toBe("Contacts");
    expect(contacts?.type).toBe("system");
    expect(content.installedCount).toBe(3);
  });

  test("searching by the human name resolves the package in one call", async () => {
    setAndroidApps(
      [{ packageName: "com.google.android.deskclock", label: "Clock", launchable: true }],
      [],
    );

    const content = await queryInstalledApps({ deviceId: androidDevice.deviceId, search: "clock" });

    expect(content.devices[0].apps.map((app) => app.packageName)).toEqual([
      "com.google.android.deskclock",
    ]);
  });

  test("a device with no launchability signal degrades to the user default rather than reporting nothing", async () => {
    setAndroidApps(
      [{ packageName: "com.android.contacts" }],
      [{ packageName: "com.example.myapp" }],
    );

    const content = await queryInstalledApps({ deviceId: androidDevice.deviceId });

    expect(content.query.type).toBe("user");
    expect(content.devices[0].apps.map((app) => app.packageName)).toEqual(["com.example.myapp"]);
  });

  test("an explicit type=launchable is rejected when launchability is unknown", async () => {
    setAndroidApps(
      [{ packageName: "com.android.contacts" }],
      [{ packageName: "com.example.myapp" }],
    );

    await expect(
      queryInstalledApps({ deviceId: androidDevice.deviceId, type: "launchable" }),
    ).rejects.toThrow(/no launchability signal/);
  });
});

describe("queryInstalledApps per-profile launchability (#6798 review)", () => {
  const androidDevice: BootedDevice = {
    deviceId: "emulator-5560",
    name: "Pixel 6 API 33",
    platform: "android",
  };

  beforeEach(() => {
    const fakeDeviceUtils = new FakeDeviceUtils();
    fakeDeviceUtils.setBootedDevices("android", [androidDevice]);
    fakeDeviceUtils.setBootedDevices("ios", []);
    PlatformDeviceManagerFactory.setInstance(fakeDeviceUtils);
  });

  afterEach(() => {
    setListInstalledAppsFactoryForTests(null);
    PlatformDeviceManagerFactory.setInstance(null);
    invalidateInstalledAppsCache(androidDevice.deviceId);
  });

  /**
   * User 0's launcher probe answered; the work profile's did not, so its apps
   * carry no launchability at all.
   */
  function setPartiallyProbedProfiles() {
    setListInstalledAppsFactoryForTests(() => ({
      executeDetailedResult: async () => ({
        apps: {
          profiles: {
            0: [
              {
                packageName: "com.example.myapp",
                userId: 0,
                profileType: "primary" as const,
                foreground: false,
                recent: false,
                label: "My App",
                launchable: true,
              },
            ],
            10: [
              {
                packageName: "com.example.work",
                userId: 10,
                profileType: "managed" as const,
                foreground: false,
                recent: false,
              },
            ],
          },
          system: [],
        } as never,
        successful: true,
      }),
      executeIosDetailedResult: async () => {
        throw new Error("not exercised on android");
      },
    }));
  }

  test("an explicit type=launchable is rejected for a profile with no launchability signal", async () => {
    setPartiallyProbedProfiles();

    await expect(
      queryInstalledApps({ deviceId: androidDevice.deviceId, type: "launchable", profile: 10 }),
    ).rejects.toThrow(/no launchability signal/);
  });

  test("a probed profile still answers an explicit type=launchable", async () => {
    setPartiallyProbedProfiles();

    const content = await queryInstalledApps({
      deviceId: androidDevice.deviceId,
      type: "launchable",
      profile: 0,
    });

    expect(content.devices[0].apps.map((app) => app.packageName)).toEqual(["com.example.myapp"]);
  });

  test("an omitted type degrades to user for an unprobed profile rather than emptying it", async () => {
    setPartiallyProbedProfiles();

    const content = await queryInstalledApps({ deviceId: androidDevice.deviceId, profile: 10 });

    expect(content.query.type).toBe("user");
    expect(content.devices[0].apps.map((app) => app.packageName)).toEqual(["com.example.work"]);
  });

  test("a profile-less query names the profiles whose launchability is unknown", async () => {
    setPartiallyProbedProfiles();

    const content = await queryInstalledApps({ deviceId: androidDevice.deviceId });

    // The launchable default still applies device-wide, but the profiles it
    // could not judge are reported instead of being silently dropped.
    expect(content.query.type).toBe("launchable");
    expect(content.launchabilityUnknownProfiles).toEqual([10]);
    expect(content.devices[0].apps.map((app) => app.packageName)).toEqual(["com.example.myapp"]);
  });

  test("a fully probed device reports no unknown profiles", async () => {
    setListInstalledAppsFactoryForTests(() => ({
      executeDetailedResult: async () => ({
        apps: {
          profiles: {
            0: [
              {
                packageName: "com.example.myapp",
                userId: 0,
                profileType: "primary" as const,
                foreground: false,
                recent: false,
                launchable: true,
              },
            ],
          },
          system: [],
        } as never,
        successful: true,
      }),
      executeIosDetailedResult: async () => {
        throw new Error("not exercised on android");
      },
    }));

    const content = await queryInstalledApps({ deviceId: androidDevice.deviceId });

    expect(content.launchabilityUnknownProfiles).toBeUndefined();
  });
});
