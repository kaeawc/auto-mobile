import { expect, test } from "bun:test";
import contract from "../../../schemas/prototype-spec-contract.json";
import { prototypeSpecSchema } from "../../../src/features/prototype/prototypeSpec";
import { validatePrototypeSpec } from "../../../src/features/prototype/prototypeValidation";
import {
  prototypeGateCapabilities,
  PROTOTYPE_SPEC_CAPABILITY_GATES,
} from "../../../src/features/prototype/prototypeCapabilityGates";
import { renderPrototypeGuide } from "../../../src/features/prototype/prototypeGuide";

const node = (sharedKey = "hero", extra: Record<string, unknown> = {}) => ({
  type: "text",
  text: "Hero",
  sharedKey,
  visibleWhen: { key: "open", equals: true },
  ...extra,
});
const spec = (children: unknown[], extra = {}) => ({
  id: "shared",
  window: { placement: { type: "fullscreen" } },
  state: { open: true },
  root: { type: "column", children },
  ...extra,
});
function error(children: unknown[], path: string, message: string) {
  expect(validatePrototypeSpec(spec(children))).toMatchObject({
    success: false,
    error: { path, message },
  });
}
test("shared pairs accept all node variants carrying visibleWhen", () => {
  expect(validatePrototypeSpec(spec([node(), node()])).success).toBe(true);
  expect(prototypeSpecSchema.safeParse(spec([node(), node()])).success).toBe(true);
  for (const variant of Object.values(contract.definitions.node.variants)) {
    if ("visibleWhen" in variant.fields) {
      expect(variant.fields).toHaveProperty("sharedKey");
    }
  }
});
test("shared keys require visibleWhen on the same node before checking pair counts", () => {
  const missing = { type: "text", text: "Hero", sharedKey: "hero" };
  error([missing], "root.children[0].sharedKey", "sharedKey requires visibleWhen on the same node");
});
test("lone keys and first extra occurrences have exact pair-count errors", () => {
  error(
    [node()],
    "root.children[0].sharedKey",
    'sharedKey "hero" must be used by exactly two nodes',
  );
  error(
    [node(), node(), node()],
    "root.children[2].sharedKey",
    'sharedKey "hero" must be used by exactly two nodes',
  );
});
test("16 distinct pairs pass and the first 17th key fails before lone-pair checks", () => {
  const pairs = Array.from({ length: 16 }, (_, i) => [node(`key${i}`), node(`key${i}`)]).flat();
  expect(validatePrototypeSpec(spec(pairs)).success).toBe(true);
  error(
    [...pairs, node("extra")],
    "root.children[32].sharedKey",
    "a spec allows at most 16 sharedKey values",
  );
});
test("repeat carriers and all nested template descendants reject shared keys", () => {
  const repeat = { items: [{ id: "one" }], as: "item" };
  error(
    [
      {
        type: "column",
        sharedKey: "hero",
        visibleWhen: { key: "open", equals: true },
        repeat,
        children: [],
      },
    ],
    "root.children[0].sharedKey",
    "sharedKey is not allowed inside repeat templates",
  );
  error(
    [{ type: "column", repeat, children: [{ type: "box", children: [node()] }] }],
    "root.children[0].children[0].children[0].sharedKey",
    "sharedKey is not allowed inside repeat templates",
  );
});
test("nested pairs fail at the descendant; path prefixes cannot confuse siblings", () => {
  error(
    [
      {
        type: "box",
        sharedKey: "hero",
        visibleWhen: { key: "open", equals: true },
        children: [node()],
      },
    ],
    "root.children[0].children[0].sharedKey",
    "sharedKey nodes cannot be nested in each other",
  );
  expect(
    validatePrototypeSpec(
      spec(
        Array.from({ length: 11 }, (_, i) => (i === 1 || i === 10 ? node() : { type: "spacer" })),
      ),
    ).success,
  ).toBe(true);
});
test("shared keys use the existing 64-character literal key grammar", () => {
  expect(validatePrototypeSpec(spec([node("k".repeat(64)), node("k".repeat(64))])).success).toBe(
    true,
  );
  for (const key of ["", "a".repeat(65), "a-b", "{item.id}"]) {
    expect(prototypeSpecSchema.safeParse(spec([node(key), node(key)])).success).toBe(false);
    expect(validatePrototypeSpec(spec([node(key), node(key)])).success).toBe(false);
  }
});
test("reduced motion is accepted and only reduced needs its capability", () => {
  for (const motion of ["none", "standard", "reduced"] as const) {
    const value = spec([], { motion });
    expect(validatePrototypeSpec(value).success).toBe(true);
    expect(prototypeSpecSchema.safeParse(value).success).toBe(true);
    expect(prototypeGateCapabilities(value)).toEqual(
      motion === "reduced" ? ["prototype_reduced_motion_v1"] : [],
    );
  }
});
test("both strict gates reject missing capabilities and accept advertised ones", () => {
  for (const [capability, value] of [
    ["prototype_reduced_motion_v1", spec([], { motion: "reduced" })],
    ["prototype_shared_element_v1", spec([node(), node()])],
  ] as const) {
    expect(
      validatePrototypeSpec(value, {
        supportedCapabilities: [],
        requiredCapabilities: prototypeGateCapabilities,
      }),
    ).toMatchObject({
      success: false,
      error: { path: "$", message: `Unsupported capabilities: ${capability}` },
    });
    expect(
      validatePrototypeSpec(value, {
        supportedCapabilities: [capability],
        requiredCapabilities: prototypeGateCapabilities,
      }).success,
    ).toBe(true);
    const gate = PROTOTYPE_SPEC_CAPABILITY_GATES.find((entry) => entry.capability === capability)!;
    for (const platform of ["ios", "android"] as const) {
      const message = gate.unsupportedMessage(gate.fields(value), platform);
      expect(message).toContain(capability);
      expect(message).toContain(platform === "ios" ? "launchApp prototype: true" : "CtrlProxy");
    }
  }
});
test("guide explains reduced profiles, system settings and shared pairs", () => {
  const guide = renderPrototypeGuide();
  for (const text of [
    'motion: "reduced"',
    "prototype_reduced_motion_v1",
    "prototype_shared_element_v1",
    "sharedKey",
    "Reduce Motion",
    "transition scale",
    "16",
  ]) {
    expect(guide).toContain(text);
  }
});

test("shared fixture errors pin native paths, messages and ordering", async () => {
  const corpus = await Bun.file(
    new URL("../../fixtures/prototype-spec/corpus.json", import.meta.url),
  ).json();
  const names: string[] = corpus.invalid.filter(
    (name: string) =>
      name.startsWith("shared-key-") ||
      name === "strict-gate-prototype_shared_element_v1.json" ||
      name === "strict-gate-prototype_reduced_motion_v1.json",
  );
  expect(names.length).toBeGreaterThanOrEqual(9);
  for (const name of names) {
    const value = await Bun.file(
      new URL(`../../fixtures/prototype-spec/invalid/${name}`, import.meta.url),
    ).json();
    expect(
      validatePrototypeSpec(value.spec, {
        ...value.options,
        requiredCapabilities: prototypeGateCapabilities,
      }),
    ).toMatchObject({
      success: false,
      error: { path: value.expectedPath, message: value.expectedMessage },
    });
  }
});
