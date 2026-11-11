import { describe, expect, test } from "bun:test";
import {
  boundLines,
  GetLogs,
  meetsUnifiedPriority,
  parseUnifiedCompact,
  unifiedLinePriority,
  resolveSinceSeconds,
  type AndroidLogSource,
  type GetLogsClock,
  type IosUnifiedLogSource,
} from "../../../src/features/deviceLogs/GetLogs";
import type { AndroidLogRequest } from "../../../src/features/deviceLogs/AndroidLogReader";
import { parseThreadtime } from "../../../src/features/deviceLogs/logcatQuery";
import type { BootedDevice } from "../../../src/models";
import { executableOfApp } from "../../../src/server/getLogsTools";
import { unifiedLogPredicate } from "../../../src/server/unifiedLogWindow";

const ANDROID: BootedDevice = { name: "Pixel", platform: "android", deviceId: "emulator-5554" };
const SIMULATOR: BootedDevice = { name: "iPhone", platform: "ios", deviceId: "SIM-UDID" };
const WATCH_SIMULATOR: BootedDevice = {
  name: "Watch",
  platform: "watchos",
  deviceId: "WATCH-UDID",
};

function clock(overrides: Partial<GetLogsClock> = {}): GetLogsClock {
  return {
    now: () => 100_000,
    lastActionStartMs: () => undefined,
    sessionStartMs: () => undefined,
    ...overrides,
  };
}

class RecordingAndroid implements AndroidLogSource {
  requests: AndroidLogRequest[] = [];
  constructor(private readonly text = "") {}
  read = async (request: AndroidLogRequest) => {
    this.requests.push(request);
    const lines = parseThreadtime(this.text);
    return { lines, pids: [], attribution: "uid" as const, warnings: [] };
  };
}

describe("resolveSinceSeconds (#14082)", () => {
  test("run-start uses this execution's start, including zero, and rejects a missing plan", () => {
    const warnings: string[] = [];
    expect(
      resolveSinceSeconds("run-start", "d", clock({ planStartMs: () => 92_500 }), warnings),
    ).toBe(8);
    expect(resolveSinceSeconds("run-start", "d", clock({ planStartMs: () => 0 }), warnings)).toBe(
      100,
    );
    expect(warnings).toEqual([]);
    expect(() => resolveSinceSeconds("run-start", "d", clock(), [])).toThrow(
      "requires an executing plan",
    );
  });

  test("lastAction is measured from the latest control call's start", () => {
    const warnings: string[] = [];
    expect(
      resolveSinceSeconds(
        "lastAction",
        "emulator-5554",
        clock({ lastActionStartMs: () => 92_500 }),
        warnings,
      ),
    ).toBe(8);
    expect(warnings).toEqual([]);
  });

  test("sessionStart uses the session's creation; seconds are taken as given", () => {
    expect(
      resolveSinceSeconds("sessionStart", "d", clock({ sessionStartMs: () => 40_000 }), []),
    ).toBe(60);
    expect(resolveSinceSeconds({ seconds: 42 }, "d", clock(), [])).toBe(42);
  });

  test("an unknown anchor falls back to the default window with a warning", () => {
    const warnings: string[] = [];
    expect(resolveSinceSeconds("lastAction", "d", clock(), warnings)).toBe(300);
    expect(warnings[0]).toContain("No earlier action on d");
  });

  test("an old anchor is capped at one hour", () => {
    const warnings: string[] = [];
    expect(
      resolveSinceSeconds(
        "sessionStart",
        "d",
        clock({ now: () => 10_000_000, sessionStartMs: () => 0 }),
        warnings,
      ),
    ).toBe(3600);
    expect(warnings[0]).toContain("capped");
  });
});

