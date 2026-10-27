import { expect, test } from "bun:test";
import { validatePrototypeSpec } from "../../../src/features/prototype/prototypeValidation";
import { prototypeGateCapabilities } from "../../../src/features/prototype/prototypeCapabilityGates";
import { bindNodeFields } from "../../../src/features/prototype/prototypeTemplate";
const action = { type: "emit", name: "appeared" };
const spec = (root: unknown) => ({
  id: "appear",
  window: { placement: { type: "fullscreen" } },
  state: { show: true },
  root,
});
test("onAppear accepts root and conditional nodes and gates even without timers", () => {
  const input = spec({
    type: "column",
    onAppear: [action],
    children: [
      {
        type: "text",
        text: "Hello",
        visibleWhen: { key: "show", equals: true },
        onAppear: [action],
      },
    ],
  });
  expect(validatePrototypeSpec(input).success).toBe(true);
  expect(prototypeGateCapabilities(input)).toContain("prototype_timers_v1");
  expect(
    validatePrototypeSpec(input, {
      supportedCapabilities: [],
      requiredCapabilities: prototypeGateCapabilities,
    }).success,
  ).toBe(false);
});
test("onAppear rejects an unconditional descendant at the field path", () => {
  const result = validatePrototypeSpec(
    spec({ type: "column", children: [{ type: "text", text: "Hello", onAppear: [action] }] }),
  );
  expect(result.success).toBe(false);
  if (!result.success) {
    expect(result.error.path).toBe("root.children[0].onAppear");
  }
});
test("onAppear enforces action bounds and the tap action union", () => {
  for (const actions of [[], Array(33).fill(action), [{ type: "unknown" }]]) {
    expect(
      validatePrototypeSpec(spec({ type: "text", text: "Hello", onAppear: actions })).success,
    ).toBe(false);
  }
  expect(
    validatePrototypeSpec(spec({ type: "text", text: "Hello", onAppear: Array(32).fill(action) }))
      .success,
  ).toBe(true);
});
test("repeat binding traverses onAppear timer actions", () => {
  const result = bindNodeFields(
    {
      type: "text",
      onAppear: [
        {
          type: "startTimer",
          id: "tick",
          afterMs: 100,
          actions: [{ type: "emit", name: "{item.title}" }],
        },
      ],
    },
    "root",
    { binding: { alias: "item", index: true }, values: { title: "Hello" }, index: 0 },
  );
  expect(JSON.stringify(result)).toContain("Hello");
});
