import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import type { PerformanceAuditRecord } from "../../../src/db/performanceAuditRepository";
import {
  createIosAuditProcessSampler,
  createIosOnDemandAuditEngines,
} from "../../../src/features/audit/IosOnDemandAuditEngines";
import { OnDemandAudit } from "../../../src/features/audit/OnDemandAudit";
import {
  SdkFrameMetricsStore,
  type SdkFrameSample,
} from "../../../src/features/performance/SdkFrameMetricsStore";
import type { BootedDevice } from "../../../src/models";
import { createExecResult } from "../../../src/utils/execResult";
import { FakeHostCommandExecutor } from "../../fakes/FakeHostCommandExecutor";
import { FakeIosAuditProcessSampler } from "../../fakes/FakeIosAuditProcessSampler";
import { FakeObserveScreen } from "../../fakes/FakeObserveScreen";
import { observation } from "../../fakes/FakeOnDemandAuditEngines";
import { FakeTimer } from "../../fakes/FakeTimer";

const device: BootedDevice = {
  deviceId: "A25C7946-AF1E-403B-AF98-CAD293FEF933",
  platform: "ios",
  name: "iPhone",
};
const appId = "com.example";

function setup(processSampler = new FakeIosAuditProcessSampler()) {
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const frameStore = new SdkFrameMetricsStore();
  const observeScreen = new FakeObserveScreen();
  observeScreen.setObserveResult(observation(appId));
  const records: PerformanceAuditRecord[] = [];
  const session = { uuid: "first-epoch" };
  const audit = new OnDemandAudit(
    device,
    createIosOnDemandAuditEngines(device, {
      observeScreen,
      timer,
      frameStore,
      processSampler,
      recorder: {
        async recordAudit(record) {
          records.push(record);
        },
      },
      deviceSessionUuid: () => session.uuid,
    }),
  );
  const publish = (sample: Omit<SdkFrameSample, "receivedAt">) =>
    frameStore.ingest(device.deviceId, appId, { ...sample, receivedAt: timer.now() });
  return { audit, timer, observeScreen, publish, records, session };
}

describe("iOS Simulator performanceAudit", () => {
  test("uses each received SDK sample once and attributes the audit to its starting epoch", async () => {
    const { audit, timer, publish, records, session, observeScreen } = setup();
    publish({ fps: 60, frameTimeMs: 10, jankFrames: 0 });
    timer.setTimeout(() => {
      session.uuid = "second-epoch";
      publish({ fps: 57, frameTimeMs: 14, jankFrames: 1 });
    }, 1500);
    timer.setTimeout(() => publish({ fps: 54, frameTimeMs: 18, jankFrames: 5 }), 2700);

    const result = await audit.run({ kinds: ["performance"], failOn: "error" });

    expect(result).toMatchObject({ success: true, failed: false, performance: { passed: true } });
    expect(result.unsupported).toBeUndefined();
    expect(result.performance?.metrics).toMatchObject({
      p50Ms: 14,
      p90Ms: 18,
      p95Ms: 18,
      p99Ms: 18,
      jankCount: 2,
      frameRateFps: 57,
      touchLatencyMs: null,
    });
    expect(result.performance?.diagnostics).toContain("one-second frame-time averages");
    expect(result.performance?.diagnostics).toContain(
      "Touch latency is not measured on iOS Simulator.",
    );
    expect(timer.getSleepHistory()).toEqual(Array(12).fill(250));
    expect(observeScreen.getExecuteOptions()).toEqual([
      {
        freshness: "fresh",
        screenshot: "none",
        skipAccessibilityAudit: true,
        skipPerformanceAudit: true,
      },
    ]);
    expect(session.uuid).toBe("second-epoch");
    expect(records).toEqual([
      expect.objectContaining({
        deviceId: device.deviceId,
        packageName: appId,
        deviceSessionUuid: "first-epoch",
        passed: true,
        metrics: result.performance?.metrics,
        diagnostics: result.performance?.diagnostics,
      }),
    ]);
  });

  test.each([
    { jankFrames: 6, severity: "warning", threshold: 5 },
    { jankFrames: 10, severity: "critical", threshold: 10 },
  ])(
    "fails high frame time and reports $severity jank at $jankFrames",
    async ({ jankFrames, severity, threshold }) => {
      const { audit, publish, records } = setup();
      publish({ fps: 25, frameTimeMs: 40, jankFrames });

      const result = await audit.run({ kinds: ["performance"], failOn: "error" });

      expect(result).toMatchObject({
        success: false,
        failed: true,
        performance: { passed: false },
      });
      expect(result.performance?.violations).toEqual([
        expect.objectContaining({
          metric: "p50Ms",
          actual: 40,
          threshold: 18,
          severity: "warning",
        }),
        expect.objectContaining({
          metric: "p90Ms",
          actual: 40,
          threshold: 18,
          severity: "warning",
        }),
        expect.objectContaining({
          metric: "p95Ms",
          actual: 40,
          threshold: 33,
          severity: "critical",
        }),
        expect.objectContaining({
          metric: "p99Ms",
          actual: 40,
          threshold: 33,
          severity: "critical",
        }),
        expect.objectContaining({ metric: "jankCount", actual: jankFrames, threshold, severity }),
      ]);
      expect(records).toEqual([expect.objectContaining({ passed: false })]);
    },
  );

  test.each(["never", "error"] as const)(
    "reports unsupported when there are no samples (failOn %s)",
    async (failOn) => {
      const { audit, records } = setup();

      const result = await audit.run({ kinds: ["performance"], failOn });

      expect(result).toEqual({
        success: failOn === "never",
        failed: failOn === "error",
        appId,
        unsupported: {
          performance:
            "No fresh frame metrics from com.example: the app must be instrumented with auto-mobile-sdk and in the foreground.",
        },
      });
      expect(records).toEqual([]);
    },
  );

  test("ignores a sample beyond the SDK freshness threshold", async () => {
    const { audit, timer, publish } = setup();
    publish({ fps: 60, frameTimeMs: 16, jankFrames: 0 });
    timer.advanceTime(2501);

    const result = await audit.run({ kinds: ["performance"] });

    expect(result.unsupported?.performance).toContain("No fresh frame metrics");
  });
});

