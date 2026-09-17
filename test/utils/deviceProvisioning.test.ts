import { describe, it, expect, spyOn } from "bun:test";
import {
  DefaultDeviceProvisioner,
  buildCreatedDeviceName,
  isCreatedDeviceName,
  pickAndroidSystemImage,
  pickIosDeviceType,
  preferredAbis,
} from "../../src/utils/deviceProvisioning";
import { CountingIdGenerator } from "../../src/utils/IdGenerator";
import { ActionableError } from "../../src/models/ActionableError";
import type { AppleDeviceType } from "../../src/utils/ios-cmdline-tools/SimCtlClient";
import {
  parseSystemImages,
  type SystemImage,
} from "../../src/utils/android-cmdline-tools/avdmanager";
import { FakeAndroidAvdCreator, FakeIosSimulatorCreator } from "../fakes/FakeDeviceProvisioner";
import { logger } from "../../src/utils/logger";

function deviceType(name: string, productFamily = "iPhone"): AppleDeviceType {
  return {
    name,
    identifier: `com.apple.CoreSimulator.SimDeviceType.${name.replace(/\s+/g, "-")}`,
    productFamily,
    bundlePath: "/tmp",
    minRuntimeVersion: 0,
    maxRuntimeVersion: 0,
  };
}

function deviceTypeWithRuntimeRange(
  name: string,
  minRuntimeVersion: string,
  maxRuntimeVersion = "99.0",
  productFamily = "iPhone",
): AppleDeviceType {
  return {
    ...deviceType(name, productFamily),
    minRuntimeVersionString: minRuntimeVersion,
    maxRuntimeVersionString: maxRuntimeVersion,
  };
}

function systemImage(
  apiLevel: number,
  tag: string,
  abi: string,
  apiIdentifier = String(apiLevel),
  packageName = `system-images;android-${apiIdentifier};${tag};${abi}`,
): SystemImage {
  return {
    packageName,
    apiIdentifier,
    apiLevel,
    tag,
    abi,
    versionInfo: "",
  };
}

describe("buildCreatedDeviceName", () => {
  it("uses a recognizable prefix and a deterministic injected suffix", () => {
    const name = buildCreatedDeviceName("iPhone 17 Pro", new CountingIdGenerator("uuid"));
    expect(name).toBe("AutoMobile-iPhone-17-Pro-uuid1");
    expect(isCreatedDeviceName(name)).toBe(true);
    expect(isCreatedDeviceName("Pixel_7_API_34")).toBe(false);
  });

  it("falls back to a placeholder when the base name has no usable characters", () => {
    expect(buildCreatedDeviceName("///", new CountingIdGenerator("x"))).toBe(
      "AutoMobile-device-x1",
    );
  });
});

describe("pickIosDeviceType", () => {
  const types = [
    deviceType("iPhone 16"),
    deviceType("iPhone 17"),
    deviceType("iPhone 17 Pro Max"),
    deviceType("iPad Pro 13-inch (M4)", "iPad"),
  ];

  it("prefers the newest base iPhone model by default", () => {
    expect(pickIosDeviceType(types, {}).name).toBe("iPhone 17");
  });

  it("honours an explicit name (case-insensitive)", () => {
    expect(pickIosDeviceType(types, { name: "iphone 16" }).name).toBe("iPhone 16");
  });

  it("selects an iPad for the tablet form factor", () => {
    expect(pickIosDeviceType(types, { formFactor: "tablet" }).name).toBe("iPad Pro 13-inch (M4)");
  });

  it("throws an actionable error when no device types exist", () => {
    expect(() => pickIosDeviceType([], {})).toThrow(ActionableError);
  });

  it("throws an actionable error when the requested family is absent", () => {
    expect(() => pickIosDeviceType([deviceType("iPhone 17")], { formFactor: "tablet" })).toThrow(
      /No iPad simulator device type/,
    );
  });
});

