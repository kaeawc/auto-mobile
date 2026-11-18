import contract from "../../../schemas/prototype-spec-contract.json";
import * as remoteImages from "../../../src/features/prototype/prototypeRemoteImages";
import { expect, test } from "bun:test";
import cases from "../../fixtures/prototype-spec/remote-images.json";
import { validatePrototypeSpec } from "../../../src/features/prototype/prototypeValidation";
import {
  prototypeRequiredCapabilities,
  requiredPrototypeCapabilities,
} from "../../../src/features/prototype/prototypeCapabilityGates";
import { prototypePlatformPlaceholders } from "../../../src/features/prototype/prototypeData";
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
  const withFallbacks = (count: number) => ({
    ...spec,
    root: {
      ...root,
      children: Array.from({ length: count }, () => ({
        type: "image",
        url: "https://example.com/a",
        placeholder: { asset: "loading" },
      })),
    },
  });
  expect(validatePrototypeSpec(withFallbacks(contract.limits.MAX_PROTOTYPE_IMAGES)).success).toBe(
    true,
  );
  expect(
    validatePrototypeSpec(withFallbacks(contract.limits.MAX_PROTOTYPE_IMAGES + 1)),
  ).toMatchObject({
    success: false,
    error: { message: "Image limit exceeded" },
  });
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
    const options = {
      supportedCapabilities: [remoteImages.PROTOTYPE_REMOTE_IMAGE_CAPABILITY],
      requiredCapabilities: requiredPrototypeCapabilities,
    };
    expect(validatePrototypeSpec(spec, options).success).toBe(true);
    const refused = validatePrototypeSpec(spec, { ...options, supportedCapabilities: [] });
    expect(refused.success).toBe(false);
    if (!refused.success) {
      expect(refused.error.message).toContain("prototype_remote_image_v1");
    }
  }
});

test("remote image constants equal the canonical cross-platform limits", () => {
  const limits = {
    MAX_PROTOTYPE_REMOTE_IMAGE_URL_LENGTH: remoteImages.MAX_PROTOTYPE_REMOTE_IMAGE_URL_LENGTH,
    MAX_PROTOTYPE_REMOTE_IMAGE_DOWNLOAD_BYTES:
      remoteImages.MAX_PROTOTYPE_REMOTE_IMAGE_DOWNLOAD_BYTES,
    PROTOTYPE_REMOTE_IMAGE_ANDROID_HEAP_DIVISOR:
      remoteImages.PROTOTYPE_REMOTE_IMAGE_ANDROID_HEAP_DIVISOR,
    MAX_PROTOTYPE_REMOTE_IMAGE_IOS_MEMORY_BYTES:
      remoteImages.MAX_PROTOTYPE_REMOTE_IMAGE_IOS_MEMORY_BYTES,
    MAX_PROTOTYPE_REMOTE_IMAGE_DISK_BYTES: remoteImages.MAX_PROTOTYPE_REMOTE_IMAGE_DISK_BYTES,
    MAX_PROTOTYPE_REMOTE_IMAGE_LOADS: remoteImages.MAX_PROTOTYPE_REMOTE_IMAGE_LOADS,
  };
  for (const [name, value] of Object.entries(limits)) {
    expect(value).toBe(Reflect.get(contract.limits, name));
  }
});

test("bottomAccessory remote images follow URL policy and capability checks", () => {
  const spec = (image: unknown) => ({
    id: "accessory",
    state: { cover: "a" },
    window: { placement: { type: "fullscreen" } },
    root: {
      type: "column",
      children: [],
      ios: {
        bottomAccessory: {
          type: "column",
          children: [image],
        },
      },
    },
  });
  const options = {
    supportedCapabilities: [
      remoteImages.PROTOTYPE_REMOTE_IMAGE_CAPABILITY,
      "prototype_platform_namespace_v1",
    ],
    requiredCapabilities: requiredPrototypeCapabilities,
  };
  const valid = spec({ type: "image", url: "https://example.com/a" });
  expect(validatePrototypeSpec(valid, options).success).toBe(true);
  expect(prototypeRequiredCapabilities(valid).map(({ capability }) => capability)).toContain(
    "prototype_remote_image_v1",
  );
  const refused = validatePrototypeSpec(valid, {
    ...options,
    supportedCapabilities: ["prototype_platform_namespace_v1"],
  });
  expect(refused.success).toBe(false);
  if (!refused.success) {
    expect(refused.error.message).toContain("prototype_remote_image_v1");
  }
  for (const url of ["http://example.com/a", "https://:/{cover}", "{cover}/thumb.png"]) {
    expect(validatePrototypeSpec(spec({ type: "image", url }), options)).toMatchObject({
      success: false,
      error: { path: "root.ios.bottomAccessory.children[0].url" },
    });
  }
});

test("invalid fallback sources report their own field", () => {
  for (const field of ["placeholder", "error"]) {
    const spec = {
      id: "fallback",
      window: { placement: { type: "fullscreen" } },
      root: { type: "image", url: "https://example.com/a", [field]: { color: "invalid" } },
    };
    expect(validatePrototypeSpec(spec)).toMatchObject({
      success: false,
      error: { path: `root.${field}.color` },
    });
  }
});

test("fallback fixtures reject the fallback independently of the primary URL", () => {
  for (const [name, field, path, message] of [
    ["fallback-both", "placeholder", "root.placeholder.color", "Unknown property"],
    ["fallback-empty", "error", "root.error.asset", "Required property"],
  ]) {
    const spec = cases.find((fixture) => fixture.name === name)!.spec;
    const result = validatePrototypeSpec(spec);
    expect(result.success).toBe(false);
    expect(result).toMatchObject({ success: false, error: { path, message } });
    expect(
      validatePrototypeSpec({ ...spec, root: { ...spec.root, [field]: { asset: "loading" } } })
        .success,
    ).toBe(true);
  }
});

test("state and platform reads follow consumed binding spans", () => {
  for (const url of [
    "https://example.test/{data:/photos/{cover}",
    "https://example.test/{platform:/device/{cover}",
  ]) {
    expect(
      remoteImages.prototypeRemoteImageError([{ value: { type: "image", url }, path: "root" }], {}),
    ).toBeUndefined();
  }
  expect(prototypePlatformPlaceholders("{data:/photos/{platform:/device/os}")).toEqual([]);
  expect(prototypePlatformPlaceholders("{data:/photos/a}{platform:/device/os}")).toEqual([
    "/device/os",
  ]);
  expect(
    remoteImages.prototypeRemoteImageError(
      [
        {
          value: { type: "image", url: "https://example.test/{data:/photos/a}/{cover}" },
          path: "root",
        },
      ],
      {},
    ),
  ).toMatchObject({ message: "Remote image URL references an undeclared state key" });
});
