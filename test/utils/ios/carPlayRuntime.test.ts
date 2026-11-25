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
      const reader = new FakeCarPlayRuntimeReader();
      // Assigned after construction: passing undefined would take the constructor default.
      reader.version = version;
      await expect(requireCarPlayRuntime(udid, reader)).resolves.toBeUndefined();
      expect(reader.calls).toEqual([udid]);
    }
  });
});

describe("DefaultCarPlayRuntimeReader", () => {
  function simctlReturning(run: () => Promise<string>) {
    const calls: unknown[] = [];
    const simctl = {
      async executeCommandArgs(args: string[], timeoutMs?: number, signal?: AbortSignal) {
        calls.push({ args, timeoutMs, signal });
        const stdout = await run();
        return {
          stdout,
          stderr: "",
          toString: () => stdout,
          trim: () => stdout.trim(),
          includes: (text: string) => stdout.includes(text),
        };
      },
    };
    return { calls, reader: new DefaultCarPlayRuntimeReader(() => simctl) };
  }

  test("reads the runtime of the one simulator through SimCtlClient", async () => {
    const { calls, reader } = simctlReturning(async () =>
      listing("com.apple.CoreSimulator.SimRuntime.iOS-27-2"),
    );
    const signal = new AbortController().signal;
    expect(await reader.runtimeVersion(udid, signal)).toBe("27.2");
    expect(calls).toEqual([
      { args: ["list", "--json", "devices", udid], timeoutMs: 10000, signal },
    ]);
  });

  test("reports an unknown runtime when simctl fails", async () => {
    const { reader } = simctlReturning(async () => {
      throw new Error("xcrun: not found");
    });
    expect(await reader.runtimeVersion(udid)).toBeUndefined();
  });

  test("rethrows a cancellation instead of reporting an unknown runtime", async () => {
    const controller = new AbortController();
    const reason = new Error("cancelled");
    const { reader } = simctlReturning(async () => {
      controller.abort(reason);
      throw new Error("killed");
    });
    await expect(reader.runtimeVersion(udid, controller.signal)).rejects.toBe(reason);
  });
});
