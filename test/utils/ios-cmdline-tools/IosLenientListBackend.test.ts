import { loggerCallsWithPrefix } from "../../helpers/loggerCallsWithPrefix";
import { describe, expect, spyOn, test } from "bun:test";
import type { BootedDevice } from "../../../src/models";
import { logger } from "../../../src/utils/logger";
import { createIosMetadataSource } from "../../../src/utils/iosAppMetadataSource";
import { SimCtlClient } from "../../../src/utils/ios-cmdline-tools/SimCtlClient";
import {
  resolveIosLenientAppListBackend,
  resolveIosLenientTerminateBackend,
  resolveIosMetadataBackend,
  type IosLenientAppListBackendDeps,
} from "../../../src/utils/ios-cmdline-tools/IosDeviceBackend";

const simulatorId = "A1B2C3D4-E5F6-7890-ABCD-EF1234567890";
const physicalId = "00008030-001C2D3E1234567A";
const bundleId = "com.example.app";
const apps = [{ bundleId }, { CFBundleIdentifier: "com.example.legacy" }];

type LenientLister = IosLenientAppListBackendDeps["simctl"];

class FakeLenientLister implements LenientLister {
  calls: (string | undefined)[] = [];
  result: Record<string, unknown>[] = apps;
  error?: Error;

  async listApps(deviceId?: string): Promise<Record<string, unknown>[]> {
    this.calls.push(deviceId);
    if (this.error) {
      throw this.error;
    }
    return this.result;
  }
}

describe("lenient simulator listing backend", () => {
  for (const deviceId of [simulatorId, physicalId, "unknown", undefined]) {
    test(`forwards ${deviceId ?? "undefined"} unchanged and preserves records`, async () => {
      const simctl = new FakeLenientLister();
      const backend = resolveIosLenientAppListBackend(deviceId, { simctl });
      expect(backend.kind).toBe("simulator");
      expect(await backend.listApps()).toBe(apps);
      expect(simctl.calls).toEqual([deviceId]);
    });
  }

  test("preserves the empty-array result of a lenient transport failure", async () => {
    const simctl = new FakeLenientLister();
    simctl.result = [];
    expect(await resolveIosLenientAppListBackend(simulatorId, { simctl }).listApps()).toEqual([]);
  });

  test("does not intercept unexpected lister rejections needed by RestoreSnapshot's catch", async () => {
    const simctl = new FakeLenientLister();
    const error = new Error("unexpected listing failure");
    simctl.error = error;
    await expect(resolveIosLenientAppListBackend(simulatorId, { simctl }).listApps()).rejects.toBe(
      error,
    );
  });

  test("retains SimCtlClient's actual lenient failure warning without an extra backend warning", async () => {
    // Exercise the legacy method with a fake strict seam, never a transport.
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    const simctl = {
      listApps: (deviceId?: string) =>
        SimCtlClient.prototype.listApps.call(
          {
            listAppsOrThrow: async (id?: string) => {
              expect(id).toBe(simulatorId);
              throw new Error("transport failed");
            },
          },
          deviceId,
        ),
    };
    try {
      expect(await resolveIosLenientAppListBackend(simulatorId, { simctl }).listApps()).toEqual([]);
      expect(loggerCallsWithPrefix(warn.mock.calls, "Failed to list iOS apps:")).toEqual([
        ["Failed to list iOS apps: Error: transport failed"],
      ]);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("lenient termination backend", () => {
  test("uses the simulator terminate seam with the original argument order", async () => {
    const calls: (string | undefined)[][] = [];
    const backend = resolveIosLenientTerminateBackend(simulatorId, {
      simctl: {
        terminateApp: async (bundle, deviceId) => {
          calls.push([bundle, deviceId]);
        },
      },
    });
    expect(backend.kind).toBe("simulator");
    expect(await backend.terminateApp(bundleId)).toBeUndefined();
    expect(calls).toEqual([[bundleId, simulatorId]]);
  });

  test("swallows failures with the exact legacy warning", async () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const backend = resolveIosLenientTerminateBackend(simulatorId, {
        simctl: {
          terminateApp: async () => {
            throw new Error("not running");
          },
        },
      });
      await expect(backend.terminateApp(bundleId)).resolves.toBeUndefined();
      expect(loggerCallsWithPrefix(warn.mock.calls, "[iOS] Failed to terminate ")).toEqual([
        [`[iOS] Failed to terminate ${bundleId}: Error: not running`],
      ]);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("metadata backend", () => {
  test("factory options inject both transports and preserve the bound-device fallback", async () => {
    const calls: (string | undefined)[] = [];
    const device = { deviceId: simulatorId, platform: "ios" } as BootedDevice;
    const source = createIosMetadataSource(device, {
      simctl: {
        listApps: async (id) => {
          calls.push(id);
          return [{ bundleId: id ?? device.deviceId }];
        },
      },
      deviceAppManager: { getInstalledAppInfo: async () => null },
    });
    expect(await source.listApps()).toEqual([{ bundleId: simulatorId }]);
    expect(await source.listApps("override")).toEqual([{ bundleId: "override" }]);
    expect(calls).toEqual([undefined, "override"]);
  });

  test("forwards physical and unknown IDs to the metadata manager unchanged", async () => {
    const calls: string[][] = [];
    const source = resolveIosMetadataBackend({
      simctl: new FakeLenientLister(),
      deviceAppManager: {
        getInstalledAppInfo: async (id, bundle) => {
          calls.push([id, bundle]);
          return apps[0];
        },
      },
    });
    for (const id of [physicalId, "unknown"]) {
      expect(await source.getPhysicalDeviceAppInfo(id, bundleId)).toBe(apps[0]);
    }
    expect(calls).toEqual([
      [physicalId, bundleId],
      ["unknown", bundleId],
    ]);
  });

  test("preserves physical null results and raw failures without adding logs", async () => {
    const error = new Error("metadata unavailable");
    const source = resolveIosMetadataBackend({
      simctl: new FakeLenientLister(),
      deviceAppManager: {
        getInstalledAppInfo: async (_id, bundle) => {
          if (bundle === "missing") {
            return null;
          }
          throw error;
        },
      },
    });
    expect(await source.getPhysicalDeviceAppInfo(physicalId, "missing")).toBeNull();
    await expect(source.getPhysicalDeviceAppInfo(physicalId, bundleId)).rejects.toBe(error);
  });
});
