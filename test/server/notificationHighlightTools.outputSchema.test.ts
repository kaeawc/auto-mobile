import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { BootedDevice } from "../../src/models";
import { NotificationPolicy } from "../../src/features/utility/NotificationPolicy";
import { registerHighlightTools } from "../../src/server/highlightTools";
import { highlightResultSchema } from "../../src/server/highlightToolOutputSchemas";
import {
  getNotificationPolicyResultSchema,
  postNotificationResultSchema,
  setNotificationPolicyResultSchema,
} from "../../src/server/notificationToolOutputSchemas";
import { registerNotificationTools } from "../../src/server/notificationTools";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { isolateToolRegistry } from "../helpers/withTemporaryTool";

isolateToolRegistry();

const device: BootedDevice = { deviceId: "fake-device", name: "Fake", platform: "android" };

type Envelope = { content: Array<{ type: string; text?: string }>; structuredContent: unknown };

function expectTextEqualsStructured(response: Envelope): void {
  expect(JSON.parse(response.content[0].text!)).toEqual(
    JSON.parse(JSON.stringify(response.structuredContent)),
  );
}

describe("notification and highlight output schemas (#11830)", () => {
  beforeEach(() => {
    ToolRegistry.clearTools();
  });

  test("each tool declares its outputSchema", () => {
    registerNotificationTools();
    registerHighlightTools();
    expect(ToolRegistry.getTool("postNotification")?.outputSchema).toBe(
      postNotificationResultSchema,
    );
    expect(ToolRegistry.getTool("getNotificationPolicy")?.outputSchema).toBe(
      getNotificationPolicyResultSchema,
    );
    expect(ToolRegistry.getTool("setNotificationPolicy")?.outputSchema).toBe(
      setNotificationPolicyResultSchema,
    );
    expect(ToolRegistry.getTool("highlight")?.outputSchema).toBe(highlightResultSchema);
  });

  test.each([true, false])(
    "postNotification success=%s validates structuredContent",
    async (ok) => {
      registerNotificationTools({
        postNotificationFactory: () => ({
          execute: async () =>
            ok
              ? { success: true, supported: true, method: "sdk" as const, channelId: "c" }
              : { success: false, supported: false, error: "nope" },
        }),
      });
      const response = (await ToolRegistry.getTool("postNotification")!.deviceAwareHandler!(
        device,
        {
          title: "T",
          body: "B",
        },
      )) as Envelope;
      expectTextEqualsStructured(response);
      expect(postNotificationResultSchema.safeParse(response.structuredContent).success).toBe(true);
      expect(postNotificationResultSchema.safeParse({ success: true }).success).toBe(false);
    },
  );

  describe.each(["getNotificationPolicy", "setNotificationPolicy"] as const)("%s", (name) => {
    let policy: ReturnType<
      typeof spyOn<typeof NotificationPolicy.prototype, "getPolicy" | "setPolicy">
    >;
    afterEach(() => policy.mockRestore());

    test.each([true, false])("success=%s validates structuredContent", async (ok) => {
      const result = {
        success: ok,
        appId: "com.example.app",
        deviceId: "fake-device",
        platform: "android" as const,
        policyAccess: {
          supported: true,
          allowed: true,
          method: "android_dumpsys_notification" as const,
        },
        ...(ok ? {} : { error: "Policy lookup failed" }),
      };
      const method = name === "getNotificationPolicy" ? "getPolicy" : "setPolicy";
      policy = spyOn(NotificationPolicy.prototype, method).mockResolvedValue(result);
      registerNotificationTools();
      const tool = ToolRegistry.getTool(name)!;
      const response = (await tool.deviceAwareHandler!(device, {
        appId: result.appId,
        policyAccess: true,
      })) as Envelope;
      expectTextEqualsStructured(response);
      expect(tool.outputSchema!.safeParse(response.structuredContent).success).toBe(true);
      expect(tool.outputSchema!.safeParse({ success: true }).success).toBe(false);
    });
  });

  test.each([true, false])("highlight success=%s validates structuredContent", async (ok) => {
    registerHighlightTools({
      highlightClientFactory: () =>
        ({
          addHighlight: async () => (ok ? { success: true } : { success: false, error: "denied" }),
        }) as never,
      generateHighlightId: () => "h1",
    });
    const response = (await ToolRegistry.getTool("highlight")!.deviceAwareHandler!(device, {
      shape: { type: "circle", bounds: { x: 1, y: 2, width: 3, height: 4 } },
    })) as Envelope;
    expectTextEqualsStructured(response);
    expect(highlightResultSchema.safeParse(response.structuredContent).success).toBe(true);
    expect(highlightResultSchema.safeParse({}).success).toBe(false);
  });
});
