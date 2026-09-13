import { afterEach, describe, expect, test } from "bun:test";
import { z } from "zod/v4";
import { McpTestFixture } from "../fixtures/mcpTestFixture";
import { ResourceRegistry } from "../../src/server/resourceRegistry";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { createJSONToolResponse } from "../../src/utils/toolUtils";

describe("session-scoped resource binding", () => {
  let fixture: McpTestFixture | undefined;

  afterEach(async () => {
    await fixture?.teardown();
    fixture = undefined;
    ToolRegistry.clearTools();
    ResourceRegistry.clearResources();
  });

  test.each([
    { toolName: "getAndroid", isError: false },
    { toolName: "getApple", isError: false },
    { toolName: "startDevice", isError: false },
    { toolName: "provisionDevice", isError: false },
    { toolName: "provisionDevice", isError: true },
  ])(
    "binds direct acquisition results for later resource reads: %j",
    async ({ toolName, isError }) => {
      fixture = new McpTestFixture();
      await fixture.setup();

      ToolRegistry.clearTools();
      ToolRegistry.register(toolName, toolName, z.object({}), async () => ({
        ...createJSONToolResponse({
          sessionUuid: "direct-session-1",
          sessionId: "direct-session-1",
        }),
        isError,
      }));
      ResourceRegistry.registerTemplateWithReadContext(
        "automobile:test-session-binding/{sessionUuid}",
        "Session binding test",
        "Returns the bound session for transport binding coverage.",
        "application/json",
        async (_params, context) => ({
          uri: "automobile:test-session-binding/direct-session-1",
          text: JSON.stringify({ sessionUuid: context.sessionUuid }),
        }),
      );

      const { client } = fixture.getContext();
      await client.request(
        {
          method: "tools/call",
          params: { name: toolName, arguments: {} },
        },
        z.any(),
      );
      const response = await client.request(
        {
          method: "resources/read",
          params: { uri: "automobile:test-session-binding/direct-session-1" },
        },
        z.object({
          contents: z.array(z.object({ text: z.string().optional() })),
        }),
      );

      expect(JSON.parse(response.contents[0].text!)).toEqual({
        sessionUuid: "direct-session-1",
      });
    },
  );
});
