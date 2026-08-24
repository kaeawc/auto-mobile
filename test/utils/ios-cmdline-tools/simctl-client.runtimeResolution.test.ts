import { describe, expect, test } from "bun:test";
import { SimCtlClient } from "../../../src/utils/ios-cmdline-tools/SimCtlClient";
import { createExecResult } from "../../../src/utils/execResult";
import { FakeTimer } from "../../fakes/FakeTimer";
import { ActionableError } from "../../../src/models";

interface RuntimeFixture {
  version: string;
  identifier: string;
  isAvailable?: boolean;
}

function createClient(
  sdkVersion: string | null,
  runtimes: RuntimeFixture[],
): {
  simctl: SimCtlClient;
  calls: string[];
} {
  const calls: string[] = [];
  const execAsync = async (file: string, args: string[]) => {
    const command = `${file} ${args.join(" ")}`;
    calls.push(command);
    if (command === "xcrun simctl --version") {
      return createExecResult("simctl version 1.0.0", "");
    }
    if (command === "xcrun --sdk iphonesimulator --show-sdk-version") {
      if (sdkVersion === null) {
        throw new Error('xcrun: error: SDK "iphonesimulator" cannot be located');
      }
      return createExecResult(`${sdkVersion}\n`, "");
    }
    if (command === "xcrun simctl list runtimes iOS --json") {
      return createExecResult(
        JSON.stringify({
          runtimes: runtimes.map((runtime) => ({
            version: runtime.version,
            identifier: runtime.identifier,
            name: `iOS ${runtime.version}`,
            isAvailable: runtime.isAvailable ?? true,
          })),
        }),
        "",
      );
    }
    return createExecResult("", "");
  };

  return {
    simctl: new SimCtlClient(null, execAsync, new FakeTimer(), "darwin"),
    calls,
  };
}

describe("SimCtlClient runtime resolution", () => {
  test("tier 1: exact SDK version prefix wins", async () => {
    const { simctl, calls } = createClient("26.3", [
      { version: "26.2.0", identifier: "com.apple.CoreSimulator.SimRuntime.iOS-26-2" },
      { version: "26.3.0", identifier: "com.apple.CoreSimulator.SimRuntime.iOS-26-3" },
      { version: "26.4.0", identifier: "com.apple.CoreSimulator.SimRuntime.iOS-26-4" },
    ]);

    expect(await simctl.resolveRuntimeIdentifier()).toBe(
      "com.apple.CoreSimulator.SimRuntime.iOS-26-3",
    );
    expect(calls).toContain("xcrun --sdk iphonesimulator --show-sdk-version");
  });

  test("tier 2: major.minor fallback when the exact patch version is absent", async () => {
    const { simctl } = createClient("26.3.1", [
      { version: "26.3.0", identifier: "com.apple.CoreSimulator.SimRuntime.iOS-26-3" },
      { version: "26.4.0", identifier: "com.apple.CoreSimulator.SimRuntime.iOS-26-4" },
    ]);

    expect(await simctl.resolveRuntimeIdentifier()).toBe(
      "com.apple.CoreSimulator.SimRuntime.iOS-26-3",
    );
  });

  test("tier 3: highest runtime in the same major when the minor is absent", async () => {
    const { simctl } = createClient("26.3", [
      { version: "25.5.0", identifier: "com.apple.CoreSimulator.SimRuntime.iOS-25-5" },
      { version: "26.1.0", identifier: "com.apple.CoreSimulator.SimRuntime.iOS-26-1" },
      { version: "26.10.0", identifier: "com.apple.CoreSimulator.SimRuntime.iOS-26-10" },
      { version: "26.2.0", identifier: "com.apple.CoreSimulator.SimRuntime.iOS-26-2" },
    ]);

    // Numeric ordering: 26.10 > 26.2 (a string sort would pick 26.2).
    expect(await simctl.resolveRuntimeIdentifier()).toBe(
      "com.apple.CoreSimulator.SimRuntime.iOS-26-10",
    );
  });

  test("an explicit version overrides SDK detection", async () => {
    const { simctl, calls } = createClient("26.3", [
      { version: "18.2.0", identifier: "com.apple.CoreSimulator.SimRuntime.iOS-18-2" },
      { version: "26.3.0", identifier: "com.apple.CoreSimulator.SimRuntime.iOS-26-3" },
    ]);

    expect(await simctl.resolveRuntimeIdentifier("18.2")).toBe(
      "com.apple.CoreSimulator.SimRuntime.iOS-18-2",
    );
    expect(calls).not.toContain("xcrun --sdk iphonesimulator --show-sdk-version");
  });

  test("unavailable runtimes are ignored", async () => {
    const { simctl } = createClient("26.3", [
      {
        version: "26.3.0",
        identifier: "com.apple.CoreSimulator.SimRuntime.iOS-26-3",
        isAvailable: false,
      },
      { version: "26.1.0", identifier: "com.apple.CoreSimulator.SimRuntime.iOS-26-1" },
    ]);

    expect(await simctl.resolveRuntimeIdentifier()).toBe(
      "com.apple.CoreSimulator.SimRuntime.iOS-26-1",
    );
  });

  test("no runtime in the major family fails actionably and lists what is installed", async () => {
    const { simctl } = createClient("26.3", [
      { version: "18.2.0", identifier: "com.apple.CoreSimulator.SimRuntime.iOS-18-2" },
    ]);

    const error = await simctl.resolveRuntimeIdentifier().catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ActionableError);
    expect((error as Error).message).toContain("tried 26.3, 26.3.x, 26.x");
    expect((error as Error).message).toContain("iOS 18.2.0");
  });

  test("SDK detection failure is reported actionably", async () => {
    const { simctl } = createClient(null, []);

    const error = await simctl.resolveRuntimeIdentifier().catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ActionableError);
    expect((error as Error).message).toContain("Could not detect the iOS SDK version");
  });
});
