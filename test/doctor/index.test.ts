import { describe, expect, test } from "bun:test";
import { applyClientBuildIdentity, runDoctor } from "../../src/doctor";
import { formatConsoleOutput, formatJsonOutput } from "../../src/doctor/formatter";
import type { DoctorReport, CheckResult, DoctorSummary } from "../../src/doctor/types";

async function withProcessPlatform<T>(platform: NodeJS.Platform, fn: () => Promise<T>): Promise<T> {
  const original = process.platform;
  Object.defineProperty(process, "platform", {
    value: platform,
    configurable: true,
  });
  try {
    return await fn();
  } finally {
    Object.defineProperty(process, "platform", {
      value: original,
      configurable: true,
    });
  }
}

function makeCheck(
  overrides: Partial<CheckResult> & Pick<CheckResult, "name" | "status">,
): CheckResult {
  return {
    message: overrides.status,
    ...overrides,
  };
}

function makeReport(overrides: Partial<DoctorReport> = {}): DoctorReport {
  const systemChecks = overrides.system?.checks ?? [];
  const androidChecks = overrides.android?.checks;
  const iosChecks = overrides.ios?.checks;
  const autoMobileChecks = overrides.autoMobile?.checks ?? [];

  const allChecks = [
    ...systemChecks,
    ...(androidChecks ?? []),
    ...(iosChecks ?? []),
    ...autoMobileChecks,
  ];

  const summary: DoctorSummary = overrides.summary ?? {
    total: allChecks.length,
    passed: allChecks.filter((c) => c.status === "pass").length,
    warnings: allChecks.filter((c) => c.status === "warn").length,
    failed: allChecks.filter((c) => c.status === "fail").length,
    skipped: allChecks.filter((c) => c.status === "skip").length,
  };

  return {
    timestamp: "2025-01-01T00:00:00.000Z",
    version: "1.0.0",
    platform: "darwin",
    arch: "arm64",
    system: { checks: systemChecks },
    autoMobile: { checks: autoMobileChecks },
    summary,
    recommendations: overrides.recommendations ?? [],
    ...(androidChecks ? { android: { checks: androidChecks } } : {}),
    ...(iosChecks ? { ios: { checks: iosChecks } } : {}),
  };
}

