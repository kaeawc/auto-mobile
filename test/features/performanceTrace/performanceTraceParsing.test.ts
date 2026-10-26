import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseTraceProcessorCsv,
  summarizePerfettoTrace,
  type PerfettoTraceProcessor,
} from "../../../src/features/performanceTrace/perfettoTraceProcessor";
import {
  perfettoTraceConfig,
  xctraceRecordArgs,
} from "../../../src/features/performanceTrace/performanceTraceTemplates";
import {
  parseXctraceTable,
  parseXctraceToc,
  summarizeXctraceTable,
} from "../../../src/features/performanceTrace/xctraceExport";

const fixture = (name: string) =>
  readFileSync(join(import.meta.dir, "../../fixtures/performanceTrace", name), "utf8");

const base = { deviceId: "SIM", outputPath: "/out/t.trace", timeLimitMs: 30_000 };

describe("xctrace record command (#14102)", () => {
  test("launches the app for appLaunch, with every flag before --launch --", () => {
    expect(
      xctraceRecordArgs({ ...base, template: "appLaunch", launchBundleId: "com.example.app" }),
    ).toEqual([
      "record",
      "--template",
      "App Launch",
      "--device",
      "SIM",
      "--time-limit",
      "30000ms",
      "--output",
      "/out/t.trace",
      "--no-prompt",
      "--launch",
      "--",
      "com.example.app",
    ]);
  });

  test("attaches by pid, or records all processes without a target", () => {
    expect(xctraceRecordArgs({ ...base, template: "hitches", attachPid: 4321 }).slice(2)).toEqual([
      "Animation Hitches",
      "--device",
      "SIM",
      "--time-limit",
      "30000ms",
      "--output",
      "/out/t.trace",
      "--no-prompt",
      "--attach",
      "4321",
    ]);
    expect(xctraceRecordArgs({ ...base, template: "timeProfiler" }).slice(-2)).toEqual([
      "--no-prompt",
      "--all-processes",
    ]);
  });
});

describe("Perfetto config (#14102)", () => {
  test("bounds every config with duration_ms and scopes atrace to the app", () => {
    const config = perfettoTraceConfig("hitches", "com.example.app", 15_000);
    expect(config).toContain("duration_ms: 15000");
    expect(config).toContain('atrace_apps: "com.example.app"');
    expect(config).toContain('atrace_categories: "gfx"');
    expect(config).toContain('name: "android.surfaceflinger.frametimeline"');
  });

  test("adds the template's own data source", () => {
    expect(perfettoTraceConfig("allocations", "com.example.app", 5_000)).toContain(
      'process_cmdline: "com.example.app"',
    );
    expect(perfettoTraceConfig("timeProfiler", "com.example.app", 5_000)).toContain(
      'target_cmdline: "com.example.app"',
    );
    expect(perfettoTraceConfig("hangs", undefined, 5_000)).toContain('atrace_apps: "*"');
  });
});

