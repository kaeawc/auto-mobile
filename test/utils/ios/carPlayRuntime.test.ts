import { describe, expect, test } from "bun:test";
import {
  DefaultCarPlayRuntimeReader,
  requireCarPlayRuntime,
} from "../../../src/utils/ios/carPlayRuntime";
import { FakeCarPlayRuntimeReader } from "../../fakes/FakeCarPlayRuntimeReader";

const udid = "SIM-UDID";
function listing(runtimeId: string): string {
  return JSON.stringify({ devices: { [runtimeId]: [{ udid, name: "iPhone 17 Pro" }] } });
}

describe("requireCarPlayRuntime", () => {
  test("refuses iOS 27 and later with the helpers' unsupported-runtime message", async () => {
    for (const version of ["27.0", "27.2", "28.1"]) {
      await expect(
        requireCarPlayRuntime(udid, new FakeCarPlayRuntimeReader(version)),
      ).rejects.toThrow(
        `[unsupported-runtime] Headless CarPlay needs an iOS 26.x runtime (found ${version}). Apple does not support CarPlay on the iOS 27 Simulator; use an Xcode 26.x iOS 26 simulator.`,
      );
    }
  });

  test("lets iOS 26.x and an unknown runtime through", async () => {
    for (const version of ["26.5", "26.0", undefined]) {
      await expect(
        requireCarPlayRuntime(udid, new FakeCarPlayRuntimeReader(version)),
      ).resolves.toBeUndefined();
    }
  });
});

describe("DefaultCarPlayRuntimeReader", () => {
  test("reads the runtime of the one simulator from simctl list devices", async () => {
    const calls: unknown[] = [];
    const reader = new DefaultCarPlayRuntimeReader(async (file, args, options) => {
      calls.push({ file, args, options });
      return {
        stdout: Buffer.from(listing("com.apple.CoreSimulator.SimRuntime.iOS-27-2")),
        stderr: "",
      };
    });
    expect(await reader.runtimeVersion(udid)).toBe("27.2");
    expect(calls).toEqual([
      {
        file: "xcrun",
        args: ["simctl", "list", "devices", udid, "--json"],
        options: { timeout: 10000, maxBuffer: 4 * 1024 * 1024 },
      },
    ]);
  });

  test("reports an unknown runtime when simctl fails", async () => {
    const reader = new DefaultCarPlayRuntimeReader(async () => {
      throw new Error("xcrun: not found");
    });
    expect(await reader.runtimeVersion(udid)).toBeUndefined();
  });

  test("rethrows a cancellation instead of reporting an unknown runtime", async () => {
    const controller = new AbortController();
    const reason = new Error("cancelled");
    const reader = new DefaultCarPlayRuntimeReader(async () => {
      controller.abort(reason);
      throw new Error("killed");
    });
    await expect(reader.runtimeVersion(udid, controller.signal)).rejects.toBe(reason);
  });
});
