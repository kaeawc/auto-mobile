import { errorMessage } from "../../utils/describeUnknownError";
import type { HostCommandExecutor } from "../../utils/HostCommandExecutor";
import type { PerformanceTraceTemplate } from "./performanceTraceTemplates";
import {
  hitchStats,
  nanosToMs,
  SUMMARY_MAX_ITEMS,
  type PerformanceTraceSummary,
} from "./PerformanceTraceSummary";

export type QueryRow = Record<string, string>;

/** Runs SQL against a recorded Perfetto trace. */
export interface PerfettoTraceProcessor {
  query(tracePath: string, sql: string, signal?: AbortSignal): Promise<QueryRow[]>;
}

const TRACE_PROCESSOR_TIMEOUT_MS = 60_000;
const TRACE_PROCESSOR_MAX_BUFFER = 16 * 1024 * 1024;

/** Split one CSV line; `trace_processor_shell` quotes strings and leaves numbers bare. */
function csvFields(line: string): string[] {
  const fields: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]!;
    if (inQuotes && char === '"' && line[index + 1] === '"') {
      field += '"';
      index += 1;
    } else if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === "," && !inQuotes) {
      fields.push(field);
      field = "";
    } else {
      field += char;
    }
  }
  fields.push(field);
  return fields;
}

/** `trace_processor_shell --query-string` prints one CSV result: a header row, then data rows. */
export function parseTraceProcessorCsv(output: string): QueryRow[] {
  const lines = output
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter((line) => line.trim() !== "");
  const header = lines[0] ? csvFields(lines[0]) : [];
  return lines
    .slice(1)
    .map((line) =>
      Object.fromEntries(csvFields(line).map((value, index) => [header[index], value])),
    );
}

/** Perfetto's `trace_processor_shell` on the host (`AUTOMOBILE_TRACE_PROCESSOR` overrides the path). */
export class TraceProcessorShell implements PerfettoTraceProcessor {
  constructor(
    private readonly host: HostCommandExecutor,
    private readonly binary: string,
  ) {}

  async query(tracePath: string, sql: string, signal?: AbortSignal): Promise<QueryRow[]> {
    const result = await this.host.executeCommand(this.binary, ["--query-string", sql, tracePath], {
      timeoutMs: TRACE_PROCESSOR_TIMEOUT_MS,
      maxBuffer: TRACE_PROCESSOR_MAX_BUFFER,
      signal,
    });
    return parseTraceProcessorCsv(result.stdout);
  }
}

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function numberOf(row: QueryRow | undefined, column: string): number | undefined {
  const value = Number(row?.[column]);
  return row?.[column] !== undefined && Number.isFinite(value) ? value : undefined;
}

/** Template queries, each folded into the summary fields it feeds. */
function templateQuery(
  template: PerformanceTraceTemplate,
  appId: string,
): { sql: string; fold: (rows: QueryRow[]) => Partial<PerformanceTraceSummary> } | undefined {
  const app = sqlString(appId);
  switch (template) {
    case "appLaunch":
      return {
        sql:
          "INCLUDE PERFETTO MODULE android.startup.startups; " +
          `SELECT startup_type AS name, dur FROM android_startups WHERE package = ${app} ORDER BY ts LIMIT ${SUMMARY_MAX_ITEMS}`,
        fold: (rows) => {
          const phases = rows.flatMap((row) => {
            const dur = numberOf(row, "dur");
            return dur === undefined
              ? []
              : [{ name: row.name || "startup", durationMs: nanosToMs(dur) }];
          });
          return phases.length > 0 ? { launch: { durationMs: phases[0]!.durationMs, phases } } : {};
        },
      };
    case "hitches":
      return {
        sql:
          "SELECT s.dur AS dur FROM actual_frame_timeline_slice s JOIN process p USING (upid) " +
          `WHERE p.name = ${app} AND s.jank_type != 'None'`,
        fold: (rows) => ({
          hitches: hitchStats(rows.flatMap((row) => numberOf(row, "dur") ?? []).map(nanosToMs)),
        }),
      };
    case "hangs":
      return {
        sql:
          "SELECT s.name AS name, s.ts - (SELECT start_ts FROM trace_bounds) AS start, s.dur AS dur " +
          "FROM slice s JOIN thread_track tt ON s.track_id = tt.id JOIN thread t USING (utid) " +
          `JOIN process p USING (upid) WHERE p.name = ${app} AND t.is_main_thread = 1 ` +
          `AND s.depth = 0 AND s.dur >= 250000000 ORDER BY s.dur DESC LIMIT ${SUMMARY_MAX_ITEMS}`,
        fold: (rows) => ({
          hangs: rows.flatMap((row) => {
            const dur = numberOf(row, "dur");
            const start = numberOf(row, "start");
            return dur === undefined
              ? []
              : [
                  {
                    durationMs: nanosToMs(dur),
                    ...(start !== undefined ? { startMs: nanosToMs(start) } : {}),
                    ...(row.name ? { type: row.name } : {}),
                  },
                ];
          }),
        }),
      };
    case "timeProfiler":
      return {
        sql:
          "SELECT f.name AS name, COUNT(*) AS samples FROM perf_sample ps " +
          "JOIN stack_profile_callsite c ON ps.callsite_id = c.id " +
          "JOIN stack_profile_frame f ON c.frame_id = f.id JOIN thread t USING (utid) " +
          `JOIN process p USING (upid) WHERE p.name = ${app} GROUP BY f.name ` +
          `ORDER BY samples DESC LIMIT ${SUMMARY_MAX_ITEMS}`,
        fold: (rows) => ({
          topFunctions: rows.flatMap((row) => {
            const samples = numberOf(row, "samples");
            return row.name && samples !== undefined ? [{ name: row.name, samples }] : [];
          }),
        }),
      };
    case "allocations":
      return {
        sql:
          "SELECT SUM(size) AS bytes, SUM(count) AS count FROM heap_profile_allocation " +
          "WHERE size > 0",
        fold: (rows) => {
          const bytes = numberOf(rows[0], "bytes");
          const count = numberOf(rows[0], "count");
          return bytes !== undefined && count !== undefined
            ? { allocations: { bytes, count } }
            : {};
        },
      };
  }
}

/**
 * Summarise a Perfetto trace for one template. Each query is isolated: a
 * failing one becomes a warning and leaves the rest of the summary intact.
 */
export async function summarizePerfettoTrace(
  processor: PerfettoTraceProcessor,
  tracePath: string,
  template: PerformanceTraceTemplate,
  appId: string | undefined,
  signal?: AbortSignal,
): Promise<{ summary: PerformanceTraceSummary; warnings: string[] }> {
  const warnings: string[] = [];
  const summary: PerformanceTraceSummary = {};
  const run = async (label: string, sql: string, fold: (rows: QueryRow[]) => object) => {
    try {
      Object.assign(summary, fold(await processor.query(tracePath, sql, signal)));
    } catch (error) {
      signal?.throwIfAborted();
      warnings.push(`trace_processor ${label} query failed: ${errorMessage(error)}`);
    }
  };
  await run("duration", "SELECT end_ts - start_ts AS dur FROM trace_bounds", (rows) => {
    const dur = numberOf(rows[0], "dur");
    return dur === undefined ? {} : { durationMs: Math.round(nanosToMs(dur)) };
  });
  const query = appId ? templateQuery(template, appId) : undefined;
  if (query) {
    await run(template, query.sql, query.fold);
  } else if (!appId) {
    warnings.push(`No appId was given, so the ${template} summary is limited to duration.`);
  }
  return { summary, warnings };
}
