import { expect, test } from "bun:test";
import platformSpec from "../../fixtures/prototype-spec/valid/links-platform.json";
import { prototypeSpecJsonSchema } from "../../../src/features/prototype/prototypeSpecJsonSchema";
import { prototypeRequiresSchema } from "../../../src/features/prototype/prototypePlatformSchema";
import {
  requiredPrototypeCapabilities,
  prototypeRequiredCapabilities,
} from "../../../src/features/prototype/prototypeCapabilityGates";
import spec from "../../fixtures/prototype-spec/valid/links-routes.json";
import { validatePrototypeSpec } from "../../../src/features/prototype/prototypeValidation";
import strictLinks from "../../fixtures/prototype-spec/invalid/strict-gate-prototype_links_v1.json";

test("hosts without inbound delivery refuse the links spec before showing it", () => {
  const requiredCapabilities = (spec: unknown) =>
    prototypeRequiredCapabilities(spec).map((gate) => gate.capability);
  expect(
    validatePrototypeSpec(strictLinks.spec, { ...strictLinks.options, requiredCapabilities }),
  ).toMatchObject({
    success: false,
    error: { path: strictLinks.expectedPath, message: strictLinks.expectedMessage },
  });
  expect(
    validatePrototypeSpec(strictLinks.spec, {
      supportedCapabilities: ["prototype_links_v1"],
      requiredCapabilities,
    }),
  ).toMatchObject({ success: true });
});

test("inbound links validate and require links, independently of platform services", () => {
  expect(validatePrototypeSpec(spec)).toMatchObject({ success: true });
  const required = prototypeRequiredCapabilities(spec).map((gate) => gate.capability);
  expect(required).toContain("prototype_links_v1");
  expect(required).not.toContain("prototype_platform_v1");
});

test("query bindings use declared scalar types and secret metadata", () => {
  const copy = {
    ...spec,
    links: [
      { ...spec.links[0]!, path: "/post", query: { postId: { type: "string", secret: true } } },
    ],
  };
  expect(validatePrototypeSpec(copy)).toMatchObject({ success: true });
});

test("bindings outside inbound entry actions are rejected", () => {
  const copy = {
    ...spec,
    root: {
      ...spec.root,
      screens: {
        ...spec.root.screens,
        feed: { ...spec.root.screens.feed, onTap: spec.links[0]!.actions },
      },
    },
  };
  expect(validatePrototypeSpec(copy)).toMatchObject({
    success: false,
    error: { message: "Unknown link binding" },
  });
});

test("links and platform calls share requires without losing either capability", () => {
  expect(validatePrototypeSpec(platformSpec)).toMatchObject({ success: true });
  expect(requiredPrototypeCapabilities(platformSpec)).toEqual([
    "prototype_data_model_v1",
    "prototype_links_v1",
    "prototype_platform_location_v1",
    "prototype_platform_v1",
  ]);
  expect(
    validatePrototypeSpec(platformSpec, {
      supportedCapabilities: [
        "prototype_data_model_v1",
        "prototype_platform_location_v1",
        "prototype_platform_v1",
      ],
      requiredCapabilities: requiredPrototypeCapabilities,
    }),
  ).toMatchObject({
    success: false,
    error: { path: "$", message: "Unsupported capabilities: prototype_links_v1" },
  });
  expect(
    validatePrototypeSpec(platformSpec, {
      supportedCapabilities: requiredPrototypeCapabilities(platformSpec),
      requiredCapabilities: requiredPrototypeCapabilities,
    }),
  ).toMatchObject({ success: true });
});

test.each([
  { requires: {} },
  { requires: { platform: ["location"] } },
  { requires: { capabilities: ["prototype_stack_v1"] } },
])("links refuse requires without the explicit links capability: %j", ({ requires }) => {
  expect(validatePrototypeSpec({ ...spec, requires })).toMatchObject({
    success: false,
    error: { path: "requires", message: "links requires prototype_links_v1" },
  });
});

test.each([
  { requires: ["prototype_links_v1"] },
  { requires: { capabilities: ["prototype_links_v1"] } },
])("either requires form enables links and participates in strict gates: %j", ({ requires }) => {
  const value = { ...strictLinks.spec, requires };
  expect(validatePrototypeSpec(value)).toMatchObject({ success: true });
  expect(validatePrototypeSpec(value, { supportedCapabilities: [] })).toMatchObject({
    success: false,
    error: { path: "$", message: "Unsupported capabilities: prototype_links_v1" },
  });
});

test("object capability bounds and item rules match the array form", () => {
  for (const capabilities of [[], [""], [1], Array(129).fill("prototype_links_v1")]) {
    expect(prototypeRequiresSchema.safeParse(capabilities).success).toBe(false);
    expect(prototypeRequiresSchema.safeParse({ capabilities }).success).toBe(false);
  }
  for (const capabilities of [
    ["prototype_future_v1"],
    [" "],
    Array(128).fill("prototype_links_v1"),
  ]) {
    expect(prototypeRequiresSchema.safeParse(capabilities).success).toBe(true);
    expect(prototypeRequiresSchema.safeParse({ capabilities }).success).toBe(true);
    expect(requiredPrototypeCapabilities({ requires: capabilities })).toEqual(
      requiredPrototypeCapabilities({ requires: { capabilities } }),
    );
  }
});

test("the advertised JSON schema includes object-form capabilities", () => {
  const properties = prototypeSpecJsonSchema().properties as Record<
    string,
    { anyOf: { properties?: Record<string, unknown> }[] }
  >;
  const objectForm = properties.requires!.anyOf.find((form) => form.properties);
  expect(objectForm?.properties?.capabilities).toEqual({
    type: "array",
    minItems: 1,
    maxItems: 128,
    items: { type: "string", minLength: 1 },
  });
});

test("links refuse an omitted requires declaration", () => {
  const withoutRequires = Object.fromEntries(
    Object.entries(spec).filter(([key]) => key !== "requires"),
  );
  expect(validatePrototypeSpec(withoutRequires)).toMatchObject({
    success: false,
    error: { path: "requires", message: "links requires prototype_links_v1" },
  });
});
