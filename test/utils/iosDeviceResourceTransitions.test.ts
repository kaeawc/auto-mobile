import { beforeEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DefaultDeviceResourceController,
  type DeviceResourceRequest,
} from "../../src/utils/deviceResourceController";
import {
  IOS_RESOURCE_COMMAND_TIMEOUT_MS,
  IosDeviceResourceReader,
} from "../../src/utils/iosDeviceResourceReader";
import { createExecResult } from "../../src/utils/execResult";
import { logger } from "../../src/utils/logger";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeDeviceResourceApplicationStore } from "../fakes/FakeDeviceResourceApplicationStore";
import {
  FakeWallpaperPlist,
  FakeWallpaperSimctl,
  label,
  runtime,
  udid,
} from "../fakes/FakeIosResourceRuntime";

const fixtures = join(import.meta.dir, "..", "fixtures", "ios-simctl");
const capturedDevices = readFileSync(join(fixtures, "list-devices.json"), "utf8");

function isPrintDisabled(args: string[]): boolean {
  return args[3] === "print-disabled";
}

describe("iOS Simulator service transitions (#6693)", () => {
  let simctl: FakeWallpaperSimctl;
  let plist: FakeWallpaperPlist;
  let timer: FakeTimer;
  let store: FakeDeviceResourceApplicationStore;
  let controller: DefaultDeviceResourceController;
  let request: DeviceResourceRequest;
  beforeEach(() => {
    simctl = new FakeWallpaperSimctl();
    plist = new FakeWallpaperPlist();
    timer = new FakeTimer();
    timer.enableAutoAdvance();
    store = new FakeDeviceResourceApplicationStore();
    controller = new DefaultDeviceResourceController(
      simctl,
      plist,
      timer,
      (path) => plist.readDirectory(path),
      undefined,
      store,
    );
    request = {
      device: { platform: "ios", name: "Phone", deviceId: udid },
      resources: { wallpaperRendering: "disabled" },
      deadlineMs: 600_000,
    };
  });

  test("bounds every native command even when the request deadline is far away", async () => {
    await controller.setResources(request);
    expect(simctl.budgets.length).toBeGreaterThan(0);
    expect(Math.max(...simctl.budgets)).toBe(IOS_RESOURCE_COMMAND_TIMEOUT_MS);
  });

  test("retries a transient override read and still applies only the delta", async () => {
    let failures = 1;
    simctl.onCommand = (args) => {
      if (isPrintDisabled(args) && failures-- > 0) {
        throw new Error("CoreSimulatorService connection interrupted");
      }
    };
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const result = await controller.setResources(request);
      expect(result.success).toBe(true);
      expect(simctl.mutations()).toEqual([
        ["spawn", udid, "launchctl", "disable", `system/${label}`],
        ["spawn", udid, "launchctl", "bootout", `system/${label}`],
      ]);
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  test("never retries a mutation; a failed write is reported per service", async () => {
    simctl.failVerb = "disable";
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const result = await controller.setResources(request);
      expect(result.success).toBe(false);
      expect(result.resources.wallpaperRendering?.state).toBe("unknown");
      expect(result.services?.wallpaperRendering?.[label]).toEqual({
        state: "unknown",
        reason: "permission denied",
      });
      expect(simctl.calls.filter((args) => args[3] === "disable")).toHaveLength(1);
      expect(store.records.size).toBe(0);
    } finally {
      warn.mockRestore();
    }
  });

  test("exhausted read retries fail closed as unknown without any write", async () => {
    simctl.onCommand = (args) => {
      if (isPrintDisabled(args)) {
        throw new Error("CoreSimulatorService connection interrupted");
      }
    };
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const result = await controller.setResources(request);
      expect(result.resources.wallpaperRendering?.state).toBe("unknown");
      expect(simctl.calls.filter(isPrintDisabled)).toHaveLength(3);
      expect(simctl.mutations()).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });

  test("cancellation during a retry backoff stops before any write", async () => {
    const abort = new AbortController();
    const manual = new FakeTimer();
    const cancellable = new DefaultDeviceResourceController(simctl, plist, manual, (path) =>
      plist.readDirectory(path),
    );
    simctl.onCommand = (args) => {
      if (isPrintDisabled(args)) {
        throw new Error("CoreSimulatorService connection interrupted");
      }
    };
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const pending = cancellable.setResources({ ...request, signal: abort.signal });
      while (manual.getPendingSleepCount() === 0) {
        await Promise.resolve();
      }
      abort.abort(new Error("caller cancelled"));
      manual.advanceTime(1_000);
      await expect(pending).rejects.toThrow("caller cancelled");
      expect(simctl.mutations()).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });

  test("records only overrides AutoMobile changed, keyed by the full incarnation", async () => {
    await controller.setResources(request);
    const record = await store.get({
      platform: "ios",
      udid,
      runtimeId: runtime,
      deviceTypeId: "com.apple.CoreSimulator.SimDeviceType.iPhone-16",
    });
    expect(record?.resources).toEqual({ wallpaperRendering: "disabled" });
    // The same UDID on a replaced runtime is another incarnation with no record.
    expect(
      await store.get({
        platform: "ios",
        udid,
        runtimeId: "com.apple.CoreSimulator.SimRuntime.iOS-26-5",
        deviceTypeId: "com.apple.CoreSimulator.SimDeviceType.iPhone-16",
      }),
    ).toBeNull();
  });

  test("an already-disabled service is not claimed as AutoMobile-owned", async () => {
    simctl.disabled = true;
    simctl.loaded = false;
    const result = await controller.setResources(request);
    expect(result.changed).toEqual([]);
    expect(store.writes).toBe(0);
  });

  test("re-enabling an owned override removes its record", async () => {
    await controller.setResources(request);
    await controller.setResources({ ...request, resources: { wallpaperRendering: "enabled" } });
    expect(store.records.size).toBe(0);
  });

  test("a metadata write failure never changes the verified mutation result", async () => {
    store.failWrites = true;
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const result = await controller.setResources(request);
      expect(result.success).toBe(true);
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

describe("simulator incarnation identity", () => {
  function reader(devicesJson: string) {
    const calls: string[][] = [];
    const timer = new FakeTimer();
    return {
      calls,
      reader: new IosDeviceResourceReader({
        timer,
        simctl: {
          async executeCommandArgs(args: string[]) {
            calls.push(args);
            return createExecResult(devicesJson, "");
          },
        },
      }),
    };
  }

  test("resolves UDID, runtime and device type from a captured simctl listing", async () => {
    const devices = JSON.parse(capturedDevices) as {
      devices: Record<string, { udid: string; state: string; deviceTypeIdentifier: string }[]>;
    };
    const [runtimeId, entries] = Object.entries(devices.devices).find(([, list]) => list.length)!;
    const target = entries[0]!;
    // The capture host had no booted simulator; mark one booted to model a live target.
    target.state = "Booted";
    const { reader: identityReader, calls } = reader(JSON.stringify(devices));
    expect(
      await identityReader.readIdentity({
        device: { platform: "ios", name: "sim", deviceId: target.udid },
        deadlineMs: 10_000,
      }),
    ).toEqual({
      platform: "ios",
      udid: target.udid,
      runtimeId,
      deviceTypeId: target.deviceTypeIdentifier,
    });
    expect(calls).toEqual([["list", "devices", "--json"]]);
  });

  test("a shutdown simulator has no current incarnation", async () => {
    const devices = JSON.parse(capturedDevices) as {
      devices: Record<string, { udid: string; state: string }[]>;
    };
    const target = Object.values(devices.devices).find((list) => list.length)![0]!;
    expect(target.state).toBe("Shutdown");
    const { reader: identityReader } = reader(capturedDevices);
    expect(
      await identityReader.readIdentity({
        device: { platform: "ios", name: "sim", deviceId: target.udid },
        deadlineMs: 10_000,
      }),
    ).toBeNull();
  });
});