describe("boundLines", () => {
  const lines = Array.from({ length: 10 }, (_, index) => ({ message: `line ${index}` }));

  test("keeps the newest lines within maxLines", () => {
    expect(boundLines(lines, 3)).toEqual({
      lines: [{ message: "line 7" }, { message: "line 8" }, { message: "line 9" }],
      truncated: true,
    });
    expect(boundLines(lines, 50).truncated).toBe(false);
  });

  test("keeps the newest lines within the byte bound", () => {
    const bounded = boundLines(lines, 50, 2 * (6 + 64));
    expect(bounded.lines.map((line) => line.message)).toEqual(["line 8", "line 9"]);
  });
});

describe("GetLogs", () => {
  test("Android: defaults to main+crash, all priorities, and the default window", async () => {
    const android = new RecordingAndroid(
      "10-21 08:15:30.123  4211  4211 E AndroidRuntime: FATAL EXCEPTION: main",
    );
    const result = await new GetLogs({
      clock: clock(),
      android: () => android,
      ios: () => {
        throw new Error("unused");
      },
    }).execute(ANDROID, { appId: "com.example" });
    expect(android.requests[0]).toEqual({
      appId: "com.example",
      sinceSeconds: 300,
      tags: undefined,
      minPriority: "V",
      grep: undefined,
      buffers: ["main", "crash"],
      includeSystem: false,
    });
    expect(result).toMatchObject({
      platform: "android",
      attribution: "uid",
      pids: [4211],
      truncated: false,
    });
  });

  test("Android: an anchored since is re-derived at read time, not frozen at request time", async () => {
    let now = 100_000;
    const android = new RecordingAndroid();
    await new GetLogs({
      clock: clock({ now: () => now, planStartMs: () => 90_000 }),
      android: () => android,
      ios: () => {
        throw new Error("unused");
      },
    }).execute(ANDROID, { appId: "com.example", since: "run-start" });
    expect(android.requests[0]?.sinceSeconds).toBe(10);
    now = 103_000;
    expect(android.requests[0]?.refreshSinceSeconds?.()).toBe(13);
  });

  test("iOS: an anchored since is re-derived after the process-name probe", async () => {
    let now = 100_000;
    const seconds: number[] = [];
    const ios: IosUnifiedLogSource = {
      resolveProcessName: async () => {
        // A slow `simctl listapps` takes 3 fake seconds.
        now += 3_000;
        return "Playground";
      },
      collect: async (_appId, sinceSeconds) => {
        seconds.push(sinceSeconds);
        return { text: "", truncated: false };
      },
    };
    await new GetLogs({
      clock: clock({ now: () => now, planStartMs: () => 90_000 }),
      android: () => {
        throw new Error("unused");
      },
      ios: () => ios,
    }).execute(SIMULATOR, { appId: "com.example", since: "run-start" });
    // 10s at request time plus the 3s probe: the window must cover the whole 13s.
    expect(seconds).toEqual([13]);
  });

  test("iOS: reads the app's unified log, applies grep and reports ignored filters", async () => {
    const calls: unknown[] = [];
    const ios: IosUnifiedLogSource = {
      collect: async (...args) => {
        calls.push(args.slice(0, 3));
        return {
          truncated: false,
          text: [
            "Timestamp               Ty Process[PID:TID]",
            "2026-10-21 08:15:30.123 Df Playground[12:34] [com.example:net] request failed",
            "2026-10-21 08:15:31.000 I  Playground[12:34] [com.example:ui] shown",
          ].join("\n"),
        };
      },
    };
    const result = await new GetLogs({
      clock: clock(),
      android: () => {
        throw new Error("unused");
      },
      ios: () => ios,
    }).execute(SIMULATOR, {
      appId: "com.example",
      minPriority: "I",
      grep: "failed",
      tags: ["X"],
      since: { seconds: 30 },
    });
    expect(calls).toEqual([["com.example", 30, "info"]]);
    expect(result.lines).toEqual([
      {
        timestamp: "2026-10-21 08:15:30.123",
        message: "Df Playground[12:34] [com.example:net] request failed",
      },
    ]);
    expect(result.attribution).toBe("subsystem");
    expect(result.warnings[0]).toContain("Android-only filters ignored on iOS: tags");
  });

  test("iOS: also matches the app's process and warns when nothing matched (#14739)", async () => {
    const calls: unknown[] = [];
    const ios: IosUnifiedLogSource = {
      resolveProcessName: async () => "Preferences",
      collect: async (...args) => {
        calls.push([args[0], args[3]?.processName]);
        return { text: "", truncated: false };
      },
    };
    const result = await new GetLogs({
      clock: clock(),
      android: () => new RecordingAndroid(),
      ios: () => ios,
    }).execute(SIMULATOR, { appId: "com.apple.Preferences" });

    expect(calls).toEqual([["com.apple.Preferences", "Preferences"]]);
    expect(result.attribution).toBe("process");
    expect(result.warnings).toEqual([expect.stringContaining("process Preferences")]);
  });

  test("iOS: a failed process lookup falls back to the subsystem with a warning (#14739)", async () => {
    const ios: IosUnifiedLogSource = {
      resolveProcessName: async () => {
        throw new Error("listapps timed out");
      },
      collect: async () => ({
        text: "2026-10-21 08:15:30.123 I  App[1:2] [com.example:ui] shown",
        truncated: false,
      }),
    };
    const result = await new GetLogs({
      clock: clock(),
      android: () => new RecordingAndroid(),
      ios: () => ios,
    }).execute(SIMULATOR, { appId: "com.example" });

    expect(result.attribution).toBe("subsystem");
    expect(result.lines).toHaveLength(1);
    expect(result.warnings).toEqual([expect.stringContaining("listapps timed out")]);
  });

  test("unifiedLogPredicate adds an escaped process clause (#14739)", () => {
    expect(unifiedLogPredicate("com.example")).toBe(
      'subsystem == "com.example" OR subsystem BEGINSWITH "com.example."',
    );
    expect(unifiedLogPredicate("com.example", 'My"App')).toBe(
      'subsystem == "com.example" OR subsystem BEGINSWITH "com.example." OR process == "My\\"App"',
    );
  });

  test("executableOfApp reads CFBundleExecutable from a listapps record", () => {
    const apps = [{ bundleId: "com.apple.Preferences", CFBundleExecutable: "Preferences" }];
    expect(executableOfApp(apps, "com.apple.Preferences")).toBe("Preferences");
    expect(executableOfApp(apps, "com.other")).toBeUndefined();
  });

  test("iOS without appId is refused", async () => {
    await expect(
      new GetLogs({
        clock: clock(),
        android: () => new RecordingAndroid(),
        ios: () => ({ collect: async () => ({ text: "", truncated: false }) }),
      }).execute(SIMULATOR, {}),
    ).rejects.toThrow("getLogs on iOS needs appId");
  });

  test("parseUnifiedCompact keeps only timestamped lines", () => {
    expect(parseUnifiedCompact("Filtering the log data\n2026-10-21 08:00:00.000 E  x")).toEqual([
      { timestamp: "2026-10-21 08:00:00.000", message: "E  x" },
    ]);
  });
});

