import { resolvePrototypeDataPointer } from "../prototypeData";
import { record, type Raw } from "../prototypeTemplate";
import { el, type WebChild, type WebElement } from "./webNodes";
import type { NodeRenderer, WebRenderKit, WebRenderScope } from "./webRender";
import { cssColor, textCss } from "./webStyle";

/** One drawn point: its `x` label, when the series names an `x` member, and its `y` value. */
export interface WebChartPoint {
  readonly x?: string;
  readonly y: number;
}

export interface WebChartSeries {
  readonly label: string;
  readonly points: readonly WebChartPoint[];
  readonly color: string;
}

/** A chart read against the spec's `/data`, as Android's chart model reads it (#14209). */
export interface WebChartModel {
  readonly variant: string;
  readonly series: readonly WebChartSeries[];
  readonly yMin: number;
  readonly yMax: number;
  readonly goal?: number;
  readonly summary: string;
}

/** The plot's drawing box: the chart is 160 dp tall and its width is scaled to the container. */
const WIDTH = 100;
const HEIGHT = 160;
const RING = 120;
const RING_STROKE = 12;
const BAR_FILL = 0.7;
const DEFAULT_ROLES = ["primary", "tertiary", "secondary", "error"] as const;

const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
const num = (value: number) => String(Number(value.toFixed(3)));

/** At most two decimals, without trailing zeros: 72, 72.5, 0.33. */
export function formatChartNumber(value: number): string {
  const rounded = Number(value.toFixed(2));
  return Object.is(rounded, -0) ? "0" : String(rounded);
}

function pointLabel(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  return finite(value) ? formatChartNumber(value) : undefined;
}

/** A point that is not an object or whose `y` is not a finite number is skipped. */
function seriesPoints(series: Raw, data: unknown): WebChartPoint[] {
  const items =
    typeof series.path === "string" ? resolvePrototypeDataPointer(data, series.path) : [];
  return (Array.isArray(items) ? items : []).flatMap((item) => {
    const point = record(item);
    const y = point?.[String(series.y)];
    if (!point || !finite(y)) {
      return [];
    }
    const x = typeof series.x === "string" ? pointLabel(point[series.x]) : undefined;
    return [x === undefined ? { y } : { x, y }];
  });
}

/** The drawn y range: the values and goal, with bars rising from zero, never empty. */
function autoRange(variant: string, series: readonly WebChartSeries[], goal?: number) {
  const values = [
    ...series.flatMap((entry) => entry.points.map((point) => point.y)),
    ...(goal === undefined ? [] : [goal]),
    ...(variant === "bar" ? [0] : []),
  ];
  const low = values.length ? Math.min(...values) : 0;
  const high = values.length ? Math.max(...values) : 1;
  return high > low ? { yMin: low, yMax: high } : { yMin: low - 1, yMax: high + 1 };
}

/** "Line chart, Heart rate, 5 points, min 58, max 141, latest 72"; a ring reads its goal. */
export function chartSummary(
  variant: string,
  series: readonly Pick<WebChartSeries, "label" | "points">[],
  goal?: number,
): string {
  const kind = `${variant.charAt(0).toUpperCase()}${variant.slice(1)} chart`;
  if (variant === "ring") {
    const only = series[0];
    const latest = only?.points.at(-1)?.y ?? 0;
    const target = goal === undefined ? "0" : formatChartNumber(goal);
    return `${kind}, ${only?.label ?? ""}, ${formatChartNumber(latest)} of ${target}`;
  }
  const parts = series.map((entry) => {
    const ys = entry.points.map((point) => point.y);
    if (!ys.length) {
      return `${entry.label}, no points`;
    }
    const noun = ys.length === 1 ? "point" : "points";
    const [min, max, latest] = [Math.min(...ys), Math.max(...ys), ys.at(-1)!].map(
      formatChartNumber,
    );
    return `${entry.label}, ${ys.length} ${noun}, min ${min}, max ${max}, latest ${latest}`;
  });
  const goalPart = goal === undefined ? "" : `, goal ${formatChartNumber(goal)}`;
  return `${kind}, ${parts.join("; ")}${goalPart}`;
}

