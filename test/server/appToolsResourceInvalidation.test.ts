import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  registerAppTools,
  resetInstalledAppResourceRefresh,
  setInstalledAppResourceRefresh,
} from "../../src/server/appTools";
import type {
  BootedDevice,
  CrashAppResult,
  InstallAppResult,
  LaunchAppResult,
  TerminateAppResult,
  UninstallAppResult,
} from "../../src/models";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { createAppToolsHarness } from "../helpers/appToolsHarness";
import { isolateToolRegistry } from "../helpers/withTemporaryTool";

isolateToolRegistry();

const appTools = createAppToolsHarness();

const device: BootedDevice = { deviceId: "test-device", name: "Test", platform: "android" };
const appId = "com.example.app";

type Outcome = "success" | "failure" | "aborted-before" | "aborted-after";

const successResults = {
  launchApp: (): LaunchAppResult => ({ success: true, packageName: appId }),
  terminateApp: (): TerminateAppResult => ({
    success: true,
    packageName: appId,
    wasForeground: false,
  }),
  crashApp: (): CrashAppResult => ({
    success: true,
    supported: true,
    platform: "android",
    appId,
    mechanism: "android_am_crash",
    timestamp: 1,
    confirmed: true,
  }),
  installApp: (): InstallAppResult => ({ success: true }),
  uninstallApp: (): UninstallAppResult => ({
    success: true,
    packageName: appId,
    keepData: false,
    wasInstalled: true,
  }),
};

type ToolName = keyof typeof successResults;

describe("app tool installed-app cache invalidation", () => {
  beforeEach(() => {
    ToolRegistry.clearTools();
    resetInstalledAppResourceRefresh();
    registerAppTools();
  });

  afterEach(() => {
    appTools.clear();
    resetInstalledAppResourceRefresh();
  });

  /** Configures `tool` so its executor runs `before`, then resolves with a successful result. */
  const configure = (tool: ToolName, before: () => Promise<void>): void => {
    switch (tool) {
      case "launchApp":
        appTools.configure("launchApp", {
          createLaunchApp: () => ({
            execute: async () => {
              await before();
              return successResults.launchApp();
            },
          }),
        });
        return;
      case "terminateApp":
        appTools.configure("terminateApp", {
          createTerminateApp: () => ({
            execute: async () => {
              await before();
              return successResults.terminateApp();
            },
          }),
        });
        return;
      case "crashApp":
        appTools.configure("crashApp", {
          createCrashApp: () => ({
            execute: async () => {
              await before();
              return successResults.crashApp();
            },
          }),
        });
        return;
      case "installApp":
        appTools.configure("installApp", {
          createInstallApp: () => ({
            execute: async () => {
              await before();
              return successResults.installApp();
            },
          }),
        });
        return;
      case "uninstallApp":
        appTools.configure("uninstallApp", {
          createUninstallApp: () => ({
            execute: async () => {
              await before();
              return successResults.uninstallApp();
            },
          }),
        });
        return;
    }
  };

  const cases: Array<{ tool: ToolName; args: Record<string, string> }> = [
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
