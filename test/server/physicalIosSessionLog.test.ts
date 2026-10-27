import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { BootedDevice, ExecResult } from "../../src/models";
import type { HostCommandExecutor, HostCommandOptions } from "../../src/utils/HostCommandExecutor";
import { createSessionLogService } from "../../src/server/sessionLogService";
import type { AppFileFileSystem } from "../../src/server/appFileService";
import { FakeTimer } from "../fakes/FakeTimer";

const physicalIos: BootedDevice = {
  deviceId: "00008110-000A1B2C3D4E5F60",
  name: "iPhone",
  platform: "ios",
};
const WORK_DIR = "/tmp/automobile-ios-log-abc";
// The provider builds paths with the host's `path.join`, so Windows CI sees backslashes.
const ARCHIVE = join(WORK_DIR, "window.logarchive");
const PREDICATE = 'subsystem == "com.example.app" OR subsystem BEGINSWITH "com.example.app."';

function execResult(stdout: string): ExecResult {
  return {
    stdout,
    stderr: "",
    toString: () => stdout,
    trim: () => stdout.trim(),
    includes: (search: string) => stdout.includes(search),
  };
}

type HostResponse = (args: string[], options?: HostCommandOptions) => Promise<ExecResult>;

class RecordingHost implements HostCommandExecutor {
  readonly calls: Array<{ file: string; args: string[]; options?: HostCommandOptions }> = [];
  collect: HostResponse = async () => execResult("");
  show: HostResponse = async () => execResult("");

  async executeCommand(
    file: string,
    args: string[] = [],
    options?: HostCommandOptions,
  ): Promise<ExecResult> {
    this.calls.push({ file, args, options });
    return args[0] === "collect" ? this.collect(args, options) : this.show(args, options);
  }
}

function unused(): never {
  throw new Error("the physical unified-log path only creates and removes its archive directory");
}

class TempDirFileSystem implements AppFileFileSystem {
  readonly created: string[] = [];
  readonly removed: string[] = [];
  stat = unused;
  lstat = unused;
  readdir = unused;
  mkdir = unused;
  copyFile = unused;
  rename = unused;
  readFileBuffer = unused;
  writeFileBuffer = unused;

  async mkdtemp(prefix: string): Promise<string> {
    this.created.push(prefix);
    return WORK_DIR;
  }

  async rm(path: string): Promise<void> {
    this.removed.push(path);
  }
}

function harness(options: { hostPlatform?: NodeJS.Platform; timeoutMs?: number } = {}) {
  const host = new RecordingHost();
  const fileSystem = new TempDirFileSystem();
  const timer = new FakeTimer();
  const service = createSessionLogService({
    adbFactory: {
      create: () => {
        throw new Error("adb must not be used for iOS");
      },
    },
    simctlFactory: () => {
      throw new Error("simctl must not be used for a physical device");
    },
    fileSystem,
    timer,
    physicalIos: {
      host,
      hostPlatform: options.hostPlatform ?? "darwin",
      timeoutMs: options.timeoutMs ?? 60_000,
      tempRoot: "/tmp",
    },
  });
  const collect = (level: "default" | "info" | "debug" = "debug", maxBytes = 1_000) =>
    service.collect({
      sessionUuid: "s",
      device: physicalIos,
      request: { appId: "com.example.app", maxBytes, unifiedLog: { lastSeconds: 30, level } },
    });
  return { host, fileSystem, timer, collect };
}

