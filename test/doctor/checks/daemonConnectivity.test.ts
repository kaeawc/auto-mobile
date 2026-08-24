import { describe, expect, test } from "bun:test";
import { checkDaemonConnectivity } from "../../../src/doctor/checks/automobile";
import type { DaemonHealthReport } from "../../../src/daemon/debugTools";

const healthReport = (overrides: Partial<DaemonHealthReport> = {}): DaemonHealthReport => ({
  timestamp: "2026-07-27T00:00:00.000Z",
  daemonRunning: true,
  socketExists: true,
  socketAccessible: true,
  pidFileExists: true,
  pidFileValid: true,
  socketConnectable: true,
  recommendations: [],
  ...overrides,
});

describe("checkDaemonConnectivity", () => {
  test.each([
    {
      name: "reports pass when the daemon socket accepts connections",
      report: healthReport(),
      expected: { status: "pass", message: "Daemon is responsive" },
    },
    {
      name: "reports skip when no daemon is running",
      report: healthReport({ daemonRunning: false, socketConnectable: false }),
      expected: { status: "skip", message: "Daemon is not running" },
    },
    {
      name: "reports the daemon recommendation when a running daemon is hung",
      report: healthReport({
        socketConnectable: false,
        recommendations: ["Remove stale socket", "Restart daemon"],
      }),
      expected: {
        status: "warn",
        message: "Daemon running but not responding",
        recommendation: "Remove stale socket; Restart daemon",
      },
    },
    {
      name: "falls back to the restart recommendation when a hung daemon gives none",
      report: healthReport({ socketConnectable: false }),
      expected: { status: "warn", message: "Daemon running but not responding" },
      recommendationContains: "--daemon restart",
    },
  ])("$name", async ({ report, expected, recommendationContains }) => {
    const result = await checkDaemonConnectivity(async () => report);

    expect(result).toMatchObject(expected);
    if (recommendationContains) {
      expect(result.recommendation).toContain(recommendationContains);
      expect(result.recommendation).not.toContain("@latest");
    } else if (!("recommendation" in expected)) {
      expect(result.recommendation).toBeUndefined();
    }
  });

  test("returns a warning when the health probe throws", async () => {
    const result = await checkDaemonConnectivity(async () => {
      throw new Error("socket unavailable");
    });

    expect(result).toMatchObject({
      name: "Daemon Connectivity",
      status: "warn",
      message: "Connectivity check failed: socket unavailable",
    });
  });
});
