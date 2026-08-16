import { describe, expect, test } from "bun:test";
import { formatHealthReport, formatSocketDiagnostics } from "../../src/daemon/debugTools";
import type { DaemonHealthReport, SocketDiagnostics } from "../../src/daemon/debugTools";

/**
 * Behaviour pins for the two report formatters (#3966).
 *
 * Both build their output by appending to a `lines` array, and the
 * `auto-mobile/no-accumulator-foreach` burn-down rewrote their per-item
 * appends from `forEach(x => lines.push(...))` to `lines.push(...map(...))`.
 * That rewrite is mechanical but not free: spreading an empty array appends
 * nothing where a `forEach` over an empty array also appended nothing, and the
 * ORDER of the appended items relative to their section heading is the thing a
 * careless rewrite gets wrong. These pin both.
 */

function healthReport(overrides: Partial<DaemonHealthReport> = {}): DaemonHealthReport {
  return {
    timestamp: "2026-07-19T00:00:00.000Z",
    daemonRunning: true,
    socketExists: true,
    socketAccessible: true,
    pidFileExists: true,
    pidFileValid: true,
    socketConnectable: true,
    recommendations: [],
    ...overrides,
  };
}

function socketDiagnostics(overrides: Partial<SocketDiagnostics> = {}): SocketDiagnostics {
  return {
    socketExists: true,
    socketReadable: true,
    socketWritable: true,
    socketConnectable: true,
    lastTestTime: "2026-07-19T00:00:00.000Z",
    issues: [],
    ...overrides,
  };
}

describe("formatHealthReport recommendations", () => {
  test("renders every recommendation, in order, under the heading", () => {
    const output = formatHealthReport(healthReport({
      recommendations: ["first thing", "second thing", "third thing"],
    }));

    expect(output).toContain("Recommendations:");
    expect(output).toContain("  • first thing");
    expect(output).toContain("  • second thing");
    expect(output).toContain("  • third thing");

    const lines = output.split("\n");
    const headingIndex = lines.indexOf("Recommendations:");
    expect(headingIndex).toBeGreaterThanOrEqual(0);
    // Order is preserved and the items follow the heading immediately.
    expect(lines.slice(headingIndex + 1, headingIndex + 4)).toEqual([
      "  • first thing",
      "  • second thing",
      "  • third thing",
    ]);
  });

  test("emits the heading and no bullets when there are no recommendations", () => {
    const output = formatHealthReport(healthReport({ recommendations: [] }));

    expect(output).toContain("Recommendations:");
    expect(output).not.toContain("  • ");
  });
});

describe("formatSocketDiagnostics issues", () => {
  test("renders every issue, in order, under the heading", () => {
    const output = formatSocketDiagnostics(socketDiagnostics({
      issues: ["socket missing", "permission denied"],
    }));

    expect(output).toContain("Issues Found:");
    const lines = output.split("\n");
    const headingIndex = lines.indexOf("Issues Found:");
    expect(headingIndex).toBeGreaterThanOrEqual(0);
    expect(lines.slice(headingIndex + 1, headingIndex + 3)).toEqual([
      "  ⚠ socket missing",
      "  ⚠ permission denied",
    ]);
  });

  test("omits the whole section when there are no issues", () => {
    const output = formatSocketDiagnostics(socketDiagnostics({ issues: [] }));

    expect(output).not.toContain("Issues Found:");
    expect(output).not.toContain("  ⚠ ");
  });
});
