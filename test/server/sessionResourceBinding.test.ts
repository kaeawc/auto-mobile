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

  test("binds the session returned by direct getAndroid for later resource reads", async () => {
    fixture = new McpTestFixture();
    await fixture.setup();

    ToolRegistry.clearTools();
    ToolRegistry.register(
      "getAndroid",
      "getAndroid",
      z.object({}),
      async () => createJSONToolResponse({ sessionId: "direct-session-1" }),
    );
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
    await client.request({
      method: "tools/call",
      params: { name: "getAndroid", arguments: {} },
    }, z.any());
    const response = await client.request({
      method: "resources/read",
      params: { uri: "automobile:test-session-binding/direct-session-1" },
    }, z.object({
      contents: z.array(z.object({ text: z.string().optional() })),
    }));

    expect(JSON.parse(response.contents[0].text!)).toEqual({
      sessionUuid: "direct-session-1",
    });
  });
});
