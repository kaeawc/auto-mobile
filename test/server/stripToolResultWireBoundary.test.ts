import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { z } from "zod";
import { McpTestFixture } from "../fixtures/mcpTestFixture";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { serverConfig } from "../../src/utils/ServerConfig";
import { createStructuredToolResponse } from "../../src/utils/toolUtils";

/**
 * End-to-end proof that the `--tool-results-no-structured-content` strip runs at
 * the real MCP CallTool boundary (`src/server/index.ts`). Uses a plain
 * `ToolRegistry.register()` probe — the same non-device registration path as
 * `exportPlan`/`recordSteps` — so this also covers the tools that bypass
 * `finalizeToolResponse`. The probe declares an `outputSchema` (like
 * `exportPlan`/`recordSteps`) so its `structuredContent` survives the gate-off
 * case; the no-schema unconditional strip (#2759) is covered separately in
 * `structuredContentGating.test.ts`.
 */
describe("CallTool wire boundary strips structuredContent (issue #2899)", () => {
  let fixture: McpTestFixture;
  const TOOL = "__strip_probe_2899__";

  beforeAll(async () => {
    ToolRegistry.register(
      TOOL,
      "probe tool for structuredContent strip",
      z.object({}).passthrough(),
      async () => createStructuredToolResponse({ success: true, marker: "probe" }),
      false,
      false,
      z.object({ success: z.boolean(), marker: z.string() })
    );
    fixture = new McpTestFixture();
    await fixture.setup();
  });

  afterAll(async () => {
    if (fixture) {
      await fixture.teardown();
    }
    (ToolRegistry as unknown as { tools: Map<string, unknown> }).tools.delete(TOOL);
    serverConfig.setToolResultsNoStructuredContentEnabled(false);
  });

  afterEach(() => {
    serverConfig.setToolResultsNoStructuredContentEnabled(false);
  });

  test("gate off: structuredContent is present on the wire", async () => {
    serverConfig.setToolResultsNoStructuredContentEnabled(false);
    const { client } = fixture.getContext();
    const res: any = await client.callTool({ name: TOOL, arguments: {} });
    expect(res.structuredContent).toBeDefined();
    // This test asserts the RAW wire envelope, so it must read `structuredContent`
    // directly rather than via getStructuredField() — that helper is the #2907
    // production dead-read guard, but here inspecting the pre-strip wire shape is
    // the whole point of the test.
    // eslint-disable-next-line no-restricted-syntax -- intentional raw-wire assertion
    expect(res.structuredContent.marker).toBe("probe");
  });

  test("gate on: structuredContent stripped, content text retains the full payload", async () => {
    serverConfig.setToolResultsNoStructuredContentEnabled(true);
    const { client } = fixture.getContext();
    const res: any = await client.callTool({ name: TOOL, arguments: {} });
    expect(res.structuredContent).toBeUndefined();
    // No data lost: the full payload is still recoverable from content[0].text.
    expect(JSON.parse(res.content[0].text).marker).toBe("probe");
  });
});
