import { expect, test } from "bun:test";
import spec from "../../fixtures/prototype-spec/valid/links-routes.json";
import { validatePrototypeSpec } from "../../../src/features/prototype/prototypeValidation";
import { prototypeRequiredCapabilities } from "../../../src/features/prototype/prototypeCapabilityGates";
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
