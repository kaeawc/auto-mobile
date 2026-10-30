import { parseStringPromise } from "xml2js";
import type { PerformanceTraceTemplate } from "./performanceTraceTemplates";
import {
  hitchStats,
  nanosToMs,
  SUMMARY_MAX_ITEMS,
  topCounts,
  type PerformanceTraceSummary,
} from "./PerformanceTraceSummary";

/** An xml2js element: attributes under `$`, text under `_`, children by tag name. */
interface XmlElement {
  $?: Record<string, string>;
  _?: string;
  [child: string]: unknown;
}

function children(element: XmlElement | undefined, tag: string): XmlElement[] {
  const value = element?.[tag];
  return Array.isArray(value) ? (value as XmlElement[]) : [];
}

function child(element: XmlElement | undefined, tag: string): XmlElement | undefined {
  return children(element, tag)[0];
}

function text(element: XmlElement | undefined): string | undefined {
  if (element === undefined) {
    return undefined;
  }
  return typeof element === "string" ? element : element._;
}

async function parseXml(xml: string): Promise<XmlElement> {
  return (await parseStringPromise(xml, { explicitArray: true })) as XmlElement;
}

export interface XctraceToc {
  durationMs?: number;
  endReason?: string;
  schemas: string[];
}

/** `xctrace export --input <trace> --toc`: the first run's duration, end reason and table schemas. */
export async function parseXctraceToc(xml: string): Promise<XctraceToc> {
  const run = child((await parseXml(xml))["trace-toc"] as XmlElement, "run");
  const summary = child(child(run, "info"), "summary");
  const seconds = Number(text(child(summary, "duration")));
  return {
    durationMs: Number.isFinite(seconds) ? Math.round(seconds * 1_000) : undefined,
    endReason: text(child(summary, "end-reason")),
    schemas: children(child(run, "data"), "table").flatMap((table) =>
      table.$?.schema ? [table.$.schema] : [],
    ),
  };
}

/**
 * xctrace de-duplicates repeated cells: the first occurrence carries `id`,
 * later ones `<tag ref="id"/>`. Index every identified element in the export.
 */
function indexIds(root: unknown, index = new Map<string, XmlElement>()): Map<string, XmlElement> {
  if (Array.isArray(root)) {
    root.forEach((item) => indexIds(item, index));
  } else if (root !== null && typeof root === "object") {
    const element = root as XmlElement;
    if (element.$?.id) {
      index.set(element.$.id, element);
    }
    for (const [key, value] of Object.entries(element)) {
      if (key !== "$" && key !== "_") {
        indexIds(value, index);
      }
    }
  }
  return index;
}

/** One exported row: a cell by column tag, with `ref` cells resolved to their first occurrence. */
export interface XctraceRow {
  (tag: string): XmlElement | undefined;
  resolve(element: XmlElement | undefined): XmlElement | undefined;
}
type Row = XctraceRow;

/** Rows of an `xctrace export --xpath …/table[@schema=…]` result, with refs resolved. */
export async function parseXctraceTable(xml: string): Promise<Row[]> {
  const root = await parseXml(xml);
  const ids = indexIds(root);
  const resolve = (element: XmlElement | undefined) => {
    const ref = element?.$?.ref;
    return ref ? ids.get(ref) : element;
  };
  const node = child(root["trace-query-result"] as XmlElement, "node");
  return children(node, "row").map((row) =>
    Object.assign((tag: string) => resolve(child(row, tag)), { resolve }),
  );
}

function nanos(row: Row, tag: string): number | undefined {
  const value = Number(text(row(tag)));
  return Number.isFinite(value) ? value : undefined;
}

/** Schemas each template's summary reads, in `xctrace export --toc` naming. */
export const XCTRACE_SUMMARY_SCHEMAS: Partial<Record<PerformanceTraceTemplate, string>> = {
  appLaunch: "life-cycle-period",
  hitches: "hitches",
  hangs: "potential-hangs",
  timeProfiler: "time-profile",
};

function launchSummary(rows: Row[]): PerformanceTraceSummary["launch"] {
  const periods = rows.flatMap((row) => {
    const start = nanos(row, "start-time");
    const duration = nanos(row, "duration");
    const name = text(row("period")) ?? row("period")?.$?.fmt;
    return start !== undefined && duration !== undefined ? [{ start, duration, name }] : [];
  });
  if (periods.length === 0) {
    return undefined;
  }
  const first = Math.min(...periods.map((period) => period.start));
  const last = Math.max(...periods.map((period) => period.start + period.duration));
  return {
    durationMs: nanosToMs(last - first),
    phases: periods.slice(0, SUMMARY_MAX_ITEMS).map((period) => ({
      name: period.name ?? "unknown",
      durationMs: nanosToMs(period.duration),
    })),
  };
}

function hangsSummary(rows: Row[]): PerformanceTraceSummary["hangs"] {
  return rows
    .flatMap((row) => {
      const duration = nanos(row, "duration");
      if (duration === undefined) {
        return [];
      }
      const start = nanos(row, "start-time");
      const type = text(row("hang-type"));
      return [
        {
          durationMs: nanosToMs(duration),
          ...(start !== undefined ? { startMs: nanosToMs(start) } : {}),
          ...(type ? { type } : {}),
        },
      ];
    })
    .sort((left, right) => right.durationMs - left.durationMs)
    .slice(0, SUMMARY_MAX_ITEMS);
}

function leafFunctions(rows: Row[]): string[] {
  return rows.flatMap((row) => {
    const tagged = row("tagged-backtrace");
    const backtrace = row("backtrace") ?? row.resolve(child(tagged, "backtrace")) ?? tagged;
    // Use the first symbolicated frame when the leaf is a placeholder or raw address.
    const name = children(backtrace, "frame")
      .map((frame) => row.resolve(frame)?.$?.name)
      .find((name) => name && name !== "<deduplicated_symbol>" && !/^0x[0-9a-f]+$/i.test(name));
    return name ? [name] : [];
  });
}

/** Fold one template table's rows into the summary fields it feeds. */
export function summarizeXctraceTable(
  template: PerformanceTraceTemplate,
  rows: Row[],
): Partial<PerformanceTraceSummary> {
  switch (template) {
    case "appLaunch": {
      const launch = launchSummary(rows);
      return launch ? { launch } : {};
    }
    case "hitches":
      return {
        hitches: hitchStats(rows.flatMap((row) => nanos(row, "duration") ?? []).map(nanosToMs)),
      };
    case "hangs":
      return { hangs: hangsSummary(rows) };
    case "timeProfiler":
      return { topFunctions: topCounts(leafFunctions(rows)) };
    default:
      return {};
  }
}
