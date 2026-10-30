import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createExecResult } from "../../../src/utils/execResult";
import { FakeHostCommandExecutor } from "../../fakes/FakeHostCommandExecutor";
import { summarizeXctrace } from "../../../src/features/performanceTrace/XctraceRecorder";
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
  type XctraceRow,
} from "../../../src/features/performanceTrace/xctraceExport";

const fixture = (name: string) =>
  readFileSync(join(import.meta.dir, "../../fixtures/performanceTrace", name), "utf8");

let timeProfileXcode27Rows: XctraceRow[];
let timeProfilerToc: string;
beforeAll(async () => {
  timeProfileXcode27Rows = await parseXctraceTable(fixture("xctrace-time-profile-xcode27-sim.xml"));
  timeProfilerToc = fixture("xctrace-toc.xml");
});

function summarizeTimeProfile(xml: string) {
  const host = new FakeHostCommandExecutor();
  host.setCommandResponse("--toc", createExecResult(timeProfilerToc, ""));
  host.setCommandResponse("--xpath", createExecResult(xml, ""));
  return summarizeXctrace(host, "/out/t.trace", "timeProfiler");
}

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

  test("counts symbolicated functions from the direct Xcode 27 tagged backtraces", () => {
    const rows = timeProfileXcode27Rows;
    expect(rows).toHaveLength(200);
    const counts = new Map<string, number>();
    // Independently scan the captured direct shape, resolving its shared frames.
    for (const row of rows) {
      const tagged = row("tagged-backtrace");
      if (!tagged) {
        continue;
      }
      expect(tagged?.backtrace).toBeUndefined();
      const frames = tagged?.frame;
      expect(Array.isArray(frames)).toBe(true);
      if (!Array.isArray(frames)) {
        throw new Error("Expected direct frame children in the captured export");
      }
      for (const frame of frames) {
        const name = row.resolve(frame)?.$?.name;
        if (!name || name === "<deduplicated_symbol>" || /^0x[0-9a-f]+$/i.test(name)) {
          continue;
        }
        counts.set(name, (counts.get(name) ?? 0) + 1);
        break;
      }
    }
    const expected = [...counts]
      .sort(
        ([leftName, leftCount], [rightName, rightCount]) =>
          rightCount - leftCount || leftName.localeCompare(rightName),
      )
      .slice(0, 10)
      .map(([name, samples]) => ({ name, samples }));
    expect(expected.length).toBeGreaterThan(0);
    expect(summarizeXctraceTable("timeProfiler", rows)).toEqual({ topFunctions: expected });
  });

  test("resolves both backtrace shapes and prefers wrapped frames, skipping hex addresses", async () => {
    const xml = `<trace-query-result><node>
      <row><tagged-backtrace id="direct">
        <frame name="0x187bc00a0"/>
        <frame id="symbol" name="symbolicatedFunction"/>
      </tagged-backtrace></row>
      <row><tagged-backtrace ref="direct"/></row>
      <row><tagged-backtrace><backtrace ref="wrapped"/>
        <frame name="mustNotWin"/>
      </tagged-backtrace></row>
      <row><backtrace id="wrapped"><frame ref="symbol"/></backtrace></row>
    </node></trace-query-result>`;
    const rows = await parseXctraceTable(xml);
    const expected = {
      topFunctions: [{ name: "symbolicatedFunction", samples: 4 }],
    };
    expect(summarizeXctraceTable("timeProfiler", rows)).toEqual(expected);
    const result = await summarizeTimeProfile(xml);
    expect(result.summary.topFunctions).toEqual(expected.topFunctions);
    expect(result.warnings).toEqual([]);
  });

  test("warns when time-profile rows contain no readable function names", async () => {
    const result = await summarizeTimeProfile(`<trace-query-result><node>
      <row><tagged-backtrace><frame name="&lt;deduplicated_symbol&gt;"/></tagged-backtrace></row>
      <row><tagged-backtrace><frame/></tagged-backtrace></row>
    </node></trace-query-result>`);
    expect(result.summary.topFunctions).toEqual([]);
    expect(result.warnings).toEqual([
      "performanceTrace timeProfiler: 2 samples exported but no function names could be read; the Xcode export shape may be unsupported.",
    ]);
  });

  test("does not warn for a time-profile table with zero rows", async () => {
    const result = await summarizeTimeProfile("<trace-query-result><node/></trace-query-result>");
    expect(result.summary.topFunctions).toEqual([]);
    expect(result.warnings).toEqual([]);
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
