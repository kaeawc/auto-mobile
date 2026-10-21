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
        return [
          "Timestamp               Ty Process[PID:TID]",
          "2026-10-21 08:15:30.123 Df Playground[12:34] [com.example:net] request failed",
          "2026-10-21 08:15:31.000 I  Playground[12:34] [com.example:ui] shown",
        ].join("\n");
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

  test("iOS without appId is refused", async () => {
    await expect(
      new GetLogs({
        clock: clock(),
        android: () => new RecordingAndroid(),
        ios: () => ({ collect: async () => "" }),
      }).execute(SIMULATOR, {}),
    ).rejects.toThrow("getLogs on iOS needs appId");
  });

  test("parseUnifiedCompact keeps only timestamped lines", () => {
    expect(parseUnifiedCompact("Filtering the log data\n2026-10-21 08:00:00.000 E  x")).toEqual([
      { timestamp: "2026-10-21 08:00:00.000", message: "E  x" },
    ]);
  });
});
