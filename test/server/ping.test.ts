import { installHermeticServerFixture } from "../helpers/hermeticServerFixture";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { McpTestFixture } from "../fixtures/mcpTestFixture";
import { z } from "zod/v4";

describe("MCP Ping", () => {
  let fixture: McpTestFixture;
  let restoreHermeticServer: () => void;

  beforeAll(async () => {
    restoreHermeticServer = installHermeticServerFixture();
    fixture = new McpTestFixture();
    await fixture.setup();
  });

  afterAll(async () => {
    if (fixture) {
      await fixture.teardown();
    }
    restoreHermeticServer();
  });

  // D5 (issue #4181, rank 15): three tautologies removed. Their bodies were
  // `expect(typeof server).toBe("object")` with comments claiming this "proved"
  // ping registration — it proved nothing. The real wire ping below is the
  // actual behavioral test and is kept.

  test("should respond to ping using createMcpServer directly", async function () {
    const { client } = fixture.getContext();

    // Send ping request using the client
    const result = await client.request(
      {
        method: "ping",
        params: {},
      },
      z.object({}),
    );

    // Verify ping response
    expect(typeof result).toBe("object");
    expect(result).toEqual({});
  });
});

test("direct initialize advertises resource subscribe and listChanged", async () => {
  const restore = installHermeticServerFixture();
  const fixture = new McpTestFixture();
  try {
    await fixture.setup();
    expect(fixture.client.getServerCapabilities()?.resources).toEqual({
      subscribe: true,
      listChanged: true,
    });
    expect(await fixture.client.subscribeResource({ uri: "automobile:devices/booted" })).toEqual(
      {},
    );
    expect(await fixture.client.unsubscribeResource({ uri: "automobile:devices/booted" })).toEqual(
      {},
    );
  } finally {
    await fixture.teardown();
    restore();
  }
});