for (const maxLines of [1, 100]) {
  test(`iOS default window preserves source byte truncation with maxLines ${maxLines}`, async () => {
    const result = await new GetLogs({
      clock: clock(),
      android: () => new RecordingAndroid(),
      ios: () => ({
        collect: async (_appId, seconds) => {
          expect(seconds).toBe(300);
          return {
            text: "2026-10-21 08:15:30.123 I App[1:2] older\n2026-10-21 08:15:31.123 I App[1:2] newest\n",
            truncated: true,
          };
        },
      }),
    }).execute(SIMULATOR, { appId: "com.example", maxLines });
    expect(result.truncated).toBe(true);
    expect(result.lines.at(-1)?.message).toContain("newest");
    expect(result.lines).toHaveLength(Math.min(maxLines, 2));
    expect(result.warnings).toContain(
      "The unified log window exceeded the byte bound; only the newest lines were read.",
    );
  });
}

// The four lines verbatim from #17963 (iPhone 17, iOS 26.5), plus an `In`, a `Db`, an `A` and a `Fa` line.
const CAPTURED_17963 = [
  "Timestamp               Ty Process[PID:TID]",
  "2026-11-11 09:14:42.351 Df Fix[11444:a60d473] [dev.am17547.iosfixture:fixture] IOSFIXTURE-ALPHA one",
  "2026-11-11 09:14:42.352 E  Fix[11444:a60d473] [dev.am17547.iosfixture:fixture] IOSFIXTURE-BETA two",
  "2026-11-11 09:14:42.374 Df Fix[11444:a60d473] (libMobileGestalt.dylib) No persisted cache on this platform.",
  "2026-11-11 09:14:42.374 Df Fix[11444:a60d484] [com.apple.xpc:connection] [0x1011fb950] activating connection: mach=true listener=false peer=false name=com.apple.cfprefsd.daemon",
  "2026-11-11 09:14:42.380 In Fix[11444:a60d473] [dev.am17547.iosfixture:fixture] IOSFIXTURE-INFO three",
  "2026-11-11 09:14:42.381 Db Fix[11444:a60d473] [dev.am17547.iosfixture:fixture] IOSFIXTURE-DEBUG four",
  "2026-11-11 09:14:42.382 A  Fix[11444:a60d473] activity created: 0x1234",
  "2026-11-11 09:14:42.383 Fa Fix[11444:a60d473] [dev.am17547.iosfixture:fixture] IOSFIXTURE-FAULT five",
].join("\n");

