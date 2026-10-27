import { expect, test } from "bun:test";
import { validatePrototypeSpec } from "../../../src/features/prototype/prototypeValidation";
import { prototypeGateCapabilities } from "../../../src/features/prototype/prototypeCapabilityGates";

const linked = { source: "feed", range: [0, 160], alpha: [1, 0] };
const spec = (child: unknown) => ({
  id: "motion",
  window: { placement: { type: "fullscreen" } },
  root: { type: "scroll", id: "feed", child },
});
test("scroll motion is validated and capability gated", () => {
  const value = spec({
    type: "text",
    text: "Hero",
    scrollLinked: linked,
    scrollTransition: { axis: "vertical", edge: { scale: 0.88, alpha: 0.5 } },
  });
  expect(validatePrototypeSpec(value).success).toBe(true);
  expect(prototypeGateCapabilities(value)).toContain("prototype_scroll_motion_v1");
});
for (const [name, patch] of Object.entries({
  source: { source: "missing" },
  range: { range: [160, 0] },
  equal: { range: [0, 0] },
  shape: { range: [0] },
  property: { opacity: [0, 1] },
})) {
  test(`rejects invalid scroll ${name}`, () => {
    expect(
      validatePrototypeSpec(
        spec({ type: "text", text: "Hero", scrollLinked: { ...linked, ...patch } }),
      ).success,
    ).toBe(false);
  });
}
test("scroll binding cap applies after repeat expansion", () => {
  const child = {
    type: "column",
    repeat: { items: Array.from({ length: 17 }, () => ({ name: "x" })), as: "row" },
    children: [{ type: "text", text: "x", scrollLinked: linked }],
  };
  expect(validatePrototypeSpec(spec(child)).success).toBe(false);
  child.repeat.items.pop();
  expect(validatePrototypeSpec(spec(child)).success).toBe(true);
});
