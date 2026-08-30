import { describe, expect, test } from "bun:test";
import type { ExecResult } from "../../../src/models";
import {
  CrashApp,
  type CrashAppDependencies,
  findAndroidCrashEvidence,
  findIosSimulatorCrashEvidence,
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
  readonly timeouts: Array<number | undefined> = [];
  private launchctlResults: string[];
  private readonly logOutput: string;
  private readonly errors = new Map<string, Error>();
  private readonly onExecute?: () => void;

  constructor(launchctlResults: string[], logOutput = "", onExecute?: () => void) {
    this.launchctlResults = [...launchctlResults];
    this.logOutput = logOutput;
    this.onExecute = onExecute;
  }

  setError(match: string, error: Error): void {
    this.errors.set(match, error);
  }

  async executeCommandArgs(args: string[], timeoutMs?: number): Promise<ExecResult> {
    this.onExecute?.();
    this.calls.push([...args]);
    this.timeouts.push(timeoutMs);
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

  test("rejects Android crash evidence older than the induction time", () => {
    const output = [
      "1700000000.000 E AndroidRuntime: FATAL EXCEPTION: main",
      "1700000000.001 E AndroidRuntime: Process: com.example.app, PID: 222",
      "1700000000.002 E AndroidRuntime: CrashedByAdbException: shell-induced crash",
    ].join("\n");

    expect(findAndroidCrashEvidence(output, "com.example.app", 222, 1_700_000_001_000)).toBe(
      undefined,
    );
    expect(
      findAndroidCrashEvidence(output, "com.example.app", 222, 1_700_000_000_000),
    ).toBeDefined();
  });

  test("induces and confirms an ActivityManager crash for the selected package", async () => {
    const adb = new FakeAdbClient();
    const timer = new FakeTimer();
    timer.advanceTime(1234);
    adb.setCommandResultSequence("shell dumpsys activity processes", [
      "*APP* UID u10a123 ProcessRecord{abc 3220:com.example.app/u10a123}",
      "*APP* UID u10a123 ProcessRecord{abc 3220:com.example.app/u10a123}",
      "*APP* UID u10a123 ProcessRecord{def 4881:com.example.other/u10a123}",
    ]);
    adb.setCommandResult(
      "shell logcat -b crash -d -v epoch -t 200",
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
    expect(adb.getCommandCalls().every((call) => (call.timeoutMs ?? 0) > 0)).toBe(true);
    expect(invalidations).toBe(1);
  });

  test("uses the foreground instance when a package runs under multiple users", async () => {
    const adb = new FakeAdbClient();
    adb.setForegroundApp({ packageName: "com.example.app", userId: 0 });
    adb.setCommandResultSequence("shell dumpsys activity processes", [
      [
        "*APP* UID u0a123 ProcessRecord{aaa 111:com.example.app/u0a123}",
        "*APP* UID u10a123 ProcessRecord{bbb 222:com.example.app/u10a123}",
      ].join("\n"),
      [
        "*APP* UID u0a123 ProcessRecord{aaa 111:com.example.app/u0a123}",
        "*APP* UID u10a123 ProcessRecord{bbb 222:com.example.app/u10a123}",
      ].join("\n"),
      "*APP* UID u10a123 ProcessRecord{bbb 222:com.example.app/u10a123}",
    ]);
    adb.setCommandResult(
      "shell logcat -b crash -d -v epoch -t 200",
      [
        "E AndroidRuntime: FATAL EXCEPTION: main",
        "E AndroidRuntime: Process: com.example.app, PID: 111",
        "E AndroidRuntime: CrashedByAdbException: shell-induced crash",
      ].join("\n"),
    );

    const result = await new CrashApp(androidDevice, dependencies({ adb })).execute(
      "com.example.app",
    );

    expect(result).toMatchObject({ success: true, userId: 0, processId: 111 });
    expect(adb.wasCommandExecuted("shell am crash --user 0 'com.example.app'")).toBe(true);
  });

  test("rejects ambiguous multi-user instances instead of guessing a profile", async () => {
    const adb = new FakeAdbClient();
    adb.setForegroundApp({ packageName: "com.example.other", userId: 10 });
    adb.setCommandResult(
      "shell dumpsys activity processes",
      [
        "*APP* UID u0a123 ProcessRecord{aaa 111:com.example.app/u0a123}",
        "*APP* UID u10a123 ProcessRecord{bbb 222:com.example.app/u10a123}",
      ].join("\n"),
    );

    const result = await new CrashApp(androidDevice, dependencies({ adb })).execute(
      "com.example.app",
    );

    expect(result).toMatchObject({
      success: false,
      supported: true,
      wasRunning: true,
      confirmed: false,
    });
    expect(result.error).toContain("multiple Android users");
    expect(adb.wasCommandExecuted("shell am crash")).toBe(false);
  });

  test("reports the package-owned secondary process that actually crashed", async () => {
    const adb = new FakeAdbClient();
    adb.setCommandResultSequence("shell dumpsys activity processes", [
      [
        "*APP* UID u0a123 ProcessRecord{aaa 111:com.example.app/u0a123}",
        "*APP* UID u0a123 ProcessRecord{bbb 222:com.example.app:worker/u0a123}",
      ].join("\n"),
      [
        "*APP* UID u0a123 ProcessRecord{aaa 111:com.example.app/u0a123}",
        "*APP* UID u0a123 ProcessRecord{bbb 222:com.example.app:worker/u0a123}",
      ].join("\n"),
      "*APP* UID u0a123 ProcessRecord{aaa 111:com.example.app/u0a123}",
    ]);
    adb.setCommandResult(
      "shell logcat -b crash -d -v epoch -t 200",
      [
        "E AndroidRuntime: FATAL EXCEPTION: main",
        "E AndroidRuntime: Process: com.example.app:worker, PID: 222",
        "E AndroidRuntime: CrashedByAdbException: shell-induced crash",
      ].join("\n"),
    );

    const result = await new CrashApp(androidDevice, dependencies({ adb })).execute(
      "com.example.app",
    );

    expect(result).toMatchObject({ success: true, processId: 222, confirmed: true });
  });

  test("crashes an app running only in a fully qualified custom process", async () => {
    const adb = new FakeAdbClient();
    const customProcess = [
      "*APP* UID u0a123 ProcessRecord{aaa 777:com.example.shared/u0a123}",
      "    packageList={com.example.app}",
    ].join("\n");
    adb.setCommandResultSequence("shell dumpsys activity processes", [
      customProcess,
      customProcess,
      "",
    ]);
    adb.setCommandResult(
      "shell logcat -b crash -d -v epoch -t 200",
      [
        "E AndroidRuntime: FATAL EXCEPTION: main",
        "E AndroidRuntime: Process: com.example.shared, PID: 777",
        "E AndroidRuntime: CrashedByAdbException: shell-induced crash",
      ].join("\n"),
    );

    const result = await new CrashApp(androidDevice, dependencies({ adb })).execute(
      "com.example.app",
    );

    expect(result).toMatchObject({
      success: true,
      processId: 777,
      userId: 0,
      confirmed: true,
    });
    expect(adb.wasCommandExecuted("shell am crash --user 0 'com.example.app'")).toBe(true);
  });

  test("refreshes a relaunched app PID immediately before dispatch", async () => {
    const adb = new FakeAdbClient();
    adb.setCommandResultSequence("shell dumpsys activity processes", [
      "*APP* UID u0a123 ProcessRecord{aaa 111:com.example.app/u0a123}",
      "*APP* UID u0a123 ProcessRecord{bbb 222:com.example.app/u0a123}",
      "",
    ]);
    adb.setCommandResult(
      "shell logcat -b crash -d -v epoch -t 200",
      [
        "E AndroidRuntime: FATAL EXCEPTION: main",
        "E AndroidRuntime: Process: com.example.app, PID: 222",
        "E AndroidRuntime: CrashedByAdbException: shell-induced crash",
      ].join("\n"),
    );

    const result = await new CrashApp(androidDevice, dependencies({ adb })).execute(
      "com.example.app",
    );

    expect(result).toMatchObject({
      success: true,
      processId: 222,
      userId: 0,
      confirmed: true,
    });
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

  test("does not compare host fallback time against device-authored crash logs", async () => {
    const adb = new FakeAdbClient();
    adb.setDeviceTimestampSource("host");
    adb.setCommandResult(
      "shell dumpsys activity processes",
      "*APP* UID u0a123 ProcessRecord{abc 3220:com.example.app/u0a123}",
    );

    const result = await new CrashApp(androidDevice, dependencies({ adb })).execute(
      "com.example.app",
    );

    expect(result).toMatchObject({
      success: false,
      supported: true,
      wasRunning: true,
      processId: 3220,
      userId: 0,
      confirmed: false,
    });
    expect(result.error).toContain("Android device time");
    expect(adb.wasCommandExecuted("shell am crash")).toBe(false);
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
    let invalidations = 0;
    const action = new CrashApp(
      androidDevice,
      dependencies({ adb, cacheInvalidator: { invalidate: () => invalidations++ } }),
    );

    const result = await action.execute("com.example.app");

    expect(result).toMatchObject({
      success: false,
      supported: false,
      processId: 3220,
      confirmed: false,
    });
    expect(result.error).toContain("Unknown command: crash");
    expect(adb.wasCommandExecuted("force-stop")).toBe(false);
    expect(invalidations).toBe(1);
  });

  test("treats an exit-zero ActivityManager permission refusal as failure", async () => {
    const adb = new FakeAdbClient();
    adb.setCommandResult(
      "shell dumpsys activity processes",
      "*APP* UID u10a123 ProcessRecord{abc 3220:com.example.app/u10a123}",
    );
    adb.setCommandResult(
      "shell am crash --user 10 'com.example.app'",
      "Shell does not have permission to crash packages for user 10",
    );

    const result = await new CrashApp(androidDevice, dependencies({ adb })).execute(
      "com.example.app",
    );

    expect(result).toMatchObject({
      success: false,
      supported: true,
      processId: 3220,
      userId: 10,
      confirmed: false,
    });
    expect(result.error).toContain("does not have permission");
  });

  test("reports failure when crash-specific evidence does not arrive", async () => {
    const adb = new FakeAdbClient();
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    adb.setCommandResultSequence("shell dumpsys activity processes", [
      "*APP* UID u0a123 ProcessRecord{abc 3220:com.example.app/u0a123}",
      "*APP* UID u0a123 ProcessRecord{abc 3220:com.example.app/u0a123}",
      "",
    ]);
    adb.setCommandResult("shell logcat -b crash -d -v epoch -t 200", "");
    const action = new CrashApp(androidDevice, dependencies({ adb, timer }));

    const result = await action.execute("com.example.app");

    expect(result).toMatchObject({
      success: false,
      supported: true,
      wasRunning: true,
      confirmed: false,
      processId: 3220,
    });
    expect(result.error).toContain("no fresh OS crash evidence");
    expect(result.evidence).toBeUndefined();
  });
});

describe("CrashApp (iOS)", () => {
  test("rejects unified-log crash evidence older than the induction time", () => {
    const output =
      "2023-11-14 22:13:20.100+0000 launchd_sim: " +
      "UIKitApplication:com.example.app[bbbb][rb-legacy] [27955]: exited due to SIGABRT";

    expect(
      findIosSimulatorCrashEvidence(output, "com.example.app", 27955, 1_700_000_001_000),
    ).toBeUndefined();
    expect(
      findIosSimulatorCrashEvidence(output, "com.example.app", 27955, 1_700_000_000_000),
    ).toBeDefined();
  });

  test("signals and confirms the exact simulator app process", async () => {
    const processList = [
      "PID\tStatus\tLabel",
      "111\t0\tUIKitApplication:com.example.app.beta[aaaa][rb-legacy]",
      "27955\t0\tUIKitApplication:com.example.app[bbbb][rb-legacy]",
    ].join("\n");
    const commands = new FakeSimulatorCommands(
      [processList, processList, "PID\tStatus\tLabel\n"],
      "2023-11-14 22:13:20.100 launchd_sim: UIKitApplication:com.example.app[bbbb][rb-legacy] [27955]: exited due to SIGABRT",
    );
    const timer = new FakeTimer();
    timer.advanceTime(1_700_000_000_000);
    const action = new CrashApp(iosSimulator, dependencies({ simctl: commands, timer }));

    const result = await action.execute("com.example.app");

    expect(result).toMatchObject({
      success: true,
      supported: true,
      platform: "ios",
      appId: "com.example.app",
      processId: 27955,
      mechanism: "ios_simulator_sigabrt",
      timestamp: 1_700_000_000_000,
      wasRunning: true,
      confirmed: true,
      evidence: {
        source: "ios_unified_log",
      },
    });
    expect(commands.calls).toContainEqual([
      "spawn",
      iosSimulator.deviceId,
      "launchctl",
      "kill",
      "SIGABRT",
      "user/501/UIKitApplication:com.example.app[bbbb][rb-legacy]",
    ]);
    expect(commands.calls.flat()).not.toContain("terminate");
    expect(commands.timeouts.every((timeoutMs) => (timeoutMs ?? 0) > 0)).toBe(true);
  });

  test("timestamps induction after simulator process preflight", async () => {
    const process = "27955\t0\tUIKitApplication:com.example.app[bbbb][rb-legacy]";
    const timer = new FakeTimer();
    timer.advanceTime(1_000);
    const commands = new FakeSimulatorCommands(
      [process, process, ""],
      "2023-11-14 22:13:20.100 launchd_sim: UIKitApplication:com.example.app[bbbb][rb-legacy] [27955]: exited due to SIGABRT",
      () => timer.advanceTime(100),
    );

    const result = await new CrashApp(
      iosSimulator,
      dependencies({ simctl: commands, timer }),
    ).execute("com.example.app");

    expect(result).toMatchObject({ success: true, timestamp: 1_200, confirmed: true });
  });

  test("refreshes a relaunched simulator PID immediately before signaling", async () => {
    const before = "111\t0\tUIKitApplication:com.example.app[aaaa][rb-legacy]";
    const atDispatch = "222\t0\tUIKitApplication:com.example.app[bbbb][rb-legacy]";
    const commands = new FakeSimulatorCommands(
      [before, atDispatch, ""],
      "2023-11-14 22:13:20.100 launchd_sim: UIKitApplication:com.example.app[bbbb][rb-legacy] [222]: exited due to SIGABRT",
    );
    const timer = new FakeTimer();
    timer.advanceTime(1_700_000_000_000);

    const result = await new CrashApp(
      iosSimulator,
      dependencies({ simctl: commands, timer }),
    ).execute("com.example.app");

    expect(result).toMatchObject({ success: true, processId: 222, confirmed: true });
    expect(commands.calls).toContainEqual([
      "spawn",
      iosSimulator.deviceId,
      "launchctl",
      "kill",
      "SIGABRT",
      "user/501/UIKitApplication:com.example.app[bbbb][rb-legacy]",
    ]);
  });

  test("invalidates cached hierarchy when abort happens after signal dispatch", async () => {
    const controller = new AbortController();
    let invalidations = 0;
    const simctl = {
      executeCommandArgs: async (
        args: string[],
        _timeoutMs?: number,
        signal?: AbortSignal,
      ): Promise<ExecResult> => {
        if (args.at(-2) === "launchctl" && args.at(-1) === "list") {
          return execResult("27955\t0\tUIKitApplication:com.example.app[bbbb][rb-legacy]");
        }
        controller.abort();
        signal?.throwIfAborted();
        return execResult();
      },
    };
    const action = new CrashApp(
      iosSimulator,
      dependencies({
        simctl,
        cacheInvalidator: { invalidate: () => invalidations++ },
      }),
    );

    await expect(action.execute("com.example.app", controller.signal)).rejects.toThrow();
    expect(invalidations).toBe(1);
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
      "27955\t0\tUIKitApplication:com.example.app[bbbb][rb-legacy]",
    ]);
    commands.setError("launchctl kill", new Error("Operation not permitted"));
    let invalidations = 0;
    const action = new CrashApp(
      iosSimulator,
      dependencies({
        simctl: commands,
        cacheInvalidator: { invalidate: () => invalidations++ },
      }),
    );

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
    expect(invalidations).toBe(1);
  });

  test("reports failure when unified-log evidence is unavailable", async () => {
    const commands = new FakeSimulatorCommands([
      "27955\t0\tUIKitApplication:com.example.app[bbbb][rb-legacy]",
      "27955\t0\tUIKitApplication:com.example.app[bbbb][rb-legacy]",
      "",
    ]);
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const action = new CrashApp(iosSimulator, dependencies({ simctl: commands, timer }));

    const result = await action.execute("com.example.app");

    expect(result).toMatchObject({
      success: false,
      supported: true,
      wasRunning: true,
      processId: 27955,
      confirmed: false,
    });
    expect(result.error).toContain("no fresh OS crash evidence");
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
      confirmed: false,
    });
    expect(result.wasRunning).toBeUndefined();
    expect(result.error).toContain("physical iOS");
    expect(commands.calls).toEqual([]);
  });
});