describe("xctrace export parsing (#14102)", () => {
  test("reads duration, end reason and table schemas from the TOC", async () => {
    expect(await parseXctraceToc(fixture("xctrace-toc.xml"))).toEqual({
      durationMs: 5_250,
      endReason: "Time limit reached",
      schemas: ["potential-hangs", "hang-risks", "time-profile"],
    });
  });

  test("reads the real host TOC", async () => {
    const toc = await parseXctraceToc(fixture("xctrace-toc-time-profiler-macos-host.xml"));
    expect(toc.durationMs).toBe(2995);
    expect(toc.endReason).toBe("Time limit reached");
    expect(toc.schemas).toEqual([
      "tick",
      "life-cycle-period",
      "tick",
      "device-thermal-state-intervals",
      "os-log",
      "os-signpost",
      "os-signpost",
      "os-log",
      "hang-risks",
      "potential-hangs",
      "global-poi-layout",
      "time-profile",
      "kdebug-signpost",
      "kdebug-strings",
      "process-info",
      "dyld-library-load",
      "kdebug-strings",
      "kdebug",
      "kdebug",
      "region-of-interest",
      "kdebug",
      "kdebug",
      "kdebug",
      "kdebug",
      "kdebug",
      "global-roi-layout",
      "os-log-arg",
      "kdebug",
      "kdebug",
      "kdebug",
      "kdebug",
      "kdebug",
      "kdebug",
      "kdebug",
      "gcd-perf-event",
      "thread-info",
      "runloop-events",
      "roi-metadata",
      "time-sample",
      "os-signpost-arg",
    ]);
  });

  test("reads tagged backtraces from the real host export, skipping placeholder frames", async () => {
    const rows = await parseXctraceTable(fixture("xctrace-time-profile-macos-host.xml"));
    expect(summarizeXctraceTable("timeProfiler", rows)).toEqual({
      topFunctions: [
        {
          name: "invocation function for block in mach_o::UnsafeHeader::forEachSegment(void (mach_o::UnsafeHeader::SegmentInfo const&, bool&) block_pointer) const",
          samples: 1,
        },
      ],
    });
  });

  test("summarises hangs longest first, resolving ref cells", async () => {
    const rows = await parseXctraceTable(fixture("xctrace-potential-hangs.xml"));
    expect(summarizeXctraceTable("hangs", rows)).toEqual({
      hangs: [
        { durationMs: 1_200, startMs: 3_000, type: "Hang" },
        { durationMs: 312.45, startMs: 1_200, type: "Hang" },
        { durationMs: 312.45, startMs: 4_500, type: "Microhang" },
      ],
    });
  });

  test("summarises hitches as count, total and worst", async () => {
    const rows = await parseXctraceTable(fixture("xctrace-hitches.xml"));
    expect(summarizeXctraceTable("hitches", rows)).toEqual({
      hitches: { count: 3, totalDurationMs: 116.666, maxDurationMs: 50 },
    });
  });

  test("counts leaf frames for the time profile, resolving backtrace and frame refs", async () => {
    const rows = await parseXctraceTable(fixture("xctrace-time-profile.xml"));
    expect(summarizeXctraceTable("timeProfiler", rows)).toEqual({
      topFunctions: [
        { name: "-[ListCell layoutSubviews]", samples: 3 },
        { name: "objc_msgSend", samples: 1 },
      ],
    });
  });

  test("reports launch duration across the launch life-cycle periods", async () => {
    const rows = await parseXctraceTable(fixture("xctrace-life-cycle-period.xml"));
    expect(summarizeXctraceTable("appLaunch", rows)).toEqual({
      launch: {
        durationMs: 500,
        phases: [
          { name: "Launching - Process Creation", durationMs: 120 },
          { name: "Launching - UIKit Initialization", durationMs: 300 },
          { name: "Launching - Initial Frame Rendering", durationMs: 80 },
        ],
      },
    });
  });
});

describe("Perfetto trace processor summaries (#14102)", () => {
  test("parses quoted CSV output", () => {
    expect(
      parseTraceProcessorCsv('"name","dur"\n"Choreographer#doFrame, late",312000000\n'),
    ).toEqual([{ name: "Choreographer#doFrame, late", dur: "312000000" }]);
  });

  test("folds duration and template queries, isolating a failing query as a warning", async () => {
    const sql: string[] = [];
    const processor: PerfettoTraceProcessor = {
      query: async (_path, query) => {
        sql.push(query);
        if (query.includes("trace_bounds")) {
          return [{ dur: "5250000000" }];
        }
        return [{ dur: "40000000" }, { dur: "20000000" }];
      },
    };

    const result = await summarizePerfettoTrace(
      processor,
      "/t.pftrace",
      "hitches",
      "com.example.app",
    );

    expect(result).toEqual({
      summary: { durationMs: 5_250, hitches: { count: 2, totalDurationMs: 60, maxDurationMs: 40 } },
      warnings: [],
    });
    expect(sql[1]).toContain("p.name = 'com.example.app'");

    const failing: PerfettoTraceProcessor = {
      query: async (_path, query) => {
        if (query.includes("android_startups")) {
          throw new Error("no such table: android_startups");
        }
        return [{ dur: "1000000000" }];
      },
    };
    expect(await summarizePerfettoTrace(failing, "/t", "appLaunch", "com.example.app")).toEqual({
      summary: { durationMs: 1_000 },
      warnings: [expect.stringContaining("no such table: android_startups")],
    });
  });

  test("escapes the app id in SQL and limits a summary without one to duration", async () => {
    const sql: string[] = [];
    const processor: PerfettoTraceProcessor = {
      query: async (_path, query) => (sql.push(query), []),
    };
    await summarizePerfettoTrace(processor, "/t", "hangs", "com.o'brien");
    expect(sql[1]).toContain("'com.o''brien'");

    const result = await summarizePerfettoTrace(processor, "/t", "hangs", undefined);
    expect(result.warnings).toEqual([expect.stringContaining("limited to duration")]);
  });
});
