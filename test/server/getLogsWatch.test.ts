import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SpawnOptions } from "node:child_process";
import { GetLogs } from "../../src/features/deviceLogs/GetLogs";
import { ActionableError, type BootedDevice, type ExecResult } from "../../src/models";
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

const WATCH: BootedDevice = {
  name: "Apple Watch Series 11 (46mm)",
  platform: "watchos",
  deviceId: "3A9A806D-0B5A-4FE9-81BC-0F9903F57A03",
};

// Verbatim head of `simctl spawn <udid> log show --style compact` on a watchOS 26.5 simulator (#17547).
const WATCH_LOG = readFileSync(
  join(import.meta.dir, "../fixtures/ios-simctl/log-show-compact-acceptwatch-watchos26-5.txt"),
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

function watchGetLogs(simctl: ReplayingSimctl, timer: FakeTimer): GetLogs {
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
      throw new Error("a watch must not read logcat");
    },
    ios: () => ({
      collect: (appId, lastSeconds, level, { signal, processName } = {}) =>
        provider.collectUnifiedLog(
          WATCH,
          appId,
          { lastSeconds, level, processName },
          { maxBytes: 256 * 1024, signal, retain: "tail" },
        ),
      resolveProcessName: async () => "AcceptWatch",
    }),
  });
}

describe("getLogs on an Apple Watch simulator (#17547)", () => {
  test("reads the watch's unified log through simctl spawn log show with the process predicate", async () => {
    const simctl = new ReplayingSimctl(WATCH_LOG);
    const result = await watchGetLogs(simctl, new FakeTimer()).execute(WATCH, {
      appId: "dev.example.AcceptWatch",
      since: { seconds: 120 },
    });

    expect(simctl.argv).toHaveLength(1);
    const [args] = simctl.argv;
    expect(args!.slice(0, 7)).toEqual([
      "spawn",
      WATCH.deviceId,
      "log",
      "show",
      "--last",
      "120",
      "--style",
    ]);
    expect(args![args!.indexOf("--predicate") + 1]).toBe(
      'subsystem == "dev.example.AcceptWatch" OR subsystem BEGINSWITH "dev.example.AcceptWatch." OR process == "AcceptWatch"',
    );
    expect(result.platform).toBe("watchos");
    expect(result.attribution).toBe("process");
    // The getpwuid_r preamble and the column header are not log lines.
    expect(result.lines).toHaveLength(4);
    expect(result.lines[0]).toEqual({
      timestamp: "2026-11-08 09:46:54.915",
      message:
        "Df AcceptWatch[34576:8e3a456] [com.apple.dt.xctest:Default] Received request to fetch matches for query:",
    });
    expect(result.warnings).toEqual([]);
  });

  test("names watchOS when appId is missing or Android-only filters are passed", async () => {
    const simctl = new ReplayingSimctl(WATCH_LOG);
    const getLogs = watchGetLogs(simctl, new FakeTimer());
    await expect(getLogs.execute(WATCH, {})).rejects.toThrow(
      "getLogs on watchOS needs appId: the unified log is read per app subsystem.",
    );
    const result = await getLogs.execute(WATCH, {
      appId: "dev.example.AcceptWatch",
      buffers: ["main"],
    });
    expect(result.warnings).toEqual(["Android-only filters ignored on watchOS: buffers."]);
  });

  test("a platform without a log path never falls through to logcat", async () => {
    const simctl = new ReplayingSimctl(WATCH_LOG);
    const tv: BootedDevice = { ...WATCH, name: "Apple TV", platform: "tvos" };
    await expect(watchGetLogs(simctl, new FakeTimer()).execute(tv, { appId: "a" })).rejects.toThrow(
      new ActionableError("getLogs does not support platform tvos."),
    );
    expect(simctl.argv).toEqual([]);
  });

  test("the tool schema and platform gate admit a watch but still refuse tvOS and visionOS", () => {
    expect(getLogsTool.schema.safeParse({ platform: "watchos", appId: "a" }).success).toBe(true);
    expect(() => assertToolSupportsDevicePlatform("getLogs", WATCH)).not.toThrow();
    expect(() =>
      assertRequestedPlatformSupported("getLogs", { platform: "watchos" }),
    ).not.toThrow();
    for (const platform of ["tvos", "visionos"] as const) {
      expect(() => assertRequestedPlatformSupported("getLogs", { platform })).toThrow(
        ActionableError,
      );
    }
  });
});
