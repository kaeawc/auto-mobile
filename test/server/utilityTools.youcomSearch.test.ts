import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { registerUtilityTools } from "../../src/server/utilityTools";
import { ToolRegistry } from "../../src/server/toolRegistry";

describe("youcomSearch tool", () => {
  beforeEach(() => {
    ToolRegistry.clearTools();
    registerUtilityTools();
  });

  afterEach(() => {
    ToolRegistry.clearTools();
    delete process.env.YDC_API_KEY;
  });

  test("registers an optional search tool", () => {
    const tool = ToolRegistry.getTool("youcomSearch");

    expect(tool).toBeDefined();
    expect(tool?.requiresDevice).toBe(false);
    expect(() => tool!.schema.parse({ query: "playwright locators", count: 5 })).not.toThrow();
  });

  test("returns a setup error when YDC_API_KEY is missing", async () => {
    const tool = ToolRegistry.getTool("youcomSearch");
    const response = await tool!.handler({ query: "playwright locators" });
    const payload = JSON.parse(response.content[0].text) as { success: boolean; error: string };

    expect(payload.success).toBe(false);
    expect(payload.error).toContain("YDC_API_KEY");
  });

  test("returns search results from You.com", async () => {
    process.env.YDC_API_KEY = "test-key";
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      expect(String(input)).toContain("ydc-index.io/v1/search");
      return new Response(JSON.stringify({
        results: { web: [{ url: "https://example.com", title: "Example" }] },
        metadata: { query: "playwright locators", search_uuid: "abc" },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    try {
      const tool = ToolRegistry.getTool("youcomSearch");
      const response = await tool!.handler({ query: "playwright locators", count: 3 });
      const payload = JSON.parse(response.content[0].text) as {
        success: boolean;
        query: string;
        results: { web: Array<{ url: string; title: string }> };
      };

      expect(payload.success).toBe(true);
      expect(payload.query).toBe("playwright locators");
      expect(payload.results.web[0].url).toBe("https://example.com");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
