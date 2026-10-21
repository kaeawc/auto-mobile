import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  compileGrep,
  logcatFilterSpecs,
  logcatShellCommand,
  matchesGrep,
  parseThreadtime,
} from "../../../src/features/deviceLogs/logcatQuery";

const FIXTURE = readFileSync(
  join(import.meta.dir, "../../fixtures/logcat/crash-threadtime.txt"),
  "utf8",
);

describe("parseThreadtime (#14082)", () => {
  test("parses a captured crash across buffers and drops separators", () => {
    const lines = parseThreadtime(FIXTURE);
    expect(lines).toHaveLength(8);
    expect(lines[0]).toEqual({
      timestamp: "10-21 08:15:28.001",
      pid: 4211,
      tid: 4211,
      priority: "D",
      tag: "Playground",
      message: "onCreate MainActivity",
    });
    expect(lines[1]).toMatchObject({ tag: "OkHttp", message: "--> GET https://example.com/feed" });
    expect(lines[6]).toMatchObject({
      priority: "E",
      tag: "AndroidRuntime",
      message: "\tat dev.jasonpearson.Crash.run(Crash.kt:12)",
    });
    expect(lines[7]?.pid).toBe(4377);
  });

  test("tolerates CRLF line endings", () => {
    expect(parseThreadtime("10-21 08:00:00.000  1  2 I Tag: hi\r\n")).toHaveLength(1);
  });
});

describe("logcatFilterSpecs", () => {
  test("without tags, every tag at the minimum priority", () => {
    expect(logcatFilterSpecs(undefined, "W")).toEqual(["*:W"]);
  });

  test("with tags, the listed tags at their own or the minimum priority, the rest silenced", () => {
    expect(logcatFilterSpecs(["AndroidRuntime:E", "Playground"], "I")).toEqual([
      "AndroidRuntime:E",
      "Playground:I",
      "*:S",
    ]);
  });

  test("a tag spec that could escape the shell quoting is refused", () => {
    expect(() => logcatFilterSpecs(["x'; reboot"], "V")).toThrow("Invalid logcat tag spec");
    expect(() => logcatFilterSpecs(["Tag:Q"], "V")).toThrow("Invalid logcat tag spec");
  });
});

describe("logcatShellCommand", () => {
  test("dumps threadtime from the chosen buffers since a device-clock window, by uid", () => {
    expect(
      logcatShellCommand({
        buffers: ["main", "crash"],
        sinceSeconds: 12.2,
        filterSpecs: ["*:V"],
        uid: 10123,
      }),
    ).toBe(
      `logcat -d -v threadtime -b main -b crash -T "$(( $(date +%s) - 13 )).000" --uid=10123 '*:V'`,
    );
  });
});

describe("grep", () => {
  test("matches against `Tag: message` and rejects an invalid pattern", () => {
    const [line] = parseThreadtime("10-21 08:00:00.000  1  2 E AndroidRuntime: FATAL EXCEPTION");
    expect(matchesGrep(line!, compileGrep("^AndroidRuntime: FATAL"))).toBe(true);
    expect(matchesGrep(line!, compileGrep("OkHttp"))).toBe(false);
    expect(matchesGrep(line!, undefined)).toBe(true);
    expect(() => compileGrep("(")).toThrow("Invalid grep regular expression");
  });
});
