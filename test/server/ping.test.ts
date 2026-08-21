import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { McpTestFixture } from "../fixtures/mcpTestFixture";
import { z } from "zod/v4";

describe("MCP Ping", () => {
  let fixture: McpTestFixture;

  beforeAll(async () => {
    fixture = new McpTestFixture();
    await fixture.setup();
  });

  afterAll(async () => {
    if (fixture) {
      await fixture.teardown();
    }
  });

  // D5 (issue #4181, rank 15): three tautologies removed. Their bodies were
  // `expect(typeof server).toBe("object")` with comments claiming this "proved"
  // ping registration — it proved nothing. The real wire ping below is the
  // actual behavioral test and is kept.

  test("should respond to ping using createMcpServer directly", async function() {
    const { client } = fixture.getContext();

    // Send ping request using the client
    const result = await client.request({
      method: "ping",
      params: {}
    }, z.object({}));

    // Verify ping response
    expect(typeof result).toBe("object");
    expect(result).toEqual({});
  });

});
