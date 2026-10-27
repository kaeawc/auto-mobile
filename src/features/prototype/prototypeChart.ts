import { PROTOTYPE_CHART_CAPABILITY } from "../observe/android/ctrlProxyProtocol";
import { resolvePrototypeDataPointer } from "./prototypeData";
import { walkPrototypeNodes } from "./prototypeNodeChildren";
import { record, type Raw } from "./prototypeTemplate";

/**
 * The `chart` node (#14209): a line, area, bar or ring chart whose points are the objects of a
 * `/data` array, read through each series' `y` (and optional `x`) member. A ring takes exactly one
 * series and a positive `goal`, and draws that series' latest value against it. Gated by
 * `prototype_chart_v1`.
 */
export interface PrototypeChartError {
  path: string;
  message: string;
}

type Located = readonly { value: Raw; path: string }[];

function ringError(node: Raw, path: string): PrototypeChartError | undefined {
  if (node.variant !== "ring") {
    return undefined;
  }
  if (Array.isArray(node.series) && node.series.length !== 1) {
    return { path: `${path}.series`, message: "A ring chart takes exactly one series" };
  }
  if (typeof node.goal !== "number") {
    return { path: `${path}.goal`, message: "A ring chart needs a goal" };
  }
  return node.goal > 0
    ? undefined
    : { path: `${path}.goal`, message: "A ring chart goal must be positive" };
}

function rangeError(node: Raw, path: string): PrototypeChartError | undefined {
  const range = record(node.yRange);
  return range && typeof range.min === "number" && typeof range.max === "number"
    ? range.max > range.min
      ? undefined
      : { path: `${path}.yRange.max`, message: "Chart yRange max must be above min" }
    : undefined;
}

/** A series whose path is literal must resolve to an array of objects with a numeric `y`. */
function seriesError(series: Raw, path: string, data: unknown): PrototypeChartError | undefined {
  const pointer = series.path;
  // A repeat-bound path is bound per row by the repeat expansion.
  if (typeof pointer !== "string" || pointer.includes("{")) {
    return undefined;
  }
  const points = resolvePrototypeDataPointer(data, pointer);
  if (!Array.isArray(points)) {
    return { path: `${path}.path`, message: "Chart series path does not resolve to an array" };
  }
  for (const [index, value] of points.entries()) {
    const point = record(value);
    if (!point) {
      return { path: `${path}.path`, message: `Chart series point ${index} is not an object` };
    }
    const y =
      typeof series.y === "string" && Object.hasOwn(point, series.y) ? point[series.y] : undefined;
    if (typeof y !== "number" || !Number.isFinite(y)) {
      return { path: `${path}.y`, message: `Chart series point ${index} y is not a number` };
    }
  }
  return undefined;
}

/** Static checks over the structurally valid nodes of one spec and its `/data`. */
export function prototypeChartError(
  nodes: Located,
  data: unknown,
): PrototypeChartError | undefined {
  for (const { value, path } of nodes) {
    if (value.type !== "chart") {
      continue;
    }
    const error = ringError(value, path) ?? rangeError(value, path);
    if (error) {
      return error;
    }
    const series = Array.isArray(value.series) ? value.series : [];
    for (const [index, entry] of series.entries()) {
      const at = `${path}.series[${index}]`;
      const failure = seriesError(record(entry) ?? {}, at, data);
      if (failure) {
        return failure;
      }
    }
  }
  return undefined;
}

/** Authored paths of every chart node. */
export function prototypeChartFields(spec: unknown): string[] {
  const fields: string[] = [];
  walkPrototypeNodes(spec, (node, path) => {
    if (node.type === "chart") {
      fields.push(path);
    }
  });
  return fields;
}

export function prototypeChartUnsupportedMessage(
  fields: readonly string[],
  platform: "android" | "ios",
): string {
  const device = platform === "ios" ? "connected iOS prototype agent" : "connected CtrlProxy";
  const update =
    platform === "ios"
      ? "Relaunch the app with launchApp prototype: true to load the agent built for this AutoMobile version"
      : "Update the connected CtrlProxy";
  const more = fields.length > 1 ? ` (and ${fields.length - 1} more)` : "";
  return `The ${device} does not advertise ${PROTOTYPE_CHART_CAPABILITY}, so it cannot render the chart at ${fields[0]}${more}. Nothing was shown. ${update}, or show the values as text.`;
}