describe("formatConsoleOutput", () => {
  test("includes header with version, platform, and timestamp", () => {
    const report = makeReport();
    const output = formatConsoleOutput(report, false);

    expect(output).toContain("AutoMobile Doctor");
    expect(output).toContain("=================");
    expect(output).toContain("Version: 1.0.0");
    expect(output).toContain("Platform: darwin (arm64)");
    expect(output).toContain("Timestamp: 2025-01-01T00:00:00.000Z");
  });

  test("all passing checks shows success message", () => {
    const report = makeReport({
      system: {
        checks: [makeCheck({ name: "OS", status: "pass", message: "darwin" })],
      },
      autoMobile: {
        checks: [makeCheck({ name: "Server", status: "pass", message: "ok" })],
      },
    });
    const output = formatConsoleOutput(report, false);

    expect(output).toContain("All checks passed! AutoMobile is ready to use.");
    expect(output).toContain("Passed: 2");
    expect(output).toContain("Warnings: 0");
    expect(output).toContain("Failed: 0");
  });

  test("warnings shows warning message", () => {
    const report = makeReport({
      system: {
        checks: [makeCheck({ name: "OS", status: "pass", message: "darwin" })],
      },
      autoMobile: {
        checks: [makeCheck({ name: "Cache", status: "warn", message: "stale" })],
      },
    });
    const output = formatConsoleOutput(report, false);

    expect(output).toContain("warnings to review");
    expect(output).not.toContain("Some checks failed");
  });

  test("failures shows failure message", () => {
    const report = makeReport({
      system: {
        checks: [makeCheck({ name: "OS", status: "fail", message: "unsupported" })],
      },
      autoMobile: {
        checks: [makeCheck({ name: "Server", status: "pass", message: "ok" })],
      },
    });
    const output = formatConsoleOutput(report, false);

    expect(output).toContain("Some checks failed");
  });

  test("skipped checks shows skipped count in summary", () => {
    const report = makeReport({
      system: {
        checks: [makeCheck({ name: "OS", status: "pass", message: "darwin" })],
      },
      autoMobile: {
        checks: [makeCheck({ name: "iOS Check", status: "skip", message: "not applicable" })],
      },
    });
    const output = formatConsoleOutput(report, false);

    expect(output).toContain("Skipped: 1");
  });

  test("skipped count is omitted when zero", () => {
    const report = makeReport({
      system: {
        checks: [makeCheck({ name: "OS", status: "pass", message: "darwin" })],
      },
      autoMobile: {
        checks: [makeCheck({ name: "Server", status: "pass", message: "ok" })],
      },
    });
    const output = formatConsoleOutput(report, false);

    expect(output).not.toContain("Skipped:");
  });

  test("useColors=false produces no ANSI escape codes", () => {
    const report = makeReport({
      system: {
        checks: [
          makeCheck({ name: "OS", status: "pass", message: "darwin" }),
          makeCheck({ name: "Broken", status: "fail", message: "bad" }),
          makeCheck({ name: "Iffy", status: "warn", message: "maybe" }),
          makeCheck({ name: "Skipped", status: "skip", message: "n/a" }),
        ],
      },
      autoMobile: { checks: [] },
    });
    const output = formatConsoleOutput(report, false);

    expect(output).not.toContain("\x1b[");
  });

  test("useColors=true produces ANSI escape codes", () => {
    const report = makeReport({
      system: {
        checks: [makeCheck({ name: "OS", status: "pass", message: "darwin" })],
      },
      autoMobile: { checks: [] },
    });
    const output = formatConsoleOutput(report, true);

    expect(output).toContain("\x1b[32m");
    expect(output).toContain("\x1b[0m");
  });

  test("check with value displays value instead of message", () => {
    const report = makeReport({
      system: {
        checks: [
          makeCheck({ name: "OS", status: "pass", message: "the message", value: "the-value" }),
        ],
      },
      autoMobile: { checks: [] },
    });
    const output = formatConsoleOutput(report, false);

    expect(output).toContain("[PASS] OS: the-value");
    expect(output).not.toContain("the message");
  });

  test("check without value displays message", () => {
    const report = makeReport({
      system: {
        checks: [makeCheck({ name: "OS", status: "pass", message: "the message" })],
      },
      autoMobile: { checks: [] },
    });
    const output = formatConsoleOutput(report, false);

    expect(output).toContain("[PASS] OS: the message");
  });

  test("recommendations on warn/fail checks in autoMobile section show tips", () => {
    const report = makeReport({
      system: { checks: [] },
      autoMobile: {
        checks: [
          makeCheck({
            name: "ADB",
            status: "fail",
            message: "not found",
            recommendation: "Install Android SDK",
          }),
        ],
      },
    });
    const output = formatConsoleOutput(report, false);

    expect(output).toContain("Tip: Install Android SDK");
  });

  test("recommendations on passing checks in autoMobile section do not show tips", () => {
    const report = makeReport({
      system: { checks: [] },
      autoMobile: {
        checks: [
          makeCheck({
            name: "ADB",
            status: "pass",
            message: "found",
            recommendation: "Should not appear",
          }),
        ],
      },
    });
    const output = formatConsoleOutput(report, false);

    expect(output).not.toContain("Tip: Should not appear");
  });

  test("recommendations on warn/fail checks in android section show tips", () => {
    const report = makeReport({
      system: { checks: [] },
      android: {
        checks: [
          makeCheck({
            name: "SDK",
            status: "warn",
            message: "outdated",
            recommendation: "Update SDK",
          }),
        ],
      },
      autoMobile: { checks: [] },
    });
    const output = formatConsoleOutput(report, false);

    expect(output).toContain("--- Android Platform ---");
    expect(output).toContain("Tip: Update SDK");
  });

  test("recommendations on warn/fail checks in ios section show tips", () => {
    const report = makeReport({
      system: { checks: [] },
      ios: {
        checks: [
          makeCheck({
            name: "Xcode",
            status: "fail",
            message: "missing",
            recommendation: "Install Xcode",
          }),
        ],
      },
      autoMobile: { checks: [] },
    });
    const output = formatConsoleOutput(report, false);

    expect(output).toContain("--- iOS Platform ---");
    expect(output).toContain("Tip: Install Xcode");
  });

  test("system section does not show tips even with recommendations", () => {
    const report = makeReport({
      system: {
        checks: [
          makeCheck({
            name: "OS",
            status: "fail",
            message: "unsupported",
            recommendation: "Use macOS",
          }),
        ],
      },
      autoMobile: { checks: [] },
    });
    const output = formatConsoleOutput(report, false);

    // System section doesn't render tips (per formatter logic)
    expect(output).toContain("[FAIL] OS");
    expect(output).not.toContain("Tip: Use macOS");
  });

  test("android section omitted when not present", () => {
    const report = makeReport({
      system: { checks: [] },
      autoMobile: { checks: [] },
    });
    const output = formatConsoleOutput(report, false);

    expect(output).not.toContain("--- Android Platform ---");
  });

  test("ios section omitted when not present", () => {
    const report = makeReport({
      system: { checks: [] },
      autoMobile: { checks: [] },
    });
    const output = formatConsoleOutput(report, false);

    expect(output).not.toContain("--- iOS Platform ---");
  });

  test("includes GitHub issues link", () => {
    const report = makeReport();
    const output = formatConsoleOutput(report, false);

    expect(output).toContain("https://github.com/kaeawc/auto-mobile/issues");
  });

  test("status icons are rendered correctly", () => {
    const report = makeReport({
      system: {
        checks: [
          makeCheck({ name: "A", status: "pass" }),
          makeCheck({ name: "B", status: "warn" }),
          makeCheck({ name: "C", status: "fail" }),
          makeCheck({ name: "D", status: "skip" }),
        ],
      },
      autoMobile: { checks: [] },
    });
    const output = formatConsoleOutput(report, false);

    expect(output).toContain("[PASS] A");
    expect(output).toContain("[WARN] B");
    expect(output).toContain("[FAIL] C");
    expect(output).toContain("[SKIP] D");
  });
});

