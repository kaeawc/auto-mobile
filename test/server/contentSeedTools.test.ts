import { describe, expect, test } from "bun:test";
import { isolateToolRegistry } from "../helpers/withTemporaryTool";
import { createSeedContentHandler, seedContentSchema } from "../../src/server/contentSeedTools";
import { seedContentResultSchema } from "../../src/server/contentSeedToolOutputSchemas";
import { ToolRegistryClass } from "../../src/server/toolRegistry";
import { registerContentSeedTools } from "../../src/server/contentSeedTools";

isolateToolRegistry();

describe("seedContent tool", () => {
  test("strict schema requires namespace, rejects photos and supports standard device targeting", () => {
    expect(seedContentSchema.safeParse({}).success).toBe(false);
    expect(
      seedContentSchema.safeParse({
        namespace: "demo",
        contacts: [{ name: "A", photoPath: "a.png" }],
      }).success,
    ).toBe(false);
    expect(
      seedContentSchema.safeParse({
        namespace: "demo",
        deviceId: "fake",
        platform: "android",
        reset: true,
      }).success,
    ).toBe(true);
  });
  test("iOS fails actionably before creating adb dependencies", async () => {
    const handler = createSeedContentHandler(() => {
      throw new Error("Must not create adb");
    });
    await expect(
      handler({ name: "fake", deviceId: "fake", platform: "ios" }, { namespace: "demo" }),
    ).rejects.toThrow("Select an Android device");
  });
  test("returns structured counts with the advertised output shape", async () => {
    const handler = createSeedContentHandler(() => ({
      adb: {
        execute: async () => {
          throw new Error("Empty input needs no adb");
        },
      },
    }));
    const response = await handler(
      { name: "fake", deviceId: "fake", platform: "android" },
      { namespace: "demo" },
    );
    const parsed = seedContentResultSchema.parse(
      (response as { structuredContent: unknown }).structuredContent,
    );
    expect(parsed.namespace).toBe("demo");
    expect(parsed.inserted.contacts).toBe(0);
  });
  test("registration entry point exists without constructing a device", () => {
    const registry = new ToolRegistryClass();
    registerContentSeedTools(registry);
    const [tool] = registry.getEveryRegisteredTool();
    expect(tool?.name).toBe("seedContent");
    expect(tool?.outputSchema).toBe(seedContentResultSchema);
    expect(tool?.planRelevant).toBe(true);
    expect(tool?.defaultEnabled).toBe(false);
  });
});
