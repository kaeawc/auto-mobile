import { describe, expect, test } from "bun:test";
import type { ExecResult } from "../../../src/models";
import {
  CrashApp,
  type CrashAppDependencies,
  findAndroidCrashEvidence,
  findIosSimulatorCrashEvidence,
} from "../../../src/features/action/CrashApp";
import type {
  NativeCrashReport,
  NativeCrashReportLookup,
  NativeCrashReportQuery,
} from "../../../src/features/crashReports/NativeCrashReport";
import type { RecordCrashInput } from "../../../src/features/failures/FailureRecorder";
import { FakeAdbClient } from "../../fakes/FakeAdbClient";
import { FakeTimer } from "../../fakes/FakeTimer";
import type { PhysicalIosCrashControl } from "../../../src/features/action/crashPhysicalIosApp";

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
  cacheInvalidator: { retireAppProcess: () => {}, invalidate: () => {} },
  uid: () => 501,
  crashReports: { find: async () => ({ status: "notFound" }) },
  crashReportRecorder: {
    recordCrash: async () => {
      throw new Error("no crash report should be recorded");
    },
  },
  ...overrides,
});

describe("CrashApp (Android)", () => {
  test("checks Android running state through the shared process-state command", async () => {
    const adb = new FakeAdbClient();
    adb.setCommandResult("shell dumpsys activity processes", "no processes");

    const result = await new CrashApp(androidDevice, dependencies({ adb })).execute(
      "com.example.app",
    );

    expect(result).toMatchObject({ success: false, wasRunning: false });
    expect(adb.getCommandCalls()).toContainEqual(
      expect.objectContaining({
        command: "shell dumpsys activity processes",
        timeoutMs: 5_000,
        noRetry: true,
      }),
    );
  });

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
        cacheInvalidator: { retireAppProcess: () => {}, invalidate: () => invalidations++ },
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
      dependencies({
        adb,
        cacheInvalidator: { retireAppProcess: () => {}, invalidate: () => invalidations++ },
      }),
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
  // RunningBoard lines are derived from the issue #6000 reproduction (NOT captured;
  // capture needed from a real simulator). Other-bundle-id lines change only the bundle-id token.
  const evidenceLines = [
    [
      "launchd",
      "2023-11-14 22:13:20.100+0000 launchd_sim: UIKitApplication:com.example.app[bbbb][rb-legacy] [27955]: exited due to SIGABRT",
    ],
    [
      "RunningBoard",
      "2023-11-14 22:13:20.100+0000 RunningBoard: Now killing [app<com.example.app(UUID)>:27955] code:SIGABRT(6)",
    ],
  ] as const;

  for (const [source, line] of evidenceLines) {
    test(`${source} attributes the exact bundle-id token`, () => {
      expect(findIosSimulatorCrashEvidence(line, "com.example.app", 27955)).toEqual({
        source: "ios_unified_log",
        summary: line,
      });
    });

    for (const otherAppId of [
      "com.example.app.widget",
      "com.example.app.ShareExtension",
      "com.example.application",
      "com.example.app-beta",
      "xcom.example.app",
      "x.com.example.app",
    ]) {
      test(`${source} rejects other bundle-id token ${otherAppId}`, () => {
        const output = line.replace("com.example.app", otherAppId);
        expect(findIosSimulatorCrashEvidence(output, "com.example.app", 27955)).toBeUndefined();
      });
    }
  }

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
    const action = new CrashApp(
      iosSimulator,
      dependencies({ simctl: commands, timer, uid: () => 501 }),
    );

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

  test("uses the host UID when signaling the simulator app process", async () => {
    const processList = "27955\t0\tUIKitApplication:com.example.app[bbbb][rb-legacy]";
    const commands = new FakeSimulatorCommands(
      [processList, processList, "PID\tStatus\tLabel\n"],
      "2023-11-14 22:13:20.100 launchd_sim: UIKitApplication:com.example.app[bbbb][rb-legacy] [27955]: exited due to SIGABRT",
    );
    const timer = new FakeTimer();
    timer.advanceTime(1_700_000_000_000);
    const action = new CrashApp(
      iosSimulator,
      dependencies({ simctl: commands, timer, uid: () => 20_123 }),
    );

    const result = await action.execute("com.example.app");

    expect(result).toMatchObject({
      success: true,
      timestamp: 1_700_000_000_000,
      confirmed: true,
    });
    expect(commands.calls).toContainEqual([
      "spawn",
      iosSimulator.deviceId,
      "launchctl",
      "kill",
      "SIGABRT",
      "user/20123/UIKitApplication:com.example.app[bbbb][rb-legacy]",
    ]);
    expect(commands.calls.flat().join(" ")).not.toContain("user/501/");
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
      dependencies({ simctl: commands, timer, uid: () => 501 }),
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
        cacheInvalidator: { retireAppProcess: () => {}, invalidate: () => invalidations++ },
      }),
    );

    await expect(
      action.execute("com.example.app", { signal: controller.signal }),
    ).rejects.toThrow();
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
        cacheInvalidator: { retireAppProcess: () => {}, invalidate: () => invalidations++ },
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

  test("physical devices never use the simulator launchctl path (#14096)", async () => {
    const commands = new FakeSimulatorCommands([]);
    const crasher = new FakePhysicalCrasher([undefined]);
    const action = new CrashApp(
      iosPhysicalDevice,
      dependencies({ simctl: commands, physicalIosCrasher: crasher }),
    );

    await action.execute("com.example.app");

    expect(commands.calls).toEqual([]);
  });
});

