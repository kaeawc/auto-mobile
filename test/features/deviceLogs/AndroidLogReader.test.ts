import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AndroidLogReader,
  mergeByTimestamp,
} from "../../../src/features/deviceLogs/AndroidLogReader";
import { parseThreadtime } from "../../../src/features/deviceLogs/logcatQuery";
import type { ExecResult } from "../../../src/models";

const FIXTURE = readFileSync(
  join(import.meta.dir, "../../fixtures/logcat/crash-threadtime.txt"),
  "utf8",
);
const APP = "dev.jasonpearson.automobile.playground";

const result = (stdout: string): ExecResult => ({
  stdout,
  stderr: "",
  toString: () => stdout,
  trim: () => stdout.trim(),
  includes: (value: string) => stdout.includes(value),
});

/** Answers `shell <command>` by the first matching prefix and records every command. */
class ScriptedAdb {
  commands: string[] = [];
  constructor(private readonly script: Array<[prefix: string, stdout: string]>) {}
  async executeCommand(command: string): Promise<ExecResult> {
    this.commands.push(command);
    const entry = this.script.find(([prefix]) => command.startsWith(`shell ${prefix}`));
    return result(entry?.[1] ?? "");
  }
}

const SYSTEM_LINES = [
  `10-21 08:15:30.200  1500  1520 I ActivityManager: Process ${APP} (pid 4211) has died: fg TOP`,
  `10-21 08:15:30.300  1500  1520 I ActivityManager: Start proc 4377:${APP}/u0a123`,
  "10-21 08:15:30.400  1500  1520 I ActivityManager: Start proc 999:com.other/u0a9",
].join("\n");

const request = {
  appId: APP,
  sinceSeconds: 60,
  minPriority: "V" as const,
  buffers: ["main", "crash"] as const,
  includeSystem: false,
};

describe("AndroidLogReader (#14082)", () => {
  test("on Android 11+ filters by uid, so the crashed process's lines survive its death", async () => {
    const adb = new ScriptedAdb([
      ["getprop ro.build.version.sdk", "34\n"],
      ["pm list packages -U", `package:${APP}.debug uid:10999\npackage:${APP} uid:10123\n`],
      ["logcat", FIXTURE],
    ]);
    const read = await new AndroidLogReader(adb).read(request);
    expect(read.attribution).toBe("uid");
    expect(read.pids).toEqual([4211, 4377]);
    expect(read.lines.map((line) => line.message)).toContain(
      "java.lang.IllegalStateException: boom",
    );
    expect(adb.commands.at(-1)).toContain("--uid=10123");
    expect(adb.commands.at(-1)).toContain("-b main -b crash");
    expect(adb.commands.some((command) => command.startsWith("shell pidof"))).toBe(false);
  });

  test("before Android 11 only running pids are kept, with a warning", async () => {
    const adb = new ScriptedAdb([
      ["getprop ro.build.version.sdk", "29\n"],
      ["pm list packages -U", `package:${APP} uid:10123\n`],
      ["pidof", "4377\n"],
      ["logcat", FIXTURE],
    ]);
    const read = await new AndroidLogReader(adb).read(request);
    expect(read.attribution).toBe("pid");
    expect(read.pids).toEqual([4377]);
    expect(read.warnings[0]).toContain("only processes of");
    expect(adb.commands.at(-1)).not.toContain("--uid");
  });

  test("tags, priority and grep reach logcat or the host filter", async () => {
    const adb = new ScriptedAdb([
      ["getprop", "34\n"],
      ["pm list packages -U", `package:${APP} uid:10123\n`],
      ["logcat", FIXTURE],
    ]);
    const read = await new AndroidLogReader(adb).read({
      ...request,
      tags: ["AndroidRuntime"],
      minPriority: "E",
      grep: "IllegalState",
    });
    expect(adb.commands.at(-1)).toContain("'AndroidRuntime:E' '*:S'");
    expect(read.lines.map((line) => line.message)).toEqual([
      "java.lang.IllegalStateException: boom",
    ]);
  });

  test("includeSystem merges ActivityManager lines that name the app, in time order", async () => {
    const adb = new ScriptedAdb([
      ["getprop", "34\n"],
      ["pm list packages -U", `package:${APP} uid:10123\n`],
      ["logcat -d -v threadtime -b main -b system -b crash", SYSTEM_LINES],
      ["logcat", FIXTURE],
    ]);
    const read = await new AndroidLogReader(adb).read({ ...request, includeSystem: true });
    const messages = read.lines.map((line) => line.message);
    expect(messages).toContain(`Process ${APP} (pid 4211) has died: fg TOP`);
    expect(messages.some((message) => message.includes("com.other"))).toBe(false);
    const died = messages.indexOf(`Process ${APP} (pid 4211) has died: fg TOP`);
    expect(died).toBeGreaterThan(messages.indexOf("java.lang.IllegalStateException: boom"));
    expect(died).toBeLessThan(messages.indexOf("onCreate MainActivity (restarted)"));
  });

  test("without appId every process is read and nothing is probed", async () => {
    const adb = new ScriptedAdb([["logcat", FIXTURE]]);
    const read = await new AndroidLogReader(adb).read({ ...request, appId: undefined });
    expect(read.attribution).toBe("none");
    expect(adb.commands).toHaveLength(1);
  });

  test("an uninstalled app is reported, not silently empty", async () => {
    const adb = new ScriptedAdb([
      ["getprop", "34\n"],
      ["pm list packages -U", ""],
      ["logcat", FIXTURE],
    ]);
    const read = await new AndroidLogReader(adb).read(request);
    expect(read.lines).toEqual([]);
    expect(read.warnings[0]).toContain("is not installed");
  });
});

describe("mergeByTimestamp", () => {
  test("interleaves by timestamp and drops exact duplicates", () => {
    const a = parseThreadtime(
      "10-21 08:00:01.000  1  1 I A: one\n10-21 08:00:03.000  1  1 I A: three",
    );
    const b = parseThreadtime(
      "10-21 08:00:02.000  2  2 I B: two\n10-21 08:00:03.000  1  1 I A: three",
    );
    expect(mergeByTimestamp(a, b).map((line) => line.message)).toEqual(["one", "two", "three"]);
  });
});
