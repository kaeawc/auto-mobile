import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

const TEST_DIR = path.join(import.meta.dir, "..");
const SERVER_CLASSES = [
  "Appearance",
  "DeviceSnapshot",
  "FailuresPush",
  "FailuresStream",
  "DeviceDataStream",
  "PerformancePush",
  "PerformanceStream",
  "TelemetryPush",
  "TestRecording",
  "VideoRecording",
  "VideoStream",
  "WebRtcStream",
];

// Relative test path -> accepted pre-existing violation lines. Keep empty while possible.
const ALLOWLIST: Record<string, string[]> = {};

function testFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? testFiles(file) : entry.name.endsWith(".test.ts") ? [file] : [];
  });
}

function candidateFiles(): string[] {
  const matches = spawnSync(
    "rg",
    ["-l", "--glob", "*.test.ts", "homedir|defaultPath|getSocketPath", TEST_DIR],
    { encoding: "utf8" },
  );
  if (!matches.error && (matches.status === 0 || matches.status === 1)) {
    return matches.stdout.trim().split("\n").filter(Boolean);
  }
  // Keep the guard portable when ripgrep is unavailable.
  return testFiles(TEST_DIR);
}

function normalizeRelativePath(relative: string): string {
  return relative.split(path.sep).join("/").split("\\").join("/");
}

const homeSocket =
  /(?:path\.)?join\s*\(\s*(?:os\.)?homedir\s*\(\s*\)\s*,\s*["']\.auto-mobile["']\s*,\s*["'][^"']+\.sock["']\s*\)/g;
const explicitDefault = new RegExp(
  `new\\s+(?:${SERVER_CLASSES.join("|")})SocketServer\\s*\\(\\s*(?:[A-Z_]+_SOCKET_CONFIG\\.defaultPath|getSocketPath\\s*\\()`,
  "g",
);

function violations(source: string): string[] {
  const found: string[] = [];
  for (const [pattern, label] of [
    [homeSocket, "home socket path"],
    [explicitDefault, "explicit production socket path"],
  ] as const) {
    pattern.lastIndex = 0;
    for (const match of source.matchAll(pattern)) {
      const line = source.slice(0, match.index).split("\n").length;
      found.push(`${line}: ${label}`);
    }
  }
  return found;
}

describe("auxiliary socket test boundary (issue #7616)", () => {
  test("normalizes Windows relative paths to POSIX form", () => {
    expect(normalizeRelativePath("lint\\auxSocketDirBoundary.test.ts")).toBe(
      "lint/auxSocketDirBoundary.test.ts",
    );
  });

  test("unit tests do not target production auxiliary socket paths", () => {
    const files = candidateFiles();
    expect(files.length).toBeGreaterThan(0);
    const offenders = files.flatMap((file) => {
      const relative = normalizeRelativePath(path.relative(TEST_DIR, file));
      // The guard's own string fixtures intentionally contain forbidden examples.
      if (relative === "lint/auxSocketDirBoundary.test.ts") {
        return [];
      }
      const allowed = [...(ALLOWLIST[relative] ?? [])];
      return violations(readFileSync(file, "utf8"))
        .filter((violation) => {
          const index = allowed.indexOf(violation);
          if (index < 0) {
            return true;
          }
          allowed.splice(index, 1);
          return false;
        })
        .map((violation) => `${relative}:${violation}`);
    });
    expect(offenders).toEqual([]);
    expect(
      violations('path.join(os.homedir(), ".auto-mobile", "observation-stream.sock")'),
    ).toHaveLength(1);
    expect(
      violations("new DeviceDataStreamSocketServer(DEVICE_DATA_STREAM_SOCKET_CONFIG.defaultPath)"),
    ).toHaveLength(1);
  });
});
