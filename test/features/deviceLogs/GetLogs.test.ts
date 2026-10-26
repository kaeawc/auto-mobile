import { describe, expect, test } from "bun:test";
import {
  boundLines,
  GetLogs,
  parseUnifiedCompact,
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
        calls.push([args[0], args[4]]);
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
