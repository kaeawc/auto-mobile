import { installHermeticServerFixture } from "../helpers/hermeticServerFixture";
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { McpTestFixture } from "../fixtures/mcpTestFixture";
import { logger } from "../../src/utils/logger";

const SECRET = "hunter2-secret";

describe("MCP request log", () => {
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

  test("logs sendKeys typed text as a placeholder, before the target field is known", async () => {
    const info = spyOn(logger, "info");
    try {
      // The unknown key makes the strict schema reject the call before any device work; the
      // request line is written before validation.
      await fixture.client
        .callTool({
          name: "sendKeys",
          arguments: {
            commands: [{ action: "type", text: SECRET }],
            notARealArgument: true,
          },
        })
        .catch(() => undefined);
      const requestLines = info.mock.calls.filter(([message]) => message === "Request: ");
      expect(requestLines).toHaveLength(1);
      const logged = JSON.stringify(requestLines[0][1]);
      expect(logged).not.toContain(SECRET);
      expect(logged).toContain('"text":"<text, 14 characters>"');
      expect(logged).toContain('"name":"sendKeys"');
    } finally {
      info.mockRestore();
    }
  });
});
