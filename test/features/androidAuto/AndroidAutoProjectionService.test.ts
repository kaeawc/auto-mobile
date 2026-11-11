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
const DEFAULT_CONFIG = path.join("/sdk", "extras", "google", "auto", "config", "default_720p.ini");
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
          configPath: request.dhu.configPath,
        };
      },
      stopDesktopHeadUnit: async () => false,
    };
    const applier = new DefaultAndroidAutoProjectionApplier(environment, runner);
    const report = await applier.apply(device, { apkDirectory: path.resolve("/apks") });
    expect(report).toEqual({
      steps: [{ step: "desktop-head-unit", status: "applied" }],
      desktopHeadUnit: { running: true, configPath: DEFAULT_CONFIG },
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
      stopDesktopHeadUnit: async () => false,
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
        return true;
      },
    };
    const applier = new DefaultAndroidAutoProjectionApplier(environment, runner);
    expect(await applier.stopDesktopHeadUnit("emulator-5554", { deviceStopped: true })).toBe(true);
    expect(stops).toEqual([["emulator-5554", { deviceStopped: true }]]);
  });

  describe("startHeadUnit (#17840)", () => {
    const connectedRunner = (
      requests: AndroidAutoProjectionRequest[],
    ): AndroidAutoProvisionRunner => ({
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
          configPath: request.dhu.configPath,
        };
      },
      stopDesktopHeadUnit: async () => false,
    });

    test("runs the same provisioner with no APKs, so a stub phone is refused rather than installed", async () => {
      const requests: AndroidAutoProjectionRequest[] = [];
      const applier = new DefaultAndroidAutoProjectionApplier(
        environment,
        connectedRunner(requests),
      );
      const report = await applier.startHeadUnit(device, {
        headUnit: { dhuConfig: "/configs/hu.ini" },
        acceptAndroidAutoTerms: true,
      });
      expect(requests).toHaveLength(1);
      // The caller's absolute path is kept as given (a drive-relative one too, on Windows).
      const configPath = requests[0]?.dhu.configPath;
      expect(configPath?.replaceAll("\\", "/").endsWith("/configs/hu.ini")).toBe(true);
      expect(report.desktopHeadUnit).toEqual({ running: true, configPath });
      expect(requests[0]).toMatchObject({
        deviceId: "emulator-5554",
        androidAutoApks: [],
        acceptAndroidAutoTerms: true,
        dhu: {
          binaryPath: path.join("/sdk", "extras", "google", "auto", "desktop-head-unit"),
        },
      });
    });

    test("a missing DHU names the headUnit field and never runs the provisioner", async () => {
      const requests: AndroidAutoProjectionRequest[] = [];
      const applier = new DefaultAndroidAutoProjectionApplier(
        { ...environment, files: { ...files, isFile: async () => false } },
        connectedRunner(requests),
      );
      await expect(applier.startHeadUnit(device, { headUnit: {} })).rejects.toThrow(
        "androidAuto.headUnit.dhuPath",
      );
      expect(requests).toHaveLength(0);
    });
  });
});
