import { describe, expect, test } from "bun:test";
import {
  adaptAndroidSessionDeviceCatalog,
  readAndroidSessionDeviceCatalog,
  type AndroidCatalogPolicy,
  type AndroidNativeCatalogReader,
} from "../../../src/devices/sessionCatalog";
import { readFileSync } from "node:fs";
import type {
  DeviceProfile,
  SystemImage,
} from "../../../src/utils/android-cmdline-tools/avdmanager";

const PROFILES: readonly DeviceProfile[] = [
  { id: "pixel_9", name: "Pixel 9", oem: "Google" },
  { id: "pixel_tablet", name: "Pixel Tablet", oem: "Google" },
  { id: "pixel_9_pro_fold", name: "Pixel 9 Pro Fold", oem: "Google" },
];

const POLICY: AndroidCatalogPolicy = {
  profileArchetypes: {
    pixel_9: "phone",
    pixel_tablet: "tablet",
  },
};

function systemImage(packageName: string): SystemImage {
  const [, api, tag, abi] = packageName.split(";");
  const apiIdentifier = api!.replace("android-", "");
  return {
    packageName,
    apiIdentifier,
    apiLevel: Number.parseInt(apiIdentifier, 10),
    tag: tag!,
    abi: abi!,
    versionInfo: "5 | Google APIs ARM 64 v8a System Image",
  };
}

const IMAGES = [
  systemImage("system-images;android-35;google_apis;arm64-v8a"),
  systemImage("system-images;android-35.1;google_apis;arm64-v8a"),
  systemImage("system-images;android-36;google_apis_playstore;arm64-v8a"),
] as const;

describe("Android native session catalog adapter", () => {
  test("uses exact installed profile IDs and leaves unconfigured categories unknown", () => {
    const catalog = adaptAndroidSessionDeviceCatalog(PROFILES, IMAGES, POLICY);

    expect(catalog.profiles).toEqual([
      { profileId: "pixel_9", archetype: "phone", metadataState: "current" },
      { profileId: "pixel_9_pro_fold", metadataState: "current" },
      { profileId: "pixel_tablet", archetype: "tablet", metadataState: "current" },
    ]);
  });

  test("keeps package identity while reporting only proven Android release precision", () => {
    const releases = adaptAndroidSessionDeviceCatalog(PROFILES, IMAGES, POLICY).releases;
    const api35 = releases.filter((release) => release.apiLevel === 35);

    expect(api35).toEqual([
      {
        systemImagePackage: "system-images;android-35;google_apis;arm64-v8a",
        osVersion: "15",
        versionPrecision: "major",
        apiLevel: 35,
        abi: "arm64-v8a",
        flavor: "google_apis",
        installed: true,
        metadataState: "current",
      },
      {
        systemImagePackage: "system-images;android-35.1;google_apis;arm64-v8a",
        osVersion: "15",
        versionPrecision: "major",
        apiLevel: 35,
        abi: "arm64-v8a",
        flavor: "google_apis",
        installed: true,
        metadataState: "current",
      },
    ]);
    expect(releases.find((release) => release.apiLevel === 36)).toMatchObject({
      osVersion: "16",
      versionPrecision: "major",
      flavor: "google_apis_playstore",
    });
  });

  test("marks contradictory native image metadata stale instead of repairing it", () => {
    const inconsistent = {
      ...IMAGES[0],
      apiLevel: 36,
    };
    const catalog = adaptAndroidSessionDeviceCatalog(PROFILES, [inconsistent], POLICY);

    expect(catalog.releases[0]).toMatchObject({
      systemImagePackage: IMAGES[0].packageName,
      apiLevel: 35,
      osVersion: "15",
      versionPrecision: "major",
      metadataState: "stale",
    });
  });

  test("propagates stale snapshot state and computes order-independent revisions", () => {
    const first = adaptAndroidSessionDeviceCatalog(PROFILES, IMAGES, POLICY);
    const reversed = adaptAndroidSessionDeviceCatalog(
      [...PROFILES].reverse(),
      [...IMAGES].reverse(),
      POLICY,
    );
    const stale = adaptAndroidSessionDeviceCatalog(PROFILES, IMAGES, POLICY, {
      metadataState: "stale",
    });

    expect(reversed.provenance.revision).toBe(first.provenance.revision);
    expect(stale.profiles.every((profile) => profile.metadataState === "stale")).toBe(true);
    expect(stale.releases.every((release) => release.metadataState === "stale")).toBe(true);
  });

  test("returns a logged unavailable catalog when native discovery fails", async () => {
    const failure = new Error("sdkmanager unavailable");
    const warnings: Array<{ message: string; error: unknown }> = [];
    const reader: AndroidNativeCatalogReader = {
      listDevices: async () => PROFILES.slice(),
      listInstalledSystemImages: async () => {
        throw failure;
      },
    };

    const catalog = await readAndroidSessionDeviceCatalog(reader, POLICY, {
      logger: { warn: (message, error) => warnings.push({ message, error }) },
    });

    expect(catalog).toMatchObject({
      platform: "android",
      provenance: {
        state: "unavailable",
        message: "Unable to read the installed Android emulator catalog: sdkmanager unavailable",
      },
      profiles: [],
      releases: [],
    });
    expect(warnings).toEqual([{ message: catalog.provenance.message!, error: failure }]);
  });

  test("does not certify an empty native profile listing as ready", async () => {
    const warnings: string[] = [];
    const reader: AndroidNativeCatalogReader = {
      listDevices: async () => [],
      listInstalledSystemImages: async () => [],
    };

    const catalog = await readAndroidSessionDeviceCatalog(reader, POLICY, {
      logger: { warn: (message) => warnings.push(message) },
    });

    expect(catalog.provenance).toMatchObject({
      state: "unavailable",
      message:
        "Unable to read the installed Android emulator catalog: Android emulator profile catalog returned no profiles.",
    });
    expect(warnings).toEqual([catalog.provenance.message!]);
  });

  test("resolves the captured API 37 image (android-37.0) to Android 17 (#12788)", () => {
    const fixtures = "test/fixtures/android-system-image-37";
    const source = readFileSync(`${fixtures}/source.properties`, "utf8");
    const buildProp = readFileSync(`${fixtures}/build.prop.excerpt`, "utf8");
    expect(source).toContain("AndroidVersion.ApiLevel=37.0");
    expect(buildProp).toContain("ro.build.version.release=17");

    const [release] = adaptAndroidSessionDeviceCatalog(
      PROFILES,
      [systemImage("system-images;android-37.0;google_apis;arm64-v8a")],
      POLICY,
    ).releases;
    expect(release).toMatchObject({ apiLevel: 37, osVersion: "17", metadataState: "current" });
  });
});
