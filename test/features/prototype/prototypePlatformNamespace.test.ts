import { hasPrototypeAnchors } from "../../../src/features/prototype/prototypeAnchors";
import { expect, test } from "bun:test";
import { validatePrototypeSpec } from "../../../src/features/prototype/prototypeValidation";

const spec = {
  id: "namespaces",
  window: { placement: { type: "fullscreen" }, ios: { sheet: { sizing: "form" } } },
  theme: { android: { indication: "none" } },
  root: {
    type: "button",
    label: "Save",
    ios: { buttonStyle: "glass" },
    android: { indication: "ripple" },
  },
};

test("platform namespaces validate on nodes, window and theme", () => {
  expect(validatePrototypeSpec(spec).success).toBe(true);
});

import { beforeAll } from "bun:test";
import contract from "../../../schemas/prototype-spec-contract.json";
import {
  prototypeSpecSchema,
  type PrototypeSpec,
} from "../../../src/features/prototype/prototypeSpec";
import {
  prototypePlatformNamespaceFields,
  PROTOTYPE_PLATFORM_NAMESPACE_CAPABILITY,
} from "../../../src/features/prototype/prototypePlatformNamespace";
import { prototypePlatformNotes } from "../../../src/features/prototype/prototypePlatformNotes";
import { specCapabilityRefusal } from "../../../src/server/prototypeTools/preflight";
import type { Rule } from "../../../src/features/prototype/prototypeBindingValidation";

beforeAll(() => {
  validatePrototypeSpec(spec);
});

test("strict namespace schemas reject unknown fields and enum values", () => {
  for (const ios of [
    { unknown: true },
    { hover: "float" },
    { tab: { role: "home" } },
    { sheet: { sizing: "wide" } },
  ]) {
    expect(prototypeSpecSchema.safeParse({ ...spec, root: { ...spec.root, ios } }).success).toBe(
      false,
    );
  }
  expect(prototypeSpecSchema.safeParse(spec).success).toBe(true);
});

test("walker preserves node order through repeat templates, screens and components plus window/theme", () => {
  const raw = {
    root: {
      type: "column",
      children: [
        { type: "text", ios: {}, repeat: { items: [{ ios: {} }] } },
        { type: "stack", screens: { home: { type: "scroll", child: { ios: {} } } } },
      ],
    },
    components: { Row: { root: { ios: {} } } },
    window: { ios: {} },
    theme: { ios: {} },
    data: { ios: {} },
  };
  expect(prototypePlatformNamespaceFields(raw, "ios")).toEqual([
    "root.children[0].ios",
    'root.children[1].screens["home"].child.ios',
    "components.Row.root.ios",
    "window.ios",
    "theme.ios",
  ]);
  expect(prototypePlatformNamespaceFields(raw, "android")).toEqual([]);
  expect(prototypePlatformNamespaceFields(null, "ios")).toEqual([]);
});

for (const platform of ["ios", "android"] as const) {
  const foreign = platform === "ios" ? "android" : "ios";
  test(`${platform} notes report foreign namespace paths and cap them`, () => {
    const notes = prototypePlatformNotes(spec as PrototypeSpec, platform, () => true);
    expect(notes).toContainEqual({
      platform,
      construct: "platformNamespace",
      effect: "ignored",
      paths: foreign === "ios" ? ["root.ios", "window.ios"] : ["root.android", "theme.android"],
      detail: `${foreign} namespace blocks are ignored on ${platform}.`,
    });
    const many = {
      ...spec,
      window: { placement: { type: "fullscreen" } },
      theme: undefined,
      root: {
        type: "column",
        children: Array.from({ length: 23 }, () => ({ type: "text", text: "Hi", [foreign]: {} })),
      },
    } as PrototypeSpec;
    const note = prototypePlatformNotes(many, platform, () => true).find(
      (n) => n.construct === "platformNamespace",
    )!;
    expect(note.paths).toHaveLength(20);
    expect(note.total).toBe(23);
  });
  const target = (supported: boolean) =>
    platform === "ios"
      ? {
          ios: {
            supportsCapability: (capability: string) =>
              capability !== PROTOTYPE_PLATFORM_NAMESPACE_CAPABILITY || supported,
          },
        }
      : {
          android: {
            supportsCommand: async (capability: string) =>
              capability !== PROTOTYPE_PLATFORM_NAMESPACE_CAPABILITY || supported,
          },
        };
  test(`${platform} refuses own namespace until advertised, including replacement results`, async () => {
    for (const own of [
      { root: { type: "text", [platform]: {} } },
      { window: { [platform]: {} } },
      { theme: { [platform]: {} } },
    ]) {
      const refusal = await specCapabilityRefusal(target(false), own, undefined);
      expect(refusal?.success).toBe(false);
      expect(refusal?.error).toContain(prototypePlatformNamespaceFields(own, platform)[0]!);
      expect(await specCapabilityRefusal(target(true), own, undefined)).toBeUndefined();
    }
  });
  test(`${platform} foreign blocks never gate`, async () => {
    expect(
      await specCapabilityRefusal(
        target(false),
        { root: { [foreign]: {} }, window: { [foreign]: {} }, theme: { [foreign]: {} } },
        undefined,
      ),
    ).toBeUndefined();
  });
}

