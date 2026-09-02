import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

const repoRoot = join(import.meta.dir, "../..");
const testRoot = join(repoRoot, "test");

function discoverTests(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return discoverTests(path);
    }
    return entry.name.endsWith(".test.ts") ? [relative(repoRoot, path).split(sep).join("/")] : [];
  });
}

function laneFor(path: string): "unit" | "integration" | "stress" {
  if (path.startsWith("test/stress/")) {
    return "stress";
  }
  if (path.endsWith(".integration.test.ts")) {
    return "integration";
  }
  return "unit";
}

describe("TypeScript test lane classification", () => {
  const tests = discoverTests(testRoot);

  test("every discovered Bun test belongs to exactly one canonical lane", () => {
    expect(tests.length).toBeGreaterThan(500);
    for (const path of tests) {
      const memberships = [
        laneFor(path) === "unit",
        laneFor(path) === "integration",
        laneFor(path) === "stress",
      ].filter(Boolean);
      expect(memberships, path).toHaveLength(1);
    }
  });

  test("the integration directory contains only suffix-classified tests", () => {
    const offenders = tests
      .filter((path) => path.startsWith("test/integration/"))
      .filter((path) => laneFor(path) !== "integration");
    expect(offenders).toEqual([]);
  });

  test("representative host, platform, guard, Windows, and stress tests stay in their lanes", () => {
    const expected = new Map<string, ReturnType<typeof laneFor>>([
      ["test/package/webrtcRuntimeMetadata.test.ts", "unit"],
      ["test/parity/webrtcDeviceCaptureLatency.test.ts", "unit"],
      ["test/features/observe/ios/IOSCtrlProxyClient.test.ts", "unit"],
      ["test/features/observe/ios/IOSCtrlProxyClient.stream.integration.test.ts", "integration"],
      ["test/daemon/daemonClientAvailability.integration.test.ts", "integration"],
      ["test/db/databaseMigrationFailure.integration.test.ts", "integration"],
      ["test/scripts/xcodegenDriftCheck.integration.test.ts", "integration"],
      ["test/integration/webrtcDeviceCapture.integration.test.ts", "integration"],
      ["test/stress/memory-leak.stress.test.ts", "stress"],
    ]);

    for (const [path, lane] of expected) {
      expect(tests, path).toContain(path);
      expect(laneFor(path), path).toBe(lane);
    }
  });

  test("the unit runner excludes only the canonical integration suffix and stress tree", () => {
    const runner = readFileSync(join(repoRoot, "scripts/test-ts.sh"), "utf8");
    expect(runner).toContain('--path-ignore-patterns "**/*.integration.test.ts"');
    expect(runner).toContain('--path-ignore-patterns "test/stress/**"');
    expect(runner).not.toContain("test/integration/**");
  });
});
