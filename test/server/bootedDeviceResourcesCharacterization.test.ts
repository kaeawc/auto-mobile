import { afterEach, expect, spyOn, test } from "bun:test";
import { queryDeviceServiceStatus } from "../../src/server/bootedDeviceResources";
import { IOSCtrlProxyManager } from "../../src/ctrlProxy/IOSCtrlProxyManager";
import type { ForcedRestartSnapshot } from "../../src/ctrlProxy/ForcedRestartBudget";
import {
  IOSCtrlProxyClient,
  IOS_RUNNER_FEATURE_FLAGS,
} from "../../src/features/observe/ios/IOSCtrlProxyClient";
import { FakeTimer } from "../fakes/FakeTimer";
import { AndroidCtrlProxyManager } from "../../src/ctrlProxy/CtrlProxyManager";
import * as release from "../../src/constants/release";

for (const expectedSha256 of ["", "ABC"]) {
  for (const installedSha256 of [null, "abc", "other"]) {
    for (const unverifiable of [false, true]) {
      test(`Android checksum expected=${expectedSha256}, installed=${installedSha256}, unverifiable=${unverifiable}`, async () => {
        const checksum = spyOn(release, "resolveApkChecksum").mockReturnValue(expectedSha256);
        const pin = spyOn(AndroidCtrlProxyManager, "isPinnedVersionUnverifiable").mockReturnValue(
          unverifiable,
        );
        const events: string[] = [];
        try {
          const status = await queryDeviceServiceStatus(
            { name: "Pixel", platform: "android", deviceId: "emulator-5554" },
            {
              getManager: () => ({
                isInstalled: async () => {
                  events.push("installed");
                  return true;
                },
                isEnabled: async () => {
                  events.push("enabled");
                  return false;
                },
                getInstalledApkSha256: async () => {
                  events.push("hash");
                  return installedSha256;
                },
              }),
              isConnected: () => {
                events.push("connected");
                return true;
              },
            },
            {
              getVersion: async () => {
                events.push("version");
                return { versionCode: "123", source: "android-package" };
              },
            },
            new FakeTimer(),
          );
          expect(status).toEqual({
            installed: true,
            enabled: false,
            running: true,
            installedSha256,
            expectedSha256,
            isCompatible: !unverifiable && (expectedSha256 === "" || installedSha256 === "abc"),
            version: "123",
            versionInfo: { versionCode: "123", source: "android-package" },
          });
          expect(events).toEqual(["installed", "enabled", "hash", "version", "connected"]);
        } finally {
          checksum.mockRestore();
          pin.mockRestore();
        }
      });
    }
  }
}

afterEach(() => {
  IOSCtrlProxyManager.resetInstances();
});

for (const commands of [null, [], ["required"]]) {
  for (const features of [null, [], [...IOS_RUNNER_FEATURE_FLAGS]]) {
    test(`iOS cached handshake commands=${JSON.stringify(commands)}, features=${JSON.stringify(features)}`, async () => {
      const events: string[] = [];
      const manager = spyOn(IOSCtrlProxyManager, "getInstance").mockReturnValue({
        isInstalled: async () => {
          events.push("installed");
          return true;
        },
        checkRunningWithReason: async () => {
          events.push("health");
          return { ok: true };
        },
        getForcedRestartBudget: () => ({
          snapshot: () => {
            events.push("recovery");
            return { state: "idle", attempts: 0 };
          },
        }),
      } as unknown as IOSCtrlProxyManager);
      const client = spyOn(IOSCtrlProxyClient, "getExistingInstance").mockReturnValue({
        getCachedSupportedCommands: () => {
          events.push("commands");
          return commands;
        },
        getCachedSupportedFeatures: () => {
          events.push("features");
          return features;
        },
      } as unknown as IOSCtrlProxyClient);
      try {
        const status = await queryDeviceServiceStatus(
          { name: "iPhone", platform: "ios", deviceId: "characterization" },
          undefined,
          {
            getVersion: async () => {
              events.push("version");
              return undefined;
            },
          },
          new FakeTimer(),
          { runnerCommandRequirements: { requiredCommands: ["required"], applicability: {} } },
        );
        expect(status?.supportedCommandsComplete).toBe(
          commands === null ? null : commands.includes("required"),
        );
        expect(status?.supportedFeaturesComplete).toBe(
          features === null ? null : features.length > 0,
        );
        expect(status?.isCompatible).toBe(
          commands?.includes("required") === true && (features?.length ?? 0) > 0,
        );
        expect(status).not.toHaveProperty("recovery");
        expect(events).toEqual([
          "installed",
          "health",
          "version",
          "commands",
          "features",
          "recovery",
        ]);
      } finally {
        manager.mockRestore();
        client.mockRestore();
      }
    });
  }
}

for (const state of ["backoff", "exhausted", "suspended"] as const) {
  for (const hasReason of [false, true]) {
    test(`iOS ${state} recovery with reason=${hasReason} while stopped`, async () => {
      const recovery: ForcedRestartSnapshot = {
        state,
        attempts: 2,
        ...(hasReason ? { lastFailureReason: "private exception", nextAttemptAtMs: 5000 } : {}),
      };
      const manager = spyOn(IOSCtrlProxyManager, "getInstance").mockReturnValue({
        isInstalled: async () => true,
        checkRunningWithReason: async () => ({ ok: false, reason: "unhealthy" }),
        getForcedRestartBudget: () => ({ snapshot: () => recovery }),
      } as unknown as IOSCtrlProxyManager);
      const client = spyOn(IOSCtrlProxyClient, "getExistingInstance").mockImplementation(() => {
        throw new Error("stopped runner must not read cache");
      });
      try {
        const status = await queryDeviceServiceStatus(
          { name: "iPhone", platform: "ios", deviceId: "characterization" },
          undefined,
          { getVersion: async () => ({ build: "build", source: "ios-runner-bundle" }) },
          new FakeTimer(),
        );
        expect(status?.supportedCommandsComplete).toBeNull();
        expect(status?.supportedFeaturesComplete).toBeNull();
        expect(status?.isCompatible).toBe(false);
        expect(status).not.toHaveProperty("versionInfo");
        expect(status?.recovery).toEqual({
          state,
          attempts: 2,
          ...(hasReason
            ? {
                reason:
                  state === "suspended"
                    ? "device removed or cleanup failed"
                    : "CtrlProxy restart failed",
                nextAttemptAt: "1970-01-01T00:00:05.000Z",
              }
            : {}),
        });
      } finally {
        manager.mockRestore();
        client.mockRestore();
      }
    });
  }
}
