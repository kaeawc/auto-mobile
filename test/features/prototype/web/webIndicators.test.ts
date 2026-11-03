import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { chartSummary, formatChartNumber } from "../../../../src/features/prototype/web/webChart";
import { webWidthClass } from "../../../../src/features/prototype/web/webAdaptive";
import {
  toHtml,
  type WebChild,
  type WebElement,
} from "../../../../src/features/prototype/web/webNodes";
import {
  renderPrototypeStill,
  type PrototypeStillOptions,
} from "../../../../src/features/prototype/web/webStill";

type Spec = Record<string, unknown>;

const fixture = (name: string): Spec =>
  JSON.parse(
    readFileSync(
      join(import.meta.dir, `../../../fixtures/prototype-spec/valid/${name}.json`),
      "utf8",
    ),
  ) as Spec;

function find(node: WebChild, predicate: (element: WebElement) => boolean): WebElement[] {
  if (typeof node === "string") {
    return [];
  }
  return [
    ...(predicate(node) ? [node] : []),
    ...node.children.flatMap((child) => find(child, predicate)),
  ];
}
const textOf = (node: WebChild): string =>
  typeof node === "string" ? node : node.children.map(textOf).join("");
const byAttr = (element: WebElement, name: string, value?: string) =>
  find(element, (candidate) =>
    value === undefined ? name in candidate.attrs : candidate.attrs[name] === value,
  );

function still(spec: Spec, options: PrototypeStillOptions = {}) {
  return renderPrototypeStill(spec, options);
}
const rootOf = (root: Spec, extra: Spec = {}): Spec => ({ id: "s", root, ...extra });
const nodes = (spec: Spec, type: string, options: PrototypeStillOptions = {}) => {
  const rendered = still(spec, options);
  return { rendered, found: byAttr(rendered.element, "data-node", type) };
};

const ERROR = "rgba(179,38,30,1)";
const PRIMARY = "rgba(103,80,164,1)";

describe("badge", () => {
  test("draws a 6 px error dot without text and an error pill with it", () => {
    const spec = rootOf(
      {
        type: "row",
        children: [{ type: "badge" }, { type: "badge", text: "{count}" }],
      },
      { state: { count: "3" } },
    );
    const { rendered, found } = nodes(spec, "badge");
    expect(rendered.unsupportedNodes).toEqual([]);
    const [dot, pill] = found;
    expect(dot!.attrs["data-badge"]).toBe("small");
    expect(dot!.style).toMatchObject({ width: "6px", height: "6px", "background-color": ERROR });
    expect(pill!.attrs["data-badge"]).toBe("large");
    expect(pill!.style).toMatchObject({ height: "16px", "min-width": "16px" });
    expect(textOf(pill!)).toBe("3");
  });
});

describe("progress", () => {
  const progress = (node: Spec, state: Spec = {}) =>
    nodes(
      rootOf({ type: "column", children: [{ type: "progress", ...node }] }, { state }),
      "progress",
    ).found[0]!;

  test("a bound linear indicator draws value / max and reports it", () => {
    const bar = progress({ stateKey: "done", max: 4 }, { done: 1 });
    expect(bar.attrs).toMatchObject({ role: "progressbar", "aria-valuenow": "25" });
    expect(bar.style).toMatchObject({ width: "240px", height: "4px" });
    expect(byAttr(bar, "data-part", "indicator")[0]!.style.width).toBe("25%");
  });

  test("the fraction clamps to 0..1 and a non-number reads as 0", () => {
    expect(progress({ stateKey: "v" }, { v: 7 }).attrs["aria-valuenow"]).toBe("100");
    expect(progress({ stateKey: "v" }, { v: -2 }).attrs["aria-valuenow"]).toBe("0");
    expect(progress({ stateKey: "v" }, { v: "half" }).attrs["aria-valuenow"]).toBe("0");
  });

  test("unbound is indeterminate and rests at a 30 % segment in a still", () => {
    const bar = progress({});
    expect(bar.attrs["data-indeterminate"]).toBe("true");
    expect(bar.attrs["aria-valuenow"]).toBeUndefined();
    expect(byAttr(bar, "data-part", "indicator")[0]!.style.width).toBe("30%");
  });

  test("circular draws a 40 px ring with an arc of the fraction", () => {
    const ring = progress({ variant: "circular", stateKey: "v" }, { v: 0.5 });
    expect(ring.style).toMatchObject({ width: "40px", height: "40px" });
    const arc = byAttr(ring, "data-part", "indicator")[0]!;
    expect(arc.attrs["stroke-dasharray"]).toBe("50 100");
    expect(arc.attrs.stroke).toBe(PRIMARY);
    expect(byAttr(ring, "data-part", "track")).toHaveLength(1);
  });

  test("a circular indicator at zero draws only its track", () => {
    const ring = progress({ variant: "circular", stateKey: "v" }, { v: 0 });
    expect(byAttr(ring, "data-part", "indicator")).toEqual([]);
  });
});

