import { describe, expect, test } from "bun:test";
import type { ExecResult } from "../../../src/models";
import {
  CrashApp,
  type CrashAppDependencies,
  findAndroidCrashEvidence,
} from "../../../src/features/action/CrashApp";
import { FakeAdbClient } from "../../fakes/FakeAdbClient";
import { FakeTimer } from "../../fakes/FakeTimer";

const androidDevice = {
  deviceId: "emulator-5554",
  name: "Pixel",
  platform: "android" as const,
};

const iosSimulator = {
  deviceId: "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE",
  name: "iPhone",
  platform: "ios" as const,
};

const iosPhysicalDevice = {
  deviceId: "00008110-001A2B3C4D5E6F70",
  name: "iPhone",
  platform: "ios" as const,
};

const execResult = (stdout = "", stderr = ""): ExecResult => ({
  stdout,
  stderr,
  toString: () => stdout,
  trim: () => stdout.trim(),
  includes: (search) => stdout.includes(search),
});

class FakeSimulatorCommands {
  readonly calls: string[][] = [];
  private launchctlResults: string[];
  private readonly logOutput: string;
  private readonly errors = new Map<string, Error>();

  constructor(launchctlResults: string[], logOutput = "") {
    this.launchctlResults = [...launchctlResults];
    this.logOutput = logOutput;
  }

  setError(match: string, error: Error): void {
    this.errors.set(match, error);
  }

  async executeCommandArgs(args: string[]): Promise<ExecResult> {
    this.calls.push([...args]);
    const command = args.join(" ");
    for (const [match, error] of this.errors) {
      if (command.includes(match)) {
        throw error;
      }
    }
    if (args.at(-2) === "launchctl" && args.at(-1) === "list") {
      return execResult(this.launchctlResults.shift() ?? "");
    }
    if (args.includes("log")) {
      return execResult(this.logOutput);
    }
    return execResult();
  }
}

const dependencies = (overrides: Partial<CrashAppDependencies> = {}): CrashAppDependencies => ({
  resolveAndroidUserId: async () => 0,
  cacheInvalidator: { invalidate: () => {} },
  ...overrides,
});

describe("CrashApp (Android)", () => {
  test("ties Android evidence summary to the target PID's crash block", () => {
    const output = [
      "E AndroidRuntime: FATAL EXCEPTION: main",
      "E AndroidRuntime: Process: com.example.app, PID: 111",
      "E AndroidRuntime: CrashedByAdbException: old shell-induced crash",
      "E AndroidRuntime: FATAL EXCEPTION: main",
      "E AndroidRuntime: Process: com.example.app, PID: 222",
      "E AndroidRuntime: CrashedByAdbException: target shell-induced crash",
    ].join("\n");

    expect(findAndroidCrashEvidence(output, "com.example.app", 222)?.summary).toContain(
      "target shell-induced crash",
    );
  });

  test("induces and confirms an ActivityManager crash for the selected package", async () => {
    const adb = new FakeAdbClient();
    const timer = new FakeTimer();
    timer.advanceTime(1234);
    adb.setCommandResultSequence("shell dumpsys activity processes", [
      "*APP* UID u10a123 ProcessRecord{abc 3220:com.example.app/u10a123}",
      "*APP* UID u10a123 ProcessRecord{def 4881:com.example.other/u10a123}",
    ]);
    adb.setCommandResult(
      "shell logcat -b crash -d -v threadtime --pid=3220 -t 200",
      [
        "E AndroidRuntime: FATAL EXCEPTION: main",
        "E AndroidRuntime: Process: com.example.app, PID: 3220",
        "E AndroidRuntime: android.app.RemoteServiceException$CrashedByAdbException: shell-induced crash",
      ].join("\n"),
    );
    let invalidations = 0;
    const action = new CrashApp(
      androidDevice,
      dependencies({
        adb,
        timer,
        resolveAndroidUserId: async () => 10,
        cacheInvalidator: { invalidate: () => invalidations++ },
      }),
    );

    const result = await action.execute("com.example.app");

    expect(result).toMatchObject({
      success: true,
      supported: true,
      platform: "android",
      appId: "com.example.app",
      processId: 3220,
      userId: 10,
      mechanism: "android_am_crash",
      timestamp: 1234,
      wasRunning: true,
      confirmed: true,
      evidence: {
        source: "android_logcat",
      },
    });
    expect(adb.wasCommandExecuted("shell am crash --user 10 'com.example.app'")).toBe(true);
    expect(adb.wasCommandExecuted("force-stop")).toBe(false);
    expect(invalidations).toBe(1);
  });

  test("returns a typed not-running result without inducing a crash", async () => {
    const adb = new FakeAdbClient();
    adb.setCommandResult(
      "shell dumpsys activity processes",
      "*APP* UID u0a123 ProcessRecord{abc 4881:com.example.other/u0a123}",
    );
    const action = new CrashApp(androidDevice, dependencies({ adb }));

    const result = await action.execute("com.example.app");

    expect(result).toMatchObject({
      success: false,
      supported: true,
      wasRunning: false,
      confirmed: false,
      mechanism: "android_am_crash",
    });
    expect(result.error).toContain("not running");
    expect(adb.wasCommandExecuted("shell am crash")).toBe(false);
  });

  test("rejects a non-package appId before it reaches the device shell", async () => {
    const adb = new FakeAdbClient();
    const action = new CrashApp(androidDevice, dependencies({ adb }));

    const result = await action.execute("com.example.app; reboot");

    expect(result).toMatchObject({
      success: false,
      supported: true,
      confirmed: false,
    });
    expect(result.error).toContain("valid Android package name");
    expect(adb.wasCommandExecuted("shell")).toBe(false);
  });

  test("reports unsupported when ActivityManager has no crash command and never force-stops", async () => {
    const adb = new FakeAdbClient();
    adb.setCommandResult(
      "shell dumpsys activity processes",
      "*APP* UID u0a123 ProcessRecord{abc 3220:com.example.app/u0a123}",
    );
    adb.setCommandError(
      "shell am crash --user 0 'com.example.app'",
      new Error("Unknown command: crash"),
    );
    const action = new CrashApp(androidDevice, dependencies({ adb }));

    const result = await action.execute("com.example.app");

    expect(result).toMatchObject({
      success: false,
      supported: false,
      processId: 3220,
      confirmed: false,
    });
    expect(result.error).toContain("Unknown command: crash");
    expect(adb.wasCommandExecuted("force-stop")).toBe(false);
  });

  test("reports accepted but unconfirmed when crash-specific evidence does not arrive", async () => {
    const adb = new FakeAdbClient();
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    adb.setCommandResultSequence("shell dumpsys activity processes", [
      "*APP* UID u0a123 ProcessRecord{abc 3220:com.example.app/u0a123}",
      "",
    ]);
    adb.setCommandResult("shell logcat -b crash -d -v threadtime --pid=3220 -t 200", "");
    const action = new CrashApp(androidDevice, dependencies({ adb, timer }));

    const result = await action.execute("com.example.app");

    expect(result).toMatchObject({
      success: true,
      supported: true,
      wasRunning: true,
      confirmed: false,
      processId: 3220,
    });
    expect(result.evidence).toBeUndefined();
  });
});

