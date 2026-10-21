import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  IosPackageSigningInspector,
  physicalBundleAccess,
  simulatorBundleAccess,
  type IosPackageSigningInspectorDeps,
  type IosSigningBundleAccess,
} from "../../../src/features/observe/IosPackageSigningInspector";
import type { BootedDevice } from "../../../src/models";
import { createExecResult } from "../../../src/utils/execResult";
import { parseCodesignDisplay } from "../../../src/utils/ios-cmdline-tools/codesignDisplay";
import { FakeTimer } from "../../fakes/FakeTimer";

const APP = "dev.jasonpearson.automobile.Playground";
const SIMULATOR: BootedDevice = {
  deviceId: "5D1E0C2A-7A4B-4C8E-9F1D-2B3C4D5E6F70",
  platform: "ios",
  name: "iPhone 16",
};
const PHYSICAL: BootedDevice = {
  deviceId: "00008110-001A2B3C4D5E801E",
  platform: "ios",
  name: "iPhone",
};
const BUNDLE = "/bundles/Playground.app";
const NOW = Date.parse("2026-10-21T10:00:00Z");

const fixture = (name: string) =>
  readFileSync(join(import.meta.dir, "../../fixtures/ios-signing", name), "utf8");

const installedAt = (path: string | null): IosSigningBundleAccess => ({
  source: "simctl-app-container+codesign",
  withBundle: async (_appId, read) => (path ? read(path) : null),
});

function inspector(
  device: BootedDevice,
  overrides: Partial<IosPackageSigningInspectorDeps> & { display?: string; now?: number } = {},
) {
  const timer = new FakeTimer();
  timer.setCurrentTime(overrides.now ?? NOW);
  const decoded: string[] = [];
  const deps: IosPackageSigningInspectorDeps = {
    bundles: installedAt(BUNDLE),
    codesign: {
      readCodeSignature: async () =>
        parseCodesignDisplay(overrides.display ?? fixture("codesign-dvvv-development.txt")),
      readEntitlements: async () => ({ "get-task-allow": true }),
    },
    profiles: {
      decodeCms: async (path) => {
        decoded.push(path);
        return fixture("embedded-mobileprovision-development.plist");
      },
    },
    fileExists: async () => true,
    timer,
    ...overrides,
  };
  return { subject: new IosPackageSigningInspector(device, deps), decoded };
}