/** Scripted `findAppPid` answers (one per call) and a scripted `sendAbort` outcome. */
class FakePhysicalCrasher implements PhysicalIosCrashControl {
  readonly lookups: string[] = [];
  readonly aborts: number[] = [];
  constructor(
    private readonly pids: Array<number | null | undefined | Error>,
    private readonly abort: "signalled" | "already_exited" | Error = "signalled",
  ) {}

  async findAppPid(bundleId: string): Promise<number | null | undefined> {
    this.lookups.push(bundleId);
    const next = this.pids.length > 1 ? this.pids.shift() : this.pids[0];
    if (next instanceof Error) {
      throw next;
    }
    return next;
  }

  async sendAbort(pid: number) {
    this.aborts.push(pid);
    if (this.abort instanceof Error) {
      throw this.abort;
    }
    return this.abort;
  }
}

describe("CrashApp (physical iOS, #14096)", () => {
  const run = async (crasher: FakePhysicalCrasher) => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const invalidations: string[] = [];
    const action = new CrashApp(
      iosPhysicalDevice,
      dependencies({
        physicalIosCrasher: crasher,
        timer,
        cacheInvalidator: {
          retireAppProcess: () => {},
          invalidate: (device) => invalidations.push(device.deviceId),
        },
      }),
    );
    return { result: await action.execute("com.example.app"), invalidations };
  };

  test("sends SIGABRT to the resolved PID and reports the exit without claiming confirmation", async () => {
    const crasher = new FakePhysicalCrasher([4321, 4321, null]);
    const { result, invalidations } = await run(crasher);

    expect(crasher.aborts).toEqual([4321]);
    expect(result).toMatchObject({
      success: true,
      supported: true,
      platform: "ios",
      mechanism: "ios_device_sigabrt",
      wasRunning: true,
      processId: 4321,
      confirmed: false,
      evidence: { source: "none" },
    });
    expect(result.evidence?.summary).toContain("#14103");
    expect(invalidations).toEqual([iosPhysicalDevice.deviceId]);
  });

  test("a relaunched app with a new PID counts as the crashed process exiting", async () => {
    const { result } = await run(new FakePhysicalCrasher([4321, 9999]));
    expect(result).toMatchObject({ success: true, processId: 4321 });
  });

  test("an app that is not installed is refused without a signal", async () => {
    const crasher = new FakePhysicalCrasher([undefined]);
    const { result } = await run(crasher);
    expect(result).toMatchObject({ success: false, supported: true, wasRunning: false });
    expect(result.error).toContain("not installed");
    expect(crasher.aborts).toEqual([]);
  });

  test("an app that is not running is refused without a signal", async () => {
    const crasher = new FakePhysicalCrasher([null]);
    const { result } = await run(crasher);
    expect(result).toMatchObject({ success: false, wasRunning: false });
    expect(result.error).toContain("not running");
    expect(crasher.aborts).toEqual([]);
  });

  test("a process that exited before the signal is not reported as crashed", async () => {
    const { result } = await run(new FakePhysicalCrasher([4321], "already_exited"));
    expect(result).toMatchObject({ success: false, wasRunning: true, confirmed: false });
    expect(result.error).toContain("exited before the crash signal");
    expect(result.evidence).toBeUndefined();
  });

  test("a process still running after the signal fails without evidence", async () => {
    const { result } = await run(new FakePhysicalCrasher([4321]));
    expect(result).toMatchObject({ success: false, processId: 4321, confirmed: false });
    expect(result.error).toContain("still running");
  });

  test("an unreadable process table after the signal cannot prove the exit", async () => {
    const { result } = await run(new FakePhysicalCrasher([4321, new Error("device locked")]));
    expect(result).toMatchObject({ success: false });
    expect(result.error).toContain("still running");
  });

  test("a devicectl signal failure surfaces its message and still invalidates caches", async () => {
    const { result, invalidations } = await run(
      new FakePhysicalCrasher([4321], new Error("Failed to send SIGABRT: device is locked")),
    );
    expect(result).toMatchObject({ success: false, wasRunning: true, processId: 4321 });
    expect(result.error).toContain("device is locked");
    expect(invalidations).toHaveLength(1);
  });
});

