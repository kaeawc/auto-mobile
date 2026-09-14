import { describe, expect, test } from "bun:test";
import type { BootedDevice, ExecResult } from "../../src/models";
import type { AppFileFileSystem, AppFileStats } from "../../src/server/appFileService";
import { createSessionLogService, type SessionLogSimctl } from "../../src/server/sessionLogService";
import { FakeAdbClientFactory } from "../fakes/FakeAdbClientFactory";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import { FakeTimer } from "../fakes/FakeTimer";

const androidDevice: BootedDevice = {
  deviceId: "emulator-5554",
  name: "Pixel",
  platform: "android",
};
const simulator: BootedDevice = {
  deviceId: "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE",
  name: "iPhone",
  platform: "ios",
};
const physicalIos: BootedDevice = {
  deviceId: "00008110-000A1B2C3D4E5F60",
  name: "iPhone",
  platform: "ios",
};

function execResult(stdout: string, stderr = ""): ExecResult {
  return {
    stdout,
    stderr,
    toString: () => stdout,
    trim: () => stdout.trim(),
    includes: (search: string) => stdout.includes(search),
  };
}

function base64Read(content: string, byteCount = Buffer.byteLength(content)): string {
  return `${byteCount}\n${Buffer.from(content).toString("base64")}\n`;
}

class RecordingSimctl implements SessionLogSimctl {
  readonly commands: string[] = [];
  readonly argv: string[][] = [];
  readonly signals: Array<AbortSignal | undefined> = [];
  private commandResults = new Map<string, ExecResult | Error>();
  private argvResult: ExecResult | Error | (() => Promise<ExecResult>) = execResult("");

  onCommand(command: string, result: ExecResult | Error): void {
    this.commandResults.set(command, result);
  }

  onArgs(result: ExecResult | Error | (() => Promise<ExecResult>)): void {
    this.argvResult = result;
  }

  async executeCommand(command: string): Promise<ExecResult> {
    this.commands.push(command);
    const result = this.commandResults.get(command);
    if (result instanceof Error) {
      throw result;
    }
    return result ?? execResult("");
  }

  async executeCommandArgs(
    args: string[],
    _timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<ExecResult> {
    this.argv.push(args);
    this.signals.push(signal);
    if (this.argvResult instanceof Error) {
      throw this.argvResult;
    }
    if (typeof this.argvResult === "function") {
      return this.argvResult();
    }
    return this.argvResult;
  }
}

/**
 * In-memory `AppFileFileSystem` keyed by POSIX-style absolute paths. The service builds
 * targets with the platform `path` module, so on win32 they arrive with backslashes; every
 * entry point normalizes separators first so fixture keys stay separator-agnostic.
 */
class MemoryFileSystem implements AppFileFileSystem {
  readonly files = new Map<string, Buffer>();
  readonly removed: string[] = [];

  private normalize(path: string): string {
    return path.replace(/\\/g, "/").replace(/\/+/g, "/");
  }

  private stats(rawPath: string): AppFileStats {
    const path = this.normalize(rawPath);
    const file = this.files.get(path);
    if (file) {
      return {
        size: file.byteLength,
        mtime: new Date(0),
        isFile: () => true,
        isDirectory: () => false,
      };
    }
    if ([...this.files.keys()].some((key) => key.startsWith(`${path}/`))) {
      return { size: 0, mtime: new Date(0), isFile: () => false, isDirectory: () => true };
    }
    throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
  }

  async stat(path: string): Promise<AppFileStats> {
    return this.stats(path);
  }

  async lstat(path: string): Promise<AppFileStats> {
    return this.stats(path);
  }

  async readdir(rawPath: string): Promise<{ name: string }[]> {
    const path = this.normalize(rawPath);
    this.stats(path);
    const names = new Set<string>();
    for (const key of this.files.keys()) {
      if (key.startsWith(`${path}/`)) {
        names.add(key.slice(path.length + 1).split("/")[0]!);
      }
    }
    return [...names].map((name) => ({ name }));
  }