describe("IosPackageSigningInspector (#14099)", () => {
  test("a physical development build reports team, entitlements and the profile expiry", async () => {
    const { subject, decoded } = inspector(PHYSICAL);

    const result = await subject.execute(APP);

    expect(result).toEqual({
      appId: APP,
      platform: "ios",
      deviceId: PHYSICAL.deviceId,
      deviceKind: "physical",
      presence: "installed",
      signing: {
        status: "available",
        cdHash: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
        identifier: APP,
        teamId: "ABCDE12345",
        signingIdentity: "Apple Development: Jane Appleseed (Q7RST8UVW9)",
        adHoc: false,
        authorities: [
          "Apple Development: Jane Appleseed (Q7RST8UVW9)",
          "Apple Worldwide Developer Relations Certification Authority",
          "Apple Root CA",
        ],
        entitlements: { "get-task-allow": true },
        provisioningProfile: {
          name: "iOS Team Provisioning Profile: dev.jasonpearson.automobile.Playground",
          uuid: "8F6C2B1A-3D4E-4F50-9A6B-7C8D9E0F1A2B",
          teamIds: ["ABCDE12345"],
          teamName: "Jane Appleseed",
          expirationDate: "2027-04-21T09:00:00.000Z",
          expired: false,
          provisionedDeviceCount: 2,
          provisionsAllDevices: false,
        },
      },
      observation: {
        source: "simctl-app-container+codesign",
        fresh: true,
        observedAt: "2026-10-21T10:00:00.000Z",
        scope: { deviceId: PHYSICAL.deviceId, appId: APP },
      },
    });
    expect(decoded).toEqual([join(BUNDLE, "embedded.mobileprovision")]);
  });

  test("an ad-hoc Simulator build has no team and no embedded profile", async () => {
    const { subject, decoded } = inspector(SIMULATOR, {
      display: fixture("codesign-dvvv-simulator-adhoc.txt"),
      fileExists: async () => false,
    });

    const result = await subject.execute(APP);

    expect(result.deviceKind).toBe("simulator");
    expect(result.presence).toBe("installed");
    expect(result.signing).toMatchObject({
      status: "available",
      adHoc: true,
      teamId: null,
      signingIdentity: null,
      provisioningProfile: null,
    });
    expect(decoded).toEqual([]);
  });

  test("an absent bundle returns absent, not an error", async () => {
    const { subject } = inspector(SIMULATOR, { bundles: installedAt(null) });
    const result = await subject.execute(APP);
    expect(result.presence).toBe("absent");
    expect(result.signing).toEqual({ status: "unavailable", reason: "App is not installed" });
  });

  test("a failed bundle lookup is unknown, never absent", async () => {
    const { subject } = inspector(PHYSICAL, {
      bundles: {
        source: "devicectl-copy+codesign",
        withBundle: async () => {
          throw new Error("devicectl copy failed");
        },
      },
    });
    const result = await subject.execute(APP);
    expect(result.presence).toBe("unknown");
    expect(result.unknownReason).toContain("devicectl copy failed");
    expect(result.observation.source).toBe("devicectl-copy+codesign");
  });

  test("an unsigned bundle is installed with signing status unsigned", async () => {
    const { subject } = inspector(SIMULATOR, {
      codesign: { readCodeSignature: async () => null, readEntitlements: async () => null },
    });
    const result = await subject.execute(APP);
    expect(result.presence).toBe("installed");
    expect(result.signing.status).toBe("unsigned");
  });

  test("a profile that fails to decode leaves the signature and records a warning", async () => {
    const { subject } = inspector(PHYSICAL, {
      profiles: {
        decodeCms: async () => {
          throw new Error("security: decode failed");
        },
      },
    });
    const result = await subject.execute(APP);
    expect(result.signing).toMatchObject({
      status: "available",
      teamId: "ABCDE12345",
      provisioningProfile: null,
      warnings: ["provisioning profile unavailable: security: decode failed"],
    });
  });

  test("an expired profile is flagged against host time", async () => {
    const { subject } = inspector(PHYSICAL, { now: Date.parse("2028-01-01T00:00:00Z") });
    const result = await subject.execute(APP);
    expect(result.signing).toMatchObject({ provisioningProfile: { expired: true } });
  });

  test("an invalid bundle id is refused before any read", async () => {
    let reads = 0;
    const { subject } = inspector(SIMULATOR, {
      bundles: {
        source: "simctl-app-container+codesign",
        withBundle: async () => {
          reads += 1;
          return null;
        },
      },
    });
    await expect(subject.execute("bad id; rm -rf")).rejects.toThrow("Invalid iOS bundle");
    await expect(subject.execute(APP, { userId: 10 })).rejects.toThrow("userId is Android-only");
    expect(reads).toBe(0);
  });
});

describe("iOS signing bundle access (#14099)", () => {
  test("the Simulator reads the app container in place", async () => {
    const calls: string[][] = [];
    const access = simulatorBundleAccess(SIMULATOR.deviceId, {
      executeCommandArgs: async (args: string[]) => {
        calls.push(args);
        return createExecResult(`${BUNDLE}\n`, "");
      },
    });
    await expect(access.withBundle(APP, async (path) => path)).resolves.toBe(BUNDLE);
    expect(calls).toEqual([["get_app_container", SIMULATOR.deviceId, APP, "app"]]);
  });

  test("a missing Simulator container reads as not installed", async () => {
    const access = simulatorBundleAccess(SIMULATOR.deviceId, {
      executeCommandArgs: async () => {
        throw new Error("simctl: No such file or directory");
      },
    });
    await expect(access.withBundle(APP, async () => "read")).resolves.toBeNull();
  });

  test("any other Simulator lookup failure propagates", async () => {
    const access = simulatorBundleAccess(SIMULATOR.deviceId, {
      executeCommandArgs: async () => {
        throw new Error("CoreSimulatorService connection invalid");
      },
    });
    await expect(access.withBundle(APP, async () => "read")).rejects.toThrow("CoreSimulator");
  });

  test("a physical device copies the bundle with lookup errors surfaced", async () => {
    const calls: unknown[] = [];
    const access = physicalBundleAccess(PHYSICAL.deviceId, {
      withInstalledAppBundle: async <T>(
        udid: string,
        bundleId: string,
        read: (path: string) => Promise<T>,
        options?: { surfaceLookupErrors?: boolean },
      ) => {
        calls.push({ udid, bundleId, options });
        return read(BUNDLE);
      },
    });
    await expect(access.withBundle(APP, async (path) => path)).resolves.toBe(BUNDLE);
    expect(calls).toEqual([
      { udid: PHYSICAL.deviceId, bundleId: APP, options: { surfaceLookupErrors: true } },
    ]);
  });
});
