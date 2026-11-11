import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SpawnOptions } from "node:child_process";
import { GetLogs } from "../../src/features/deviceLogs/GetLogs";
import { type BootedDevice, type ExecResult } from "../../src/models";
import {
  assertRequestedPlatformSupported,
  assertToolSupportsDevicePlatform,
} from "../../src/server/applePlatformToolSupport";
import type { SessionLogSimctl } from "../../src/server/sessionLogService";
import { getLogsTool } from "../../src/server/getLogsTools";
import { IosSimulatorSessionLogProvider } from "../../src/server/IosSimulatorSessionLogProvider";
import type { AppFileFileSystem } from "../../src/server/appFileService";
import { FakeTimer } from "../fakes/FakeTimer";
import { StreamingChildProcess } from "../fakes/StreamingChildProcess";

const TV: BootedDevice = {
  name: "Apple TV 4K (3rd generation)",
  platform: "tvos",
  deviceId: "F7ACFDD0-2EF2-4A3B-B7DA-B3BA02F86BD6",
};

// Verbatim head of `simctl spawn <udid> log show --style compact` on a tvOS 26.5 simulator (#16723).
const TV_LOG = readFileSync(
  join(import.meta.dir, "../fixtures/ios-simctl/log-show-compact-crashtv-tvos26-5.txt"),
  "utf8",
);

/** Replays `stdout` for every streamed command and records its argv. */
class ReplayingSimctl implements SessionLogSimctl {
  readonly argv: string[][] = [];
  constructor(private readonly stdout: string) {}

  async startCommandArgs(args: string[], _options?: SpawnOptions): Promise<StreamingChildProcess> {
    this.argv.push(args);
    const child = new StreamingChildProcess();
    // Emit after the collector attaches its close listener, as RecordingSimctl does.
    void Promise.resolve().then(() =>
      queueMicrotask(() => {
        child.stdout.write(this.stdout);
        child.finish();
      }),
    );
    return child;
  }

  async executeCommand(): Promise<ExecResult> {
    throw new Error("getLogs must stream log show, not run a shell command");
  }

  async executeCommandArgs(): Promise<ExecResult> {
    throw new Error("getLogs must stream log show, not buffer it");
  }
}

function unusedFileSystem(): AppFileFileSystem {
  return new Proxy({} as AppFileFileSystem, {
    get: () => () => {
      throw new Error("getLogs must not touch the host file system");
    },
  });
}

function tvGetLogs(simctl: ReplayingSimctl, timer: FakeTimer): GetLogs {
  const provider = new IosSimulatorSessionLogProvider(() => simctl, unusedFileSystem(), timer, {
    unifiedLogTimeoutMs: 5000,
  });
  return new GetLogs({
    clock: {
      now: () => timer.now(),
      lastActionStartMs: () => undefined,
      sessionStartMs: () => undefined,
    },
    android: () => {
      throw new Error("an Apple TV must not read logcat");
    },
    ios: () => ({
      collect: (appId, lastSeconds, level, { signal, processName } = {}) =>
        provider.collectUnifiedLog(
          TV,
          appId,
          { lastSeconds, level, processName },
          { maxBytes: 256 * 1024, signal, retain: "tail" },
        ),
      resolveProcessName: async () => "CrashTv",
    }),
  });
}

describe("getLogs on an Apple TV simulator (#16723)", () => {
  test("reads the Apple TV's unified log through simctl spawn log show with the process predicate", async () => {
    const simctl = new ReplayingSimctl(TV_LOG);
    const timer = new FakeTimer();
    const result = await tvGetLogs(simctl, timer).execute(TV, {
      appId: "dev.jasonpearson.automobile.crashtv",
      since: { seconds: 120 },
    });

    expect(simctl.argv).toHaveLength(1);
    const [args] = simctl.argv;
    expect(args!.slice(0, 7)).toEqual([
      "spawn",
      TV.deviceId,
      "log",
      "show",
      "--last",
      "120",
      "--style",
    ]);
    expect(args![args!.indexOf("--predicate") + 1]).toBe(
      'subsystem == "dev.jasonpearson.automobile.crashtv" OR subsystem BEGINSWITH "dev.jasonpearson.automobile.crashtv." OR process == "CrashTv"',
    );
    expect(result.platform).toBe("tvos");
    expect(result.attribution).toBe("process");
    // The getpwuid_r preamble and the column header are not log lines.
    expect(result.lines).toHaveLength(2);
    expect(result.lines[0]).toEqual({
      timestamp: "2026-11-11 07:50:26.806",
      message:
        "E  CrashTv[80815:a48f749] [dev.jasonpearson.automobile.crashtv:lifecycle] CrashTv launched; crashing deliberately in 2s",
    });
    expect(result.warnings).toEqual([]);
    expect(timer.getSleepHistory()).toEqual([]);
  });

  test("names tvOS when appId is missing or Android-only filters are passed", async () => {
    const simctl = new ReplayingSimctl(TV_LOG);
    const getLogs = tvGetLogs(simctl, new FakeTimer());
    await expect(getLogs.execute(TV, {})).rejects.toThrow(
      "getLogs on tvOS needs appId: the unified log is read per app subsystem.",
    );
    const result = await getLogs.execute(TV, {
      appId: "dev.jasonpearson.automobile.crashtv",
      buffers: ["main"],
    });
    expect(result.warnings).toEqual(["Android-only filters ignored on tvOS: buffers."]);
  });

  test("the tool schema and platform gate admit an Apple TV", () => {
    expect(getLogsTool.schema.safeParse({ platform: "tvos", appId: "a" }).success).toBe(true);
    expect(() => assertToolSupportsDevicePlatform("getLogs", TV)).not.toThrow();
    expect(() => assertRequestedPlatformSupported("getLogs", { platform: "tvos" })).not.toThrow();
  });
});
