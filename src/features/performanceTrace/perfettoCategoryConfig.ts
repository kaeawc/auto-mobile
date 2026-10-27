import { ActionableError } from "../../models/ActionableError";
import {
  PERFORMANCE_TRACE_MAX_TIME_LIMIT_MS,
  PERFORMANCE_TRACE_MIN_TIME_LIMIT_MS,
} from "./performanceTraceTemplates";

/** The only way a caller shapes a `captureTrace` config; there is no raw-config escape hatch. */
export const TRACE_CATEGORIES = [
  "sched",
  "gfx",
  "view",
  "am",
  "wm",
  "binder_driver",
  "memory",
  "app",
] as const;
export type TraceCategory = (typeof TRACE_CATEGORIES)[number];

export const TRACE_DEFAULT_CATEGORIES: readonly TraceCategory[] = ["sched", "gfx", "view"];
export const TRACE_DEFAULT_BUFFER_MB = 32;
export const TRACE_MAX_BUFFER_MB = 256;
export const TRACE_DEFAULT_MAX_DURATION_MS = 30_000;
export const TRACE_MIN_DURATION_MS = PERFORMANCE_TRACE_MIN_TIME_LIMIT_MS;
export const TRACE_MAX_DURATION_MS = PERFORMANCE_TRACE_MAX_TIME_LIMIT_MS;

/** What each category contributes to the Perfetto `linux.ftrace` data source. */
interface CategoryContribution {
  ftraceEvents?: readonly string[];
  atraceCategories?: readonly string[];
  /** Memory counters come from `linux.sys_stats`, not ftrace. */
  sysStats?: boolean;
}

const CATEGORY_CONTRIBUTIONS: Record<Exclude<TraceCategory, "app">, CategoryContribution> = {
  sched: {
    ftraceEvents: [
      "sched/sched_switch",
      "sched/sched_waking",
      "sched/sched_wakeup",
      "sched/sched_process_exit",
      "sched/sched_process_free",
      "task/task_newtask",
      "task/task_rename",
    ],
  },
  gfx: { atraceCategories: ["gfx"] },
  view: { atraceCategories: ["view"] },
  am: { atraceCategories: ["am"] },
  wm: { atraceCategories: ["wm"] },
  binder_driver: {
    atraceCategories: ["binder_driver"],
    ftraceEvents: ["binder/binder_transaction", "binder/binder_transaction_received"],
  },
  memory: {
    ftraceEvents: ["kmem/rss_stat", "oom/oom_score_adj_update"],
    sysStats: true,
  },
};

export interface TraceConfigRequest {
  categories?: readonly TraceCategory[];
  appId?: string;
  bufferMb?: number;
  maxDurationMs?: number;
}

/** The request with defaults applied, as it is echoed to callers. */
export interface ResolvedTraceConfig {
  categories: TraceCategory[];
  appId?: string;
  bufferMb: number;
  maxDurationMs: number;
}

function quoted(value: string): string {
  return JSON.stringify(value);
}

function assertIntegerInRange(name: string, value: number, min: number, max: number): void {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ActionableError(`${name} must be an integer from ${min} to ${max}; got ${value}.`);
  }
}

/** Apply defaults and the checks a zod schema cannot express (`app` needs an `appId`). */
export function resolveTraceConfig(request: TraceConfigRequest): ResolvedTraceConfig {
  const categories = [...new Set(request.categories ?? TRACE_DEFAULT_CATEGORIES)];
  if (categories.length === 0) {
    throw new ActionableError("categories must name at least one category, or be omitted.");
  }
  if (categories.includes("app") && !request.appId) {
    throw new ActionableError("The app category traces one app's atrace tags and needs an appId.");
  }
  if (request.appId && !categories.includes("app")) {
    // An appId always turns on the app's atrace tags; say so in the echoed config.
    categories.push("app");
  }
  const bufferMb = request.bufferMb ?? TRACE_DEFAULT_BUFFER_MB;
  assertIntegerInRange("bufferMb", bufferMb, 1, TRACE_MAX_BUFFER_MB);
  const maxDurationMs = request.maxDurationMs ?? TRACE_DEFAULT_MAX_DURATION_MS;
  assertIntegerInRange(
    "maxDurationMs",
    maxDurationMs,
    TRACE_MIN_DURATION_MS,
    TRACE_MAX_DURATION_MS,
  );
  return {
    categories,
    ...(request.appId ? { appId: request.appId } : {}),
    bufferMb,
    maxDurationMs,
  };
}

/**
 * Text-format Perfetto TraceConfig built only from the typed categories. `duration_ms` makes the
 * on-device recorder stop itself even if AutoMobile never sends the stop. The `appId` has been
 * validated as a package name by the tool schema, so quoting it cannot break out of the string.
 */
export function perfettoCategoryConfig(config: ResolvedTraceConfig): string {
  const contributions = config.categories
    .filter((category): category is Exclude<TraceCategory, "app"> => category !== "app")
    .map((category) => CATEGORY_CONTRIBUTIONS[category]);
  const ftraceEvents = [
    ...new Set([
      // Always on: thread names and the counters trace_processor needs to label slices.
      "ftrace/print",
      "power/suspend_resume",
      ...contributions.flatMap((contribution) => contribution.ftraceEvents ?? []),
    ]),
  ];
  const atraceCategories = [
    ...new Set(contributions.flatMap((contribution) => contribution.atraceCategories ?? [])),
  ];
  const atraceApps = config.appId ? [config.appId] : [];
  const lines = [
    `buffers { size_kb: ${config.bufferMb * 1024} fill_policy: RING_BUFFER }`,
    'data_sources { config { name: "linux.process_stats" process_stats_config { scan_all_processes_on_start: true } } }',
    'data_sources { config { name: "android.packages_list" } }',
    "data_sources {",
    "  config {",
    '    name: "linux.ftrace"',
    "    ftrace_config {",
    ...ftraceEvents.map((event) => `      ftrace_events: ${quoted(event)}`),
    ...atraceCategories.map((category) => `      atrace_categories: ${quoted(category)}`),
    ...atraceApps.map((app) => `      atrace_apps: ${quoted(app)}`),
    "    }",
    "  }",
    "}",
  ];
  if (contributions.some((contribution) => contribution.sysStats)) {
    lines.push(
      'data_sources { config { name: "linux.sys_stats" sys_stats_config { meminfo_period_ms: 1000 vmstat_period_ms: 1000 } } }',
    );
  }
  lines.push(`duration_ms: ${config.maxDurationMs}`, "flush_period_ms: 1000", "");
  return lines.join("\n");
}
