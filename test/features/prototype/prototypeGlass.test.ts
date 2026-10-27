import { expect, test } from "bun:test";
import {
  prototypeGlassFields,
  prototypeScrollEdgeEffectFields,
} from "../../../src/features/prototype/prototypeGlass";
import { validatePrototypeSpec } from "../../../src/features/prototype/prototypeValidation";
import { prototypePlatformNotes } from "../../../src/features/prototype/prototypePlatformNotes";
import { prototypeGateCapabilities } from "../../../src/features/prototype/prototypeCapabilityGates";
import { specCapabilityRefusal } from "../../../src/server/prototypeTools/preflight";

const spec = (root: unknown) => ({
  id: "glass",
  window: { placement: { type: "fullscreen" } },
  root,
});

test("conditional and component glass fields are gated, opaque data stays opaque", () => {
  const input = {
    root: {
      type: "text",
      text: "Hi",
      styleWhen: [{ when: { key: "x", equals: true }, style: { surface: "glass", glass: {} } }],
    },
    components: {
      Panel: { root: { type: "scroll", edgeEffect: "soft", child: { type: "spacer" } } },
    },
    data: { style: { surface: "glass" }, edgeEffect: "hard" },
  };
  expect(prototypeGlassFields(input)).toEqual([
    "root.styleWhen[0].style.surface",
    "root.styleWhen[0].style.glass",
  ]);
  expect(prototypeScrollEdgeEffectFields(input)).toEqual(["components.Panel.root.edgeEffect"]);
  expect(prototypeGlassFields({ root: { type: "spacer" }, data: input.data })).toEqual([]);
});

test("foreign namespace glass is ignored with each field path, and never requires Android glass", () => {
  const input = spec({
    type: "box",
    ios: { glassGroup: { spacing: 20 } },
    children: [
      {
        type: "text",
        text: "Hi",
        style: { surface: "glass" },
        ios: { glassUnion: "u", glassTransition: "identity" },
      },
    ],
  });
  const parsed = validatePrototypeSpec(input);
  expect(parsed.success).toBe(true);
  if (!parsed.success) {
    throw new Error(parsed.error.message);
  }
  expect(prototypePlatformNotes(parsed.data, "android", () => false)[0]).toMatchObject({
    effect: "ignored",
    paths: [
      "root.ios.glassGroup",
      "root.children[0].ios.glassUnion",
      "root.children[0].ios.glassTransition",
    ],
  });
  expect(
    prototypeGlassFields(
      spec({ type: "box", ios: { glassGroup: { spacing: 20 } }, children: [] }),
      "android",
    ),
  ).toEqual([]);
});

test("older iOS reports its advertised edge-effect approximation", () => {
  const parsed = validatePrototypeSpec(
    spec({ type: "scroll", edgeEffect: "hard", child: { type: "spacer" } }),
  );
  if (!parsed.success) {
    throw new Error(parsed.error.message);
  }
  expect(prototypePlatformNotes(parsed.data, "ios", () => true, 25)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        construct: "scroll.edgeEffect",
        effect: "substituted",
        paths: ["root.edgeEffect"],
      }),
    ]),
  );
  expect(
    prototypePlatformNotes(parsed.data, "ios", () => true, 26).some(
      (n) => n.construct === "scroll.edgeEffect",
    ),
  ).toBe(false);
});

test("library specs refuse glass until it is explicitly listed", () => {
  const input = spec({ type: "box", children: [], style: { surface: "glass" } });
  expect(
    validatePrototypeSpec(input, {
      library: true,
      supportedCapabilities: [],
      requiredCapabilities: prototypeGateCapabilities,
    }),
  ).toEqual({
    success: false,
    error: { path: "$", message: "Unsupported capabilities: prototype_glass_v1" },
  });
  expect(
    validatePrototypeSpec(input, {
      library: true,
      supportedCapabilities: ["prototype_glass_v1"],
      requiredCapabilities: prototypeGateCapabilities,
    }).success,
  ).toBe(true);
});

test("glass namespace keys have an independent gate and mixed blocks require both", () => {
  const node = { type: "box", ios: { glassGroup: { spacing: 8 } }, children: [] };
  expect(prototypeGateCapabilities(spec(node))).toEqual(["prototype_glass_v1"]);
  expect(prototypeGateCapabilities(spec({ ...node, ios: { ...node.ios, hover: "lift" } }))).toEqual(
    ["prototype_glass_v1", "prototype_platform_namespace_v1"],
  );
});

test("iOS 26 refuses unimplemented hover and glass refusal names its OS requirement once", async () => {
  const capabilities = new Set(["prototype_glass_v1", "prototype_scroll_edge_effect_v1"]);
  const target = {
    ios: { supportsCapability: (capability: string) => capabilities.has(capability) },
  };
  const refusal = await specCapabilityRefusal(
    target,
    spec({ type: "text", text: "Hi", ios: { hover: "lift" } }),
    undefined,
  );
  expect(refusal?.error).toContain("prototype_platform_namespace_v1");
  const glassRefusal = await specCapabilityRefusal(
    { ios: { supportsCapability: () => false } },
    spec({ type: "box", children: [], style: { surface: "glass" } }),
    undefined,
  );
  expect(glassRefusal?.error?.match(/needs iOS 26 or later/g)).toHaveLength(1);
});

test("iOS namespace notes preserve implemented glass alongside native hover", () => {
  const parsed = validatePrototypeSpec(
    spec({
      type: "box",
      ios: { glassGroup: { spacing: 12 }, hover: "lift" },
      children: [
        {
          type: "text",
          text: "Hi",
          style: { surface: "glass" },
          ios: { glassUnion: "group", glassTransition: "identity" },
        },
      ],
    }),
  );
  expect(parsed.success).toBe(true);
  if (!parsed.success) {
    throw new Error(parsed.error.message);
  }
  expect(
    prototypePlatformNotes(parsed.data, "ios", () => true, 26).filter(
      (note) => note.construct === "platformNamespace",
    ),
  ).toEqual([]);
  expect(parsed.data.root.ios?.glassGroup).toEqual({ spacing: 12 });
});
