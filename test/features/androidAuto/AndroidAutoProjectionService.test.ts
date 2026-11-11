import { describe, expect, test } from "bun:test";
import path from "node:path";
import type { AndroidAutoProjectionRequest } from "../../../src/features/androidAuto/AndroidAutoProjectionProvisioner";
import {
  DefaultAndroidAutoProjectionApplier,
  type AndroidAutoProvisionRunner,
} from "../../../src/features/androidAuto/AndroidAutoProjectionService";
import type { AndroidAutoHostFiles } from "../../../src/features/androidAuto/androidAutoProvisionInputs";

const files: AndroidAutoHostFiles = {
  isDirectory: async (target) => target === path.resolve("/apks"),
  isFile: async () => true,
  list: async () => ["base.apk", "split_config.en.apk"],
};

const environment = { env: { ANDROID_HOME: "/sdk" }, platform: "linux" as const, files };
const device = { deviceId: "emulator-5554", platform: "android" as const, name: "Pixel_9" };

describe("DefaultAndroidAutoProjectionApplier", () => {
  test("runs the provisioner on the booted device with the resolved host inputs", async () => {
    const requests: AndroidAutoProjectionRequest[] = [];
    const runner: AndroidAutoProvisionRunner = {
      provision: async (request) => {
        requests.push(request);
        return {
          steps: [{ step: "desktop-head-unit", status: "applied" }],
          session: {
            sendCommand: () => {},
            isRunning: () => true,
            isAlive: () => true,
            stop: async () => {},
          },
        };
      },
      stopDesktopHeadUnit: async () => {},
    };
    const applier = new DefaultAndroidAutoProjectionApplier(environment, runner);
    const report = await applier.apply(device, { apkDirectory: path.resolve("/apks") });
    expect(report).toEqual({
      steps: [{ step: "desktop-head-unit", status: "applied" }],
      desktopHeadUnit: { running: true },
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      deviceId: "emulator-5554",
      acceptAndroidAutoTerms: false,
    });
    expect(requests[0]?.androidAutoApks).toHaveLength(2);
  });

  test("missing host inputs refuse before the provisioner runs", async () => {
    let runs = 0;
    const runner: AndroidAutoProvisionRunner = {
      provision: async () => {
        runs++;
        throw new Error("unreachable");
      },
      stopDesktopHeadUnit: async () => {},
    };
    const applier = new DefaultAndroidAutoProjectionApplier(environment, runner);
    await expect(applier.apply(device, { apkDirectory: "/missing" })).rejects.toThrow(
      "does not exist",
    );
    expect(runs).toBe(0);
  });

  test("stopDesktopHeadUnit forwards the device and its stop reason to the provisioner", async () => {
    const stops: Array<[string, unknown]> = [];
    const runner: AndroidAutoProvisionRunner = {
      provision: async () => {
        throw new Error("unreachable");
      },
      stopDesktopHeadUnit: async (deviceId, options) => {
        stops.push([deviceId, options]);
      },
    };
    const applier = new DefaultAndroidAutoProjectionApplier(environment, runner);
    await applier.stopDesktopHeadUnit("emulator-5554", { deviceStopped: true });
    expect(stops).toEqual([["emulator-5554", { deviceStopped: true }]]);
  });
});
