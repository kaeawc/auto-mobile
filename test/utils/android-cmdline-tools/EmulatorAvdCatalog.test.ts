import { describe, expect, test } from "bun:test";
import { ActionableError, type DeviceInfo, type ExecResult } from "../../../src/models";
import {
  DefaultEmulatorAvdCatalog,
  isMissingExecutableError,
  type ListAvdsOptions,
} from "../../../src/utils/android-cmdline-tools/EmulatorAvdCatalog";
import { AndroidEmulatorUnavailableError } from "../../../src/utils/android-cmdline-tools/AndroidEmulatorUnavailableError";
import { resetAndroidInventoryEnrichmentCache } from "../../../src/utils/android-cmdline-tools/AndroidDeviceInventoryScanner";
import { FakeAvdConfigReader } from "../../fakes/FakeAvdConfigReader";
import { FakeTimer } from "../../fakes/FakeTimer";

function execResult(stdout = ""): ExecResult {
  return {
    stdout,
    stderr: "",
    toString: () => stdout,
    trim: () => stdout.trim(),
    includes: (value) => stdout.includes(value),
  };
}

function catalog(
  executeCommand: (args: string[], timeoutMs?: number, signal?: AbortSignal) => Promise<ExecResult>,
  emulatorPath = "/does/not/exist/emulator",
) {
  const timer = new FakeTimer();
  const uncachedCalls: (ListAvdsOptions | undefined)[] = [];
  const executed: { args: string[]; timeoutMs?: number }[] = [];
  const subject: DefaultEmulatorAvdCatalog = new DefaultEmulatorAvdCatalog({
    timer: () => timer,
    emulatorPath: () => emulatorPath,
    avdConfigReader: () => new FakeAvdConfigReader(),
    executeCommand: (args, timeoutMs, signal) => {
      executed.push({ args, timeoutMs });
      return executeCommand(args, timeoutMs, signal);
    },
    listAvdsUncached: (options) => {
      uncachedCalls.push(options);
      return subject.listAvdsUncached(options);
    },
  });
  return { subject, timer, uncachedCalls, executed };
}

function names(devices: DeviceInfo[]): string[] {
  return devices.map((device) => device.name);
}

describe("isMissingExecutableError", () => {
  const enoent = Object.assign(new Error("spawn emulator ENOENT"), { code: "ENOENT" });

  test("is true for an ENOENT with no surviving executable", () => {
    expect(isMissingExecutableError(enoent, "emulator", false)).toBe(true);
  });

  test("is false when the executable exists, the process was killed, or it is not an Error", () => {
    expect(isMissingExecutableError(enoent, "emulator", true)).toBe(false);
    expect(
      isMissingExecutableError(Object.assign(enoent, { killed: true }), "emulator", false),
    ).toBe(false);
    expect(isMissingExecutableError("ENOENT", "emulator", false)).toBe(false);
  });

  test("is false when the error names a different path", () => {
    const other = Object.assign(new Error("x"), { code: "ENOENT", path: "/other" });
    expect(isMissingExecutableError(other, "/emulator", false)).toBe(false);
  });
});

describe("DefaultEmulatorAvdCatalog.listAvdsUncached", () => {
  test("parses -list-avds output into local android devices, dropping blank lines", async () => {
    const { subject, executed } = catalog(
      async () => execResult("Pixel_9\n\n  Pixel_Fold \n"),
      "/x",
    );
    const devices = await subject.listAvdsUncached({ timeoutMs: 4_000 });
    expect(names(devices)).toEqual(["Pixel_9", "Pixel_Fold"]);
    expect(devices[0]).toMatchObject({ platform: "android", isRunning: false, source: "local" });
    expect(executed).toEqual([{ args: ["-list-avds"], timeoutMs: 4_000 }]);
  });

  test("a missing emulator binary raises the unavailable error with install guidance", async () => {
    const { subject } = catalog(async () => {
      throw Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });
    });
    const failure = await subject.listAvdsUncached().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AndroidEmulatorUnavailableError);
    expect((failure as Error).message).toContain('sdkmanager --install "emulator"');
  });

  test("other failures are wrapped with the underlying message", async () => {
    const { subject } = catalog(async () => {
      throw new Error("boom");
    });
    const failure = await subject.listAvdsUncached().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ActionableError);
    expect((failure as Error).message).toBe("Failed to list AVDs: boom");
  });

  test("a caller abort rethrows the abort instead of a list failure", async () => {
    const controller = new AbortController();
    const { subject } = catalog(async () => {
      controller.abort();
      throw new Error("killed");
    });
    const failure = await subject
      .listAvdsUncached({ signal: controller.signal })
      .catch((error: unknown) => error);
    expect((failure as Error).message).not.toContain("Failed to list AVDs");
  });
});

describe("DefaultEmulatorAvdCatalog.listAvds", () => {
  test("without coalescing it enumerates through the host each time", async () => {
    const { subject, uncachedCalls } = catalog(async () => execResult("A"), "/x");
    await subject.listAvds();
    await subject.listAvds();
    expect(uncachedCalls).toHaveLength(2);
  });

  test("with coalescing, sequential callers share one enumeration", async () => {
    resetAndroidInventoryEnrichmentCache();
    const { subject, uncachedCalls, timer } = catalog(async () => execResult("A\nB"), "/x");
    timer.enableAutoAdvance();
    const first = await subject.listAvds({ coalesceInventoryEnrichment: true });
    const second = await subject.listAvds({ coalesceInventoryEnrichment: true });
    expect(names(first)).toEqual(["A", "B"]);
    expect(second).toBe(first);
    expect(uncachedCalls).toHaveLength(1);
    resetAndroidInventoryEnrichmentCache();
  });
});