export function chartModel(node: Raw, scope: WebRenderScope): WebChartModel {
  const variant = String(node.variant);
  const series = (Array.isArray(node.series) ? node.series : []).map((entry, index) => {
    const raw = record(entry) ?? {};
    const fallback = DEFAULT_ROLES[index % DEFAULT_ROLES.length]!;
    return {
      label: typeof raw.label === "string" ? raw.label : "",
      points: seriesPoints(raw, scope.data),
      color: cssColor(raw.color, scope.style) ?? cssColor(fallback, scope.style) ?? "currentColor",
    };
  });
  const goal = finite(node.goal) ? node.goal : undefined;
  const range = record(node.yRange);
  const { yMin, yMax } =
    range && finite(range.min) && finite(range.max)
      ? { yMin: range.min, yMax: range.max }
      : autoRange(variant, series, goal);
  return {
    variant,
    series,
    yMin,
    yMax,
    ...(goal === undefined ? {} : { goal }),
    summary: chartSummary(variant, series, goal),
  };
}

function scaleY(model: WebChartModel, value: number): number {
  const span = model.yMax - model.yMin;
  const ratio = span === 0 ? 0 : (value - model.yMin) / span;
  return HEIGHT - Math.min(Math.max(ratio, 0), 1) * HEIGHT;
}

/** A point's x centre: the full width for a line, the middle for a single point. */
const scaleX = (index: number, count: number) =>
  count <= 1 ? WIDTH / 2 : (index * WIDTH) / (count - 1);

/** Strokes keep their dp width while the plot stretches to the container's width. */
const NON_SCALING = { "vector-effect": "non-scaling-stroke" };

function goalLine(model: WebChartModel, scope: WebRenderScope): WebElement[] {
  if (model.goal === undefined) {
    return [];
  }
  const y = num(scaleY(model, model.goal));
  return [
    el("line", {
      attrs: {
        "data-part": "goal",
        x1: "0",
        x2: String(WIDTH),
        y1: y,
        y2: y,
        stroke: cssColor("outline", scope.style) ?? "currentColor",
        "stroke-width": "1",
        "stroke-dasharray": "6 6",
        ...NON_SCALING,
      },
    }),
  ];
}

function lineSeries(model: WebChartModel, series: WebChartSeries, area: boolean): WebElement[] {
  const ys = series.points.map((point) => point.y);
  if (!ys.length) {
    return [];
  }
  const points = ys.map((y, index) => `${num(scaleX(index, ys.length))},${num(scaleY(model, y))}`);
  const fill = area
    ? [
        el("polygon", {
          attrs: {
            "data-part": "area",
            points: [
              ...points,
              `${num(scaleX(ys.length - 1, ys.length))},${HEIGHT}`,
              `${num(scaleX(0, ys.length))},${HEIGHT}`,
            ].join(" "),
            fill: series.color,
            "fill-opacity": "0.25",
          },
        }),
      ]
    : [];
  return [
    ...fill,
    el("polyline", {
      attrs: {
        "data-part": "line",
        points: points.join(" "),
        fill: "none",
        stroke: series.color,
        "stroke-width": "2",
        "stroke-linecap": "round",
        "stroke-linejoin": "round",
        ...NON_SCALING,
      },
    }),
  ];
}

/** Grouped bars: one slot per point index, one bar per series within it, rising from zero. */
function bars(model: WebChartModel): WebElement[] {
  const slots = Math.max(0, ...model.series.map((series) => series.points.length));
  if (!slots) {
    return [];
  }
  const slot = WIDTH / slots;
  const bar = (slot * BAR_FILL) / model.series.length;
  const base = scaleY(model, Math.min(Math.max(0, model.yMin), model.yMax));
  return model.series.flatMap((series, index) =>
    series.points.map((point, at) => {
      const top = scaleY(model, point.y);
      return el("rect", {
        attrs: {
          "data-part": "bar",
          x: num(at * slot + (slot * (1 - BAR_FILL)) / 2 + index * bar),
          y: num(Math.min(top, base)),
          width: num(bar),
          height: num(Math.abs(base - top)),
          fill: series.color,
        },
      });
    }),
  );
}

