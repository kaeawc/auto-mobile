import { expect, test } from "bun:test";
import { IosPrototypeTransport } from "../../../../src/features/prototype/ios/iosPrototypeTransport";
import { FakePrototypeAgentClient } from "../../../fakes/FakePrototypeAgentClient";
import { PROTOTYPE_SHADER_MIME_TYPE } from "../../../../src/features/prototype/prototypeShaderSource";
import { prototypeSpecSchema } from "../../../../src/features/prototype/prototypeSpec";
import shaderSpec from "../../../fixtures/prototype-spec/valid/custom-shader.json";

test("iOS refuses shader specs and assets before agent dispatch even if a peer claims support", async () => {
  const agent = new FakePrototypeAgentClient({
    agentVersion: "test",
    protocolVersion: 1,
    capabilities: ["prototype_custom_shaders_v1", "show_prototype", "put_prototype_asset"],
  });
  const transport = new IosPrototypeTransport(agent);
  await expect(transport.show(prototypeSpecSchema.parse(shaderSpec))).rejects.toThrow(
    "Android-only",
  );
  await expect(
    transport.putAsset({
      id: "effect",
      mimeType: PROTOTYPE_SHADER_MIME_TYPE,
      bytes: Buffer.from("uniform float x;"),
    }),
  ).rejects.toThrow("Android-only");
  expect(
    await transport.patch({
      id: shaderSpec.id,
      ops: [
        { op: "replaceNode", id: "node", node: { ...prototypeSpecSchema.parse(shaderSpec).root } },
      ],
    }),
  ).toMatchObject({
    success: false,
    delivery: "unsent",
    error: expect.stringContaining("Android-only"),
  });
  expect(agent.requests).toEqual([]);
});
