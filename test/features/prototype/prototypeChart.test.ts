import { describe, expect, test } from "bun:test";
import { requiredPrototypeCapabilities } from "../../../src/features/prototype/prototypeCapabilityGates";
import {
  prototypeChartFields,
  prototypeChartUnsupportedMessage,
} from "../../../src/features/prototype/prototypeChart";
import { validatePrototypeSpec } from "../../../src/features/prototype/prototypeValidation";

const chart = (extra: Record<string, unknown> = {}) => ({
  type: "chart",
  variant: "line",
  series: [{ path: "/points", y: "y", label: "Points" }],
  ...extra,
});
const spec = (root: unknown, data: unknown = { points: [{ y: 1 }] }) => ({
  id: "charts",
  window: { placement: { type: "fullscreen" } },
  data,
  root,
});

describe("chart validation (#14209)", () => {
  test("an empty series is valid: points arrive later through /data", () => {
    expect(validatePrototypeSpec(spec(chart(), { points: [] })).success).toBe(true);
  });

  test("a point without the y member is not a number", () => {
    const result = validatePrototypeSpec(spec(chart(), { points: [{ y: 1 }, { x: 2 }] }));
    expect(result.success ? undefined : result.error).toEqual({
      path: "root.series[0].y",
      message: "Chart series point 1 y is not a number",
    });
  });

  test("a goal on a line chart may be any number", () => {
    expect(validatePrototypeSpec(spec(chart({ goal: -5 }))).success).toBe(true);
  });
});

describe("chart gate", () => {
  test("reports every chart node, in tree order", () => {
    const root = { type: "column", children: [chart(), { type: "card", children: [chart()] }] };
    expect(prototypeChartFields(spec(root))).toEqual([
      "root.children[0]",
      "root.children[1].children[0]",
    ]);
    expect(requiredPrototypeCapabilities(spec(root))).toContain("prototype_chart_v1");
  });

  test("a spec without charts needs no gate", () => {
    expect(prototypeChartFields(spec({ type: "text", text: "Hi" }))).toEqual([]);
  });

  test("the refusal names the capability and the field", () => {
    const message = prototypeChartUnsupportedMessage(["root", "root.children[1]"], "android");
    expect(message).toContain("prototype_chart_v1");
    expect(message).toContain("chart at root (and 1 more)");
  });
});