/** The first series' x labels: none, the two ends, or all of them spaced between the edges. */
function xLabels(node: Raw, model: WebChartModel, scope: WebRenderScope): WebElement[] {
  const labels = (model.series[0]?.points ?? []).flatMap((point) =>
    point.x === undefined ? [] : [point.x],
  );
  const shown =
    node.xLabels === "all"
      ? labels
      : node.xLabels === "ends" && labels.length > 1
        ? [labels[0]!, labels.at(-1)!]
        : node.xLabels === "ends"
          ? labels
          : [];
  if (!shown.length) {
    return [];
  }
  const color = cssColor("onSurfaceVariant", scope.style);
  return [
    el(
      "div",
      {
        attrs: { "data-part": "x-labels", "aria-hidden": "true" },
        style: {
          display: "flex",
          "justify-content": "space-between",
          ...textCss({ textStyle: "labelSmall" }, scope.style),
          ...(color ? { color } : {}),
        },
      },
      shown.map((label) => el("span", { style: { "white-space": "nowrap" } }, [label])),
    ),
  ];
}

/** A 120 dp ring of the first series' latest value against the goal, from twelve o'clock. */
function ring(model: WebChartModel, scope: WebRenderScope): WebChild[] {
  const latest = model.series[0]?.points.at(-1)?.y ?? 0;
  const goal = model.goal ?? 1;
  const fraction = goal === 0 ? 0 : Math.min(Math.max(latest / goal, 0), 1);
  const center = String(RING / 2);
  const circle = (stroke: string, length: number, part: string) =>
    el("circle", {
      attrs: {
        "data-part": part,
        cx: center,
        cy: center,
        r: num((RING - RING_STROKE) / 2),
        fill: "none",
        stroke,
        "stroke-width": String(RING_STROKE),
        "stroke-linecap": "round",
        pathlength: "100",
        "stroke-dasharray": `${num(length * 100)} 100`,
        transform: `rotate(-90 ${center} ${center})`,
      },
    });
  const arc = fraction > 0 ? [circle(model.series[0]!.color, fraction, "ring")] : [];
  return [circle(cssColor("surfaceVariant", scope.style) ?? "#e7e0ec", 1, "track"), ...arc];
}

/**
 * A `chart` drawn as inline SVG with no charting dependency: lines, filled areas, grouped bars, or
 * a ring of the latest value against the goal, with Android's geometry (a 160 dp plot that fills
 * the width, a 120 dp ring). The chart's summary is its accessible label unless the spec names
 * one; the x labels below the plot are visual only.
 */
const chartRenderer =
  (kit: WebRenderKit): NodeRenderer =>
  (node, scope) => {
    const model = chartModel(node, scope);
    const isRing = model.variant === "ring";
    const { attrs, style } = kit.base(
      node,
      scope,
      isRing
        ? { display: "block", width: `${RING}px`, height: `${RING}px`, "flex-shrink": "0" }
        : { display: "flex", "flex-direction": "column", "align-self": "stretch" },
    );
    const labelled = {
      role: "img",
      "aria-label": attrs["aria-label"] ?? model.summary,
      "data-chart": model.variant,
    };
    if (isRing) {
      const svg = el(
        "svg",
        {
          // The view box keeps the ring's geometry; the SVG fills the node's (possibly authored) box.
          attrs: { viewbox: `0 0 ${RING} ${RING}`, width: "100%", height: "100%" },
          style: { display: "block" },
        },
        ring(model, scope),
      );
      return el("div", { attrs: { ...attrs, ...labelled }, style }, [svg]);
    }
    const plot =
      model.variant === "bar"
        ? bars(model)
        : model.series.flatMap((series) => lineSeries(model, series, model.variant === "area"));
    const svg = el(
      "svg",
      {
        attrs: {
          viewbox: `0 0 ${WIDTH} ${HEIGHT}`,
          preserveaspectratio: "none",
          width: "100%",
          height: String(HEIGHT),
        },
        style: { display: "block", overflow: "visible" },
      },
      [...goalLine(model, scope), ...plot],
    );
    return el("div", { attrs: { ...attrs, ...labelled }, style }, [
      svg,
      ...xLabels(node, model, scope),
    ]);
  };

export function webChartRenderers(kit: WebRenderKit): Record<string, NodeRenderer> {
  return { chart: chartRenderer(kit) };
}