describe("fab", () => {
  const fab = (node: Spec, state: Spec = {}) =>
    nodes(
      rootOf({ type: "column", children: [{ type: "fab", icon: "add", ...node }] }, { state }),
      "fab",
    ).found[0]!;

  test("sizes follow Material 3: small, regular and large", () => {
    expect(fab({ size: "small" }).style).toMatchObject({ width: "40px", "border-radius": "12px" });
    expect(fab({}).style).toMatchObject({ width: "56px", height: "56px", "border-radius": "16px" });
    const large = fab({ size: "large" });
    expect(large.style).toMatchObject({ width: "96px", "border-radius": "28px" });
    expect(byAttr(large, "data-node", "icon")[0]!.style.width).toBe("36px");
  });

  test("a label makes it extended and draws the label after the icon", () => {
    const extended = fab({ label: "Compose" });
    expect(extended.style).toMatchObject({ height: "56px", gap: "12px" });
    expect(extended.style.width).toBeUndefined();
    expect(textOf(extended)).toBe("ACompose");
  });

  test("disabled draws a 12 % on-surface container and says so", () => {
    const disabled = fab({ enabledWhen: { key: "ok", equals: true } }, { ok: false });
    expect(disabled.attrs["aria-disabled"]).toBe("true");
    expect(disabled.style["background-color"]).toContain("12%");
    expect(disabled.style["box-shadow"]).toBeUndefined();
  });
});

describe("flow", () => {
  test("flow_basic places children with spacing and runSpacing gaps", () => {
    const { rendered, found } = nodes(fixture("flow-basic"), "flow");
    expect(rendered.unsupportedNodes).toEqual([]);
    const flow = found[0]!;
    const items = byAttr(flow, "data-part", "item");
    expect(items.map(textOf)).toEqual(["Hello", "World"]);
    expect(items[0]!.style).toMatchObject({
      display: "inline-block",
      "margin-inline-end": "8px",
      "margin-bottom": "12px",
    });
    const lines = byAttr(flow, "data-part", "lines")[0]!;
    expect(lines.style).toMatchObject({ "margin-inline-end": "-8px", "margin-bottom": "-12px" });
    expect(lines.style["-webkit-line-clamp"]).toBeUndefined();
  });

  test("flow_max_lines_repeat repeats its children and clamps to maxLines", () => {
    const flow = nodes(fixture("flow-max-lines-repeat"), "flow").found[0]!;
    expect(byAttr(flow, "data-part", "item").map(textOf)).toEqual(["One", "Two", "Three"]);
    const lines = byAttr(flow, "data-part", "lines")[0]!;
    expect(lines.style).toMatchObject({ display: "-webkit-box", "-webkit-line-clamp": "1" });
  });

  test("a hidden child takes no item slot", () => {
    const spec = rootOf(
      {
        type: "flow",
        children: [
          { type: "text", text: "a" },
          { type: "text", text: "b", visibleWhen: { key: "show", equals: true } },
        ],
      },
      { state: { show: false } },
    );
    const flow = nodes(spec, "flow").found[0]!;
    expect(byAttr(flow, "data-part", "item").map(textOf)).toEqual(["a"]);
  });
});

