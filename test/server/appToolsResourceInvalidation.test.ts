import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  registerAppTools,
  resetCrashAppToolDependencies,
  resetInstallAppToolDependencies,
  resetInstalledAppResourceRefresh,
  resetLaunchAppToolDependencies,
  resetTerminateAppToolDependencies,
  resetUninstallAppToolDependencies,
  setCrashAppToolDependencies,
  setInstallAppToolDependencies,
  setInstalledAppResourceRefresh,
  setLaunchAppToolDependencies,
  setTerminateAppToolDependencies,
  setUninstallAppToolDependencies,
} from "../../src/server/appTools";
import type { BootedDevice } from "../../src/models";
import { ToolRegistry } from "../../src/server/toolRegistry";

const device: BootedDevice = { deviceId: "test-device", name: "Test", platform: "android" };
const appId = "com.example.app";

type Outcome = "success" | "failure" | "aborted-before" | "aborted-after";

const resultFor = (tool: string, success: boolean): Record<string, unknown> => {
  switch (tool) {
    case "launchApp":
      return { success, packageName: appId, ...(success ? {} : { error: "failed" }) };
    case "terminateApp":
      return {
        success,
        packageName: appId,
        wasForeground: false,
        ...(success ? {} : { error: "failed" }),
      };
    case "crashApp":
      return {
        success,
        supported: true,
        platform: "android",
        appId,
        mechanism: "android_am_crash",
        timestamp: 1,
        confirmed: success,
      };
    case "installApp":
      return { success, ...(success ? {} : { error: "failed" }) };
    default:
      return {
        success,
        packageName: appId,
        keepData: false,
        wasInstalled: true,
        ...(success ? {} : { error: "failed" }),
      };
  }
};

describe("app tool installed-app cache invalidation", () => {
  beforeEach(() => {
    ToolRegistry.clearTools();
    resetLaunchAppToolDependencies();
    resetTerminateAppToolDependencies();
    resetCrashAppToolDependencies();
    resetInstallAppToolDependencies();
    resetUninstallAppToolDependencies();
    resetInstalledAppResourceRefresh();
    registerAppTools();
  });

  afterEach(() => {
    ToolRegistry.clearTools();
    resetLaunchAppToolDependencies();
    resetTerminateAppToolDependencies();
    resetCrashAppToolDependencies();
    resetInstallAppToolDependencies();
    resetUninstallAppToolDependencies();
    resetInstalledAppResourceRefresh();
  });

  const configure = (tool: string, execute: () => Promise<Record<string, unknown>>): void => {
    const executor = { execute: async (..._args: unknown[]) => await execute() };
    if (tool === "launchApp") {
      setLaunchAppToolDependencies({ createLaunchApp: () => executor });
    }
    if (tool === "terminateApp") {
      setTerminateAppToolDependencies({ createTerminateApp: () => executor });
    }
    if (tool === "crashApp") {
      setCrashAppToolDependencies({ createCrashApp: () => executor });
    }
    if (tool === "installApp") {
      setInstallAppToolDependencies({ createInstallApp: () => executor });
    }
    if (tool === "uninstallApp") {
      setUninstallAppToolDependencies({ createUninstallApp: () => executor });
    }
  };

  const cases: Array<{ tool: string; args: Record<string, string> }> = [
    { tool: "launchApp", args: { appId } },
    { tool: "terminateApp", args: { appId } },
    { tool: "crashApp", args: { appId } },
    { tool: "installApp", args: { artifactPath: "/tmp/app.apk" } },
    { tool: "uninstallApp", args: { appId } },
  ];

  for (const { tool, args } of cases) {
    for (const outcome of ["success", "failure", "aborted-before", "aborted-after"] as Outcome[]) {
      test(`${tool} invalidates cache for ${outcome}`, async () => {
        let invalidations = 0;
        setInstalledAppResourceRefresh({
          invalidate: () => invalidations++,
          notify: async () => {},
        });
        const controller = new AbortController();
        let dispatched = false;
        configure(tool, async () => {
          dispatched = true;
          if (outcome === "aborted-after") {
            controller.abort();
            controller.signal.throwIfAborted();
          }
          if (outcome === "failure") {
            throw new Error("failed");
          }
          return resultFor(tool, outcome !== "failure");
        });
        if (outcome === "aborted-before") {
          controller.abort();
        }
        const handler = ToolRegistry.getTool(tool)!.deviceAwareHandler!;
        const pending = handler(device, args, undefined, controller.signal);
        if (outcome === "failure" || outcome.startsWith("aborted")) {
          await expect(pending).rejects.toThrow();
        } else {
          await pending;
        }
        expect(dispatched).toBe(outcome !== "aborted-before");
        expect(invalidations).toBe(outcome === "aborted-before" ? 0 : 1);
      });
    }
  }
});
