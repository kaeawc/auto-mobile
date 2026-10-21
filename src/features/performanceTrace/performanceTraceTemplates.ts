/**
 * Platform tracer templates for `performanceTrace` (#14102). Each AutoMobile
 * template maps to an Apple Instruments template on iOS and to a Perfetto
 * config on Android.
 */
export const PERFORMANCE_TRACE_TEMPLATES = [
  "appLaunch",
  "hitches",
  "hangs",
  "timeProfiler",
  "allocations",
] as const;
export type PerformanceTraceTemplate = (typeof PERFORMANCE_TRACE_TEMPLATES)[number];

export const PERFORMANCE_TRACE_DEFAULT_TIME_LIMIT_MS = 30_000;
export const PERFORMANCE_TRACE_MAX_TIME_LIMIT_MS = 300_000;
export const PERFORMANCE_TRACE_MIN_TIME_LIMIT_MS = 1_000;

/** Apple's Instruments template names, as `xctrace list templates` prints them. */
export const XCTRACE_TEMPLATE_NAMES: Record<PerformanceTraceTemplate, string> = {
  appLaunch: "App Launch",
  hitches: "Animation Hitches",
  hangs: "Hangs",
  timeProfiler: "Time Profiler",
  allocations: "Allocations",
};

/** Templates that need a target process; the rest can record every process. */
export const TEMPLATES_REQUIRING_APP: ReadonlySet<PerformanceTraceTemplate> = new Set([
  "appLaunch",
  "allocations",
]);

export interface XctraceRecordOptions {
  template: PerformanceTraceTemplate;
  deviceId: string;
  outputPath: string;
  timeLimitMs: number;
  /** `appLaunch` launches this bundle id under the recorder. */
  launchBundleId?: string;
  /** Attach to this running process id. */
  attachPid?: number;
}

/** `xcrun xctrace record …` arguments after `xcrun xctrace`. */
export function xctraceRecordArgs(options: XctraceRecordOptions): string[] {
  const target =
    options.launchBundleId !== undefined
      ? ["--launch", "--", options.launchBundleId]
      : options.attachPid !== undefined
        ? ["--attach", `${options.attachPid}`]
        : ["--all-processes"];
  // `--launch --` consumes the rest of argv, so every flag precedes the target.
  return [
    "record",
    "--template",
    XCTRACE_TEMPLATE_NAMES[options.template],
    "--device",
    options.deviceId,
    "--time-limit",
    `${options.timeLimitMs}ms`,
    "--output",
    options.outputPath,
    "--no-prompt",
    ...target,
  ];
}

const ATRACE_CATEGORIES: Record<PerformanceTraceTemplate, string[]> = {
  appLaunch: ["am", "wm", "view", "gfx", "dalvik", "binder_driver"],
  hitches: ["gfx", "view", "input", "wm"],
  hangs: ["am", "view", "gfx", "dalvik", "binder_driver"],
  timeProfiler: ["am", "view", "gfx"],
  allocations: ["am", "dalvik"],
};

function quoted(value: string): string {
  return JSON.stringify(value);
}

function ftraceDataSource(template: PerformanceTraceTemplate, appId: string | undefined): string {
  const events = [
    "sched/sched_switch",
    "sched/sched_wakeup",
    "power/suspend_resume",
    "ftrace/print",
  ];
  return [
    "data_sources {",
    "  config {",
    '    name: "linux.ftrace"',
    "    ftrace_config {",
    ...events.map((event) => `      ftrace_events: ${quoted(event)}`),
    ...ATRACE_CATEGORIES[template].map(
      (category) => `      atrace_categories: ${quoted(category)}`,
    ),
    `      atrace_apps: ${quoted(appId ?? "*")}`,
    "    }",
    "  }",
    "}",
  ].join("\n");
}

function templateDataSources(
  template: PerformanceTraceTemplate,
  appId: string | undefined,
): string[] {
  const target = appId ?? "";
  switch (template) {
    case "hitches":
      return ['data_sources { config { name: "android.surfaceflinger.frametimeline" } }'];
    case "timeProfiler":
      return [
        [
          "data_sources { config {",
          '  name: "linux.perf"',
          "  perf_event_config {",
          "    timebase { frequency: 100 }",
          `    callstack_sampling { scope { target_cmdline: ${quoted(target)} } }`,
          "  }",
          "} }",
        ].join("\n"),
      ];
    case "allocations":
      return [
        [
          "data_sources { config {",
          '  name: "android.heapprofd"',
          "  heapprofd_config {",
          "    sampling_interval_bytes: 4096",
          `    process_cmdline: ${quoted(target)}`,
          "    shmem_size_bytes: 8388608",
          "  }",
          "} }",
        ].join("\n"),
      ];
    default:
      return [];
  }
}

/**
 * Text-format Perfetto TraceConfig for one template. `duration_ms` makes the
 * on-device recorder stop itself even if AutoMobile never sends the stop.
 */
export function perfettoTraceConfig(
  template: PerformanceTraceTemplate,
  appId: string | undefined,
  durationMs: number,
): string {
  return [
    "buffers { size_kb: 65536 fill_policy: RING_BUFFER }",
    'data_sources { config { name: "linux.process_stats" process_stats_config { scan_all_processes_on_start: true } } }',
    'data_sources { config { name: "android.packages_list" } }',
    ftraceDataSource(template, appId),
    ...templateDataSources(template, appId),
    `duration_ms: ${durationMs}`,
    "flush_period_ms: 1000",
    "",
  ].join("\n");
}
