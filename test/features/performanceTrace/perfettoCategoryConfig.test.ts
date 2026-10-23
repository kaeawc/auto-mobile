import { describe, expect, test } from "bun:test";
import {
  perfettoCategoryConfig,
  resolveTraceConfig,
  TRACE_CATEGORIES,
} from "../../../src/features/performanceTrace/perfettoCategoryConfig";

const APP = "dev.jasonpearson.automobile.playground";

function configFor(request: Parameters<typeof resolveTraceConfig>[0]): string {
  return perfettoCategoryConfig(resolveTraceConfig(request));
}

describe("perfettoCategoryConfig (#14113)", () => {
  test("defaults to sched, gfx and view in a 32 MB ring buffer bounded at 30 s", () => {
    const config = configFor({});
    expect(config).toContain("buffers { size_kb: 32768 fill_policy: RING_BUFFER }");
    expect(config).toContain('atrace_categories: "gfx"');
    expect(config).toContain('atrace_categories: "view"');
    expect(config).toContain('ftrace_events: "sched/sched_switch"');
    expect(config).not.toContain("atrace_apps");
    expect(config).not.toContain("linux.sys_stats");
    expect(config).toContain("duration_ms: 30000");
  });

  test("an appId turns on the app's atrace tags and is echoed as the app category", () => {
    const resolved = resolveTraceConfig({ appId: APP, categories: ["view"] });
    expect(resolved.categories).toEqual(["view", "app"]);
    expect(perfettoCategoryConfig(resolved)).toContain(`atrace_apps: "${APP}"`);
  });

  test("each category adds exactly its own sources", () => {
    expect(configFor({ categories: ["binder_driver"] })).toContain(
      'ftrace_events: "binder/binder_transaction"',
    );
    expect(configFor({ categories: ["binder_driver"] })).toContain(
      'atrace_categories: "binder_driver"',
    );
    const memory = configFor({ categories: ["memory"] });
    expect(memory).toContain('ftrace_events: "kmem/rss_stat"');
    expect(memory).toContain("linux.sys_stats");
    expect(memory).not.toContain("sched/sched_switch");
    expect(configFor({ categories: ["am", "wm"] })).toMatch(/atrace_categories: "am"[\s\S]*"wm"/);
  });

  test("duplicate categories collapse and every category builds a config", () => {
    expect(resolveTraceConfig({ categories: ["gfx", "gfx"] }).categories).toEqual(["gfx"]);
    for (const category of TRACE_CATEGORIES) {
      expect(configFor({ categories: [category], appId: APP })).toContain("duration_ms");
    }
  });

  test("the config embeds nothing but typed values", () => {
    const config = configFor({ appId: APP, bufferMb: 8, maxDurationMs: 5000 });
    expect(config).toContain("size_kb: 8192");
    expect(config).toContain("duration_ms: 5000");
    expect(config.split("\n").filter((line) => line.includes(APP))).toEqual([
      `      atrace_apps: "${APP}"`,
    ]);
  });

  test("refuses what the schema cannot express", () => {
    expect(() => resolveTraceConfig({ categories: ["app"] })).toThrow("needs an appId");
    expect(() => resolveTraceConfig({ categories: [] })).toThrow("at least one category");
    expect(() => resolveTraceConfig({ bufferMb: 0 })).toThrow("bufferMb");
    expect(() => resolveTraceConfig({ bufferMb: 257 })).toThrow("bufferMb");
    expect(() => resolveTraceConfig({ maxDurationMs: 10 })).toThrow("maxDurationMs");
    expect(() => resolveTraceConfig({ maxDurationMs: 300_001 })).toThrow("maxDurationMs");
  });
});