test("every namespace leaf has exactly one why and capability entry", () => {
  function leaves(rule: Rule, prefix = ""): string[] {
    if (rule.kind !== "object") {
      return [prefix];
    }
    return Object.entries(rule.fields ?? {}).flatMap(([key, field]) =>
      leaves(field!.rule, prefix ? `${prefix}.${key}` : key),
    );
  }
  for (const platform of ["ios", "android"] as const) {
    const metadata = contract.platformNamespaces[platform];
    expect(Object.keys(metadata).sort()).toEqual(
      leaves(contract.definitions[`${platform}Namespace`] as Rule).sort(),
    );
    for (const [key, entry] of Object.entries(metadata)) {
      expect(entry.why.length).toBeGreaterThan(0);
      expect(entry.requires).toBe(
        platform === "ios" &&
          ["glassGroup", "glassUnion", "glassTransition", "backgroundExtension"].includes(key)
          ? "prototype_glass_v1"
          : PROTOTYPE_PLATFORM_NAMESPACE_CAPABILITY,
      );
    }
  }
});

test("bottom accessory is a strictly validated node", () => {
  const valid = {
    ...spec,
    root: {
      type: "text",
      text: "Hello",
      ios: { bottomAccessory: { type: "text", text: "Playing" } },
    },
  };
  expect(validatePrototypeSpec(valid).success).toBe(true);
  expect(
    validatePrototypeSpec({
      ...valid,
      root: {
        ...valid.root,
        ios: { bottomAccessory: { type: "text", text: "Playing", surprise: true } },
      },
    }).success,
  ).toBe(false);
});

test("iOS reports custom chrome paths and OS-specific bordered fallback", () => {
  const parsed = prototypeSpecSchema.parse({
    ...spec,
    root: {
      type: "button",
      label: "Save",
      ios: {
        buttonStyle: "glass",
        hover: "lift",
        tab: { role: "search" },
        navigationTitle: "large",
        sheet: { sizing: "form" },
        bottomAccessory: { type: "text", text: "Playing" },
      },
    },
  });
  const notes = prototypePlatformNotes(parsed, "ios", () => true, 25);
  expect(
    notes.find((note) => note.construct === "platformNamespace" && note.effect === "substituted")
      ?.paths,
  ).toEqual(["root.ios.buttonStyle"]);
  expect(
    notes.find(
      (note) =>
        note.construct === "platformNamespace" &&
        note.effect === "ignored" &&
        note.paths.includes("root.ios.tab.role"),
    )?.paths,
  ).toEqual([
    "root.ios.bottomAccessory",
    "root.ios.tab.role",
    "root.ios.sheet.sizing",
    "root.ios.navigationTitle",
    "window.ios",
  ]);
  expect(
    prototypePlatformNotes(parsed, "ios", () => true, 26).filter(
      (note) => note.construct === "platformNamespace" && note.effect === "substituted",
    ),
  ).toEqual([]);
});

test("Android reports own fields without an applicable interaction and ignores iOS", () => {
  const parsed = prototypeSpecSchema.parse({
    ...spec,
    root: {
      type: "text",
      text: "Hello",
      android: { predictiveBack: { style: "none" }, indication: "none" },
    },
  });
  const notes = prototypePlatformNotes(parsed, "android", () => true);
  expect(notes.find((note) => note.paths.includes("root.android.predictiveBack"))?.paths).toEqual([
    "root.android.predictiveBack",
    "root.android.indication",
    "theme.android",
  ]);
  expect(notes.find((note) => note.paths.includes("window.ios"))?.effect).toBe("ignored");
});

test("accessory subtrees neither gate nor produce nested platform notes", async () => {
  const raw = {
    ...spec,
    theme: undefined,
    window: { placement: { type: "fullscreen" } },
    root: {
      type: "text",
      text: "Shown",
      ios: {
        bottomAccessory: {
          type: "chart",
          android: { indication: "ripple" },
          ios: { hover: "lift" },
        },
      },
    },
  };
  expect(prototypePlatformNamespaceFields(raw, "android")).toEqual([]);
  expect(
    await specCapabilityRefusal(
      { android: { supportsCommand: async () => false } },
      raw,
      undefined,
    ),
  ).toBeUndefined();
  const notes = prototypePlatformNotes(raw as PrototypeSpec, "android", () => true);
  expect(
    notes.filter((note) => note.construct === "platformNamespace").map((note) => note.paths),
  ).toEqual([["root.ios"]]);
});

for (const site of ["window", "theme"] as const) {
  test(`bottomAccessory is forbidden in ${site}.ios in both schemas`, () => {
    const raw = {
      ...spec,
      [site]: { ...spec[site], ios: { bottomAccessory: { type: "text", text: "Hidden" } } },
    };
    expect(prototypeSpecSchema.safeParse(raw).success).toBe(false);
    expect(validatePrototypeSpec(raw)).toMatchObject({
      success: false,
      error: { path: `${site}.ios.bottomAccessory` },
    });
  });
}

test("ignored accessory anchors do not request app target resolution", () => {
  const root = {
    type: "text",
    text: "Shown",
    ios: {
      bottomAccessory: {
        type: "text",
        text: "Hidden",
        anchor: {
          type: "element",
          selector: { text: "Hidden app target" },
          alignment: "cover",
        },
      },
    },
  };
  expect(hasPrototypeAnchors({ root })).toBe(false);
  expect(validatePrototypeSpec({ ...spec, root }).success).toBe(true);
});