describe("chart", () => {
  const charts = () => nodes(fixture("chart-variants"), "chart");

  test("every variant draws as SVG with no placeholder", () => {
    const { rendered, found } = charts();
    expect(rendered.unsupportedNodes).toEqual([]);
    expect(found.map((chart) => chart.attrs["data-chart"])).toEqual([
      "line",
      "area",
      "bar",
      "ring",
    ]);
    expect(found.every((chart) => byAttr(chart, "viewbox").length === 1)).toBe(true);
  });

  test("a line chart scales points into its yRange and labels its ends", () => {
    const line = charts().found[0]!;
    const points = byAttr(line, "data-part", "line")[0]!.attrs.points!;
    // 58 bpm over 40..160 sits 15 % up the 160 px plot; 141 bpm 84.17 % up.
    expect(points.split(" ")[0]).toBe("0,136");
    expect(points.split(" ")[2]).toBe("50,25.333");
    expect(textOf(byAttr(line, "data-part", "x-labels")[0]!)).toBe("6:0018:00");
    expect(line.attrs["aria-label"]).toBe(
      "Line chart, Heart rate, 5 points, min 58, max 141, latest 72",
    );
  });

  test("an area chart fills under its line and draws its goal dashed", () => {
    const area = charts().found[1]!;
    expect(byAttr(area, "data-part", "area")).toHaveLength(1);
    expect(byAttr(area, "data-part", "goal")[0]!.attrs["stroke-dasharray"]).toBe("6 6");
    expect(byAttr(area, "data-part", "x-labels")).toEqual([]);
  });

  test("a bar chart groups one bar per series in each slot, rising from zero", () => {
    const bars = byAttr(charts().found[2]!, "data-part", "bar");
    expect(bars).toHaveLength(6);
    expect(bars.map((bar) => Number(bar.attrs.y) + Number(bar.attrs.height))).toEqual(
      Array(6).fill(160),
    );
    expect(bars[3]!.attrs.fill).toBe("rgba(255,109,0,1)");
  });

  test("a ring draws the latest value over the goal and keeps an authored label", () => {
    const ring = charts().found[3]!;
    expect(ring.style).toMatchObject({ width: "120px", height: "120px" });
    expect(byAttr(ring, "data-part", "ring")[0]!.attrs["stroke-dasharray"]).toBe("65 100");
    expect(ring.attrs["aria-label"]).toBe("Steps today, 6500 of 10000");
  });

  test("the summary matches the device wording", () => {
    expect(chartSummary("ring", [{ label: "Steps", points: [{ y: 6500 }] }], 10000)).toBe(
      "Ring chart, Steps, 6500 of 10000",
    );
    expect(chartSummary("bar", [{ label: "Empty", points: [] }])).toBe(
      "Bar chart, Empty, no points",
    );
    expect(formatChartNumber(72.499)).toBe("72.5");
    expect(formatChartNumber(-0.001)).toBe("0");
  });
});

