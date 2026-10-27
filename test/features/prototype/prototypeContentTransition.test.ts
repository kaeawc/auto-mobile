import { expect, test } from "bun:test";
import {
  contentTransitionDirection,
  parseContentTransitionNumber,
  prototypeContentTransitionFields,
} from "../../../src/features/prototype/prototypeContentTransition";
import { prototypeGateCapabilities } from "../../../src/features/prototype/prototypeCapabilityGates";
import { validatePrototypeSpec } from "../../../src/features/prototype/prototypeValidation";
const spec = (root: unknown) => ({ id: "a", window: { placement: { type: "fullscreen" } }, root });
const text = (contentTransition?: string) => ({
  type: "text",
  text: "9",
  ...(contentTransition ? { contentTransition } : {}),
});
test("numeric parsing and direction are deterministic", () => {
  for (const [previous, next, direction] of [
    ["9", "10", "up"],
    ["$1,200", "$980", "down"],
    ["abc", "abd", "crossfade"],
    ["-3.5", "-2.5", "up"],
    ["1.2", "1.1", "down"],
    ["9", "9", "crossfade"],
    ["09", "9", "crossfade"],
    ["0", "-1", "down"],
  ]) {
    expect(contentTransitionDirection(previous!, next!)).toBe(direction);
  }
  expect(parseContentTransitionNumber("$1,200")).toBe(1200);
  expect(parseContentTransitionNumber("-3.5")).toBe(-3.5);
  expect(parseContentTransitionNumber("1.2.3")).toBe(1.23);
  expect(parseContentTransitionNumber("abc")).toBeUndefined();
});
test("only non-none text fields gate, including nested templates and components", () => {
  expect(prototypeContentTransitionFields(spec(text("numeric")))).toEqual([
    "root.contentTransition",
  ]);
  for (const mode of [undefined, "none"])
    expect(prototypeGateCapabilities(spec(text(mode)))).toEqual([]);
  expect(
    prototypeGateCapabilities(
      spec({
        type: "column",
        repeat: { items: [{ count: 1 }], as: "item" },
        children: [text("crossfade")],
      }),
    ),
  ).toContain("prototype_content_transition_v1");
});
test("component definitions gate without scanning opaque data", () => {
  const input = {
    ...spec(text("none")),
    components: { total: { root: text("numeric") } },
    data: { sample: text("numeric") },
  };
  expect(prototypeContentTransitionFields(input)).toEqual([
    "components.total.root.contentTransition",
  ]);
});
test("text-only enum is strict", () => {
  for (const mode of ["numeric", "crossfade", "none"])
    expect(validatePrototypeSpec(spec(text(mode))).success).toBe(true);
  expect(validatePrototypeSpec(spec(text("slide"))).success).toBe(false);
  expect(
    validatePrototypeSpec(spec({ type: "button", text: "Go", contentTransition: "numeric" }))
      .success,
  ).toBe(false);
});