describe("formatJsonOutput", () => {
  test("returns valid JSON", () => {
    const report = makeReport({
      system: {
        checks: [makeCheck({ name: "OS", status: "pass", message: "darwin" })],
      },
      autoMobile: { checks: [] },
    });
    const json = formatJsonOutput(report);

    expect(() => JSON.parse(json)).not.toThrow();
  });

  test("roundtrips correctly", () => {
    const report = makeReport({
      system: {
        checks: [makeCheck({ name: "OS", status: "pass", message: "darwin", value: "darwin" })],
      },
      android: {
        checks: [
          makeCheck({ name: "ADB", status: "warn", message: "old", recommendation: "update" }),
        ],
      },
      autoMobile: {
        checks: [makeCheck({ name: "Server", status: "pass", message: "running" })],
      },
      recommendations: ["ADB: update"],
    });

    const json = formatJsonOutput(report);
    const parsed = JSON.parse(json) as DoctorReport;

    expect(parsed.timestamp).toBe(report.timestamp);
    expect(parsed.version).toBe(report.version);
    expect(parsed.platform).toBe(report.platform);
    expect(parsed.arch).toBe(report.arch);
    expect(parsed.system.checks).toEqual(report.system.checks);
    expect(parsed.android?.checks).toEqual(report.android?.checks);
    expect(parsed.autoMobile.checks).toEqual(report.autoMobile.checks);
    expect(parsed.summary).toEqual(report.summary);
    expect(parsed.recommendations).toEqual(report.recommendations);
  });

  test("is pretty-printed with 2-space indentation", () => {
    const report = makeReport();
    const json = formatJsonOutput(report);

    // JSON.stringify with indent 2 starts object contents at 2-space indent
    expect(json).toContain('  "timestamp"');
  });
});

