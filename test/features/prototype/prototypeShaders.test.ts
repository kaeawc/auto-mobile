import { expect, test } from "bun:test";
import fixtures from "../../fixtures/prototype-spec/shader-assets.json";
import shaderSpec from "../../fixtures/prototype-spec/valid/custom-shader.json";
import {
  validatePrototypeShaderSource,
  PROTOTYPE_SHADER_MIME_TYPE,
} from "../../../src/features/prototype/prototypeShaderSource";
import {
  prototypeAssetUploadProblem,
  MAX_PROTOTYPE_SHADER_ASSET_BYTES,
  maxPrototypeAssetBytes,
} from "../../../src/features/prototype/prototypeAssets";
import {
  cachedPrototypeShaderAssetProblem,
  prototypeShaderAssetProblem,
  prototypeShaderFields,
  prototypeShaderOptInProblem,
  prototypeShadersEnabled,
} from "../../../src/features/prototype/prototypeShaders";
import { boundedPrototypeError } from "../../../src/features/prototype/prototypeErrors";
import { validatePrototypeSpec } from "../../../src/features/prototype/prototypeValidation";
import { prototypeSpecSchema } from "../../../src/features/prototype/prototypeSpec";
import { requiredPrototypeCapabilities } from "../../../src/features/prototype/prototypeCapabilityGates";
import { uploadPrototypeAssets } from "../../../src/features/prototype/prototypeAssetUploader";
import { FakePrototypeAssetCache } from "../../fakes/FakePrototypeAssetCache";

const shader: import("../../../src/features/prototype/prototypeAssets").PrototypeAssetUpload = {
  id: "effect",
  mimeType: PROTOTYPE_SHADER_MIME_TYPE,
  bytes: Buffer.from(fixtures.cases[0].source),
};
const enabled = { AUTOMOBILE_PROTOTYPE_CUSTOM_SHADERS: "1" };

test.each(fixtures.cases)("AGSL lexer: $name", ({ source, valid }) => {
  expect(validatePrototypeShaderSource(Buffer.from(source)).success).toBe(valid);
});

test("AGSL assets reject invalid UTF-8 and honor the mirrored byte limit", () => {
  expect(validatePrototypeShaderSource(new Uint8Array([0xc3, 0x28]))).toMatchObject({
    success: false,
    error: "AGSL source must be valid UTF-8 text.",
  });
  expect(MAX_PROTOTYPE_SHADER_ASSET_BYTES).toBe(16384);
  expect(maxPrototypeAssetBytes(PROTOTYPE_SHADER_MIME_TYPE)).toBe(16384);
  expect(prototypeAssetUploadProblem(shader)).toBeNull();
  expect(prototypeAssetUploadProblem({ ...shader, bytes: Buffer.alloc(16385, 32) })).toContain(
    "16384",
  );
});

test("only the exact opt-in value enables custom shaders", () => {
  for (const value of [undefined, "", "0", "true", " 1", "1 ", "01"]) {
    const env = { AUTOMOBILE_PROTOTYPE_CUSTOM_SHADERS: value };
    expect(prototypeShadersEnabled(env)).toBe(false);
    expect(prototypeShaderOptInProblem(shaderSpec, env)).toContain(
      "AUTOMOBILE_PROTOTYPE_CUSTOM_SHADERS=1",
    );
  }
  expect(prototypeShadersEnabled(enabled)).toBe(true);
  expect(prototypeShaderOptInProblem(shaderSpec, enabled)).toBeUndefined();
  expect(prototypeShaderOptInProblem({ root: { type: "spacer" } }, {})).toBeUndefined();
});

test("shader shape and capability checks agree with the shared contract", () => {
  expect(prototypeSpecSchema.safeParse(shaderSpec).success).toBe(true);
  expect(validatePrototypeSpec(shaderSpec).success).toBe(true);
  expect(requiredPrototypeCapabilities(shaderSpec)).toEqual(["prototype_custom_shaders_v1"]);
  expect(
    validatePrototypeSpec(shaderSpec, {
      supportedCapabilities: [],
      requiredCapabilities: requiredPrototypeCapabilities,
    }).success,
  ).toBe(false);
  for (const uniforms of [
    { strength: Infinity },
    { strength: NaN },
    { "bad-name": 1 },
    { strength: -1000001 },
    Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`u${i}`, 1])),
  ]) {
    const spec = {
      ...shaderSpec,
      root: { ...shaderSpec.root, style: { shader: { asset: "effect", uniforms } } },
    };
    expect(prototypeSpecSchema.safeParse(spec).success).toBe(false);
    expect(validatePrototypeSpec(spec).success).toBe(false);
  }
});

