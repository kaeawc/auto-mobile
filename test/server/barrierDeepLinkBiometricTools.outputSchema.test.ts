import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { registerBarrierTools } from "../../src/server/barrierTools";
import { barrierResultSchema } from "../../src/server/barrierToolOutputSchemas";
import { registerBiometricTools } from "../../src/server/biometricTools";
import { biometricAuthResultSchema } from "../../src/server/biometricToolOutputSchemas";
import { createGetDeepLinksHandler, registerDeepLinkTools } from "../../src/server/deepLinkTools";
import { getDeepLinksResultSchema } from "../../src/server/deepLinkToolOutputSchemas";
import { ToolRegistry } from "../../src/server/toolRegistry";
import type { BootedDevice, DeepLinkResult } from "../../src/models";
import { isolateToolRegistry } from "../helpers/withTemporaryTool";

isolateToolRegistry();

const device: BootedDevice = { deviceId: "fake-device", name: "Fake", platform: "android" };

const findTool = (name: string) =>
  ToolRegistry.getAllTools({ includeUnavailable: true }).find((tool) => tool.name === name);

function textOf(response: { content: Array<{ type: string; text?: string }> }): string {
  const block = response.content[0];
  if (block.type !== "text" || block.text === undefined) {
    throw new Error("Expected text result");
  }
  return block.text;
}

describe("barrier, getDeepLinks and biometricAuth output schemas (#11830)", () => {
  beforeEach(() => {
    ToolRegistry.clearTools();
    registerBarrierTools();
    registerDeepLinkTools();
    registerBiometricTools();
  });
  afterEach(() => ToolRegistry.clearTools());

  test.each([
    ["barrier", barrierResultSchema],
    ["getDeepLinks", getDeepLinksResultSchema],
    ["biometricAuth", biometricAuthResultSchema],
  ] as const)("%s declares its outputSchema", (name, schema) => {
    expect(findTool(name)?.outputSchema).toBe(schema);
  });

  test("barrier keeps the text payload and validates structuredContent", async () => {
    const response = (await findTool("barrier")!.deviceAwareHandler!(device, {
      lock: "gate",
      deviceCount: 1,
    })) as { content: Array<{ type: string; text?: string }>; structuredContent: unknown };
    expect(JSON.parse(textOf(response))).toEqual(
      JSON.parse(JSON.stringify(response.structuredContent)),
    );
    expect(barrierResultSchema.safeParse(response.structuredContent).success).toBe(true);
  });

  test.each([true, false])(
    "getDeepLinks (success=%s) keeps the text payload and validates structuredContent",
    async (success) => {
      const result: DeepLinkResult = {
        success,
        appId: "com.example.app",
        deepLinks: {
          schemes: ["example"],
          hosts: ["example.com"],
          intentFilters: [
            {
              action: "android.intent.action.VIEW",
              category: ["DEFAULT"],
              data: [{ scheme: "x" }],
            },
          ],
          supportedMimeTypes: [],
        },
        ...(success ? {} : { error: "boom" }),
      };
      const response = await createGetDeepLinksHandler(() => ({ execute: async () => result }))(
        device,
        { appId: result.appId },
      );
      expect(JSON.parse(textOf(response))).toEqual(
        JSON.parse(JSON.stringify(response.structuredContent)),
      );
      expect(getDeepLinksResultSchema.safeParse(response.structuredContent).success).toBe(true);
    },
  );

  test("biometricAuth schema accepts a success payload with an observation", () => {
    expect(
      biometricAuthResultSchema.safeParse({
        success: true,
        message: "Biometric match executed",
        action: "match",
        modality: "fingerprint",
        fingerprintId: 1,
        supported: "partial",
        observation: { updatedAt: 1 },
      }).success,
    ).toBe(true);
    expect(biometricAuthResultSchema.safeParse({ success: false }).success).toBe(false);
  });
});
