import { NotificationPolicy } from "../../src/features/utility/NotificationPolicy";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  postNotificationSchema,
  registerNotificationTools,
} from "../../src/server/notificationTools";
import { ToolRegistry } from "../../src/server/toolRegistry";

describe("notification tools", () => {
  beforeEach(() => {
    ToolRegistry.clearTools();
    registerNotificationTools();
  });

  afterEach(() => {
    ToolRegistry.clearTools();
  });

  test("registers notification policy schemas", () => {
    const getTool = ToolRegistry.getTool("getNotificationPolicy");
    const setTool = ToolRegistry.getTool("setNotificationPolicy");

    expect(getTool).toBeDefined();
    expect(getTool?.requiresDevice).toBe(true);
    expect(() =>
      getTool!.schema.parse({
        appId: "com.example.app",
      }),
    ).not.toThrow();
    expect(() => getTool!.schema.parse({})).toThrow();

    expect(setTool).toBeDefined();
    expect(setTool?.requiresDevice).toBe(true);
    expect(() =>
      setTool!.schema.parse({
        appId: "com.example.app",
        policyAccess: true,
      }),
    ).not.toThrow();
    expect(() =>
      setTool!.schema.parse({
        appId: "com.example.app",
      }),
    ).toThrow();
  });

  test("requires appId when posting notifications on iOS", () => {
    const result = postNotificationSchema.safeParse({
      platform: "ios",
      title: "T",
      body: "B",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].path).toEqual(["appId"]);
      expect(result.error.issues[0].message).toBe("appId is required when platform is ios");
    }
  });

  test("keeps appId optional when posting notifications on Android", () => {
    const result = postNotificationSchema.safeParse({
      platform: "android",
      title: "T",
      body: "B",
    });

    expect(result.success).toBe(true);
  });

  test("accepts Android packageName alias when posting notifications", () => {
    const result = postNotificationSchema.safeParse({
      platform: "android",
      title: "T",
      body: "B",
      packageName: "dev.jasonpearson.automobile.playground",
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.appId).toBe("dev.jasonpearson.automobile.playground");
      expect("packageName" in result.data).toBe(false);
    }
  });

  test("rejects invalid Android appId when posting notifications", () => {
    const result = postNotificationSchema.safeParse({
      platform: "android",
      title: "T",
      body: "B",
      appId: "dev.jasonpearson.automobile.playground; echo injected",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toBe("appId must be an Android package name");
    }
  });

  test("keeps generated tool definition free of top-level combinators", () => {
    const toolDefinition = ToolRegistry.getToolDefinitions().find(
      (tool) => tool.name === "postNotification",
    );

    expect(toolDefinition).toBeDefined();
    const schema = toolDefinition!.inputSchema as any;
    // #6154: platform is optional wherever deviceId/session resolves it.
    expect(schema.required).toEqual(["title", "body"]);
    // #6154: platform now comes from the shared `platformSchema` (android, ios)
    // instead of a per-branch literal union, so the enum order flipped.
    expect(schema.properties.platform.enum).toEqual(["android", "ios"]);
    expect(schema.properties.appId.description).toContain(
      "Android defaults to the live foreground app",
    );
    expect(schema.anyOf).toBeUndefined();
    expect(schema.oneOf).toBeUndefined();
    expect(schema.allOf).toBeUndefined();
  });

  test("generated tool definition leaves iOS appId validation to runtime", () => {
    const toolDefinition = ToolRegistry.getToolDefinitions().find(
      (tool) => tool.name === "postNotification",
    );

    expect(toolDefinition).toBeDefined();
    const schema = toolDefinition!.inputSchema as any;
    // #6154: platform is optional wherever deviceId/session resolves it.
    expect(schema.required).toEqual(["title", "body"]);
    expect(schema.if).toBeUndefined();
    expect(schema.then).toBeUndefined();
    expect(schema.required).not.toContain("appId");
  });
});

for (const name of ["getNotificationPolicy", "setNotificationPolicy"] as const) {
  test.each([false, true])(
    name + " success=%s preserves payload and gates isError",
    async (success) => {
      registerNotificationTools();
      const result = {
        success,
        appId: "com.example.app",
        deviceId: "fake",
        platform: "android" as const,
        policyAccess: {
          supported: true,
          allowed: true,
          method: "android_dumpsys_notification" as const,
        },
        ...(success ? {} : { error: "Policy lookup failed" }),
      };
      const method = name === "getNotificationPolicy" ? "getPolicy" : "setPolicy";
      const policy = spyOn(NotificationPolicy.prototype, method).mockResolvedValue(result);
      try {
        const response = await ToolRegistry.getTool(name)!.deviceAwareHandler!(
          { name: "Fake", deviceId: "fake", platform: "android" },
          { appId: result.appId, policyAccess: true },
        );
        const message = success
          ? name === "getNotificationPolicy"
            ? `Read notification policy for ${result.appId}`
            : `Allowed notification policy access for ${result.appId}`
          : result.error;
        expect(response).toEqual({
          content: [{ type: "text", text: JSON.stringify({ message, ...result }) }],
          ...(success ? {} : { isError: true }),
        });
      } finally {
        policy.mockRestore();
        ToolRegistry.clearTools();
      }
    },
  );
}

test.each([
  [true, "Requested notification policy access be allowed"],
  [false, "Requested notification policy access be revoked"],
])(
  "setNotificationPolicy policyAccess=%s does not claim success when the state is unverified",
  async (policyAccess, expectedPrefix) => {
    registerNotificationTools();
    const result = {
      success: true,
      appId: "com.example.app",
      deviceId: "fake",
      platform: "android" as const,
      policyAccess: {
        supported: true,
        allowed: null,
        method: "android_dumpsys_notification" as const,
        warning: "Command succeeded but the resulting policy access was not verified: unknown",
      },
    };
    const policy = spyOn(NotificationPolicy.prototype, "setPolicy").mockResolvedValue(result);
    try {
      const response = await ToolRegistry.getTool("setNotificationPolicy")!.deviceAwareHandler!(
        { name: "Fake", deviceId: "fake", platform: "android" },
        { appId: result.appId, policyAccess },
      );
      const payload = JSON.parse(response.content[0].text);
      expect(payload.message).toStartWith(expectedPrefix);
      expect(payload.message).toContain("not verified");
      expect(payload.message).not.toStartWith("Allowed");
      expect(payload.message).not.toStartWith("Revoked");
      expect(response.isError).toBeUndefined();
    } finally {
      policy.mockRestore();
      ToolRegistry.clearTools();
    }
  },
);
