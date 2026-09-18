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

  test("carries ownership of an earlier direct acquisition into resource reads", async () => {
    fixture = new McpTestFixture();
    await fixture.setup();

    ToolRegistry.clearTools();
    for (const [toolName, sessionUuid] of [
      ["getAndroid", "direct-session-android"],
      ["getApple", "direct-session-ios"],
    ] as const) {
      ToolRegistry.register(toolName, toolName, z.object({}), async () =>
        createJSONToolResponse({ sessionUuid, sessionId: sessionUuid }),
      );
    }
    ResourceRegistry.registerTemplateWithReadContext(
      "automobile:test-session-ownership/{sessionUuid}",
      "Session ownership test",
      "Reports the current binding and whether it owns the requested session.",
      "application/json",
      async (params, context) => ({
        uri: `automobile:test-session-ownership/${params.sessionUuid}`,
        text: JSON.stringify({
          sessionUuid: context.sessionUuid,
          ownsRequestedSession: context.ownsSession?.(params.sessionUuid) ?? false,
        }),
      }),
    );

    const { client } = fixture.getContext();
    for (const toolName of ["getAndroid", "getApple"]) {
      await client.request(
        { method: "tools/call", params: { name: toolName, arguments: {} } },
        z.any(),
      );
    }
    const response = await client.request(
      {
        method: "resources/read",
        params: { uri: "automobile:test-session-ownership/direct-session-android" },
      },
      z.object({
        contents: z.array(z.object({ text: z.string().optional() })),
      }),
    );

    expect(JSON.parse(response.contents[0].text!)).toEqual({
      sessionUuid: "direct-session-ios",
      ownsRequestedSession: true,
    });
  });
});
