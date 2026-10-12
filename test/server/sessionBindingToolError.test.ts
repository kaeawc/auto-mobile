import { afterAll, beforeAll, expect, test } from "bun:test";
import { McpTestFixture } from "../fixtures/mcpTestFixture";
import { installHermeticServerFixture } from "../helpers/hermeticServerFixture";

let fixture: McpTestFixture;
let restore: () => void;
beforeAll(async () => {
  restore = installHermeticServerFixture();
  fixture = new McpTestFixture({ sessionContext: { initialSessionToolBinding: "session-a" } });
  await fixture.setup();
});
afterAll(async () => {
  await fixture.teardown();
  restore();
});

test("cross-session refusal reaches the client as a tool error before executing", async () => {
  const response = await fixture.client.callTool({
    name: "tapOn",
    arguments: { sessionUuid: "session-b", text: "x" },
  });
  expect(response.isError).toBe(true);
  expect(response.content).toEqual([
    { type: "text", text: expect.stringMatching(/session-a.*session-b.*separate MCP connection/) },
  ]);
  const content = response.content as { text: string }[];
  expect(JSON.parse(content[0].text)).toEqual({
    success: false,
    error: expect.stringMatching(/session-a.*session-b.*separate MCP connection/),
    code: "device_outside_bound_session",
    boundSessionUuid: "session-a",
    requestedSessionUuid: "session-b",
    retryable: false,
  });
});
