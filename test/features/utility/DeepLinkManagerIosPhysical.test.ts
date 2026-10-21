import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  DeepLinkManager,
  physicalDeepLinkCacheKey,
  type PhysicalIosBundleSource,
} from "../../../src/features/utility/DeepLinkManager";
import { ActionableError, type BootedDevice, type DeepLinkResult } from "../../../src/models";
import type { AppBundleMetadata } from "../../../src/utils/ios-cmdline-tools/AppBundleMetadataClient";
import type { PlistReader } from "../../../src/utils/ios-cmdline-tools/PlistClient";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { FakeSimctl } from "../../fakes/FakeSimctl";

const SIM_UDID = "7B3A3792-DB53-4654-BA94-27A1D305C3B7";
const PHYSICAL_UDID = "00008110-000A1234567890AB";
const BUNDLE_ID = "com.example.deeplinkdemo";
const FIXTURE_BUNDLE = path.join(import.meta.dir, "../../fixtures/ios-app-bundle/DeepLinkDemo.app");

const physicalDevice: BootedDevice = { name: "iPhone", platform: "ios", deviceId: PHYSICAL_UDID };
const simulator: BootedDevice = { name: "iPhone 16", platform: "ios", deviceId: SIM_UDID };

/** Reads the fixture bundle's `Info.plist` from its committed JSON form (see the fixture README). */
const fixturePlist: PlistReader = {
  readJsonFile: async (file) => JSON.parse(readFileSync(`${file}.json`, "utf8")),
  readJsonBytes: async (bytes) => JSON.parse(bytes.toString("utf8")),
  readXmlFile: async () => "",
  readXmlBytes: async () => "",
  extractRawFile: async () => "",
};

const fixtureMetadata: AppBundleMetadata = {
  readEntitlements: async ({ appBundlePath }) =>
    JSON.parse(readFileSync(path.join(appBundlePath, "entitlements.json"), "utf8")),
};

class FakeBundleSource implements PhysicalIosBundleSource {
  copies = 0;
  constructor(
    private readonly options: {
      installed?: Record<string, unknown> | null;
      bundle?: string | null;
      copyError?: Error;
    } = {},
  ) {}

  async getInstalledAppInfo() {
    return this.options.installed === undefined
      ? { bundleIdentifier: BUNDLE_ID, version: "1.2.0", bundleVersion: "42" }
      : this.options.installed;
  }

  async withInstalledAppBundle<T>(
    _udid: string,
    _bundleId: string,
    fn: (bundlePath: string) => Promise<T>,
  ): Promise<T | null> {
    this.copies += 1;
    if (this.options.copyError) {
      throw this.options.copyError;
    }
    const bundle = this.options.bundle === undefined ? FIXTURE_BUNDLE : this.options.bundle;
    return bundle === null ? null : fn(bundle);
  }
}

function physicalManager(
  source: FakeBundleSource,
  cache: Map<string, DeepLinkResult> = new Map(),
): DeepLinkManager {
  return new DeepLinkManager(physicalDevice, new FakeAdbClientFactory(), {
    simctl: new FakeSimctl(),
    plist: fixturePlist,
    appBundleMetadata: fixtureMetadata,
    deviceApps: source,
    physicalDeepLinkCache: cache,
  });
}

describe("DeepLinkManager physical iOS (#14094)", () => {
  test("reports the same deep links as the Simulator for the same build", async () => {
    const simctl = new FakeSimctl();
    simctl.setCommandArgsResult(["get_app_container", SIM_UDID, BUNDLE_ID, "app"], FIXTURE_BUNDLE);
    const simulatorResult = await new DeepLinkManager(simulator, new FakeAdbClientFactory(), {
      simctl,
      plist: fixturePlist,
      appBundleMetadata: fixtureMetadata,
    }).getDeepLinks(BUNDLE_ID);

    const deviceResult = await physicalManager(new FakeBundleSource()).getDeepLinks(BUNDLE_ID);

    expect(deviceResult.success).toBe(true);
    expect(deviceResult.deepLinks).toEqual(simulatorResult.deepLinks);
    expect(deviceResult.deepLinks.schemes).toEqual(["deeplinkdemo", "ddemo", "ddemo-oauth"]);
    expect(deviceResult.deepLinks.supportedMimeTypes).toEqual(["public.png"]);
  });

  test("reports associated domains from the copied bundle's entitlements", async () => {
    const result = await physicalManager(new FakeBundleSource()).getDeepLinks(BUNDLE_ID);
    expect(result.deepLinks.hosts).toEqual(["demo.example.com", "*.demo.example.com"]);
  });

  test("a failed copy returns a typed failure carrying the devicectl stderr", async () => {
    const source = new FakeBundleSource({
      copyError: new ActionableError(
        `Failed to copy the installed ${BUNDLE_ID} bundle from device ${PHYSICAL_UDID}: ERROR: The device is locked.`,
      ),
    });
    const result = await physicalManager(source).getDeepLinks(BUNDLE_ID);
    expect(result.success).toBe(false);
    expect(result.error).toContain("The device is locked.");
    expect(result.deepLinks.schemes).toEqual([]);
  });

  test("an app that is not installed is reported as not installed", async () => {
    const result = await physicalManager(
      new FakeBundleSource({ installed: null, bundle: null }),
    ).getDeepLinks(BUNDLE_ID);
    expect(result).toMatchObject({ success: false });
    expect(result.error).toContain("not installed");
  });

  test("repeat calls for the same installed version reuse the first copy", async () => {
    const cache = new Map<string, DeepLinkResult>();
    const source = new FakeBundleSource();
    const first = await physicalManager(source, cache).getDeepLinks(BUNDLE_ID);
    const second = await physicalManager(source, cache).getDeepLinks(BUNDLE_ID);
    expect(second).toEqual(first);
    expect(source.copies).toBe(1);
  });

  test("a new installed version copies the bundle again", async () => {
    const cache = new Map<string, DeepLinkResult>();
    await physicalManager(new FakeBundleSource(), cache).getDeepLinks(BUNDLE_ID);
    const updated = new FakeBundleSource({
      installed: { bundleIdentifier: BUNDLE_ID, version: "1.3.0", bundleVersion: "43" },
    });
    await physicalManager(updated, cache).getDeepLinks(BUNDLE_ID);
    expect(updated.copies).toBe(1);
  });

  test("failures and version-less installs are never cached", async () => {
    const cache = new Map<string, DeepLinkResult>();
    const failing = new FakeBundleSource({ copyError: new Error("copy failed") });
    await physicalManager(failing, cache).getDeepLinks(BUNDLE_ID);
    const unversioned = new FakeBundleSource({ installed: { bundleIdentifier: BUNDLE_ID } });
    await physicalManager(unversioned, cache).getDeepLinks(BUNDLE_ID);
    await physicalManager(unversioned, cache).getDeepLinks(BUNDLE_ID);
    expect(cache.size).toBe(0);
    expect(unversioned.copies).toBe(2);
  });

  test("the cache key names the device, bundle and installed version", () => {
    expect(physicalDeepLinkCacheKey("udid", BUNDLE_ID, null)).toBeUndefined();
    expect(physicalDeepLinkCacheKey("udid", BUNDLE_ID, { version: "", bundleVersion: 7 })).toBe(
      undefined,
    );
    expect(
      physicalDeepLinkCacheKey("udid", BUNDLE_ID, { version: "1.0", bundleVersion: "7" }),
    ).toBe(JSON.stringify(["udid", BUNDLE_ID, "1.0", "7"]));
  });
});