describe("CrashApp (iOS)", () => {
  test("signals and confirms the exact simulator app process", async () => {
    const processList = [
      "PID\tStatus\tLabel",
      "111\t0\tUIKitApplication:com.example.app.beta[aaaa][rb-legacy]",
      "27955\t0\tUIKitApplication:com.example.app[bbbb][rb-legacy]",
    ].join("\n");
    const commands = new FakeSimulatorCommands(
      [processList, "PID\tStatus\tLabel\n"],
      "launchd_sim: UIKitApplication:com.example.app[bbbb][rb-legacy] [27955]: exited due to SIGABRT",
    );
    const timer = new FakeTimer();
    timer.advanceTime(5678);
    const action = new CrashApp(iosSimulator, dependencies({ simctl: commands, timer }));

    const result = await action.execute("com.example.app");

    expect(result).toMatchObject({
      success: true,
      supported: true,
      platform: "ios",
      appId: "com.example.app",
      processId: 27955,
      mechanism: "ios_simulator_sigabrt",
      timestamp: 5678,
      wasRunning: true,
      confirmed: true,
      evidence: {
        source: "ios_unified_log",
      },
    });
    expect(commands.calls).toContainEqual([
      "spawn",
      iosSimulator.deviceId,
      "/bin/kill",
      "-ABRT",
      "27955",
    ]);
    expect(commands.calls.flat()).not.toContain("terminate");
  });

  test("returns a typed not-running result without signaling another bundle", async () => {
    const commands = new FakeSimulatorCommands([
      "111\t0\tUIKitApplication:com.example.app.beta[aaaa][rb-legacy]",
    ]);
    const action = new CrashApp(iosSimulator, dependencies({ simctl: commands }));

    const result = await action.execute("com.example.app");

    expect(result).toMatchObject({
      success: false,
      supported: true,
      wasRunning: false,
      confirmed: false,
    });
    expect(commands.calls).toHaveLength(1);
  });

  test("preserves known running metadata when SIGABRT is rejected", async () => {
    const commands = new FakeSimulatorCommands([
      "27955\t0\tUIKitApplication:com.example.app[bbbb][rb-legacy]",
    ]);
    commands.setError("/bin/kill", new Error("Operation not permitted"));
    const action = new CrashApp(iosSimulator, dependencies({ simctl: commands }));

    const result = await action.execute("com.example.app");

    expect(result).toMatchObject({
      success: false,
      supported: true,
      wasRunning: true,
      processId: 27955,
      confirmed: false,
      error: "Operation not permitted",
    });
    expect(commands.calls.flat()).not.toContain("terminate");
  });

  test("reports accepted but unconfirmed when unified-log evidence is unavailable", async () => {
    const commands = new FakeSimulatorCommands([
      "27955\t0\tUIKitApplication:com.example.app[bbbb][rb-legacy]",
      "",
    ]);
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const action = new CrashApp(iosSimulator, dependencies({ simctl: commands, timer }));

    const result = await action.execute("com.example.app");

    expect(result).toMatchObject({
      success: true,
      supported: true,
      wasRunning: true,
      processId: 27955,
      confirmed: false,
    });
    expect(result.evidence).toBeUndefined();
  });

  test("returns explicit unsupported metadata for a physical device without running commands", async () => {
    const commands = new FakeSimulatorCommands([]);
    const action = new CrashApp(iosPhysicalDevice, dependencies({ simctl: commands }));

    const result = await action.execute("com.example.app");

    expect(result).toMatchObject({
      success: false,
      supported: false,
      platform: "ios",
      appId: "com.example.app",
      mechanism: "unsupported",
      wasRunning: false,
      confirmed: false,
    });
    expect(result.error).toContain("physical iOS");
    expect(commands.calls).toEqual([]);
  });
});
