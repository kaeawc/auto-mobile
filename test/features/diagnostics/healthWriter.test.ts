import { describe, expect, test } from "bun:test";
import path from "path";
import {
  DefaultHealthWriter,
  type HealthWriterFs,
} from "../../../src/features/diagnostics/healthWriter";
import type { RunHealthSummary } from "../../../src/features/diagnostics/types";


function makeSummary(overrides: Partial<RunHealthSummary> = {}): RunHealthSummary {
  return {
    version: 1,
    sessionId: "session-abc",
    planName: "demo",
    startedAt: "2026-05-21T14:00:00.000Z",
    finishedAt: "2026-05-21T14:00:05.000Z",
    durationMs: 5000,
    device: null,
    screenshot: {
      count: 0,
      latencyMs: { count: 0, minMs: 0, p50Ms: 0, p90Ms: 0, p99Ms: 0, maxMs: 0 },
    },
    backStack: {
      count: 0,
      latencyMs: { count: 0, minMs: 0, p50Ms: 0, p90Ms: 0, p99Ms: 0, maxMs: 0 },
    },
    accessibilityDetector: {
      count: 0,
      latencyMs: { count: 0, minMs: 0, p50Ms: 0, p90Ms: 0, p99Ms: 0, maxMs: 0 },
    },
    hierarchy: {
      syncRequests: 0,
      freshDeliveries: 0,
      staleCacheReturns: 0,
      timeouts: 0,
      stalenessRate: 0,
      freshLatencyMs: { count: 0, minMs: 0, p50Ms: 0, p90Ms: 0, p99Ms: 0, maxMs: 0 },
    },
    awaitIdle: {
      calls: 0,
      timeouts: 0,
      timeoutRate: 0,
      durationMs: { count: 0, minMs: 0, p50Ms: 0, p90Ms: 0, p99Ms: 0, maxMs: 0 },
    },
    toolCalls: { total: 0, successes: 0, failures: 0, byTool: {} },
    ghostTap: {
      evaluations: 0,
      tapRegistered: 0,
      falsePositives: 0,
      bailedNullHierarchy: 0,
      falsePositiveRate: 0,
    },
    ...overrides,
  };
}


class FakeWriterFs implements HealthWriterFs {

  public readonly mkdirCalls: { p: string; recursive: boolean }[] = [];

  public readonly writtenFiles: Map<string, string> = new Map();

  public writeShouldThrow: Error | null = null;


  mkdirSync(p: string, options: { recursive: boolean }): void {
    this.mkdirCalls.push({ p, recursive: options.recursive });
  }


  writeFileSync(p: string, contents: string): void {
    if (this.writeShouldThrow) {
      throw this.writeShouldThrow;
    }
    this.writtenFiles.set(p, contents);
  }
}


describe("DefaultHealthWriter", () => {

  test("writes JSON to the resolved directory and returns the full path", () => {
    const fakeFs = new FakeWriterFs();
    const writer = new DefaultHealthWriter({
      envValue: "/tmp/health",
      homeDir: "/home/user",
      fs: fakeFs,
      randomSuffix: () => "deadbeef",
    });

    const fullPath = writer.write(makeSummary());

    expect(fullPath).not.toBeNull();
    expect(fakeFs.mkdirCalls[0]).toEqual({ p: path.resolve("/tmp/health"), recursive: true });
    expect(fakeFs.writtenFiles.size).toBe(1);
    const [writtenPath, contents] = Array.from(fakeFs.writtenFiles.entries())[0];
    expect(writtenPath).toBe(fullPath);
    expect(writtenPath).toContain("session-abc");
    expect(writtenPath.endsWith(".json")).toBe(true);
    const parsed = JSON.parse(contents);
    expect(parsed.sessionId).toBe("session-abc");
  });


  test("uses the random-suffix seam for ad-hoc filenames when sessionId is null", () => {
    const fakeFs = new FakeWriterFs();
    const writer = new DefaultHealthWriter({
      envValue: "/tmp/health",
      homeDir: "/home/user",
      fs: fakeFs,
      randomSuffix: () => "cafebabe",
    });

    const fullPath = writer.write(makeSummary({ sessionId: null }));

    expect(fullPath).not.toBeNull();
    expect(fullPath).toContain("adhoc-cafebabe");
  });


  test("returns null and does not throw when the underlying write fails", () => {
    const fakeFs = new FakeWriterFs();
    fakeFs.writeShouldThrow = new Error("disk full");
    const writer = new DefaultHealthWriter({
      envValue: "/tmp/health",
      homeDir: "/home/user",
      fs: fakeFs,
      randomSuffix: () => "deadbeef",
    });

    const result = writer.write(makeSummary());

    expect(result).toBeNull();
  });
});
