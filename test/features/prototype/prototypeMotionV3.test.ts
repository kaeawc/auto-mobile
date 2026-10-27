import { expect, test } from "bun:test";
import { prototypeMotionV3Fields } from "../../../src/features/prototype/prototypeMotionV3";
import { prototypeGateCapabilities } from "../../../src/features/prototype/prototypeCapabilityGates";
import { validatePrototypeSpec } from "../../../src/features/prototype/prototypeValidation";
const spec = (root: unknown, motion?: string) => ({
  id: "motion3",
  window: { placement: { type: "fullscreen" } },
  state: { on: false },
  root,
  ...(motion ? { motion } : {}),
});
test("motion v3 reports authored expressive, press and layout animation paths", () => {
  expect(
    prototypeMotionV3Fields(
      spec(
        {
          type: "button",
          label: "Go",
          press: { scale: 0.9 },
          animate: {},
          styleWhen: [{ when: { key: "on", equals: true }, style: { width: { dp: 50 } } }],
        },
        "expressive",
      ),
    ),
  ).toEqual(["motion", "root.press", "root.animate"]);
  expect(
    prototypeGateCapabilities(spec({ type: "button", label: "Go", press: { scale: 0.9 } })),
  ).toEqual(["prototype_motion_v3"]);
});
for (const style of [
  { cornerRadius: 12 },
  { elevation: 4 },
  { shadowColor: "#112233" },
  { padding: { top: 8 } },
  { border: { color: "#112233", width: 1 } },
  { width: { dp: 50 } },
  { height: { dp: 60 } },
]) {
  test(`base and conditional ${JSON.stringify(style)} need v3 only under animate`, () => {
    for (const extra of [
      { style },
      { styleWhen: [{ when: { key: "on", equals: true }, style }] },
    ]) {
      expect(
        prototypeMotionV3Fields(spec({ type: "text", text: "Hi", animate: {}, ...extra })),
      ).toEqual(["root.animate"]);
      expect(prototypeMotionV3Fields(spec({ type: "text", text: "Hi", ...extra }))).toEqual([]);
    }
  });
}
test("alpha and fill-only animation keep their v2 capability", () => {
  const value = spec({
    type: "text",
    text: "Hi",
    animate: {},
    style: { alpha: 0.5, width: "fill" },
  });
  expect(prototypeMotionV3Fields(value)).toEqual([]);
  expect(prototypeGateCapabilities(value)).toEqual(["prototype_motion_v2"]);
});
test("press validates bounds, strict keys, presence and pressability", () => {
  for (const press of [
    {},
    { scale: 0.84 },
    { scale: 1.01 },
    { alpha: 0.49 },
    { alpha: 1.01 },
    { scale: 0.9, extra: true },
  ]) {
    expect(validatePrototypeSpec(spec({ type: "button", label: "Go", press })).success).toBe(false);
  }
  for (const press of [{ scale: 0.85 }, { alpha: 0.5 }, { scale: 1, alpha: 1 }]) {
    expect(
      validatePrototypeSpec(spec({ type: "button", label: "Go", press }, "expressive")).success,
    ).toBe(true);
  }
  expect(validatePrototypeSpec(spec({ type: "text", text: "Hi", press: { alpha: 0.7 } }))).toEqual({
    success: false,
    error: { path: "root.press", message: "press requires a pressable node" },
  });
  expect(
    validatePrototypeSpec(spec({ type: "card", children: [], press: { scale: 0.9 } })).success,
  ).toBe(false);
  expect(
    validatePrototypeSpec(
      spec({
        type: "text",
        text: "Hi",
        onTap: [{ type: "emit", name: "tap" }],
        press: { alpha: 0.7 },
      }),
    ).success,
  ).toBe(true);
});

test("motion v3 composes with lazy lists and platform namespaces", () => {
  const value = {
    ...spec(
      {
        type: "list",
        repeat: { items: { path: "/rows" }, as: "row", key: "id" },
        children: [{ type: "text", text: "{row.title}" }],
        onTap: [{ type: "emit", name: "tap" }],
        press: { alpha: 0.8 },
        animate: {},
        style: { padding: { top: 8 } },
        ios: { hover: "lift" },
        android: { indication: "none" },
      },
      "expressive",
    ),
    data: { rows: [{ id: "first", title: "First" }] },
  };
  expect(validatePrototypeSpec(value)).toMatchObject({ success: true });
  expect(prototypeMotionV3Fields(value)).toEqual(["motion", "root.press", "root.animate"]);
  expect(prototypeGateCapabilities(value)).toEqual([
    "prototype_data_model_v1",
    "prototype_lazy_list_v1",
    "prototype_motion_v2",
    "prototype_motion_v3",
    "prototype_platform_namespace_v1",
  ]);
});