  async mkdir(): Promise<void> {}

  async copyFile(): Promise<void> {}

  async readFileBuffer(rawPath: string): Promise<Buffer> {
    const path = this.normalize(rawPath);
    const file = this.files.get(path);
    if (!file) {
      throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
    }
    return file;
  }

  async writeFileBuffer(): Promise<void> {}

  async mkdtemp(prefix: string): Promise<string> {
    return prefix;
  }

  async rm(rawPath: string): Promise<void> {
    const path = this.normalize(rawPath);
    this.removed.push(path);
    this.files.delete(path);
  }
}

const DATA_ROOT = "/sim/data/com.example.app";
const GROUP_ROOT = "/sim/groups/group.com.example.shared";

function iosHarness(options: { timeoutMs?: number } = {}) {
  const simctl = new RecordingSimctl();
  simctl.onCommand(
    `get_app_container '${simulator.deviceId}' 'com.example.app' 'data'`,
    execResult(`${DATA_ROOT}\n`),
  );
  simctl.onCommand(
    `get_app_container '${simulator.deviceId}' 'com.example.app' 'group.com.example.shared'`,
    execResult(`${GROUP_ROOT}\n`),
  );
  const fileSystem = new MemoryFileSystem();
  const timer = new FakeTimer();
  const service = createSessionLogService({
    adbFactory: {
      create: () => {
        throw new Error("adb must not be used for iOS");
      },
    },
    simctlFactory: () => simctl,
    fileSystem,
    timer,
    unifiedLogTimeoutMs: options.timeoutMs ?? 5_000,
  });
  return { simctl, fileSystem, timer, service };
}

describe("SessionLogService (#7006)", () => {
  describe("Android", () => {
    test("reads named app-private logs through run-as with per-path outcomes", async () => {
      const adb = new FakeAdbExecutor();
      adb.setCommandResponse(
        "shell run-as 'com.example.app' sh -c 'if [ -f '\\''files/logs/app.log'\\'' ]; then wc -c < '\\''files/logs/app.log'\\''; head -c 8 '\\''files/logs/app.log'\\'' | base64; else echo __AUTOMOBILE_MISSING__; fi'",
        execResult(base64Read("line one", 40)),
      );
      adb.setCommandResponse(
        "shell run-as 'com.example.app' sh -c 'if [ -f '\\''files/logs/gone.log'\\'' ]; then wc -c < '\\''files/logs/gone.log'\\''; head -c 8 '\\''files/logs/gone.log'\\'' | base64; else echo __AUTOMOBILE_MISSING__; fi'",
        execResult("__AUTOMOBILE_MISSING__\n"),
      );
      adb.setCommandError(
        "shell run-as 'com.example.app' sh -c 'if [ -f '\\''files/logs/denied.log'\\'' ]; then wc -c < '\\''files/logs/denied.log'\\''; head -c 8 '\\''files/logs/denied.log'\\'' | base64; else echo __AUTOMOBILE_MISSING__; fi'",
        new Error("run-as: package not debuggable: com.example.app"),
      );
      const service = createSessionLogService({ adbFactory: new FakeAdbClientFactory(adb) });

      const result = await service.collect({
        sessionUuid: "session-1",
        device: androidDevice,
        request: {
          appId: "com.example.app",
          maxBytes: 8,
          files: {
            container: "documents",
            paths: ["logs/app.log", "logs/gone.log", "logs/denied.log"],
          },
        },
      });

      expect(result.files).toEqual({
        status: "ok",
        container: "documents",
        entries: [
          {
            path: "logs/app.log",
            status: "read",
            byteCount: 40,
            truncated: true,
            text: "line one",
          },
          { path: "logs/gone.log", status: "missing" },
          {
            path: "logs/denied.log",
            status: "failed",
            reason: expect.stringContaining("requires a debuggable app build"),
          },
        ],
      });
      expect(result.appGroup).toBeUndefined();
      expect(result.unifiedLog).toBeUndefined();
    });

    test("reports iOS-only sources as unavailable without blocking the file source", async () => {
      const adb = new FakeAdbExecutor();
      adb.setDefaultResponse(execResult(base64Read("ok")));
      const service = createSessionLogService({ adbFactory: new FakeAdbClientFactory(adb) });

      const result = await service.collect({
        sessionUuid: "session-1",
        device: androidDevice,
        request: {
          appId: "com.example.app",
          maxBytes: 1024,
          files: { container: "cache", paths: ["app.log"] },
          appGroup: { groupId: "group.com.example.shared", paths: [] },
          unifiedLog: { lastSeconds: 30, level: "default" },
        },
      });

      expect(result.files).toMatchObject({
        status: "ok",
        entries: [{ status: "read", text: "ok" }],
      });
      expect(result.appGroup).toEqual({
        status: "unavailable",
        reason: "App Group containers are not available on android.",
      });
      expect(result.unifiedLog).toEqual({
        status: "unavailable",
        reason: "The unified log is not available on android.",
      });
    });

    test("resets rotated app-private logs with per-path outcomes", async () => {
      const adb = new FakeAdbExecutor();
      const resetScript = (path: string) =>
        `shell run-as 'com.example.app' sh -c 'found=0; for f in '\\''${path}'\\'' '\\''${path}'\\''.[0-9]*; do if [ -e "$f" ]; then rm -f -- "$f" && found=1; fi; done; if [ "$found" = 1 ]; then echo reset; else echo missing; fi'`;
      adb.setCommandResponse(resetScript("files/logs/app.log"), execResult("reset\n"));
      adb.setCommandResponse(resetScript("files/logs/gone.log"), execResult("missing\n"));
      adb.setCommandError(resetScript("files/logs/denied.log"), new Error("Permission denied"));
      const service = createSessionLogService({ adbFactory: new FakeAdbClientFactory(adb) });

      const result = await service.resetAppLogs({
        device: androidDevice,
        appId: "com.example.app",
        container: "documents",
        paths: ["logs/app.log", "logs/gone.log", "logs/denied.log", "x.log"],
      });

      expect(result).toMatchObject({
        success: true,
        deviceId: "emulator-5554",
        platform: "android",
        appId: "com.example.app",
        container: "documents",
      });
      expect(result.entries.slice(0, 3)).toEqual([
        { path: "logs/app.log", status: "reset" },
        { path: "logs/gone.log", status: "missing" },
        {
          path: "logs/denied.log",
          status: "failed",
          reason: expect.stringContaining("was denied by the device"),
        },
      ]);
      // An unconfigured command falls through to the fake default (empty stdout): not reset.
      expect(result.entries[3]).toEqual({ path: "x.log", status: "missing" });
    });

    test("uses plain shell, not run-as, for the externalFiles container", async () => {
      const adb = new FakeAdbExecutor();
      adb.setDefaultResponse(execResult("reset\n"));
      const service = createSessionLogService({ adbFactory: new FakeAdbClientFactory(adb) });

      await service.resetAppLogs({
        device: androidDevice,
        appId: "com.example.app",
        container: "externalFiles",
        paths: ["app.log"],
      });

      const [command] = adb.getExecutedCommands();
      expect(command).toStartWith("shell sh -c ");
      expect(command).toContain("/sdcard/Android/data/com.example.app/files/app.log");
      expect(command).not.toContain("run-as");
    });

    test("reports the unsupported library container per path instead of throwing", async () => {
      const adb = new FakeAdbExecutor();
      const service = createSessionLogService({ adbFactory: new FakeAdbClientFactory(adb) });

      const result = await service.collect({
        sessionUuid: "s",
        device: androidDevice,
        request: {
          appId: "com.example.app",
          maxBytes: 10,
          files: { container: "library", paths: ["a.log"] },
        },
      });

      expect(result.files).toMatchObject({
        status: "ok",
        entries: [
          {
            path: "a.log",
            status: "failed",
            reason: expect.stringContaining("library is not available"),
          },
        ],
      });
      expect(adb.getExecutedCommands()).toEqual([]);
    });
  });

  describe("iOS Simulator", () => {
    test("reads app-container logs, App Group files, and a bounded unified-log window", async () => {
      const { simctl, fileSystem, service } = iosHarness();
      fileSystem.files.set(`${DATA_ROOT}/Library/Caches/logs/app.log`, Buffer.from("hello world"));
      fileSystem.files.set(`${GROUP_ROOT}/Logs/extension.log`, Buffer.from("ext"));
      fileSystem.files.set(`${GROUP_ROOT}/state.bin`, Buffer.from([0xff, 0x00, 0x01]));
      simctl.onArgs(execResult("2026-09-14 10:00:00 Df com.example.app boot\n".repeat(3)));

      const result = await service.collect({
        sessionUuid: "session-1",
        device: simulator,
        request: {
          appId: "com.example.app",
          maxBytes: 5,
          files: { container: "cache", paths: ["logs/app.log", "logs/missing.log"] },
          appGroup: {
            groupId: "group.com.example.shared",
            paths: ["Logs/extension.log", "state.bin"],
          },
          unifiedLog: { lastSeconds: 90, level: "debug" },
        },
      });

      expect(result.files).toEqual({
        status: "ok",
        container: "cache",
        entries: [
          { path: "logs/app.log", status: "read", byteCount: 11, truncated: true, text: "hello" },
          { path: "logs/missing.log", status: "missing" },
        ],
      });
      expect(result.appGroup).toMatchObject({
        status: "ok",
        groupId: "group.com.example.shared",
        entries: [
          {
            path: "Logs/extension.log",
            status: "read",
            byteCount: 3,
            truncated: false,
            text: "ext",
          },
          { path: "state.bin", status: "read", byteCount: 3, truncated: false, blob: "/wAB" },
        ],
      });
      const groupFiles = (result.appGroup as { files: { path: string; isDirectory?: boolean }[] })
        .files;
      expect(groupFiles.map((file) => file.path).sort()).toEqual([
        "Logs",
        "Logs/extension.log",
        "state.bin",
      ]);
      expect(result.unifiedLog).toEqual({
        status: "ok",
        lastSeconds: 90,
        level: "debug",
        predicate: 'subsystem == "com.example.app" OR subsystem BEGINSWITH "com.example.app."',
        timeoutMs: 5_000,
        byteCount: 132,
        truncated: true,
        text: "2026-",
      });
      expect(simctl.argv).toEqual([
        [
          "spawn",
          simulator.deviceId,
          "log",
          "show",
          "--last",
          "90",
          "--style",
          "compact",
          "--predicate",
          'subsystem == "com.example.app" OR subsystem BEGINSWITH "com.example.app."',
          "--info",
          "--debug",
        ],
      ]);
    });

    test("passes --info alone for the info level and nothing for default", async () => {
      const { simctl, service } = iosHarness();
      simctl.onArgs(execResult(""));
      for (const level of ["default", "info"] as const) {
        await service.collect({
          sessionUuid: "s",
          device: simulator,
          request: {
            appId: "com.example.app",
            maxBytes: 100,
            unifiedLog: { lastSeconds: 10, level },
          },
        });
      }
      expect(simctl.argv[0]!.slice(-2)).toEqual(["--predicate", expect.any(String)]);
      expect(simctl.argv[1]!.slice(-1)).toEqual(["--info"]);
    });

    test("times out the unified-log window on the injected timer and aborts the child", async () => {
      const { simctl, timer, service } = iosHarness({ timeoutMs: 2_000 });
      simctl.onArgs(() => new Promise<ExecResult>(() => {}));

      const pending = service.collect({
        sessionUuid: "s",
        device: simulator,
        request: {
          appId: "com.example.app",
          maxBytes: 100,
          unifiedLog: { lastSeconds: 10, level: "default" },
        },
      });
      await Promise.resolve();
      expect(timer.getPendingTimeouts()).toHaveLength(1);
      timer.advanceTime(2_000);
      const result = await pending;

      expect(result.unifiedLog).toEqual({
        status: "timedOut",
        reason: expect.stringContaining("timed out after 2000ms"),
      });
      expect(simctl.signals[0]?.aborted).toBe(true);
      expect(timer.getPendingTimeouts()).toHaveLength(0);
    });

    test("isolates a failed source from the others", async () => {
      const { simctl, fileSystem, service } = iosHarness();
      fileSystem.files.set(`${DATA_ROOT}/Documents/app.log`, Buffer.from("fine"));
      simctl.onCommand(
        `get_app_container '${simulator.deviceId}' 'com.example.app' 'group.com.example.shared'`,
        new Error("No such file or directory"),
      );
      simctl.onArgs(new Error("log: simulator not booted"));

      const result = await service.collect({
        sessionUuid: "s",
        device: simulator,
        request: {
          appId: "com.example.app",
          maxBytes: 100,
          files: { container: "documents", paths: ["app.log"] },
          appGroup: { groupId: "group.com.example.shared", paths: [] },
          unifiedLog: { lastSeconds: 10, level: "default" },
        },
      });

      expect(result.files).toMatchObject({
        status: "ok",
        entries: [{ status: "read", text: "fine" }],
      });
      expect(result.appGroup).toEqual({
        status: "failed",
        reason: expect.stringContaining("group.com.example.shared"),
      });
      expect(result.unifiedLog).toEqual({
        status: "failed",
        reason: expect.stringContaining("simulator not booted"),
      });
    });

    test("resets a log and its rotated siblings, leaving unrelated files alone", async () => {
      const { fileSystem, service } = iosHarness();
      for (const name of ["app.log", "app.log.1", "app.log.2", "app.log.bak", "other.log"]) {
        fileSystem.files.set(`${DATA_ROOT}/Documents/logs/${name}`, Buffer.from("x"));
      }

      const result = await service.resetAppLogs({
        device: simulator,
        appId: "com.example.app",
        container: "documents",
        paths: ["logs/app.log", "logs/none.log", "nodir/x.log"],
      });

      expect(result.entries).toEqual([
        { path: "logs/app.log", status: "reset" },
        { path: "logs/none.log", status: "missing" },
        { path: "nodir/x.log", status: "missing" },
      ]);
      expect(fileSystem.removed.sort()).toEqual([
        `${DATA_ROOT}/Documents/logs/app.log`,
        `${DATA_ROOT}/Documents/logs/app.log.1`,
        `${DATA_ROOT}/Documents/logs/app.log.2`,
      ]);
      expect(fileSystem.files.has(`${DATA_ROOT}/Documents/logs/app.log.bak`)).toBe(true);
      expect(fileSystem.files.has(`${DATA_ROOT}/Documents/logs/other.log`)).toBe(true);
    });

    test("refuses physical iOS devices as unavailable without touching simctl", async () => {
      const { simctl, service } = iosHarness();

      const result = await service.collect({
        sessionUuid: "s",
        device: physicalIos,
        request: {
          appId: "com.example.app",
          maxBytes: 100,
          files: { container: "documents", paths: ["app.log"] },
          unifiedLog: { lastSeconds: 10, level: "default" },
        },
      });

      expect(result.files).toEqual({
        status: "unavailable",
        reason: expect.stringContaining("only supported on iOS simulators"),
      });
      expect(result.unifiedLog).toEqual({
        status: "unavailable",
        reason: expect.stringContaining("only supported on iOS simulators"),
      });
      expect(simctl.commands).toEqual([]);
      expect(simctl.argv).toEqual([]);
    });
  });
});