describe("pickAndroidSystemImage tag preference", () => {
  // Play Store images refuse `adb root`, and AutoMobile needs a root shell for the
  // root-backed system-locale path (AndroidSystemConfigurationAdapter). Auto-creating
  // one would hand the user a device that cannot run changeLocalization on the API
  // levels that require root, so it must rank BELOW google_apis and default.
  it("prefers a rootable google_apis image over a same-API playstore image", () => {
    const images = [
      systemImage(35, "google_apis_playstore", "arm64-v8a"),
      systemImage(35, "google_apis", "arm64-v8a"),
      systemImage(35, "default", "arm64-v8a"),
    ];

    expect(pickAndroidSystemImage(images, {}, "arm64").packageName).toBe(
      "system-images;android-35;google_apis;arm64-v8a",
    );
  });

  it("prefers default over playstore when google_apis is unavailable", () => {
    const images = [
      systemImage(35, "google_apis_playstore", "arm64-v8a"),
      systemImage(35, "default", "arm64-v8a"),
    ];

    expect(pickAndroidSystemImage(images, {}, "arm64").packageName).toBe(
      "system-images;android-35;default;arm64-v8a",
    );
  });
});

describe("pickAndroidSystemImage", () => {
  const images = [
    systemImage(33, "default", "arm64-v8a"),
    systemImage(34, "google_apis", "arm64-v8a"),
    systemImage(34, "google_apis", "x86_64"),
    systemImage(35, "google_apis", "x86_64"),
  ];

  it("prefers the newest API level with a host-runnable ABI", () => {
    expect(pickAndroidSystemImage(images, {}, "x64").packageName).toBe(
      "system-images;android-35;google_apis;x86_64",
    );
  });

  it("orders dotted API components numerically after parsing sdkmanager output", () => {
    const parsed = parseSystemImages(
      `Installed packages:
 system-images;android-36.2;google_apis;arm64-v8a | 1 | image
 system-images;android-36.10;google_apis;arm64-v8a | 1 | image`,
      undefined,
      "installed",
    );

    expect(pickAndroidSystemImage(parsed, {}, "arm64").packageName).toBe(
      "system-images;android-36.10;google_apis;arm64-v8a",
    );
  });

  it("selects the newest minor API after parsing sdkmanager output", () => {
    const parsed = parseSystemImages(
      `Installed packages:
 system-images;android-36.1;google_apis;arm64-v8a | 1 | image
 system-images;android-36.2;google_apis;arm64-v8a | 1 | image`,
      undefined,
      "installed",
    );

    expect(pickAndroidSystemImage(parsed, {}, "arm64").packageName).toBe(
      "system-images;android-36.2;google_apis;arm64-v8a",
    );
  });

  it("prefers rootable tags over a newer minor at the same major API", () => {
    const candidates = [
      systemImage(36, "google_apis_playstore", "arm64-v8a", "36.2"),
      systemImage(36, "google_apis", "arm64-v8a", "36.1"),
    ];

    expect(pickAndroidSystemImage(candidates, {}, "arm64").packageName).toBe(
      "system-images;android-36.1;google_apis;arm64-v8a",
    );
  });

  it("prefers a higher minor within the same tag", () => {
    const candidates = [
      systemImage(36, "google_apis", "arm64-v8a", "36.1"),
      systemImage(36, "google_apis", "arm64-v8a", "36.2"),
    ];

    expect(pickAndroidSystemImage(candidates, {}, "arm64").apiIdentifier).toBe("36.2");
  });

  it("prefers a higher major API regardless of tag", () => {
    const candidates = [
      systemImage(34, "google_apis", "arm64-v8a"),
      systemImage(35, "google_apis_playstore", "arm64-v8a"),
    ];

    expect(pickAndroidSystemImage(candidates, {}, "arm64").apiLevel).toBe(35);
  });

  it("honours a major API constraint before ranking minor versions", () => {
    const candidates = [
      systemImage(35, "google_apis", "arm64-v8a"),
      systemImage(36, "google_apis_playstore", "arm64-v8a", "36.2"),
      systemImage(36, "google_apis", "arm64-v8a", "36.1"),
    ];

    expect(
      pickAndroidSystemImage(candidates, { minOsVersion: "36", maxOsVersion: "36" }, "arm64")
        .apiIdentifier,
    ).toBe("36.1");
  });

  it("uses packageName as the deterministic final tie-break", () => {
    const candidates = [
      systemImage(36, "google_apis", "arm64-v8a", "36.1", "z-package"),
      systemImage(36, "google_apis", "arm64-v8a", "36.1", "a-package"),
    ];

    expect(pickAndroidSystemImage(candidates, {}, "arm64").packageName).toBe("a-package");
  });

  it("prefers the host ABI when several API levels tie", () => {
    expect(pickAndroidSystemImage(images.slice(0, 3), {}, "arm64").packageName).toBe(
      "system-images;android-34;google_apis;arm64-v8a",
    );
  });

  it("honours release-version bounds, the form the startDevice schema documents (#6132)", () => {
    // maxOsVersion "14" is Android 14 (API 34), not API 14: the android-34
    // image must be selected instead of "nothing installed in range".
    expect(pickAndroidSystemImage(images, { maxOsVersion: "14" }, "x64").apiLevel).toBe(34);
    expect(pickAndroidSystemImage(images, { minOsVersion: "15" }, "x64").apiLevel).toBe(35);
    expect(
      pickAndroidSystemImage(images, { minOsVersion: "13", maxOsVersion: "14" }, "x64").apiLevel,
    ).toBe(34);
    expect(pickAndroidSystemImage(images, { minOsVersion: "14.0" }, "x64").apiLevel).toBe(35);
  });

  it("resolves a redundant trailing-zero bound identically to its bare major (regression)", () => {
    // The device matcher's own comparator treats "14", "14.0", and "14.0.0"
    // as equal (zero-padded comparison), so provisioning must accept the
    // same forms instead of throwing "Unrecognized ...OsVersion".
    expect(pickAndroidSystemImage(images, { minOsVersion: "14.0.0" }, "x64").apiLevel).toBe(
      pickAndroidSystemImage(images, { minOsVersion: "14" }, "x64").apiLevel,
    );
  });

  it("spans point releases when a release-version bound names only the major", () => {
    const legacy = [
      systemImage(26, "google_apis", "x86_64"),
      systemImage(27, "google_apis", "x86_64"),
      systemImage(28, "google_apis", "x86_64"),
    ];
    // "8" as a max means "<= 8.x", so API 27 (Android 8.1) is still in range.
    expect(pickAndroidSystemImage(legacy, { maxOsVersion: "8" }, "x64").apiLevel).toBe(27);
    // "8" as a min means ">= 8.0", so API 26 stays eligible.
    expect(
      pickAndroidSystemImage(legacy, { minOsVersion: "8", maxOsVersion: "8.0" }, "x64").apiLevel,
    ).toBe(26);
  });

  it("still accepts raw API levels as bounds", () => {
    expect(pickAndroidSystemImage(images, { maxOsVersion: "34" }, "x64").apiLevel).toBe(34);
    expect(pickAndroidSystemImage(images, { minOsVersion: "35" }, "x64").apiLevel).toBe(35);
  });

  it("does not throw on a QPR-qualified bound, falling back to its leading major (regression)", () => {
    // The pre-#6132 resolver used parseInt on the leading digits of any
    // bound, so minOsVersion:"14-QPR2" always "worked" (loosely) -- an
    // installed API 35 image safely satisfies a min of 14. The structured
    // release-version resolver must not be stricter than that: it should
    // fall back to the leading major instead of throwing "Unrecognized
    // Android minOsVersion" for a qualifier syntax it doesn't parse.
    expect(() => pickAndroidSystemImage(images, { minOsVersion: "14-QPR2" }, "x64")).not.toThrow();
    expect(pickAndroidSystemImage(images, { minOsVersion: "14-QPR2" }, "x64").apiLevel).toBe(35);
  });

  for (const qualifiedBound of ["14-QPR2", "15-QPR1", "13-QPR3", "9-QPR1"]) {
    it(`does not throw at provisioning for the qualified bound '${qualifiedBound}'`, () => {
      expect(() =>
        pickAndroidSystemImage(images, { minOsVersion: qualifiedBound }, "x64"),
      ).not.toThrow();
    });
  }

  it("rejects a release version it cannot map instead of silently widening the range", () => {
    expect(() => pickAndroidSystemImage(images, { minOsVersion: "17" }, "x64")).toThrow(
      ActionableError,
    );
    expect(() => pickAndroidSystemImage(images, { minOsVersion: "17" }, "x64")).toThrow(
      /minOsVersion '17'/,
    );
    expect(() => pickAndroidSystemImage(images, { maxOsVersion: "4.4" }, "x64")).toThrow(
      /maxOsVersion '4.4'/,
    );
  });

  it("throws an actionable error when nothing is installed in range", () => {
    expect(() => pickAndroidSystemImage(images, { minOsVersion: "99" }, "x64")).toThrow(
      /No installed Android system image/,
    );
    expect(() => pickAndroidSystemImage(images, { maxOsVersion: "12" }, "x64")).toThrow(
      /No installed Android system image.*max=12 \(API 31\)/,
    );
  });

  it("maps host architecture to runnable ABIs", () => {
    expect(preferredAbis("arm64")[0]).toBe("arm64-v8a");
    expect(preferredAbis("x64")[0]).toBe("x86_64");
  });

  describe("CtrlProxy runner-APK minSdk floor (#6187)", () => {
    // The runner APK targets minSdk 24; provisioning must never hand back a
    // sub-24 image that would boot an AVD the runner can never install onto.
    const withLegacy = [
      systemImage(21, "google_apis", "x86_64"),
      systemImage(23, "google_apis", "x86_64"),
      systemImage(24, "google_apis", "x86_64"),
      systemImage(34, "google_apis", "x86_64"),
    ];

    it("never selects an image below API 24 even without an explicit min bound", () => {
      // API 21 is newest-by-nothing here only because 24/34 also exist; ensure a
      // catalog whose only options are sub-24 is rejected rather than selected.
      const onlyLegacy = [
        systemImage(21, "google_apis", "x86_64"),
        systemImage(23, "google_apis", "x86_64"),
      ];
      expect(() => pickAndroidSystemImage(onlyLegacy, {}, "x64")).toThrow(
        /No installed Android system image.*CtrlProxy runner minSdk/,
      );
    });

    it("clamps a below-floor min bound up to API 24 without touching valid picks", () => {
      // minOsVersion "5.0" is Android 5.0 (API 21) — below the runner floor. The
      // API 21/23 images stay excluded; the newest at-or-above 24 is chosen.
      expect(pickAndroidSystemImage(withLegacy, { minOsVersion: "5.0" }, "x64").apiLevel).toBe(34);
    });

    it("fails fast when the requested max cannot host the runner APK", () => {
      // maxOsVersion "6" is Android 6.0 (API 23): creating that AVD would fail
      // APK install later, so provisioning rejects it up front.
      for (const maxOsVersion of ["6", "23"]) {
        expect(() => pickAndroidSystemImage(withLegacy, { maxOsVersion }, "x64")).toThrow(
          ActionableError,
        );
        expect(() => pickAndroidSystemImage(withLegacy, { maxOsVersion }, "x64")).toThrow(
          /below API 24.*CtrlProxy runner APK/,
        );
      }
    });

    it("leaves a valid at-or-above-floor bound unaffected", () => {
      // A normal request that already sits at/above the floor selects exactly as
      // before — the guard adds no behavior for in-support bounds.
      expect(pickAndroidSystemImage(withLegacy, { minOsVersion: "7.0" }, "x64").apiLevel).toBe(34);
      expect(pickAndroidSystemImage(withLegacy, { maxOsVersion: "7.0" }, "x64").apiLevel).toBe(24);
    });
  });
});