test("uniforms must name float declarations and reference the AGSL MIME", () => {
  expect(prototypeShaderAssetProblem(shaderSpec, [shader])).toBeUndefined();
  expect(prototypeShaderAssetProblem(shaderSpec, [{ ...shader, mimeType: "image/png" }])).toContain(
    "application/vnd.automobile.agsl",
  );
  expect(
    prototypeShaderAssetProblem(shaderSpec, [
      { ...shader, bytes: Buffer.from("uniform float other;") },
    ]),
  ).toContain("not declared");
  const content = {
    ...shaderSpec,
    root: { ...shaderSpec.root, style: { shader: { asset: "effect", uniforms: { content: 1 } } } },
  };
  expect(prototypeShaderAssetProblem(content, [shader])).toContain("not declared");
  expect(prototypeShaderAssetProblem(shaderSpec, [])).toBeUndefined();
});

test("cached checks use an injected cache and same-call uploads override old bytes", async () => {
  const cache = new FakePrototypeAssetCache();
  await cache.put("serial", { ...shader, mimeType: "image/png" });
  expect(await cachedPrototypeShaderAssetProblem(shaderSpec, "serial", cache)).toContain(
    "application/vnd.automobile.agsl",
  );
  expect(
    await cachedPrototypeShaderAssetProblem(shaderSpec, "serial", cache, [shader]),
  ).toBeUndefined();
});

test("shader gates traverse conditional, hidden and component nodes but ignore opaque data", () => {
  const root = {
    ...shaderSpec.root,
    visibleWhen: { key: "hidden", equals: true },
    styleWhen: [{ when: { key: "hidden", equals: true }, style: shaderSpec.root.style }],
  };
  expect(prototypeShaderFields({ root, components: { effect: { root } }, data: { root } })).toEqual(
    [
      "root.style.shader",
      "root.styleWhen[0].style.shader",
      "components.effect.root.style.shader",
      "components.effect.root.styleWhen[0].style.shader",
    ],
  );
});

test("error cap measures UTF-8 bytes and preserves whole characters", () => {
  for (const message of ["a".repeat(3000), "☃".repeat(1000), "😀".repeat(1000)]) {
    const bounded = boundedPrototypeError(message);
    expect(Buffer.byteLength(bounded)).toBeLessThanOrEqual(2048);
    expect(message.startsWith(bounded)).toBe(true);
    expect(bounded).not.toContain("�");
  }
});

test("uploader refuses before dispatch unless enabled, and caps device compile errors", async () => {
  const calls: string[] = [];
  const client = {
    requestPutPrototypeAsset: async () => {
      calls.push("put");
      return { success: false, error: "😀".repeat(2000), dispatched: true, acknowledged: true };
    },
  };
  const refused = await uploadPrototypeAssets(client, [shader], { action: "show", env: {} });
  expect(refused.error).toContain("AUTOMOBILE_PROTOTYPE_CUSTOM_SHADERS=1");
  expect(calls).toEqual([]);
  const result = await uploadPrototypeAssets(client, [shader], { action: "show", env: enabled });
  expect(calls).toEqual(["put"]);
  expect(Buffer.byteLength(result.error!)).toBeLessThanOrEqual(2048);
});

test.each(fixtures.bindings)(
  "shader asset binding fixture: $name",
  ({ mimeType, source, valid }) => {
    const asset = {
      id: "effect",
      mimeType:
        mimeType as import("../../../src/features/prototype/prototypeAssets").PrototypeAssetMimeType,
      bytes: Buffer.from(source),
    };
    expect(prototypeShaderAssetProblem(shaderSpec, [asset]) === undefined).toBe(valid);
  },
);

test("file preparation recognizes .agsl, validates before dispatch and bounds its read", async () => {
  let reads = 0;
  const reader = {
    stat: async () => ({ isFile: () => true, size: shader.bytes.length }),
    readFile: async () => {
      reads++;
      return Buffer.from(shader.bytes);
    },
  };
  const { preparePrototypeAssets } =
    await import("../../../src/features/prototype/prototypeAssetUploader");
  const sources = [{ id: "effect", path: "/assets/effect.agsl" }];
  const refused = await preparePrototypeAssets(sources, reader, undefined, {});
  expect(refused).toMatchObject({
    error: expect.stringContaining("AUTOMOBILE_PROTOTYPE_CUSTOM_SHADERS=1"),
  });
  expect(reads).toBe(0);
  const accepted = await preparePrototypeAssets(sources, reader, undefined, enabled);
  expect(accepted).toMatchObject({
    assets: [{ id: "effect", mimeType: PROTOTYPE_SHADER_MIME_TYPE }],
  });
  const oversized = { ...reader, stat: async () => ({ isFile: () => true, size: 16385 }) };
  expect(await preparePrototypeAssets(sources, oversized, undefined, enabled)).toMatchObject({
    error: expect.stringContaining("16384"),
  });
  expect(reads).toBe(1);
});
