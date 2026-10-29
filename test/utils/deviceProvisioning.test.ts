import { readFileSync } from "node:fs";
import { describe, it, expect, spyOn } from "bun:test";
import {
  DefaultDeviceProvisioner,
  type AndroidAvdCreator,
  buildCreatedDeviceName,
  isCreatedDeviceName,
  pickAndroidSystemImage,
  pickIosDeviceType,
  preferredAbis,
} from "../../src/devices/deviceProvisioning";
import { CountingIdGenerator } from "../../src/utils/IdGenerator";
import { ActionableError } from "../../src/models/ActionableError";
import type { AppleDeviceType } from "../../src/utils/ios-cmdline-tools/SimCtlClient";
import {
  parseSystemImages,
  type SystemImage,
} from "../../src/utils/android-cmdline-tools/avdmanager";
import { FakeAndroidAvdCreator, FakeIosSimulatorCreator } from "../fakes/FakeDeviceProvisioner";
import { logger } from "../../src/utils/logger";
import { ProvisionDeviceCreateRejectedError } from "../../src/devices/exactDeviceProvisioning";

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

  it("never picks the foldable iPhone Duo for a phone request, even when it is the newest", () => {
    const withDuo = [deviceType("iPhone 17"), deviceType("iPhone Duo")];
    expect(pickIosDeviceType(withDuo, {}).name).toBe("iPhone 17");
    expect(() => pickIosDeviceType([deviceType("iPhone Duo")], {})).toThrow(ActionableError);
    expect(pickIosDeviceType(withDuo, { name: "iPhone Duo" }).name).toBe("iPhone Duo");
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

describe("pickAndroidSystemImage handheld-only default selection (#14900)", () => {
  const sdkmanagerListing = readFileSync(
    new URL("../fixtures/android-sdkmanager/list-system-images-available.txt", import.meta.url),
    "utf8",
  );
  const NON_HANDHELD_TAGS = [
    "android-wear",
    "android-wear-signed",
    "android-wear-cn",
    "android-tv",
    "google-tv",
    "google-tv-ps16k",
    "android-automotive",
    "android-automotive-playstore",
    "android-automotive-distant-display-playstore",
    "android-desktop",
    "android-xr-preview-playstore",
    "ai-glasses",
  ];

  for (const tag of NON_HANDHELD_TAGS) {
    it(`does not pick a newer '${tag}' image over an older phone image`, () => {
      const images = [systemImage(35, "google_apis", "x86_64"), systemImage(36, tag, "x86_64")];

      expect(pickAndroidSystemImage(images, {}, "x64").packageName).toBe(
        "system-images;android-35;google_apis;x86_64",
      );
    });
  }

  it("keeps the phone image when a newer Wear image has the preferred ABI", () => {
    const images = [
      systemImage(35, "google_apis", "x86"),
      systemImage(36, "android-wear", "x86_64"),
    ];

    expect(pickAndroidSystemImage(images, {}, "x64").packageName).toBe(
      "system-images;android-35;google_apis;x86",
    );
  });

  it("picks the newest phone image from a captured sdkmanager listing that includes every tag", () => {
    const parsed = parseSystemImages(sdkmanagerListing, undefined, "available");
    expect(parsed.length).toBeGreaterThan(40);
    expect(new Set(parsed.map((image) => image.tag))).toContain("android-wear-signed");

    const picked = pickAndroidSystemImage(parsed, {}, "x64");
    expect(picked.packageName).toBe("system-images;android-36;google_apis;x86_64");
  });

  it("throws a typed error naming the non-handheld images when no phone image is installed", () => {
    const parsed = parseSystemImages(sdkmanagerListing, undefined, "available").filter((image) =>
      NON_HANDHELD_TAGS.includes(image.tag),
    );
    expect(parsed.length).toBeGreaterThan(10);

    let thrown: unknown;
    try {
      pickAndroidSystemImage(parsed, {}, "x64");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ActionableError);
    const message = (thrown as ActionableError).message;
    expect(message).toContain("handheld");
    expect(message).toContain("system-images;android-36;android-wear-signed;x86_64");
    expect(message).toContain("system-images;android-34;android-tv;x86");
    expect(message).toContain("sdkmanager");
  });

  it("reports only non-handheld images when the requested API range holds no phone image", () => {
    const images = [
      systemImage(34, "google_apis", "x86_64"),
      systemImage(36, "android-wear", "x86_64"),
    ];

    expect(() => pickAndroidSystemImage(images, { minOsVersion: "36" }, "x64")).toThrow(
      /non-handheld[\s\S]*system-images;android-36;android-wear;x86_64/,
    );
  });

  it("still reports the range mismatch when nothing is installed in range at all", () => {
    expect(() =>
      pickAndroidSystemImage(
        [systemImage(34, "google_apis", "x86_64")],
        { minOsVersion: "36" },
        "x64",
      ),
    ).toThrow(/No installed Android system image matches/);
  });

  it("still accepts the other phone and tablet image tags the SDK ships", () => {
    for (const tag of [
      "default",
      "google_apis_playstore",
      "google_apis_ps16k",
      "google_apis_playstore_ps16k",
      "google_apis_tablet",
      "google_apis_playstore_tablet",
    ]) {
      expect(pickAndroidSystemImage([systemImage(35, tag, "x86_64")], {}, "x64").tag).toBe(tag);
    }
  });
});

describe("pickAndroidSystemImage TV selection (#15881)", () => {
  const sdkmanagerListing = readFileSync(
    new URL("../fixtures/android-sdkmanager/list-system-images-available.txt", import.meta.url),
    "utf8",
  );
  const tv = { formFactor: "tv" } as const;

  it("selects only TV images, even when a newer phone image is installed", () => {
    const images = [
      systemImage(36, "google_apis", "x86_64"),
      systemImage(36, "android-wear", "x86_64"),
      systemImage(36, "android-automotive", "x86_64"),
      systemImage(34, "android-tv", "x86_64"),
    ];

    expect(pickAndroidSystemImage(images, tv, "x64").packageName).toBe(
      "system-images;android-34;android-tv;x86_64",
    );
  });

  it("prefers android-tv, then google-tv, then google-tv-ps16k at the same API and ABI", () => {
    const all = [
      systemImage(36, "google-tv-ps16k", "x86_64"),
      systemImage(36, "google-tv", "x86_64"),
      systemImage(36, "android-tv", "x86_64"),
    ];

    expect(pickAndroidSystemImage(all, tv, "x64").tag).toBe("android-tv");
    expect(pickAndroidSystemImage(all.slice(0, 2), tv, "x64").tag).toBe("google-tv");
    expect(pickAndroidSystemImage(all.slice(0, 1), tv, "x64").tag).toBe("google-tv-ps16k");
  });

  it("ranks API level, then host-runnable ABI, ahead of the tag", () => {
    expect(
      pickAndroidSystemImage(
        [systemImage(34, "android-tv", "x86_64"), systemImage(36, "google-tv", "x86_64")],
        tv,
        "x64",
      ).packageName,
    ).toBe("system-images;android-36;google-tv;x86_64");
    expect(
      pickAndroidSystemImage(
        [systemImage(34, "android-tv", "x86"), systemImage(34, "google-tv", "arm64-v8a")],
        tv,
        "arm64",
      ).packageName,
    ).toBe("system-images;android-34;google-tv;arm64-v8a");
  });

  it("honours the requested API range", () => {
    const images = [
      systemImage(34, "android-tv", "x86_64"),
      systemImage(35, "android-tv", "x86_64"),
      systemImage(36, "android-tv", "x86_64"),
    ];

    expect(pickAndroidSystemImage(images, { ...tv, maxOsVersion: "35" }, "x64").apiLevel).toBe(35);
    expect(
      pickAndroidSystemImage(images, { ...tv, minOsVersion: "14", maxOsVersion: "14" }, "x64")
        .apiLevel,
    ).toBe(34);
  });

  it("never selects a TV image below the CtrlProxy minSdk floor", () => {
    expect(() => pickAndroidSystemImage([systemImage(23, "android-tv", "x86")], tv, "x64")).toThrow(
      /API 24 \(CtrlProxy runner minSdk\)/,
    );
  });

  it("picks the newest host-runnable android-tv image from a captured sdkmanager listing", () => {
    const parsed = parseSystemImages(sdkmanagerListing, undefined, "available");

    expect(pickAndroidSystemImage(parsed, tv, "x64").packageName).toBe(
      "system-images;android-36;android-tv;x86_64",
    );
    expect(pickAndroidSystemImage(parsed, tv, "arm64").packageName).toBe(
      "system-images;android-36;android-tv;arm64-v8a",
    );
  });

  it.each(["phone", "tablet", "foldable"] as const)(
    "a %s request never selects a TV image",
    (formFactor) => {
      expect(() =>
        pickAndroidSystemImage([systemImage(36, "android-tv", "x86_64")], { formFactor }, "x64"),
      ).toThrow(/No installed handheld \(phone\) Android system image/);
    },
  );

  it.each([
    [{}, "x64", 'sdkmanager "system-images;android-34;android-tv;x86_64"', "x86_64 or x86"],
    [
      {},
      "arm64",
      'sdkmanager "system-images;android-34;android-tv;arm64-v8a"',
      "arm64-v8a or x86_64",
    ],
    [
      { maxOsVersion: "35" },
      "x64",
      'sdkmanager "system-images;android-35;android-tv;x86_64"',
      "x86_64 or x86",
    ],
    [
      { minOsVersion: "36" },
      "x64",
      'sdkmanager "system-images;android-36;android-tv;x86_64"',
      "x86_64 or x86",
    ],
  ] as const)(
    "names the missing TV image and its install command (%j on %s)",
    (range, architecture, command, abis) => {
      const images = [
        systemImage(36, "google_apis", "x86_64"),
        systemImage(23, "android-tv", "x86"),
      ];
      let thrown: unknown;
      try {
        pickAndroidSystemImage(images, { ...tv, ...range }, architecture);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(ActionableError);
      const message = thrown instanceof Error ? thrown.message : "";
      expect(message).toContain(
        "No installed Android TV system image (android-tv, google-tv, google-tv-ps16k)",
      );
      expect(message).toContain(command);
      expect(message).toContain(`This host runs ${abis} images`);
      expect(message).toContain(
        "Installed images: system-images;android-36;google_apis;x86_64, system-images;android-23;android-tv;x86.",
      );
      expect(message).toContain("does not download system images");
    },
  );
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
    expect(() => pickAndroidSystemImage(images, { minOsVersion: "18" }, "x64")).toThrow(
      ActionableError,
    );
    expect(() => pickAndroidSystemImage(images, { minOsVersion: "18" }, "x64")).toThrow(
      /minOsVersion '18'/,
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
      runtimeId: "com.apple.CoreSimulator.SimRuntime.iOS-26-3",
    });
    expect(simctl.createCalls).toEqual([
      {
        name: "AutoMobile-iPhone-17-uuid1",
        deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-17",
        runtime: "com.apple.CoreSimulator.SimRuntime.iOS-26-3",
      },
    ]);
  });

  it("names the created iOS simulator after a requested name that is not a device type (#11148)", async () => {
    const simctl = new FakeIosSimulatorCreator(
      [deviceType("iPhone 17")],
      "com.apple.CoreSimulator.SimRuntime.iOS-26-3",
      "NEW-UDID",
    );
    const provisioner = new DefaultDeviceProvisioner({
      iosCreator: () => simctl,
      androidCreator: () => new FakeAndroidAvdCreator(),
      idGenerator: new CountingIdGenerator("uuid"),
    });

    const created = await provisioner.provision({ platform: "ios", name: "My Test Sim" });

    expect(created.name).toBe("AutoMobile-My-Test-Sim-uuid1");
    expect(simctl.createCalls[0].name).toBe("AutoMobile-My-Test-Sim-uuid1");
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
      runtimeId: "system-images;android-34;google_apis;arm64-v8a",
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
    const creator: AndroidAvdCreator = avd;
    const createAvd = creator.createAvd.bind(creator);
    creator.createAvd = async (params, signal) => {
      events.push(`create:${params.name}`);
      expect(signal).toBe(controller.signal);
      return await createAvd(params, signal);
    };
    const provisioner = new DefaultDeviceProvisioner({
      iosCreator: () => undefined,
      androidCreator: () => creator,
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
    // A clean avdmanager rejection created nothing, so it must not be rolled back (#11155).
    await expect(provisioner.provision({ platform: "android" })).rejects.toBeInstanceOf(
      ProvisionDeviceCreateRejectedError,
    );
  });

  it("claims the exact iOS identity before simctl create runs (#11155)", async () => {
    const claimed: unknown[] = [];
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
        reserveBeforeCreate: async (identity) => {
          claimed.push(identity);
          return undefined;
        },
        bindAfterCreate: async () => {},
      },
    });

    await provisioner.provision({ platform: "ios" });

    expect(claimed).toEqual([
      {
        platform: "ios",
        name: "AutoMobile-iPhone-17-uuid1",
        deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-17",
        runtimeId: "com.apple.CoreSimulator.SimRuntime.iOS-26-3",
        runtime: "com.apple.CoreSimulator.SimRuntime.iOS-26-3",
      },
    ]);
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
  it("creates a TV AVD from a TV image with the shared TV profile (#15881)", async () => {
    const avd = new FakeAndroidAvdCreator([
      systemImage(36, "google_apis", "x86_64"),
      systemImage(34, "google-tv", "x86_64"),
      systemImage(34, "android-tv", "x86_64"),
    ]);
    const provisioner = new DefaultDeviceProvisioner({
      iosCreator: () => undefined,
      androidCreator: () => avd,
      idGenerator: new CountingIdGenerator("uuid"),
      architecture: "x64",
    });

    const created = await provisioner.provision({ platform: "android", formFactor: "tv" });

    expect(created).toEqual({
      platform: "android",
      name: "AutoMobile-android-tv-34-uuid1",
      deviceType: "system-images;android-34;android-tv;x86_64",
      runtime: "android-34",
      runtimeId: "system-images;android-34;android-tv;x86_64",
    });
    expect(avd.createCalls).toEqual([
      {
        name: "AutoMobile-android-tv-34-uuid1",
        package: "system-images;android-34;android-tv;x86_64",
        device: "tv_1080p",
      },
    ]);
  });

  it("keeps a requested name for a TV AVD", async () => {
    const avd = new FakeAndroidAvdCreator([systemImage(34, "android-tv", "arm64-v8a")]);
    const provisioner = new DefaultDeviceProvisioner({
      iosCreator: () => undefined,
      androidCreator: () => avd,
      idGenerator: new CountingIdGenerator("uuid"),
      architecture: "arm64",
    });

    await provisioner.provision({ platform: "android", formFactor: "tv", name: "living-room" });

    expect(avd.createCalls[0]?.name).toBe("AutoMobile-living-room-uuid1");
  });

  it("creates nothing and names the sdkmanager command when no TV image is installed", async () => {
    const avd = new FakeAndroidAvdCreator([systemImage(36, "google_apis", "arm64-v8a")]);
    const provisioner = new DefaultDeviceProvisioner({
      iosCreator: () => undefined,
      androidCreator: () => avd,
      idGenerator: new CountingIdGenerator("uuid"),
      architecture: "arm64",
    });

    await expect(provisioner.provision({ platform: "android", formFactor: "tv" })).rejects.toThrow(
      'sdkmanager "system-images;android-34;android-tv;arm64-v8a"',
    );
    expect(avd.createCalls).toEqual([]);
  });

  it.each(["phone", "tablet", "foldable", undefined] as const)(
    "a %p request creates a handheld AVD with avdmanager's default hardware",
    async (formFactor) => {
      const avd = new FakeAndroidAvdCreator([
        systemImage(34, "google_apis", "x86_64"),
        systemImage(36, "android-tv", "x86_64"),
      ]);
      const provisioner = new DefaultDeviceProvisioner({
        iosCreator: () => undefined,
        androidCreator: () => avd,
        idGenerator: new CountingIdGenerator("uuid"),
        architecture: "x64",
      });

      await provisioner.provision({ platform: "android", ...(formFactor ? { formFactor } : {}) });

      expect(avd.createCalls).toEqual([
        {
          name: "AutoMobile-android-34-uuid1",
          package: "system-images;android-34;google_apis;x86_64",
        },
      ]);
    },
  );

  it.each(["watch", "automotive"] as const)(
    "refuses to create a handheld AVD for a %s request",
    async (formFactor) => {
      const avd = new FakeAndroidAvdCreator([
        systemImage(35, "google_apis", "x86_64"),
        systemImage(35, "android-tv", "x86"),
      ]);
      const provisioner = new DefaultDeviceProvisioner({
        iosCreator: () => undefined,
        androidCreator: () => avd,
        idGenerator: new CountingIdGenerator("uuid"),
      });

      await expect(provisioner.provision({ platform: "android", formFactor })).rejects.toThrow(
        new RegExp(`'${formFactor}' AVD is not supported yet`),
      );
      expect(avd.createCalls).toEqual([]);
      expect(() =>
        pickAndroidSystemImage([systemImage(35, "google_apis", "x86_64")], { formFactor }, "x64"),
      ).toThrow(/not supported yet/);
    },
  );
});

it.each(["none", "minimal", "failed"] as const)(
  "applies only the default %s preboot profile after iOS creation",
  async (selectedProfile) => {
    const { SimulatorPrebootProfile, resolvePrebootLabels } =
      await import("../../src/utils/ios-cmdline-tools/SimulatorPrebootProfile");
    const { FakeSimulatorHostState } = await import("../fakes/FakeSimulatorHostState");
    const udid = "12345678-1234-ABCD-9876-123456789ABC";
    const host = new FakeSimulatorHostState();
    const simctl = new FakeIosSimulatorCreator([deviceType("iPhone 17")], "iOS-26", udid);
    const profile = new SimulatorPrebootProfile(host, () =>
      selectedProfile === "failed" ? "minimal" : selectedProfile,
    );
    if (selectedProfile === "failed") {
      host.writeError = new Error("denied");
    }
    const calls: string[] = [];
    let bound: import("../../src/devices/deviceProvisioning").ProvisionedDevice | undefined;
    const provisioner = new DefaultDeviceProvisioner({
      iosCreator: () => simctl,
      androidCreator: () => new FakeAndroidAvdCreator(),
      idGenerator: new CountingIdGenerator("uuid"),
      prebootProfile: {
        apply: async (...args) => {
          expect(calls).toEqual(["bind"]);
          expect(simctl.createCalls).toHaveLength(1);
          expect(args).toEqual([udid, {}, undefined]);
          calls.push("apply");
          return profile.apply(...args);
        },
      },
    });
    const result = await provisioner.provision({ platform: "ios" }, undefined, {
      reserveBeforeCreate: async () => undefined,
      bindAfterCreate: async (device) => {
        bound = device;
        calls.push("bind");
      },
    });
    expect(result.prebootDisabledResources).toEqual(
      selectedProfile !== "minimal"
        ? undefined
        : ["wallpaperRendering", "widgets", "liveActivities"],
    );
    expect(bound?.prebootDisabledResources).toBeUndefined();
    expect(result).not.toBe(bound);
    expect(calls).toEqual(["bind", "apply"]);
    expect(Object.keys(host.written ?? {}).sort()).toEqual(
      selectedProfile === "failed" ? [] : resolvePrebootLabels({ profile: selectedProfile }),
    );
    if (selectedProfile === "none") {
      expect(host.calls).toEqual([]);
    }
  },
);
