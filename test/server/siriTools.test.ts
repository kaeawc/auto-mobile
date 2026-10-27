import { describe, expect, test } from "bun:test";
import type { ActivateSiriResult } from "../../src/features/action/ActivateSiri";
import type { BootedDevice } from "../../src/models";
import { createSiriHandler, type SiriArgs } from "../../src/server/siriTools";
import { siriResultSchema } from "../../src/server/siriToolOutputSchemas";

const SIMULATOR: BootedDevice = { name: "iPhone", platform: "ios", deviceId: "SIM-1" };

interface ToolResult {
  structuredContent: Record<string, unknown>;
  isError?: true;
}

async function call(result: ActivateSiriResult): Promise<{ out: ToolResult; phrases: string[] }> {
  const phrases: string[] = [];
  const handler = createSiriHandler({
    siriFactory: () => ({
      execute: async (phrase: string) => {
        phrases.push(phrase);
        return result;
      },
    }),
  });
  const args: SiriArgs = { phrase: "Show my orders" };
  const out = (await handler(SIMULATOR, args)) as ToolResult;
  expect(() => siriResultSchema.parse(out.structuredContent)).not.toThrow();
  return { out, phrases };
}

describe("siri tool (#14109)", () => {
  test("an activation reports status activated", async () => {
    const { out, phrases } = await call({ success: true, phrase: "Show my orders" });
    expect(phrases).toEqual(["Show my orders"]);
    expect(out.isError).toBeUndefined();
    expect(out.structuredContent).toMatchObject({
      success: true,
      status: "activated",
      deviceId: "SIM-1",
      platform: "ios",
      phrase: "Show my orders",
    });
  });

  test("an unsupported target is a typed result, not an error", async () => {
    const { out } = await call({
      success: false,
      unsupported: true,
      phrase: "Show my orders",
      error: "siri is iOS only",
    });
    expect(out.isError).toBeUndefined();
    expect(out.structuredContent).toMatchObject({ success: false, status: "unsupported" });
  });

  test("a failure is an error result", async () => {
    const { out } = await call({ success: false, phrase: "Show my orders", error: "boom" });
    expect(out.isError).toBe(true);
    expect(out.structuredContent).toMatchObject({
      success: false,
      status: "failed",
      error: "boom",
      message: "boom",
    });
  });
});
