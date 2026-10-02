import { describe, expect, test, spyOn } from "bun:test";
import {
  PhysicalIosAppInfoBackend,
  PhysicalIosAppListBackend,
  resolveIosAppInfoBackend,
  resolveIosAppListBackend,
  SimulatorIosAppInfoBackend,
  SimulatorIosAppListBackend,
} from "../../../src/utils/ios-cmdline-tools/IosDeviceBackend";
import type { IosAppMetadataSource } from "../../../src/models/IosAppMetadataSource";
import type { IosInstalledAppRecord } from "../../../src/utils/ios-cmdline-tools/iosInstalledApp";
import { findAppByBundleId } from "../../../src/features/observe/GetAppMetadata";
import { logger } from "../../../src/utils/logger";

const simulatorId = "A1B2C3D4-E5F6-7890-ABCD-EF1234567890";
const modernPhysicalId = "00008030-001C2D3E1234567A";
const legacyPhysicalId = "a".repeat(40);
const bundleId = "com.example.app";
const app = { CFBundleIdentifier: ` ${bundleId} `, CFBundleVersion: "42" };

class FakeAppSource implements IosAppMetadataSource {
  readonly listCalls: Array<string | undefined> = [];
  readonly infoCalls: Array<{ deviceId: string; bundleId: string }> = [];
  apps: IosInstalledAppRecord[] = [{ bundleId: "com.other.app" }, app];
  error?: Error;

  async listApps(deviceId?: string): Promise<IosInstalledAppRecord[]> {
    this.listCalls.push(deviceId);
    if (this.error) {
      throw this.error;
    }
    return this.apps;
  }

  async getPhysicalDeviceAppInfo(
    deviceId: string,
    requestedBundleId: string,
  ): Promise<IosInstalledAppRecord | null> {
    this.infoCalls.push({ deviceId, bundleId: requestedBundleId });
    if (this.error) {
      throw this.error;
    }
    return findAppByBundleId(this.apps, requestedBundleId);
  }
}

class FakeAppLister {
  readonly calls: string[] = [];
  error?: Error;

  async listAppsOrThrow(deviceId?: string): Promise<IosInstalledAppRecord[]> {
    this.calls.push(deviceId ?? "");
    if (this.error) {
      throw this.error;
    }
    return [app];
  }

  listInstalledApps(deviceId: string): Promise<IosInstalledAppRecord[]> {
    return this.listAppsOrThrow(deviceId);
  }
}

describe("iOS app list and info backends", () => {
  for (const [deviceId, physicalList, simulatorInfo] of [
    [simulatorId, false, true],
    [modernPhysicalId, true, false],
    [legacyPhysicalId, true, false],
    ["unrecognized-device", false, false],
  ] as const) {
    test(`preserves each resolver's predicate and arguments for ${deviceId}`, async () => {
      const simctl = new FakeAppLister();
      const physical = new FakeAppLister();
      let physicalConstructions = 0;
      const list = resolveIosAppListBackend(deviceId, {
        simctl,
        getPhysicalAppLister: () => {
          physicalConstructions++;
          return physical;
        },
      });
      expect(list).toBeInstanceOf(
        physicalList ? PhysicalIosAppListBackend : SimulatorIosAppListBackend,
      );
      expect(physicalConstructions).toBe(0);
      expect(await list.listApps()).toEqual([app]);
      expect(physicalConstructions).toBe(physicalList ? 1 : 0);
      expect(simctl.calls).toEqual(physicalList ? [] : [deviceId]);
      expect(physical.calls).toEqual(physicalList ? [deviceId] : []);

      const iosSource = new FakeAppSource();
      const info = resolveIosAppInfoBackend(deviceId, { iosSource, findAppByBundleId });
      expect(info).toBeInstanceOf(
        simulatorInfo ? SimulatorIosAppInfoBackend : PhysicalIosAppInfoBackend,
      );
      expect(await info.getAppInfo(bundleId)).toBe(app);
      expect(iosSource.listCalls).toEqual(simulatorInfo ? [deviceId] : []);
      expect(iosSource.infoCalls).toEqual(simulatorInfo ? [] : [{ deviceId, bundleId }]);
    });
  }

  for (const deviceId of [simulatorId, modernPhysicalId]) {
    test(`propagates listing errors for ${deviceId}`, async () => {
      const lister = new FakeAppLister();
      const error = new Error("listing failed");
      lister.error = error;
      const backend = resolveIosAppListBackend(deviceId, {
        simctl: lister,
        getPhysicalAppLister: () => lister,
      });
      await expect(backend.listApps()).rejects.toBe(error);
    });

    test(`returns null and preserves metadata warning for ${deviceId}`, async () => {
      const iosSource = new FakeAppSource();
      iosSource.error = new Error("source failed");
      const warn = spyOn(logger, "warn").mockImplementation(() => undefined);
      try {
        const backend = resolveIosAppInfoBackend(deviceId, { iosSource, findAppByBundleId });
        expect(await backend.getAppInfo(bundleId)).toBeNull();
        expect(warn).toHaveBeenCalledWith(
          deviceId === simulatorId
            ? "[GetAppMetadata] Failed to list iOS apps: Error: source failed"
            : "[GetAppMetadata] Failed to get physical device app info: Error: source failed",
        );
      } finally {
        warn.mockRestore();
      }
    });

    test(`returns null for absent app for ${deviceId}`, async () => {
      const iosSource = new FakeAppSource();
      const backend = resolveIosAppInfoBackend(deviceId, { iosSource, findAppByBundleId });
      expect(await backend.getAppInfo("com.missing.app")).toBeNull();
    });
  }

  test("simulator uses the supplied finder after fetching the original list", async () => {
    const iosSource = new FakeAppSource();
    const calls: Array<{ apps: IosInstalledAppRecord[]; bundleId: string }> = [];
    const backend = resolveIosAppInfoBackend(simulatorId, {
      iosSource,
      findAppByBundleId: (apps, requestedBundleId) => {
        calls.push({ apps, bundleId: requestedBundleId });
        return app;
      },
    });
    expect(await backend.getAppInfo(bundleId)).toBe(app);
    expect(calls).toEqual([{ apps: iosSource.apps, bundleId }]);
    expect(calls[0].apps).toBe(iosSource.apps);
  });
});