describe("Apple unified-log minPriority (#17963)", () => {
  test("type columns map to the documented priority scale", () => {
    expect(
      ["Db x", "In x", "Df x", "A  x", "E  x", "Fa x", "Sp x", "no-type"].map(unifiedLinePriority),
    ).toEqual(["D", "I", "W", "W", "E", "F", "W", "W"]);
  });

  test("each minPriority keeps its own rank and above", () => {
    const kept = (min: "V" | "D" | "I" | "W" | "E" | "F") =>
      parseUnifiedCompact(CAPTURED_17963)
        .filter((line) => meetsUnifiedPriority(line.message, min))
        .map((line) => line.message.slice(0, 2).trim());
    expect(kept("V")).toEqual(["Df", "E", "Df", "Df", "In", "Db", "A", "Fa"]);
    expect(kept("D")).toEqual(kept("V"));
    expect(kept("I")).toEqual(["Df", "E", "Df", "Df", "In", "A", "Fa"]);
    expect(kept("W")).toEqual(["Df", "E", "Df", "Df", "A", "Fa"]);
    expect(kept("E")).toEqual(["E", "Fa"]);
    expect(kept("F")).toEqual(["Fa"]);
  });

  for (const device of [SIMULATOR, WATCH_SIMULATOR]) {
    test(`${device.platform}: minPriority E returns only error and fault lines`, async () => {
      const levels: unknown[] = [];
      const result = await new GetLogs({
        clock: clock(),
        android: () => {
          throw new Error("unused");
        },
        ios: () => ({
          collect: async (_appId, _seconds, level) => {
            levels.push(level);
            return { text: CAPTURED_17963, truncated: false };
          },
        }),
      }).execute(device, { appId: "dev.am17547.iosfixture", minPriority: "E" });
      expect(levels).toEqual(["default"]);
      expect(result.lines).toEqual([
        {
          timestamp: "2026-11-11 09:14:42.352",
          message: "E  Fix[11444:a60d473] [dev.am17547.iosfixture:fixture] IOSFIXTURE-BETA two",
        },
        {
          timestamp: "2026-11-11 09:14:42.383",
          message: "Fa Fix[11444:a60d473] [dev.am17547.iosfixture:fixture] IOSFIXTURE-FAULT five",
        },
      ]);
    });
  }
});