describe("CrashApp native crash reports (#14103)", () => {
  const report = (processId: number, platform: "android" | "ios"): NativeCrashReport => ({
    id: `report-${processId}`,
    platform,
    source: platform === "ios" ? "ios_ips" : "android_dropbox",
    appId: "com.example.app",
    appVersion: "1.4.0",
    processId,
    exceptionType: platform === "ios" ? "EXC_CRASH (SIGABRT)" : "CrashedByAdbException",
    exceptionMessage: platform === "ios" ? "abort() called" : "shell-induced crash",
    terminationReason: "SIGNAL 6: Abort trap: 6",
    frames: [
      {
        className: "libsystem_c.dylib",
        methodName: "abort",
        fileName: null,
        lineNumber: null,
        isAppCode: false,
      },
    ],
    reportPath: "/reports/Playground.ips",
  });

  function finder(lookup: NativeCrashReportLookup) {
    const queries: NativeCrashReportQuery[] = [];
    return {
      queries,
      find: async (query: NativeCrashReportQuery) => (queries.push(query), lookup),
    };
  }

  function recorder(result: string | Error = "occ-7") {
    const recorded: RecordCrashInput[] = [];
    return {
      recorded,
      recordCrash: async (input: RecordCrashInput) => {
        recorded.push(input);
        if (result instanceof Error) {
          throw result;
        }
        return result;
      },
    };
  }

  function androidWithoutLogcatEvidence() {
    const adb = new FakeAdbClient();
    adb.setCommandResultSequence("shell dumpsys activity processes", [
      "*APP* UID u0a123 ProcessRecord{abc 3220:com.example.app/u0a123}",
      "*APP* UID u0a123 ProcessRecord{abc 3220:com.example.app/u0a123}",
      "",
    ]);
    adb.setCommandResult("shell logcat -b crash -d -v epoch -t 200", "");
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    return { adb, timer };
  }

  test("confirms an Android crash from the dropbox report when logcat has no marker", async () => {
    const { adb, timer } = androidWithoutLogcatEvidence();
    const crashReports = finder({ status: "found", report: report(3220, "android") });
    const failures = recorder();

    const result = await new CrashApp(
      androidDevice,
      dependencies({ adb, timer, crashReports, crashReportRecorder: failures }),
    ).execute("com.example.app");

    expect(result).toMatchObject({
      success: true,
      confirmed: true,
      processId: 3220,
      evidence: {
        source: "android_dropbox",
        summary: "CrashedByAdbException: shell-induced crash",
      },
      crashReport: {
        status: "found",
        source: "android_dropbox",
        reportId: "report-3220",
        exceptionType: "CrashedByAdbException",
        terminationReason: "SIGNAL 6: Abort trap: 6",
        frames: ["abort (libsystem_c.dylib)"],
        failureOccurrenceId: "occ-7",
      },
    });
    expect(result.error).toBeUndefined();
    expect(crashReports.queries).toEqual([
      expect.objectContaining({ appId: "com.example.app", processId: 3220 }),
    ]);
    expect(failures.recorded).toEqual([
      expect.objectContaining({
        exceptionType: "CrashedByAdbException",
        deviceId: androidDevice.deviceId,
        appVersion: "1.4.0",
      }),
    ]);
  });

  test("keeps the unconfirmed result and reports notFound when no report exists", async () => {
    const { adb, timer } = androidWithoutLogcatEvidence();

    const result = await new CrashApp(androidDevice, dependencies({ adb, timer })).execute(
      "com.example.app",
    );

    expect(result).toMatchObject({
      success: false,
      confirmed: false,
      crashReport: { status: "notFound" },
    });
    expect(result.error).toContain("no fresh OS crash evidence");
  });

  test("attaches the .ips report to a log-confirmed iOS Simulator crash and records it", async () => {
    const processList = "27955\t0\tUIKitApplication:com.example.app[bbbb][rb-legacy]";
    const commands = new FakeSimulatorCommands(
      [processList, processList, "PID\tStatus\tLabel\n"],
      "2023-11-14 22:13:20.100 launchd_sim: UIKitApplication:com.example.app[bbbb][rb-legacy] [27955]: exited due to SIGABRT",
    );
    const timer = new FakeTimer();
    timer.advanceTime(1_700_000_000_000);
    const crashReports = finder({ status: "found", report: report(27955, "ios") });
    const failures = recorder();

    const result = await new CrashApp(
      iosSimulator,
      dependencies({ simctl: commands, timer, crashReports, crashReportRecorder: failures }),
    ).execute("com.example.app");

    expect(result).toMatchObject({
      success: true,
      confirmed: true,
      evidence: { source: "ios_unified_log" },
      crashReport: {
        status: "found",
        source: "ios_ips",
        reportPath: "/reports/Playground.ips",
        exceptionType: "EXC_CRASH (SIGABRT)",
        failureOccurrenceId: "occ-7",
      },
    });
    expect(crashReports.queries).toEqual([
      {
        appId: "com.example.app",
        processId: 27955,
        notBeforeTimestampMs: 1_700_000_000_000,
        signal: undefined,
      },
    ]);
    expect(failures.recorded).toHaveLength(1);
  });

  test("a failure to record the report never fails a confirmed crash", async () => {
    const { adb, timer } = androidWithoutLogcatEvidence();

    const result = await new CrashApp(
      androidDevice,
      dependencies({
        adb,
        timer,
        crashReports: finder({ status: "found", report: report(3220, "android") }),
        crashReportRecorder: recorder(new Error("database is locked")),
      }),
    ).execute("com.example.app");

    expect(result).toMatchObject({ success: true, confirmed: true });
    expect(result.crashReport).toMatchObject({ status: "found" });
    expect(result.crashReport).not.toHaveProperty("failureOccurrenceId");
  });
});
