import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { z } from "zod/v4";
import { ActionableError } from "../../src/models";
import {
  clearDirectSessionDevices,
  registerDirectSessionDevice,
} from "../../src/server/directSessionDeviceRegistry";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { McpTestFixture } from "../fixtures/mcpTestFixture";

describe("session tool binding after failed calls", () => {
  let fixture: McpTestFixture | undefined;

  beforeEach(() => {
    ToolRegistry.clearTools();
    clearDirectSessionDevices();
    registerDirectSessionDevice("session-a", {
      deviceId: "emulator-5554",
      name: "Pixel_9_API_36",
      platform: "android",
    });
  });

  afterEach(async () => {
    if (fixture) {
      await fixture.teardown();
      fixture = undefined;
    }
    ToolRegistry.clearTools();
    clearDirectSessionDevices();
  });

  test("keeps the prior binding when an explicit session UUID call is rejected", async () => {
    const schema = z.object({ sessionUuid: z.string().optional() });
    ToolRegistry.register("bindingProbe", "bindingProbe", schema, async () => ({ success: true }));
    ToolRegistry.register("rejectSession", "rejectSession", schema, async () => {
      throw new ActionableError("session rejected");
    });

    fixture = new McpTestFixture({
      sessionContext: { sessionId: "transport-a" },
      sessionToolSelectionService: {
        isEnabled: async (sessionUuid, toolName, declaredDefault) =>
          toolName === "bindingProbe" && sessionUuid === "session-b" ? false : declaredDefault,
      },
    });
    await fixture.setup();

    await fixture.client.callTool({
      name: "bindingProbe",
      arguments: { sessionUuid: "session-a" },
    });
    await expect(
      fixture.client.callTool({
        name: "rejectSession",
        arguments: { sessionUuid: "session-b" },
      }),
    ).rejects.toThrow("session rejected");
    await expect(fixture.client.listTools()).resolves.toMatchObject({
      tools: expect.arrayContaining([expect.objectContaining({ name: "bindingProbe" })]),
    });
  });

  test("keeps the prior binding when an explicit session UUID call returns an error result", async () => {
    const schema = z.object({ sessionUuid: z.string().optional() });
    ToolRegistry.register("bindingProbe", "bindingProbe", schema, async () => ({ success: true }));
    ToolRegistry.register("rejectSession", "rejectSession", schema, async () => ({
      content: [{ type: "text" as const, text: "session rejected" }],
      isError: true,
    }));

    fixture = new McpTestFixture({
      sessionContext: { sessionId: "transport-a" },
      sessionToolSelectionService: {
        isEnabled: async (sessionUuid, toolName, declaredDefault) =>
          toolName === "bindingProbe" && sessionUuid === "session-b" ? false : declaredDefault,
      },
    });
    await fixture.setup();

    await fixture.client.callTool({
      name: "bindingProbe",
      arguments: { sessionUuid: "session-a" },
    });
    const rejected = await fixture.client.callTool({
      name: "rejectSession",
      arguments: { sessionUuid: "session-b" },
    });

    expect(rejected.isError).toBe(true);
    await expect(fixture.client.listTools()).resolves.toMatchObject({
      tools: expect.arrayContaining([expect.objectContaining({ name: "bindingProbe" })]),
    });
  });

  test("does not bind an unadmitted UUID that an unscoped tool ignores", async () => {
    const schema = z.object({ sessionUuid: z.string().optional() });
    ToolRegistry.register("bindingProbe", "bindingProbe", schema, async () => ({ success: true }));
    ToolRegistry.register("unscopedSuccess", "unscopedSuccess", z.object({}), async () => ({
      success: true,
    }));

    fixture = new McpTestFixture({
      sessionContext: { sessionId: "transport-a" },
      sessionToolSelectionService: {
        isEnabled: async (sessionUuid, toolName, declaredDefault) =>
          toolName === "bindingProbe" && sessionUuid === "session-b" ? false : declaredDefault,
      },
    });
    await fixture.setup();

    await fixture.client.callTool({
      name: "bindingProbe",
      arguments: { sessionUuid: "session-a" },
    });
    await fixture.client.callTool({
      name: "unscopedSuccess",
      arguments: { sessionUuid: "session-b" },
    });

    await expect(fixture.client.listTools()).resolves.toMatchObject({
      tools: expect.arrayContaining([expect.objectContaining({ name: "bindingProbe" })]),
    });
  });
});