describe("adaptive", () => {
  const LANDSCAPE: PrototypeStillOptions = { frame: "medium-tablet", orientation: "landscape" };
  const adaptive = (name: string, state: Spec = {}, options: PrototypeStillOptions = {}) => {
    const spec = fixture(name);
    const { rendered, found } = nodes(
      { ...spec, state: { ...(spec.state as Spec), ...state } },
      "adaptive",
      options,
    );
    expect(rendered.unsupportedNodes).toEqual([]);
    return found[0]!;
  };
  const panes = (element: WebElement) =>
    byAttr(element, "data-pane").map((pane) => pane.attrs["data-pane"]);

  test("width classes follow Material's 600 and 840 dp breakpoints", () => {
    expect([599, 600, 839, 840].map(webWidthClass)).toEqual([
      "compact",
      "medium",
      "medium",
      "expanded",
    ]);
  });

  test("list-detail shows the list, the detail with Back once selected, or both expanded", () => {
    expect(panes(adaptive("adaptive-list-detail"))).toEqual(["list"]);
    const selected = adaptive("adaptive-list-detail", { selection: "a" });
    expect(panes(selected)).toEqual(["detail"]);
    expect(textOf(byAttr(selected, "role", "button")[0]!)).toBe("Back");
    expect(panes(adaptive("adaptive-list-detail", {}, LANDSCAPE))).toEqual(["list", "detail"]);
  });

  test("navigation suite is a bar when compact, a rail when medium, a drawer when expanded", () => {
    const layout = (options: PrototypeStillOptions) =>
      byAttr(adaptive("adaptive-navigation-suite", {}, options), "data-part", "navigation")[0]!
        .attrs["data-layout"];
    expect(layout({})).toBe("compact");
    expect(layout({ frame: "medium-tablet" })).toBe("medium");
    expect(layout(LANDSCAPE)).toBe("expanded");
    const tabs = byAttr(adaptive("adaptive-navigation-suite"), "role", "tab");
    expect(tabs.map((tab) => tab.attrs["aria-selected"])).toEqual(["true", "false"]);
  });

  test("supporting shows main when closed, supporting alone when open and narrow", () => {
    expect(panes(adaptive("adaptive-supporting", { open: false }))).toEqual(["main"]);
    expect(panes(adaptive("adaptive-supporting", { open: true }))).toEqual(["supporting"]);
    expect(panes(adaptive("adaptive-supporting", { open: true }, LANDSCAPE))).toEqual([
      "main",
      "supporting",
    ]);
  });
});

describe("swipe actions", () => {
  test("a list item keeps its swipe actions as hidden edge panels", () => {
    const { rendered, found } = nodes(fixture("swipe-actions-list-item"), "listItem");
    expect(rendered.unsupportedNodes).toEqual([]);
    expect(found).toHaveLength(2);
    const [latte] = found;
    expect(latte!.attrs["data-full-swipe"]).toBe("true");
    const edges = byAttr(latte!, "data-swipe-edge");
    expect(edges.map((edge) => [edge.attrs["data-swipe-edge"], edge.attrs.hidden])).toEqual([
      ["start", ""],
      ["end", ""],
    ]);
    const labels = byAttr(latte!, "data-swipe-role").map((action) => action.attrs["aria-label"]);
    expect(labels).toEqual(["Pin Latte", "Delete", "Archive"]);
    expect(byAttr(latte!, "data-swipe-role", "destructive")[0]!.style["background-color"]).toBe(
      "rgba(249,222,220,1)",
    );
  });

  test("a node without swipe actions is unchanged", () => {
    const html = toHtml(still(rootOf({ type: "row", children: [] })).element);
    expect(html).not.toContain("data-swipe-edge");
  });
});

describe("list", () => {
  test("draws its header, every repeated row and its footer", () => {
    const { rendered, found } = nodes(fixture("list-header-footer"), "list");
    expect(rendered.unsupportedNodes).toEqual([]);
    const list = found[0]!;
    expect(list.attrs.role).toBe("list");
    expect(list.children.map(textOf)).toEqual(["Feed p2", "One", "Two", "End"]);
    expect(list.style).toMatchObject({ "flex-direction": "column", "overflow-y": "auto" });
  });

  test("a horizontal list scrolls sideways with its spacing and content padding", () => {
    const list = nodes(fixture("list-horizontal"), "list").found[0]!;
    expect(list.style).toMatchObject({
      "flex-direction": "row",
      "overflow-x": "auto",
      gap: "8px",
      padding: "12px",
    });
  });

  test("maxItems caps the rows and an empty source draws none", () => {
    const spec = fixture("list-header-footer");
    const root = { ...(spec.root as Spec), maxItems: 1 };
    const capped = nodes({ ...spec, root }, "list").found[0]!;
    expect(capped.children.map(textOf)).toEqual(["Feed p2", "One", "End"]);
    expect(nodes(fixture("list-empty"), "list").found[0]!.children).toEqual([]);
  });
});
