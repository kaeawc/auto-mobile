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
  signals: Array<AbortSignal | undefined>;
} {
  const calls: string[] = [];
  const signals: Array<AbortSignal | undefined> = [];
  const execAsync = async (
    file: string,
    args: string[],
    _maxBuffer?: number,
    signal?: AbortSignal,
  ) => {
    const command = `${file} ${args.join(" ")}`;
    calls.push(command);
    signals.push(signal);
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
    signals,
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

  test("keeps SDK-default selection when no bounds are requested", async () => {
    const { simctl, calls } = createClient("26.3", [
      { version: "18.2.0", identifier: "com.apple.CoreSimulator.SimRuntime.iOS-18-2" },
      { version: "26.3.0", identifier: "com.apple.CoreSimulator.SimRuntime.iOS-26-3" },
    ]);

    expect(await simctl.resolveRuntimeIdentifiersForBounds()).toEqual([
      "com.apple.CoreSimulator.SimRuntime.iOS-26-3",
    ]);
    expect(calls).toContain("xcrun --sdk iphonesimulator --show-sdk-version");
  });

  test("tier 1: minor version matching stops at component boundaries", async () => {
    const { simctl } = createClient("26.1", [
      { version: "26.1.0", identifier: "com.apple.CoreSimulator.SimRuntime.iOS-26-1" },
      { version: "26.10.0", identifier: "com.apple.CoreSimulator.SimRuntime.iOS-26-10" },
    ]);

    expect(await simctl.resolveRuntimeIdentifier()).toBe(
      "com.apple.CoreSimulator.SimRuntime.iOS-26-1",
    );
  });

  test("tier 1: patch version matching stops at component boundaries", async () => {
    const { simctl } = createClient("26.3.1", [
      { version: "26.3.1", identifier: "com.apple.CoreSimulator.SimRuntime.iOS-26-3-1" },
      { version: "26.3.10", identifier: "com.apple.CoreSimulator.SimRuntime.iOS-26-3-10" },
    ]);

    expect(await simctl.resolveRuntimeIdentifier()).toBe(
      "com.apple.CoreSimulator.SimRuntime.iOS-26-3-1",
    );
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

  test("selects the newest available runtime at or above a minimum", async () => {
    const { simctl, calls } = createClient("26.3", [
      { version: "18.2.0", identifier: "com.apple.CoreSimulator.SimRuntime.iOS-18-2" },
      { version: "26.3.0", identifier: "com.apple.CoreSimulator.SimRuntime.iOS-26-3" },
    ]);

    expect(await simctl.resolveRuntimeIdentifiersForBounds("18.3")).toEqual([
      "com.apple.CoreSimulator.SimRuntime.iOS-26-3",
    ]);
    expect(calls).not.toContain("xcrun --sdk iphonesimulator --show-sdk-version");
  });

  test("selects the newest available runtime at or below a maximum", async () => {
    const { simctl } = createClient("26.3", [
      { version: "18.2.0", identifier: "com.apple.CoreSimulator.SimRuntime.iOS-18-2" },
      { version: "26.3.0", identifier: "com.apple.CoreSimulator.SimRuntime.iOS-26-3" },
    ]);

    expect(await simctl.resolveRuntimeIdentifiersForBounds(undefined, "18.2")).toEqual([
      "com.apple.CoreSimulator.SimRuntime.iOS-18-2",
    ]);
  });

  test("selects the newest available runtime within combined bounds", async () => {
    const { simctl } = createClient("26.3", [
      { version: "18.2.0", identifier: "com.apple.CoreSimulator.SimRuntime.iOS-18-2" },
      { version: "18.4.0", identifier: "com.apple.CoreSimulator.SimRuntime.iOS-18-4" },
      { version: "26.3.0", identifier: "com.apple.CoreSimulator.SimRuntime.iOS-26-3" },
    ]);

    expect(await simctl.resolveRuntimeIdentifiersForBounds("18.1", "18.4")).toEqual([
      "com.apple.CoreSimulator.SimRuntime.iOS-18-4",
      "com.apple.CoreSimulator.SimRuntime.iOS-18-2",
    ]);
  });

  test("uses the same numeric bound grammar as existing-device matching", async () => {
    const { simctl } = createClient("26.3", [
      { version: "18.2.0", identifier: "com.apple.CoreSimulator.SimRuntime.iOS-18-2" },
    ]);

    expect(await simctl.resolveRuntimeIdentifiersForBounds(undefined, "018.002.000.000")).toEqual([
      "com.apple.CoreSimulator.SimRuntime.iOS-18-2",
    ]);
  });

  test("forwards cancellation to bounded runtime discovery", async () => {
    const controller = new AbortController();
    const { simctl, calls, signals } = createClient("26.3", [
      { version: "18.2.0", identifier: "com.apple.CoreSimulator.SimRuntime.iOS-18-2" },
    ]);

    await simctl.resolveRuntimeIdentifiersForBounds("18.0", "18.2", controller.signal);

    const runtimeCall = calls.indexOf("xcrun simctl list runtimes iOS --json");
    expect(runtimeCall).toBeGreaterThanOrEqual(0);
    expect(signals[runtimeCall]).toBe(controller.signal);
  });

  test("fails actionably when no available runtime is within the requested range", async () => {
    const { simctl } = createClient("26.3", [
      { version: "18.2.0", identifier: "com.apple.CoreSimulator.SimRuntime.iOS-18-2" },
      { version: "26.3.0", identifier: "com.apple.CoreSimulator.SimRuntime.iOS-26-3" },
    ]);

    const error = await simctl
      .resolveRuntimeIdentifiersForBounds("26.4", "27.0")
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ActionableError);
    expect((error as Error).message).toContain("min=26.4, max=27.0");
    expect((error as Error).message).toContain("iOS 18.2.0, iOS 26.3.0");
  });

  test("does not select an unavailable runtime that satisfies the requested range", async () => {
    const { simctl } = createClient("26.3", [
      {
        version: "18.2.0",
        identifier: "com.apple.CoreSimulator.SimRuntime.iOS-18-2",
        isAvailable: false,
      },
      { version: "26.3.0", identifier: "com.apple.CoreSimulator.SimRuntime.iOS-26-3" },
    ]);

    await expect(simctl.resolveRuntimeIdentifiersForBounds("18.0", "18.2")).rejects.toThrow(
      /No available iOS simulator runtime/,
    );
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