describe("runDoctor", () => {
  // Deterministic, I/O-free seams. The real runners shell out to ADB, sockets
  // and simctl; injecting fakes lets us assert orchestration (section selection,
  // summary math, version resolution) without real I/O or a wall-clock budget.
  const fakeDeps = () => ({
    runSystemChecks: () => [makeCheck({ name: "Runtime", status: "pass" })],
    runAndroidChecks: async () => [makeCheck({ name: "Android SDK", status: "pass" })],
    runIosChecks: async () => [makeCheck({ name: "Xcode", status: "skip" })],
    runAutoMobileChecks: async () => [makeCheck({ name: "AutoMobile Daemon", status: "warn" })],
  });

  test("runs android and autoMobile but not iOS for a default run on non-darwin", async () => {
    await withProcessPlatform("linux", async () => {
      const report = await runDoctor({}, fakeDeps());

      expect(report.android?.checks.map((c) => c.name)).toEqual(["Android SDK"]);
      expect(report.ios).toBeUndefined();
      expect(report.autoMobile.checks.map((c) => c.name)).toEqual(["AutoMobile Daemon"]);
    });
  });

  test("runs iOS and autoMobile but not android for an iOS-only run", async () => {
    await withProcessPlatform("linux", async () => {
      const report = await runDoctor({ ios: true }, fakeDeps());

      expect(report.platform).toBe("linux");
      expect(report.android).toBeUndefined();
      expect(report.ios?.checks.map((c) => c.name)).toEqual(["Xcode"]);
    });
  });

  test("summary.total counts every check across all rendered sections", async () => {
    await withProcessPlatform("linux", async () => {
      const report = await runDoctor({ ios: true }, fakeDeps());

      expect(report.summary.total).toBe(
        report.system.checks.length +
          (report.ios?.checks.length ?? 0) +
          report.autoMobile.checks.length,
      );
      expect(report.summary.passed).toBe(1);
      expect(report.summary.warnings).toBe(1);
      expect(report.summary.skipped).toBe(1);
    });
  });

  test("report.version is a concrete pinned version, never the 'latest' literal (#2746)", async () => {
    await withProcessPlatform("linux", async () => {
      const prev = process.env.AUTOMOBILE_VERSION;
      process.env.AUTOMOBILE_VERSION = "0.0.18";
      try {
        const report = await runDoctor({ ios: true }, fakeDeps());
        expect(report.version).toBe("0.0.18");
      } finally {
        if (prev === undefined) {
          delete process.env.AUTOMOBILE_VERSION;
        } else {
          process.env.AUTOMOBILE_VERSION = prev;
        }
      }
    });
  });
});

describe("applyClientBuildIdentity", () => {
  test("replaces the daemon's self-comparison with the client-side skew verdict and recounts", async () => {
    const report = makeReport({
      system: { checks: [makeCheck({ name: "Node.js", status: "pass" })] },
      autoMobile: {
        checks: [
          makeCheck({ name: "AutoMobile Daemon Version", status: "pass" }),
          // What the daemon produced by comparing itself to itself:
          makeCheck({
            name: "Daemon Build Identity",
            status: "pass",
            message: "Build aaaa (/daemon)",
          }),
        ],
      },
    });
    expect(report.summary.passed).toBe(3);
    expect(report.summary.warnings).toBe(0);

    const clientVerdict: CheckResult = {
      name: "Daemon Build Identity",
      status: "warn",
      message: "Build skew: daemon aaaa (/daemon), client bbbb (/wt)",
      recommendation: "Restart the daemon from THIS checkout.",
    };

    const result = await applyClientBuildIdentity(report, async () => clientVerdict);

    const entry = result.autoMobile.checks.find((c) => c.name === "Daemon Build Identity");
    expect(entry?.status).toBe("warn");
    expect(entry?.message).toContain("Build skew");
    // Recounted: one of the three passes became a warn.
    expect(result.summary.warnings).toBe(1);
    expect(result.summary.passed).toBe(2);
    expect(
      result.recommendations.some((r) => r.includes("Restart the daemon from THIS checkout")),
    ).toBe(true);
  });

  test("appends the client verdict when the daemon report lacks the check (older daemon)", async () => {
    const report = makeReport({
      autoMobile: { checks: [makeCheck({ name: "AutoMobile Daemon Version", status: "pass" })] },
    });

    const clientVerdict: CheckResult = {
      name: "Daemon Build Identity",
      status: "warn",
      message: "Build skew",
    };

    const result = await applyClientBuildIdentity(report, async () => clientVerdict);

    expect(result.autoMobile.checks.filter((c) => c.name === "Daemon Build Identity")).toHaveLength(
      1,
    );
    expect(result.summary.warnings).toBe(1);
  });

  test("is a no-op when the report has no AutoMobile section", async () => {
    let ran = false;
    const malformed = { summary: { failed: 0 } } as any;

    const result = await applyClientBuildIdentity(malformed, async () => {
      ran = true;
      return { name: "Daemon Build Identity", status: "warn", message: "x" };
    });

    expect(ran).toBe(false);
    expect(result).toBe(malformed);
  });
});