describe("Physical iOS unified-log window (#14104)", () => {
  test("collects a device archive, filters it with log show, and reports mechanism and latency", async () => {
    const { host, fileSystem, timer, collect } = harness();
    host.collect = async () => {
      timer.advanceTime(4_200);
      return execResult("Archive successfully written\n");
    };
    host.show = async () => {
      timer.advanceTime(300);
      return execResult("2026-10-21 10:00:00 Df com.example.app[123] boot\n");
    };

    const result = await collect("debug", 10);

    expect(result.unifiedLog).toEqual({
      status: "ok",
      lastSeconds: 30,
      level: "debug",
      predicate: PREDICATE,
      mechanism: "log-collect",
      collectionMs: 4_500,
      timeoutMs: 60_000,
      byteCount: 49,
      truncated: true,
      text: "2026-10-21",
    });
    expect(host.calls.map((call) => [call.file, ...call.args])).toEqual([
      [
        "log",
        "collect",
        "--device-udid",
        physicalIos.deviceId,
        "--last",
        "30",
        "--output",
        ARCHIVE,
      ],
      [
        "log",
        "show",
        "--last",
        "30",
        "--style",
        "compact",
        "--predicate",
        PREDICATE,
        "--info",
        "--debug",
        ARCHIVE,
      ],
    ]);
    expect(fileSystem.created).toEqual([join("/tmp", "automobile-ios-log-")]);
    expect(fileSystem.removed).toEqual([WORK_DIR]);
  });

  test("passes the same level flags as the Simulator path", async () => {
    const { host, collect } = harness();
    await collect("default");
    await collect("info");
    const shows = host.calls.filter((call) => call.args[0] === "show").map((call) => call.args);
    expect(shows[0]!.slice(-3)).toEqual(["--predicate", PREDICATE, ARCHIVE]);
    expect(shows[1]!.slice(-2)).toEqual(["--info", ARCHIVE]);
  });

  test("reports unavailable with HOST_UNSUPPORTED on a non-macOS host without running log", async () => {
    const { host, fileSystem, collect } = harness({ hostPlatform: "linux" });

    const result = await collect();

    expect(result.unifiedLog).toEqual({
      status: "unavailable",
      code: "HOST_UNSUPPORTED",
      reason: expect.stringContaining("requires a macOS host"),
    });
    expect(host.calls).toEqual([]);
    expect(fileSystem.created).toEqual([]);
  });

  test.each([
    ["Device is locked. Unlock the device to continue.", "failed", "DEVICE_LOCKED"],
    ["Device is not paired with this host", "unavailable", "DEVICE_NOT_PAIRED"],
    ["log: No devices found matching UDID", "unavailable", "DEVICE_NOT_CONNECTED"],
    ["log: Must be admin to run 'collect' command", "failed", "HOST_NOT_ADMIN"],
  ] as const)("types the log collect failure %p", async (stderr, status, code) => {
    const { host, fileSystem, collect } = harness();
    host.collect = async () => {
      throw new Error(`Command failed: log collect\nstderr: ${stderr}`);
    };

    const result = await collect();

    expect(result.unifiedLog).toEqual({
      status,
      code,
      reason: expect.stringContaining(stderr),
    });
    expect(host.calls).toHaveLength(1);
    expect(fileSystem.removed).toEqual([WORK_DIR]);
  });

  test("keeps an unrecognised log collect failure as a plain failed outcome", async () => {
    const { host, collect } = harness();
    host.collect = async () => {
      throw new Error("Command failed: log collect\nstderr: archive write error");
    };

    expect((await collect()).unifiedLog).toEqual({
      status: "failed",
      reason: expect.stringContaining("archive write error"),
    });
  });

  test("times out the whole collection on the injected timer, aborts the child, and cleans up", async () => {
    const { host, fileSystem, timer, collect } = harness({ timeoutMs: 45_000 });
    host.collect = () => new Promise<ExecResult>(() => {});

    const pending = collect();
    await Promise.resolve();
    await Promise.resolve();
    expect(timer.getPendingTimeouts()).toEqual([45_000]);
    timer.advanceTime(45_000);
    const result = await pending;

    expect(result.unifiedLog).toEqual({
      status: "timedOut",
      reason: expect.stringContaining("timed out after 45000ms"),
    });
    expect(host.calls[0]!.options?.signal?.aborted).toBe(true);
    expect(host.calls[0]!.options?.timeoutMs).toBe(45_000);
    expect(fileSystem.removed).toEqual([WORK_DIR]);
    expect(timer.getPendingTimeouts()).toEqual([]);
  });
});
