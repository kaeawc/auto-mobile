import { describe, expect, test } from "bun:test";
import { ActionableError, type ExecResult } from "../../../src/models";
import {
  appendCategory,
  classifyEmulatorExitOutput,
  DefaultEmulatorLaunchDiagnostics,
  formatEarlyExitError,
  isArchitectureCompatible,
  sandboxFailure,
} from "../../../src/utils/android-cmdline-tools/EmulatorLaunchDiagnostics";
import type { AvdConfigReader } from "../../../src/utils/android-cmdline-tools/AvdConfigReader";
import { FakeAvdConfigReader } from "../../fakes/FakeAvdConfigReader";
import { FakeTimer } from "../../fakes/FakeTimer";

const MPROTECT = "qemu_mprotect__osdep: mprotect failed: permission denied";

function execResult(stdout = "", stderr = ""): ExecResult {
  return {
    stdout,
    stderr,
    toString: () => stdout,
    trim: () => stdout.trim(),
    includes: (value) => stdout.includes(value),
  };
}

class ThrowingAvdConfigReader implements AvdConfigReader {
  async readConfig(): Promise<never> {
    throw new Error("config.ini unreadable");
  }
}

function diagnostics(
  options: {
    timer?: FakeTimer;
    hostArchitecture?: string;
    reader?: AvdConfigReader;
    exec?: (file: string, args: string[], signal?: AbortSignal) => Promise<ExecResult>;
  } = {},
) {
  const timer = options.timer ?? new FakeTimer();
  const calls: { file: string; args: string[] }[] = [];
  const subject = new DefaultEmulatorLaunchDiagnostics({
    timer: () => timer,
    emulatorPath: () => "/sdk/emulator",
    hostArchitecture: () => options.hostArchitecture ?? "arm64",
    avdConfigReader: () => options.reader ?? new FakeAvdConfigReader(),
    execAsync: (file, args, signal) => {
      calls.push({ file, args });
      return (options.exec ?? (async () => execResult()))(file, args, signal);
    },
  });
  return { subject, timer, calls };
}

describe("launch failure formatting", () => {
  test("isArchitectureCompatible rejects only x86 AVDs on ARM64 hosts", () => {
    expect(isArchitectureCompatible("arm64", "x86_64")).toBe(false);
    expect(isArchitectureCompatible("aarch64", "x86")).toBe(false);
    expect(isArchitectureCompatible("arm64", "arm64-v8a")).toBe(true);
    expect(isArchitectureCompatible("x64", "x86_64")).toBe(true);
  });

  test("sandboxFailure is null for unrelated output and carries the suggestion otherwise", () => {
    expect(sandboxFailure("nothing wrong")).toBeNull();
    const error = sandboxFailure(MPROTECT);
    expect(error).toBeInstanceOf(ActionableError);
    expect(error?.message).toContain("Emulator failed to start:");
    expect(error?.message).toContain("Suggestion:");
  });

  test("classifyEmulatorExitOutput maps corrupt-image and display output, else null", () => {
    expect(classifyEmulatorExitOutput("qcow2: image is corrupt")?.message).toContain(
      "Emulator failed to start:",
    );
    expect(classifyEmulatorExitOutput("could not connect to display")?.message).toContain(
      "Suggestion:",
    );
    expect(classifyEmulatorExitOutput("all quiet")).toBeNull();
  });

  test("classifyEmulatorExitOutput prefers the sandbox failure over later classes", () => {
    const error = classifyEmulatorExitOutput(`${MPROTECT}\nqcow2: image is corrupt`);
    expect(error?.message).toBe(sandboxFailure(MPROTECT)?.message);
  });

  test("formatEarlyExitError lists the header, diagnostic and accel-check sections", () => {
    const error = formatEarlyExitError(
      "Pixel",
      1,
      "SIGSEGV",
      "hardware_acceleration_unavailable",
      " boom ",
      " accel ",
    );
    expect(error.message).toBe(
      [
        "Emulator process exited with code: 1 (signal: SIGSEGV) (AVD 'Pixel'; category=hardware_acceleration_unavailable)",
        "Diagnostic:\nboom",
        "emulator -accel-check:\naccel",
      ].join("\n"),
    );
  });

  test("formatEarlyExitError omits empty sections and the category", () => {
    const error = formatEarlyExitError("Pixel", null, null, undefined, "", "");
    expect(error.message).toBe("Emulator process exited with code: null (AVD 'Pixel')");
  });

  test("appendCategory suffixes the category line", () => {
    expect(
      appendCategory(new ActionableError("failed"), "hardware_acceleration_unavailable").message,
    ).toBe("failed\n\ncategory=hardware_acceleration_unavailable");
  });
});

describe("DefaultEmulatorLaunchDiagnostics.checkArchitectureCompatibility", () => {
  test("flags an x86_64 AVD on an arm64 host", async () => {
    const { subject } = diagnostics({
      reader: new FakeAvdConfigReader({ architecture: "x86_64" }),
    });
    expect(await subject.checkArchitectureCompatibility("Pixel")).toEqual({
      compatible: false,
      hostArch: "arm64",
      avdArch: "x86_64",
      reason: "Host architecture 'arm64' cannot run AVD with architecture 'x86_64'",
    });
  });

  test("allows the attempt when the config has no architecture", async () => {
    const { subject } = diagnostics();
    const result = await subject.checkArchitectureCompatibility("Pixel");
    expect(result.compatible).toBe(true);
    expect(result.reason).toContain("Could not determine AVD architecture");
  });

  test("an explicit config skips the reader", async () => {
    const reader = new FakeAvdConfigReader({ architecture: "x86" });
    const { subject } = diagnostics({ reader });
    const result = await subject.checkArchitectureCompatibility("Pixel", {
      architecture: "arm64",
    });
    expect(result.compatible).toBe(true);
    expect(reader.readConfigCalls).toEqual([]);
  });

  test("a reader failure allows the attempt", async () => {
    const { subject } = diagnostics({ reader: new ThrowingAvdConfigReader() });
    expect(await subject.checkArchitectureCompatibility("Pixel")).toEqual({
      compatible: true,
      hostArch: "arm64",
      reason: "Could not verify compatibility, allowing attempt",
    });
  });
});

describe("DefaultEmulatorLaunchDiagnostics.runAccelerationCheck", () => {
  test("returns combined stdout and stderr of -accel-check", async () => {
    const { subject, calls } = diagnostics({
      exec: async () => execResult("HAXM ok", "warn"),
    });
    expect(await subject.runAccelerationCheck()).toBe("HAXM ok\nwarn");
    expect(calls).toEqual([{ file: "/sdk/emulator", args: ["-accel-check"] }]);
  });

  test("a failing probe reports its captured output instead of throwing", async () => {
    const { subject } = diagnostics({
      exec: async () => {
        throw Object.assign(new Error("exit 1"), { stdout: "out", stderr: Buffer.from("err") });
      },
    });
    expect(await subject.runAccelerationCheck()).toBe("out\nerr");
  });

  test("a hung probe is aborted at the 3s bound and yields an empty string", async () => {
    const timer = new FakeTimer();
    let aborted = false;
    const { subject } = diagnostics({
      timer,
      exec: (_file, _args, signal) =>
        new Promise<ExecResult>(() => {
          signal?.addEventListener("abort", () => {
            aborted = true;
          });
        }),
    });
    const result = subject.runAccelerationCheck();
    await Promise.resolve();
    await Promise.resolve();
    timer.advanceTime(3_000);
    expect(await result).toBe("");
    expect(aborted).toBe(true);
  });
});
