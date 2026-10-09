import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import {
  calculateMetrics,
  formatReportJson,
  formatReportTable,
  helpText,
  parseBenchmarkArgs,
  platformFromDeviceList,
  settledAsyncDelta,
  type BenchmarkReport,
} from "../../scripts/benchmarkSettledScreenshotReport";
import {
  runBenchmark,
  type BenchmarkClient,
  type BenchmarkDeps,
} from "../../scripts/benchmark-settled-screenshot";

describe("benchmark-settled-screenshot pure logic", () => {
  test("arguments apply defaults and accept target and overrides", () => {
    expect(parseBenchmarkArgs(["--platform", "ios"])).toMatchObject({
      iterations: 30,
      warmup: 3,
      platform: "ios",
    });
    expect(
      parseBenchmarkArgs([
        "--device",
        "emulator-1",
        "--iterations",
        "7",
        "--warmup",
        "0",
        "--json",
      ]),
    ).toMatchObject({ deviceId: "emulator-1", iterations: 7, warmup: 0, json: true });
  });
  test("help needs no device and invalid targeting/flags fail", () => {
    expect(parseBenchmarkArgs(["--help"]).help).toBe(true);
    expect(helpText()).toContain("ambient default, not mode-controlled");
    expect(() => parseBenchmarkArgs([])).toThrow("Specify a target");
    expect(() => parseBenchmarkArgs(["--platform", "android", "--device", "x"])).toThrow(
      "not both",
    );
    expect(() => parseBenchmarkArgs(["--wat"])).toThrow("Unknown option");
  });
  test("nearest-rank percentile metrics include p50, p95, p99, min, and max", () => {
    expect(
      calculateMetrics(
        Array.from({ length: 100 }, (_, i) => i + 1),
        2,
        4,
      ),
    ).toEqual({
      p50: 50,
      p95: 95,
      p99: 99,
      min: 1,
      max: 100,
      sampleSize: 100,
      failures: 2,
      screenshotSettledFalse: 4,
      failureReasons: [],
    });
  });
  test("settled delta is signed subtraction", () => {
    const metrics = (p50: number, p95: number, p99: number) => ({
      p50,
      p95,
      p99,
      min: 0,
      max: 0,
      sampleSize: 1,
      failures: 0,
      screenshotSettledFalse: 0,
      failureReasons: [],
    });
    expect(settledAsyncDelta(metrics(15, 29, 42), metrics(10, 31, 40))).toEqual({
      p50: 5,
      p95: -2,
      p99: 2,
    });
  });
  test("table and JSON preserve report data", () => {
    const report: BenchmarkReport = {
      platform: "ios",
      generatedAt: "2026-09-28T00:00:00.000Z",
      iterations: 1,
      warmup: 0,
      actionMode: "ambient default, not mode-controlled",
      results: {
        observe: {
          async: calculateMetrics([3], 0, 0),
          settled: calculateMetrics([5], 0, 0),
          none: calculateMetrics([1], 0, 0),
        },
      },
      settledVsAsync: { observe: { p50: 2, p95: 2, p99: 2 } },
    };
    const table = formatReportTable(report);
    expect(table).toContain("async");
    expect(table).toContain("settled");
    expect(table).toContain("p50");
    expect(JSON.parse(formatReportJson(report))).toEqual(report);
  });
  test("injected client receives each explicit observe mode and ambient action args", async () => {
    class FakeClient implements BenchmarkClient {
      calls: Array<{ name: string; args: Record<string, unknown> }> = [];
      async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
        this.calls.push({ name, args });
        return {
          structuredContent: {
            success: true,
            observation: { screenshotSettled: args.screenshot !== "none", platform: "android" },
          },
        };
      }
      async close(): Promise<void> {}
    }
    const fake = new FakeClient();
    const deps: BenchmarkDeps = fakeDeps(fake);
    const report = await runBenchmark(
      parseBenchmarkArgs(["--device", "emu", "--iterations", "1", "--warmup", "0"]),
      deps,
    );
    expect(fake.calls.filter((c) => c.name === "observe").map((c) => c.args)).toEqual([
      { screenshot: "async", deviceId: "emu" },
      { screenshot: "settled", deviceId: "emu" },
      { screenshot: "none", deviceId: "emu" },
    ]);
    expect(fake.calls.at(-1)).toEqual({
      name: "pressButton",
      args: { button: "volume_up", deviceId: "emu" },
    });
    expect(report.platform).toBe("android");
  });

  test("platformFromDeviceList matches runtime id, stable id or transport alias", () => {
    const payload = {
      devices: [
        { platform: "ios", runtime: { deviceId: "SIM-UDID" }, identity: { stableId: "SIM-UDID" } },
        {
          platform: "android",
          runtime: { deviceId: "emulator-5554" },
          identity: { stableId: "Pixel_Fold" },
          transportAliases: ["localhost:5555"],
        },
      ],
    };
    expect(platformFromDeviceList(payload, "SIM-UDID")).toBe("ios");
    expect(platformFromDeviceList(payload, "emulator-5554")).toBe("android");
    expect(platformFromDeviceList(payload, "Pixel_Fold")).toBe("android");
    expect(platformFromDeviceList(payload, "localhost:5555")).toBe("android");
    expect(platformFromDeviceList(payload, "missing")).toBeUndefined();
    expect(platformFromDeviceList(undefined, "SIM-UDID")).toBeUndefined();
  });
  test("--device runs report the platform from listDevices when observe omits it (#8758)", async () => {
    const calls: string[] = [];
    const client: BenchmarkClient = {
      async callTool(name: string): Promise<unknown> {
        calls.push(name);
        if (name === "listDevices") {
          return {
            structuredContent: {
              devices: [{ platform: "ios", runtime: { deviceId: "SIM-UDID" } }],
            },
          };
        }
        return { structuredContent: { success: true, observation: { screenshotSettled: true } } };
      },
      async close(): Promise<void> {},
    };
    const report = await runBenchmark(
      parseBenchmarkArgs(["--device", "SIM-UDID", "--iterations", "1", "--warmup", "0"]),
      fakeDeps(client),
    );
    expect(report.platform).toBe("ios");
    expect(calls[0]).toBe("listDevices");
    expect(report.results.observe.settled?.failures).toBe(0);
  });
});

function fakeDeps(client: BenchmarkClient): BenchmarkDeps {
  return {
    parentEnv: {},
    safety: {
      homeDir: "/fake/home",
      builtInResidentPaths: [
        "/tmp/auto-mobile-daemon-501.sock",
        "/tmp/auto-mobile-daemon-501.pid",
        "/tmp/auto-mobile-daemon-501.lock",
      ],
      effectiveDaemonPaths: ["/fake/scratch/d.sock", "/fake/scratch/d.pid", "/fake/scratch/d.lock"],
    },
    createClient: async () => client,
    pickPort: async () => 49152,
    now: (() => {
      let n = 0;
      return () => n++;
    })(),
    log: () => {},
    write: () => {},
    serverExists: () => true,
    stopPrivateDaemon: async () => {},
    makeRunDir: () => resolve("/tmp/fake-aux"),
    removeRunDir: () => {},
  };
}
