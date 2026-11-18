import contract from "../../../schemas/prototype-spec-contract.json";
import * as remoteImages from "../../../src/features/prototype/prototypeRemoteImages";
import { expect, test } from "bun:test";
import cases from "../../fixtures/prototype-spec/remote-images.json";
import { validatePrototypeSpec } from "../../../src/features/prototype/prototypeValidation";
import {
  prototypeRequiredCapabilities,
  requiredPrototypeCapabilities,
} from "../../../src/features/prototype/prototypeCapabilityGates";
import { collectPrototypeAssetReferences } from "../../../src/features/prototype/prototypeAssetReferences";

for (const fixture of cases) {
  test(`remote image contract: ${fixture.name}`, () => {
    expect(validatePrototypeSpec(fixture.spec).success).toBe(fixture.valid);
  });
}
test("remote fields require the capability and fallback assets are referenced", () => {
  const spec = cases.find((fixture) => fixture.name === "static")!.spec;
  expect(prototypeRequiredCapabilities(spec).map((gate) => gate.capability)).toContain(
    "prototype_remote_image_v1",
  );
  expect([...collectPrototypeAssetReferences(spec).images]).toEqual(["loading"]);
});

test("URL images have a separate budget, while fallback assets use the asset budget", () => {
  const root = {
    type: "column",
    children: Array.from({ length: 33 }, () => ({ type: "image", url: "https://example.com/a" })),
  };
  const spec = { id: "budget", window: { placement: { type: "fullscreen" } }, root };
  expect(validatePrototypeSpec(spec).success).toBe(true);
  expect(
    validatePrototypeSpec({
      ...spec,
      root: {
        ...root,
        children: root.children.map((node) => ({ ...node, placeholder: { asset: "loading" } })),
      },
    }).success,
  ).toBe(false);
});

test("each remote-only field is refused without capability support", () => {
  for (const field of [
    { url: "https://example.com/a" },
    { placeholder: { asset: "p" } },
    { error: { color: "#123456" } },
    { crossfade: false },
    { via: "device" },
  ]) {
    const node =
      "url" in field ? { type: "image", ...field } : { type: "image", asset: "a", ...field };
    const spec = { id: "gate", window: { placement: { type: "fullscreen" } }, root: node };
    expect(
      validatePrototypeSpec(spec, {
        supportedCapabilities: [],
        requiredCapabilities: requiredPrototypeCapabilities,
      }).success,
    ).toBe(false);
  }
});

test("remote image constants equal the canonical cross-platform limits", () => {
  for (const [name, value] of Object.entries(remoteImages)) {
    if (name in contract.limits) {
      expect(value).toBe(Reflect.get(contract.limits, name));
    }
  }
});
