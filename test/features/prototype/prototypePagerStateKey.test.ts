import { applyPrototypePatch } from "../../../src/features/prototype/prototypePatch";
import { expect, test } from "bun:test";
import { validatePrototypeSpec } from "../../../src/features/prototype/prototypeValidation";
import { prototypeGateCapabilities } from "../../../src/features/prototype/prototypeCapabilityGates";
const pager = {
  type: "pager",
  id: "deck",
  stateKey: "page",
  children: [{ type: "spacer" }, { type: "spacer" }],
};
const spec = (state: unknown = { page: 1 }, root: unknown = pager) => ({
  id: "deck",
  window: { placement: { type: "fullscreen" } },
  state,
  root,
});
test("pager state key accepts declared integer and requires its capability", () => {
  expect(validatePrototypeSpec(spec()).success).toBe(true);
  expect(prototypeGateCapabilities(spec())).toContain("prototype_pager_state_key_v1");
});
test.each([{}, { page: "1" }, { page: true }, { page: -1 }, { page: 0.5 }])(
  "pager rejects invalid state %j",
  (state) => {
    expect(validatePrototypeSpec(spec(state))).toMatchObject({
      success: false,
      error: { path: "root.stateKey" },
    });
  },
);
test("pagers cannot share a key", () => {
  expect(
    validatePrototypeSpec(
      spec({ page: 0 }, { type: "column", children: [pager, { ...pager, id: "other" }] }),
    ),
  ).toMatchObject({ success: false, error: { path: "root.children[1].stateKey" } });
});
test("pager key cannot appear in repeat template", () => {
  expect(
    validatePrototypeSpec(
      spec({ page: 0 }, { type: "column", children: [pager], repeat: { as: "item", items: [{}] } }),
    ),
  ).toMatchObject({ success: false, error: { path: "root.children[0].stateKey" } });
});

test("tab bar can alias pager key", () => {
  expect(
    validatePrototypeSpec(
      spec(
        { page: 0 },
        {
          type: "column",
          children: [
            pager,
            { type: "tabBar", stateKey: "page", items: [{ label: "One" }, { label: "Two" }] },
          ],
        },
      ),
    ).success,
  ).toBe(true);
});
test.each([-10, 20])("patch clamps pager key %s before validating", (value) => {
  const result = applyPrototypePatch(spec(), [{ op: "replace", path: "/state/page", value }]);
  expect(result.success).toBe(true);
  if (result.success) {
    expect(result.spec.state).toEqual({ page: value < 0 ? 0 : 1 });
    expect(validatePrototypeSpec(result.spec).success).toBe(true);
  }
});
test("patch tests compare the actual clamped value and never mutate input", () => {
  const source = spec();
  const result = applyPrototypePatch(source, [
    { op: "replace", path: "/state/page", value: 20 },
    { op: "test", path: "/state/page", value: 1 },
  ]);
  expect(result.success).toBe(true);
  expect(source.state).toEqual({ page: 1 });
});
