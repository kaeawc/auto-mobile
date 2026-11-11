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

const VISION: BootedDevice = {
  name: "Apple Vision Pro 4K",
  platform: "visionos",
  deviceId: "5C1B7D0E-3A57-4E6F-9D0B-2F8E61A4C9B3",
};

// Verbatim `log show --style compact` stdout from a visionOS 26.5 simulator (#18011).
const VISION_LOG = readFileSync(
  join(import.meta.dir, "../fixtures/ios-simctl/log-show-compact-dogfoodvision-visionos26-5.txt"),
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

function visionGetLogs(simctl: ReplayingSimctl, timer: FakeTimer): GetLogs {
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
      throw new Error("an Apple Vision Pro must not read logcat");
    },
    ios: () => ({
      collect: (appId, lastSeconds, level, { signal, processName } = {}) =>
        provider.collectUnifiedLog(
          VISION,
          appId,
          { lastSeconds, level, processName },
          { maxBytes: 256 * 1024, signal, retain: "tail" },
        ),
      resolveProcessName: async () => "DogfoodVision",
    }),
  });
}

const APP_ID = "dev.dogfood.vision";

describe("getLogs on an Apple Vision Pro simulator (#18011)", () => {
  test("reads the unified log through simctl spawn log show and parses the captured lines", async () => {
    const simctl = new ReplayingSimctl(VISION_LOG);
    const timer = new FakeTimer();
    const result = await visionGetLogs(simctl, timer).execute(VISION, {
      appId: APP_ID,
      since: { seconds: 120 },
    });

    expect(simctl.argv).toHaveLength(1);
    const [args] = simctl.argv;
    expect(args!.slice(0, 6)).toEqual(["spawn", VISION.deviceId, "log", "show", "--last", "120"]);
    expect(args![args!.indexOf("--predicate") + 1]).toBe(
      'subsystem == "dev.dogfood.vision" OR subsystem BEGINSWITH "dev.dogfood.vision." OR process == "DogfoodVision"',
    );
    expect(result.platform).toBe("visionos");
    expect(result.appId).toBe(APP_ID);
    expect(result.attribution).toBe("process");
    // The getpwuid_r preamble and the column header are not log lines.
    expect(result.lines).toEqual([
      {
        timestamp: "2026-11-11 13:22:24.030",
        message: "Df DogfoodVision[68785:a908940] [dev.dogfood.vision:ui] detail opened Item 3",
      },
      {
        timestamp: "2026-11-11 13:23:07.649",
        message: "Df DogfoodVision[68785:a908940] [dev.dogfood.vision:ui] toggle true",
      },
      {
        timestamp: "2026-11-11 13:23:13.192",
        message: "Df DogfoodVision[68785:a908940] [dev.dogfood.vision:ui] ornament add tapped",
      },
      {
        timestamp: "2026-11-11 13:23:20.068",
        message: "Df DogfoodVision[68785:a908940] [dev.dogfood.vision:ui] toggle false",
      },
    ]);
    expect(result.warnings).toEqual([]);
    expect(timer.getSleepHistory()).toEqual([]);
  });

  test("filters the captured lines by grep", async () => {
    const result = await visionGetLogs(new ReplayingSimctl(VISION_LOG), new FakeTimer()).execute(
      VISION,
      { appId: APP_ID, grep: "detail opened" },
    );
    expect(result.lines.map((line) => line.timestamp)).toEqual(["2026-11-11 13:22:24.030"]);
  });

  test("resolves since against the last action on the Vision Pro", async () => {
    const simctl = new ReplayingSimctl(VISION_LOG);
    const timer = new FakeTimer();
    timer.setCurrentTime(100_000);
    const getLogs = new GetLogs({
      clock: {
        now: () => timer.now(),
        lastActionStartMs: (deviceId) => (deviceId === VISION.deviceId ? 55_500 : undefined),
        sessionStartMs: () => undefined,
      },
      android: () => {
        throw new Error("an Apple Vision Pro must not read logcat");
      },
      ios: () => ({
        collect: async (_appId, lastSeconds) => {
          simctl.argv.push(["--last", String(lastSeconds)]);
          return { text: VISION_LOG, truncated: false };
        },
      }),
    });
    const result = await getLogs.execute(VISION, { appId: APP_ID, since: "lastAction" });
    expect(result.sinceSeconds).toBe(45);
    expect(simctl.argv).toEqual([["--last", "45"]]);
    expect(result.attribution).toBe("subsystem");
  });

  test("names visionOS when appId is missing or Android-only filters are passed", async () => {
    const getLogs = visionGetLogs(new ReplayingSimctl(VISION_LOG), new FakeTimer());
    await expect(getLogs.execute(VISION, {})).rejects.toThrow(
      "getLogs on visionOS needs appId: the unified log is read per app subsystem.",
    );
    const result = await getLogs.execute(VISION, { appId: APP_ID, tags: ["ui"] });
    expect(result.warnings).toEqual(["Android-only filters ignored on visionOS: tags."]);
  });

  test("the tool schema and platform gate admit a Vision Pro", () => {
    expect(getLogsTool.schema.safeParse({ platform: "visionos", appId: APP_ID }).success).toBe(
      true,
    );
    expect(() => assertToolSupportsDevicePlatform("getLogs", VISION)).not.toThrow();
    expect(() =>
      assertRequestedPlatformSupported("getLogs", { platform: "visionos" }),
    ).not.toThrow();
  });
});
