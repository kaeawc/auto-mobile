import { describe, expect, test } from "bun:test";
import type { BootedDevice, ExecResult } from "../../../src/models";
import {
  findBrokenXctraceCombination,
  HostXctraceEnvironment,
} from "../../../src/features/performanceTrace/xctraceCompatibility";
import type { XcodebuildCommandOptions } from "../../../src/utils/ios-cmdline-tools/XcodebuildClient";

const simulator: BootedDevice = {
  deviceId: "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE",
  name: "iPhone",
  platform: "ios",
};
const physical: BootedDevice = {
  deviceId: "00008110-001A2B3C4D5E6F70",
  name: "iPhone",
  platform: "ios",
};

function execResult(stdout: string): ExecResult {
  return {
    stdout,
    stderr: "",
    toString: () => stdout,
    trim: () => stdout.trim(),
    includes: (search: string) => stdout.includes(search),
  };
}

class FakeXcodebuild {
  calls = 0;
  stdout = "Xcode 26.6\nBuild version 17F113\n";
  error?: Error;
  async executeCommand(_args: string[], _options?: XcodebuildCommandOptions): Promise<ExecResult> {
    this.calls += 1;
    if (this.error) {
      throw this.error;
    }
    return execResult(this.stdout);
  }
}

function environment(simctlJson: string | Error = "{}") {
  const xcodebuild = new FakeXcodebuild();
  const listed: string[] = [];
  const env = new HostXctraceEnvironment({
    xcodebuild,
    listSimulatorDevices: async (device) => {
      listed.push(device.deviceId);
      if (simctlJson instanceof Error) {
        throw simctlJson;
      }
      return simctlJson;
    },
  });
  return { env, xcodebuild, listed };
}

describe("findBrokenXctraceCombination (#16999)", () => {
  test("matches Xcode 26.6 with an iOS 26.5 runtime, including point releases", () => {
    expect(findBrokenXctraceCombination("26.6", "26.5")).toBeDefined();
    expect(findBrokenXctraceCombination("26.6.2", "26.5.1")).toBeDefined();
  });

  test.each([
    ["27.1", "26.5"],
    ["26.6", "27.0"],
    ["26.6", "26.4"],
    ["26.5", "26.5"],
    ["26.60", "26.5"],
    ["26", "26.5"],
    [undefined, "26.5"],
    ["26.6", undefined],
  ])("does not match Xcode %p with iOS %p", (xcode, runtime) => {
    expect(findBrokenXctraceCombination(xcode, runtime)).toBeUndefined();
  });

  test("reads further rows from the table", () => {
    const table = [{ xcodeVersion: "25.1", simulatorRuntime: "25.0" }];
    expect(findBrokenXctraceCombination("25.1", "25.0", table)).toEqual(table[0]);
    expect(findBrokenXctraceCombination("26.6", "26.5", table)).toBeUndefined();
  });
});

describe("HostXctraceEnvironment (#16999)", () => {
  test("reads the Xcode version from xcodebuild -version once", async () => {
    const { env, xcodebuild } = environment();
    expect(await env.xcodeVersion()).toBe("26.6");
    expect(await env.xcodeVersion()).toBe("26.6");
    expect(xcodebuild.calls).toBe(1);
  });

  test("reports an unknown Xcode when xcodebuild fails, and asks again next time", async () => {
    const { env, xcodebuild } = environment();
    xcodebuild.error = new Error("xcode-select: error: no developer tools");
    expect(await env.xcodeVersion()).toBeUndefined();
    xcodebuild.error = undefined;
    expect(await env.xcodeVersion()).toBe("26.6");
    expect(xcodebuild.calls).toBe(2);
  });

  test("uses the simulator's known iOS version without asking simctl", async () => {
    const { env, listed } = environment();
    expect(await env.simulatorRuntime({ ...simulator, iosVersion: "26.5" })).toBe("26.5");
    expect(listed).toEqual([]);
  });

  test("reads the runtime from simctl when the device record has none", async () => {
    const json = JSON.stringify({
      devices: {
        "com.apple.CoreSimulator.SimRuntime.iOS-26-5": [{ udid: simulator.deviceId }],
      },
    });
    const { env } = environment(json);
    expect(await env.simulatorRuntime(simulator)).toBe("26.5");
  });

  test("reports an unknown runtime when simctl fails or does not list the device", async () => {
    expect(await environment(new Error("simctl timed out")).env.simulatorRuntime(simulator)).toBe(
      undefined,
    );
    expect(await environment('{"devices":{}}').env.simulatorRuntime(simulator)).toBeUndefined();
  });

  test("has no simulator runtime for a physical device", async () => {
    const { env, listed } = environment();
    expect(await env.simulatorRuntime({ ...physical, iosVersion: "26.5" })).toBeUndefined();
    expect(listed).toEqual([]);
  });
});
