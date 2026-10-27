import { describe, expect, test } from "bun:test";
import {
  prototypeChoreographyError,
  prototypeChoreographyFields,
  prototypeChoreographyUnsupportedMessage,
  prototypeStaggerRank,
  prototypeTransitionType,
} from "../../../src/features/prototype/prototypeChoreography";
import { prototypeGateCapabilities } from "../../../src/features/prototype/prototypeCapabilityGates";
import { validatePrototypeSpec } from "../../../src/features/prototype/prototypeValidation";

const visible = { key: "show", equals: true };
const row = (extra: Record<string, unknown> = {}) => ({
  type: "text",
  text: "x",
  visibleWhen: visible,
  ...extra,
});
const column = (children: unknown[], stagger: unknown, extra: Record<string, unknown> = {}) => ({
  type: "column",
  stagger,
  children,
  ...extra,
});
const spec = (root: unknown) => ({
  id: "a",
  window: { placement: { type: "fullscreen" } },
  state: { show: true },
  root,
});
const located = (value: Record<string, unknown>) => [{ value, path: "root" }];

describe("prototype choreography (#15247)", () => {
  test("a transition's type reads from either form", () => {
    expect(prototypeTransitionType("fade")).toBe("fade");
    expect(prototypeTransitionType({ type: "scale", delayMs: 5 })).toBe("scale");
    expect(prototypeTransitionType({ delayMs: 5 })).toBeUndefined();
    expect(prototypeTransitionType(3)).toBeUndefined();
  });

  test("only the object form, blurReplace and stagger need the capability", () => {
    expect(prototypeChoreographyFields(spec(row({ transition: "fade" })))).toEqual([]);
    expect(prototypeChoreographyFields(spec(row({ transition: "blurReplace" })))).toEqual([
      "root.transition",
    ]);
    expect(
      prototypeChoreographyFields(
        spec(column([row({ transition: { type: "fade" } })], { ms: 10 })),
      ),
    ).toEqual(["root.stagger", "root.children[0].transition"]);
  });

  test("an object transition of a motion v2 type also needs motion v2", () => {
    expect(prototypeGateCapabilities(spec(row({ transition: { type: "scale" } })))).toEqual([
      "prototype_choreography_v1",
      "prototype_motion_v2",
    ]);
    expect(prototypeGateCapabilities(spec(row({ transition: "blurReplace" })))).toEqual([
      "prototype_choreography_v1",
    ]);
  });

  test("ranks follow the stagger order", () => {
    const ranks = (order: "forward" | "reverse" | "center", count: number) =>
      Array.from({ length: count }, (_, i) => prototypeStaggerRank(i, count, order));
    expect(ranks("forward", 4)).toEqual([0, 1, 2, 3]);
    expect(ranks("reverse", 4)).toEqual([3, 2, 1, 0]);
    expect(ranks("center", 4)).toEqual([1, 0, 0, 1]);
    expect(ranks("center", 5)).toEqual([2, 1, 0, 1, 2]);
    expect(ranks("center", 1)).toEqual([0]);
  });

  test("the total delay may reach 600 ms and no more", () => {
    const seven = Array.from({ length: 7 }, () => row());
    const eight = Array.from({ length: 8 }, () => row());
    expect(prototypeChoreographyError(located(column(seven, { ms: 100 })))).toBeUndefined();
    expect(prototypeChoreographyError(located(column(eight, { ms: 100 })))).toEqual({
      path: "root.stagger",
      message: "Stagger and transition delays add up to more than 600 ms",
    });
  });

  test("a child's own delay adds to its stagger rank", () => {
    const children = [row(), row({ transition: { type: "fade", delayMs: 500 } })];
    expect(prototypeChoreographyError(located(column(children, { ms: 100 })))).toBeUndefined();
    expect(prototypeChoreographyError(located(column(children, { ms: 101 })))).toBeDefined();
  });

  test("order decides which child waits longest", () => {
    const children = [row({ transition: { type: "fade", delayMs: 550 } }), row()];
    expect(prototypeChoreographyError(located(column(children, { ms: 100 })))).toBeUndefined();
    expect(
      prototypeChoreographyError(located(column(children, { ms: 100, order: "reverse" }))),
    ).toBeDefined();
  });

  test("only visibleWhen children are staggered and a literal repeat multiplies them", () => {
    const plain = { type: "text", text: "p" };
    expect(
      prototypeChoreographyError(located(column([plain, plain, plain, plain, row()], { ms: 100 }))),
    ).toBeUndefined();
    const repeated = column(
      [row()],
      { ms: 100 },
      { repeat: { items: Array.from({ length: 8 }, (_, n) => ({ n })), as: "i" } },
    );
    expect(prototypeChoreographyError(located(repeated))).toBeDefined();
    const bound = column(
      [row()],
      { ms: 100 },
      { repeat: { items: { path: "/data/rows" }, as: "i" } },
    );
    expect(prototypeChoreographyError(located(bound))).toBeUndefined();
  });

  test("the validator reports the cap through the whole spec", () => {
    const eight = Array.from({ length: 8 }, () => row());
    const result = validatePrototypeSpec(spec(column(eight, { ms: 100 })));
    expect(result.success).toBe(false);
    expect(result.success ? undefined : result.error.path).toBe("root.stagger");
  });

  test("the refusal names the first field and counts the rest", () => {
    const message = prototypeChoreographyUnsupportedMessage(
      ["root.stagger", "root.transition"],
      "ios",
    );
    expect(message).toContain("prototype_choreography_v1");
    expect(message).toContain("root.stagger (and 1 more)");
    expect(message).toContain("launchApp prototype: true");
    expect(prototypeChoreographyUnsupportedMessage(["a"], "android")).toContain("CtrlProxy");
  });
});
