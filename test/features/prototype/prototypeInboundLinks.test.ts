import { expect, test } from "bun:test";
import spec from "../../fixtures/prototype-spec/valid/links-routes.json";
import { validatePrototypeSpec } from "../../../src/features/prototype/prototypeValidation";
import { prototypeRequiredCapabilities } from "../../../src/features/prototype/prototypeCapabilityGates";

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