describe("iOS Simulator memoryAudit", () => {
  test.each([
    { growth: 25, severity: null, threshold: null },
    { growth: 37.5, severity: "warning", threshold: 25 },
    { growth: 38, severity: "critical", threshold: 37.5 },
  ])("judges $growth MB of RSS growth", async ({ growth, severity, threshold }) => {
    const processes = new FakeIosAuditProcessSampler(
      [19876, 19876],
      [80 * 1024, (80 + growth) * 1024],
    );
    const { audit, timer, records } = setup(processes);

    const result = await audit.run({ kinds: ["memory"], failOn: "error" });

    expect(result.failed).toBe(severity !== null);
    expect(result.memory).toMatchObject({
      passed: severity === null,
      metrics: { rssStartMb: 80, rssEndMb: 80 + growth, rssGrowthMb: growth, windowMs: 3000 },
      violations:
        severity === null
          ? []
          : [expect.objectContaining({ metric: "rssGrowth", actual: growth, severity, threshold })],
    });
    expect(processes.resolvedApps).toEqual([appId, appId]);
    expect(processes.sampledPids).toEqual([19876, 19876]);
    expect(timer.getSleepHistory()).toEqual([3000]);
    expect(records).toEqual([]);
  });

  test("reports an app that is not running without starting the window", async () => {
    const { audit, timer } = setup();

    const result = await audit.run({ kinds: ["memory"], failOn: "error" });

    expect(result.failed).toBe(true);
    expect(result.unsupported?.memory).toBe(`${appId} is not running on ${device.deviceId}`);
    expect(timer.getSleepHistory()).toEqual([]);
  });

  test("reports a restarted app without sampling the new PID", async () => {
    const processes = new FakeIosAuditProcessSampler([19876, 19877], [80 * 1024]);
    const { audit, timer } = setup(processes);

    const result = await audit.run({ kinds: ["memory"], failOn: "error" });

    expect(result.failed).toBe(true);
    expect(result.unsupported?.memory).toBe("app restarted during the audit");
    expect(processes.sampledPids).toEqual([19876]);
    expect(timer.getSleepHistory()).toEqual([3000]);
  });

  test("uses launchctl's simulator application label for the PID lookup", async () => {
    const capture = await readFile(
      new URL("../../fixtures/ios-simctl/launchctl-list-crashtv-tvos26-5.txt", import.meta.url),
      "utf8",
    );
    const simctl = new FakeHostCommandExecutor();
    simctl.setDefaultResponse(createExecResult(capture, ""));
    const host = new FakeHostCommandExecutor();
    const sampler = createIosAuditProcessSampler(
      device,
      {
        executeCommandArgs: (args, timeoutMs) =>
          simctl.executeCommand("simctl", args, { timeoutMs }),
      },
      host,
    );

    expect(await sampler.resolvePid("dev.jasonpearson.automobile.crashtv")).toBe(19876);
    expect(await sampler.resolvePid(appId)).toBeNull();
    expect(simctl.getExecutedCalls()[0]?.args).toEqual([
      "spawn",
      device.deviceId,
      "launchctl",
      "list",
    ]);
  });

  test("reads the host ps RSS column in KiB", async () => {
    const capture = await readFile(
      new URL("../../fixtures/ios-sim-fleet/ps-captured-one-booted-simulator.txt", import.meta.url),
      "utf8",
    );
    // Select the RSS column of the captured PID 183 row to match `ps -o rss=`.
    const rss = capture.split("\n")[1].trim().split(/\s+/)[2];
    const host = new FakeHostCommandExecutor();
    host.setDefaultResponse(createExecResult(rss, ""));
    const sampler = createIosAuditProcessSampler(
      device,
      {
        executeCommandArgs: async () => {
          throw new Error("Unexpected simctl call");
        },
      },
      host,
    );

    expect(await sampler.readRssKiB(183)).toBe(55312);
    expect(host.getExecutedCommands()).toEqual(["ps -o rss= -p 183"]);
  });
});
