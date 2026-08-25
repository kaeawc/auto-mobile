import { describe, expect, test } from "bun:test";
import { SimCtlClient } from "../../../src/utils/ios-cmdline-tools/SimCtlClient";
import type { PlistReader } from "../../../src/utils/ios-cmdline-tools/PlistClient";
import { BootedDevice } from "../../../src/models";
import { createExecResult } from "../../../src/utils/execResult";

describe("SimCtlClient listApps", () => {
  test("runs listapps with argv and uses --all flag", async () => {
    const device: BootedDevice = {
      deviceId: "ios-device-123",
      name: "iOS Device",
      platform: "ios",
      source: "local",
    };
    const execCalls: string[] = [];
    const execAsync = async (file: string, args: string[]) => {
      const cmd = `${file} ${args.join(" ")}`;
      execCalls.push(cmd);
      if (args.join(" ") === "simctl --version") {
        return createExecResult("simctl version 1.0.0", "");
      }
      if (cmd === "xcrun simctl listapps ios-device-123 --all") {
        const payload = JSON.stringify({
          "com.apple.Preferences": { bundleName: "Settings" },
        });
        return createExecResult(payload, "");
      }
      return createExecResult("{}", "");
    };

    const simctl = new SimCtlClient(device, execAsync);
    const apps = await simctl.listApps();

    expect(execCalls).toContain("xcrun simctl listapps ios-device-123 --all");
    expect(execCalls.some((c) => c.startsWith("/bin/sh "))).toBe(false);
    expect(apps).toEqual([{ bundleId: "com.apple.Preferences", bundleName: "Settings" }]);
  });

  test("falls back to listapps without --all when --all fails", async () => {
    const device: BootedDevice = {
      deviceId: "ios-device-456",
      name: "iOS Device",
      platform: "ios",
      source: "local",
    };
    const execCalls: string[] = [];
    const execAsync = async (file: string, args: string[]) => {
      const cmd = `${file} ${args.join(" ")}`;
      execCalls.push(cmd);
      if (args.join(" ") === "simctl --version") {
        return createExecResult("simctl version 1.0.0", "");
      }
      if (cmd === "xcrun simctl listapps ios-device-456 --all") {
        throw new Error("unknown option: --all");
      }
      if (cmd === "xcrun simctl listapps ios-device-456") {
        const payload = JSON.stringify({
          "com.apple.Fitness": { bundleName: "Fitness" },
        });
        return createExecResult(payload, "");
      }
      return createExecResult("{}", "");
    };

    const simctl = new SimCtlClient(device, execAsync);
    const apps = await simctl.listApps();

    expect(execCalls).toContain("xcrun simctl listapps ios-device-456 --all");
    expect(execCalls).toContain("xcrun simctl listapps ios-device-456");
    expect(apps).toEqual([{ bundleId: "com.apple.Fitness", bundleName: "Fitness" }]);
  });

  test("converts plist output through the bytes-safe PlistClient path", async () => {
    const device: BootedDevice = {
      deviceId: "ios-device-plist",
      name: "iOS Device",
      platform: "ios",
      source: "local",
    };
    const calls: string[] = [];
    let converted: Buffer | undefined;
    const plist: PlistReader = {
      readJsonFile: async () => ({}),
      readJsonBytes: async (bytes) => {
        converted = bytes;
        return { "com.apple.Maps": { bundleName: "Maps" } };
      },
      readXmlFile: async () => "",
      readXmlBytes: async () => "",
      extractRawFile: async () => "",
    };
    const execAsync = async (file: string, args: string[]) => {
      calls.push(`${file} ${args.join(" ")}`);
      if (args.join(" ") === "simctl --version") {
        return createExecResult("simctl version 1.0.0", "");
      }
      if (args.join(" ") === "simctl listapps ios-device-plist --all") {
        return createExecResult("<plist />", "");
      }
      return createExecResult("", "");
    };

    const apps = await new SimCtlClient(
      device,
      execAsync,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      plist,
    ).listApps();

    expect(converted?.toString("utf8")).toBe("<plist />");
    expect(calls.some((call) => call.startsWith("plutil "))).toBe(false);
    expect(apps).toEqual([{ bundleId: "com.apple.Maps", bundleName: "Maps" }]);
  });

  // Issue #5621: `listApps` keeps its lenient "failure reads as no apps"
  // contract for existing callers, but the install pre-checks in UninstallApp /
  // TerminateApp need the failure preserved, so `listAppsOrThrow` propagates it.
  const failingSimctl = (deviceId: string): SimCtlClient => {
    const device: BootedDevice = {
      deviceId,
      name: "iOS Device",
      platform: "ios",
      source: "local",
    };
    const execAsync = async (file: string, args: string[]) => {
      if (args.join(" ") === "simctl --version") {
        return createExecResult("simctl version 1.0.0", "");
      }
      throw new Error("Unable to boot device in current state");
    };
    return new SimCtlClient(device, execAsync);
  };

  test("listAppsOrThrow propagates a listing failure", async () => {
    const simctl = failingSimctl("ios-device-fails");

    await expect(simctl.listAppsOrThrow()).rejects.toThrow(
      "Unable to boot device in current state",
    );
  });

  test("listApps still collapses a listing failure into an empty array", async () => {
    const simctl = failingSimctl("ios-device-fails-lenient");

    expect(await simctl.listApps()).toEqual([]);
  });
});