describe("DefaultDeviceProvisioner", () => {
  it("creates an iOS simulator with the resolved device type and runtime", async () => {
    const simctl = new FakeIosSimulatorCreator(
      [deviceType("iPhone 17")],
      "com.apple.CoreSimulator.SimRuntime.iOS-26-3",
      "NEW-UDID",
    );
    const provisioner = new DefaultDeviceProvisioner({
      iosCreator: () => simctl,
      androidCreator: () => new FakeAndroidAvdCreator(),
      idGenerator: new CountingIdGenerator("uuid"),
      architecture: "arm64",
    });

    const created = await provisioner.provision({ platform: "ios" });

    expect(created).toEqual({
      platform: "ios",
      name: "AutoMobile-iPhone-17-uuid1",
      deviceId: "NEW-UDID",
      deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-17",
      runtime: "com.apple.CoreSimulator.SimRuntime.iOS-26-3",
    });
    expect(simctl.createCalls).toEqual([
      {
        name: "AutoMobile-iPhone-17-uuid1",
        deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-17",
        runtime: "com.apple.CoreSimulator.SimRuntime.iOS-26-3",
      },
    ]);
  });

  it("uses both iOS version bounds when selecting the runtime", async () => {
    const signal = new AbortController().signal;
    const simctl = new FakeIosSimulatorCreator(
      [deviceType("iPhone 16")],
      "com.apple.CoreSimulator.SimRuntime.iOS-18-2",
      "NEW-UDID",
    );
    const provisioner = new DefaultDeviceProvisioner({
      iosCreator: () => simctl,
      androidCreator: () => new FakeAndroidAvdCreator(),
      idGenerator: new CountingIdGenerator("uuid"),
    });

    const created = await provisioner.provision(
      { platform: "ios", minOsVersion: "18.0", maxOsVersion: "18.2" },
      signal,
    );

    expect(created.runtime).toBe("com.apple.CoreSimulator.SimRuntime.iOS-18-2");
    expect(simctl.rangeRequests).toEqual([{ minVersion: "18.0", maxVersion: "18.2", signal }]);
    expect(simctl.createCalls).toHaveLength(1);
  });

  it("selects a device type compatible with an older bounded iOS runtime", async () => {
    const simctl = new FakeIosSimulatorCreator(
      [
        deviceTypeWithRuntimeRange("iPhone 17", "26.0"),
        deviceTypeWithRuntimeRange("iPhone 16", "18.0"),
      ],
      "com.apple.CoreSimulator.SimRuntime.iOS-18-2",
      "NEW-UDID",
    );
    const provisioner = new DefaultDeviceProvisioner({
      iosCreator: () => simctl,
      androidCreator: () => new FakeAndroidAvdCreator(),
      idGenerator: new CountingIdGenerator("uuid"),
    });

    const created = await provisioner.provision({ platform: "ios", maxOsVersion: "18.2" });

    expect(created.deviceType).toBe("com.apple.CoreSimulator.SimDeviceType.iPhone-16");
    expect(simctl.createCalls[0]?.deviceType).toBe(
      "com.apple.CoreSimulator.SimDeviceType.iPhone-16",
    );
  });

  it("falls back to a lower in-range runtime when the newest has no compatible device type", async () => {
    const simctl = new FakeIosSimulatorCreator(
      [deviceTypeWithRuntimeRange("iPhone 8", "12.0", "18.2")],
      "com.apple.CoreSimulator.SimRuntime.iOS-26-3",
      "NEW-UDID",
    );
    simctl.runtimeCandidates = [
      "com.apple.CoreSimulator.SimRuntime.iOS-26-3",
      "com.apple.CoreSimulator.SimRuntime.iOS-18-2",
    ];
    const provisioner = new DefaultDeviceProvisioner({
      iosCreator: () => simctl,
      androidCreator: () => new FakeAndroidAvdCreator(),
      idGenerator: new CountingIdGenerator("uuid"),
    });

    const created = await provisioner.provision({
      platform: "ios",
      minOsVersion: "18.0",
      maxOsVersion: "26.3",
    });

    expect(created.runtime).toBe("com.apple.CoreSimulator.SimRuntime.iOS-18-2");
    expect(simctl.createCalls[0]?.runtime).toBe("com.apple.CoreSimulator.SimRuntime.iOS-18-2");
  });

  it("falls back when the newest runtime supports only the wrong family for a phone", async () => {
    const simctl = new FakeIosSimulatorCreator(
      [
        deviceTypeWithRuntimeRange("iPhone 8", "12.0", "18.2"),
        deviceTypeWithRuntimeRange("iPad Pro", "26.0", "99.0", "iPad"),
      ],
      "com.apple.CoreSimulator.SimRuntime.iOS-26-3",
      "NEW-UDID",
    );
    simctl.runtimeCandidates = [
      "com.apple.CoreSimulator.SimRuntime.iOS-26-3",
      "com.apple.CoreSimulator.SimRuntime.iOS-18-2",
    ];
    const provisioner = new DefaultDeviceProvisioner({
      iosCreator: () => simctl,
      androidCreator: () => new FakeAndroidAvdCreator(),
      idGenerator: new CountingIdGenerator("uuid"),
    });

    const created = await provisioner.provision({
      platform: "ios",
      formFactor: "phone",
      minOsVersion: "18.0",
      maxOsVersion: "26.3",
    });

    expect(created.deviceType).toBe("com.apple.CoreSimulator.SimDeviceType.iPhone-8");
    expect(created.runtime).toBe("com.apple.CoreSimulator.SimRuntime.iOS-18-2");
  });

  it("falls back when the newest runtime supports only the wrong family for a tablet", async () => {
    const simctl = new FakeIosSimulatorCreator(
      [
        deviceTypeWithRuntimeRange("iPhone 17", "26.0"),
        deviceTypeWithRuntimeRange("iPad Pro", "12.0", "18.2", "iPad"),
      ],
      "com.apple.CoreSimulator.SimRuntime.iOS-26-3",
      "NEW-UDID",
    );
    simctl.runtimeCandidates = [
      "com.apple.CoreSimulator.SimRuntime.iOS-26-3",
      "com.apple.CoreSimulator.SimRuntime.iOS-18-2",
    ];
    const provisioner = new DefaultDeviceProvisioner({
      iosCreator: () => simctl,
      androidCreator: () => new FakeAndroidAvdCreator(),
      idGenerator: new CountingIdGenerator("uuid"),
    });

    const created = await provisioner.provision({
      platform: "ios",
      formFactor: "tablet",
      minOsVersion: "18.0",
      maxOsVersion: "26.3",
    });

    expect(created.deviceType).toBe("com.apple.CoreSimulator.SimDeviceType.iPad-Pro");
    expect(created.runtime).toBe("com.apple.CoreSimulator.SimRuntime.iOS-18-2");
  });

  it("reports the requested family when only wrong-family types support matching runtimes", async () => {
    const simctl = new FakeIosSimulatorCreator(
      [deviceTypeWithRuntimeRange("iPad Pro", "26.0", "99.0", "iPad")],
      "com.apple.CoreSimulator.SimRuntime.iOS-26-3",
      "NEW-UDID",
    );
    const provisioner = new DefaultDeviceProvisioner({
      iosCreator: () => simctl,
      androidCreator: () => new FakeAndroidAvdCreator(),
      idGenerator: new CountingIdGenerator("uuid"),
    });

    await expect(
      provisioner.provision({
        platform: "ios",
        formFactor: "phone",
        minOsVersion: "26.0",
        maxOsVersion: "26.3",
      }),
    ).rejects.toThrow(
      "No installed iPhone simulator device type supports the matching runtime(s) 26.3. " +
        "Available device types: iPad Pro.",
    );
    expect(simctl.createCalls).toEqual([]);
  });

  it("does not create an iOS simulator when no runtime is within the requested range", async () => {
    const simctl = new FakeIosSimulatorCreator([deviceType("iPhone 16")]);
    simctl.rangeFailure = new ActionableError(
      "No available iOS simulator runtime matches the requested range",
    );
    const provisioner = new DefaultDeviceProvisioner({
      iosCreator: () => simctl,
      androidCreator: () => new FakeAndroidAvdCreator(),
      idGenerator: new CountingIdGenerator("uuid"),
    });

    await expect(provisioner.provision({ platform: "ios", minOsVersion: "26.4" })).rejects.toThrow(
      /No available iOS simulator runtime/,
    );
    expect(simctl.createCalls).toEqual([]);
  });

  it("reserves the generated iOS name before creation and binds the returned UDID", async () => {
    const events: string[] = [];
    const controller = new AbortController();
    const simctl = new FakeIosSimulatorCreator(
      [deviceType("iPhone 17")],
      "com.apple.CoreSimulator.SimRuntime.iOS-26-3",
      "NEW-UDID",
    );
    const createSimulator = simctl.createSimulator.bind(simctl);
    simctl.createSimulator = async (name, deviceTypeIdentifier, runtime) => {
      events.push(`create:${name}`);
      return await createSimulator(name, deviceTypeIdentifier, runtime);
    };
    const provisioner = new DefaultDeviceProvisioner({
      iosCreator: () => simctl,
      androidCreator: () => new FakeAndroidAvdCreator(),
      idGenerator: new CountingIdGenerator("uuid"),
      architecture: "arm64",
      identityHooks: {
        reserveBeforeCreate: async (identity) => {
          events.push(`reserve:${identity.name}`);
          return controller.signal;
        },
        bindAfterCreate: async (device) => {
          events.push(`bind:${device.deviceId}`);
        },
      },
    });

    await provisioner.provision({ platform: "ios" });

    expect(events).toEqual([
      "reserve:AutoMobile-iPhone-17-uuid1",
      "create:AutoMobile-iPhone-17-uuid1",
      "bind:NEW-UDID",
    ]);
  });

  it("logs a created iOS simulator identity before canonical binding rejects", async () => {
    const bindingError = new Error("lifecycle binding failed");
    const infoSpy = spyOn(logger, "info").mockImplementation(() => {});
    const provisioner = new DefaultDeviceProvisioner({
      iosCreator: () =>
        new FakeIosSimulatorCreator(
          [deviceType("iPhone 17")],
          "com.apple.CoreSimulator.SimRuntime.iOS-26-3",
          "NEW-UDID",
        ),
      androidCreator: () => new FakeAndroidAvdCreator(),
      idGenerator: new CountingIdGenerator("uuid"),
      architecture: "arm64",
      identityHooks: {
        reserveBeforeCreate: async () => undefined,
        bindAfterCreate: async () => {
          throw bindingError;
        },
      },
    });

    try {
      await expect(provisioner.provision({ platform: "ios" })).rejects.toBe(bindingError);
      expect(
        infoSpy.mock.calls.some(([message]) =>
          String(message).includes(
            "Created iOS simulator 'AutoMobile-iPhone-17-uuid1' (udid=NEW-UDID",
          ),
        ),
      ).toBe(true);
      expect(
        infoSpy.mock.calls.some(([message]) =>
          String(message).includes("xcrun simctl delete NEW-UDID"),
        ),
      ).toBe(true);
    } finally {
      infoSpy.mockRestore();
    }
  });

  it("creates an Android AVD from an installed system image", async () => {
    const avd = new FakeAndroidAvdCreator([systemImage(34, "google_apis", "arm64-v8a")]);
    const provisioner = new DefaultDeviceProvisioner({
      iosCreator: () => undefined,
      androidCreator: () => avd,
      idGenerator: new CountingIdGenerator("uuid"),
      architecture: "arm64",
    });

    const created = await provisioner.provision({ platform: "android" });

    expect(created).toEqual({
      platform: "android",
      name: "AutoMobile-android-34-uuid1",
      deviceType: "system-images;android-34;google_apis;arm64-v8a",
      runtime: "android-34",
    });
    expect(avd.createCalls).toEqual([
      {
        name: "AutoMobile-android-34-uuid1",
        package: "system-images;android-34;google_apis;arm64-v8a",
      },
    ]);
  });

  it("returns the exact minor runtime selected through the parser and creator", async () => {
    const images = parseSystemImages(
      `Installed packages:
 system-images;android-36.1;google_apis;arm64-v8a | 1 | image`,
      undefined,
      "installed",
    );
    const avd = new FakeAndroidAvdCreator(images);
    const provisioner = new DefaultDeviceProvisioner({
      iosCreator: () => undefined,
      androidCreator: () => avd,
      idGenerator: new CountingIdGenerator("uuid"),
      architecture: "arm64",
    });

    const created = await provisioner.provision({ platform: "android" });

    expect(created.runtime).toBe("android-36.1");
    expect(avd.createCalls[0]?.package).toBe("system-images;android-36.1;google_apis;arm64-v8a");
  });

  it("reserves the generated Android AVD name before creation and binds afterward", async () => {
    const events: string[] = [];
    const controller = new AbortController();
    const avd = new FakeAndroidAvdCreator([systemImage(34, "google_apis", "arm64-v8a")]);
    const createAvd = avd.createAvd.bind(avd);
    avd.createAvd = async (params, signal) => {
      events.push(`create:${params.name}`);
      expect(signal).toBe(controller.signal);
      return await createAvd(params, signal);
    };
    const provisioner = new DefaultDeviceProvisioner({
      iosCreator: () => undefined,
      androidCreator: () => avd,
      idGenerator: new CountingIdGenerator("uuid"),
      architecture: "arm64",
      identityHooks: {
        reserveBeforeCreate: async (identity) => {
          events.push(`reserve:${identity.name}`);
          return controller.signal;
        },
        bindAfterCreate: async (device) => {
          events.push(`bind:${device.name}`);
        },
      },
    });

    await provisioner.provision({ platform: "android" });

    expect(events).toEqual([
      "reserve:AutoMobile-android-34-uuid1",
      "create:AutoMobile-android-34-uuid1",
      "bind:AutoMobile-android-34-uuid1",
    ]);
  });

  it("surfaces an actionable error when AVD creation fails", async () => {
    const avd = new FakeAndroidAvdCreator([systemImage(34, "google_apis", "arm64-v8a")]);
    avd.result = { success: false, message: "package not installed" };
    const provisioner = new DefaultDeviceProvisioner({
      iosCreator: () => undefined,
      androidCreator: () => avd,
      idGenerator: new CountingIdGenerator("uuid"),
      architecture: "arm64",
    });

    await expect(provisioner.provision({ platform: "android" })).rejects.toThrow(
      /Failed to create Android AVD .*package not installed/,
    );
  });

  it("reports an actionable error when simctl is unavailable", async () => {
    const provisioner = new DefaultDeviceProvisioner({
      iosCreator: () => undefined,
      androidCreator: () => new FakeAndroidAvdCreator(),
    });

    await expect(provisioner.provision({ platform: "ios" })).rejects.toThrow(
      /iOS simulator tools \(xcrun simctl\) are not available/,
    );
  });
});
