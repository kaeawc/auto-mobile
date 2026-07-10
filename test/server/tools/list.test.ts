import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createMcpServer } from "../../../src/server/index";
import { ToolRegistry } from "../../../src/server/toolRegistry";
import { McpTestFixture } from "../../fixtures/mcpTestFixture";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { FakeToolRegistry } from "../../fakes/FakeToolRegistry";
import { z } from "zod";

const listToolsResponseSchema = z.object({
  tools: z.array(z.object({
    name: z.string(),
    description: z.string(),
    inputSchema: z.object({}).passthrough(),
    outputSchema: z.object({}).passthrough().optional()
  }).passthrough())
});

function unresolvedLocalRefs(schema: unknown): string[] {
  const unresolved = new Set<string>();
  const stack: unknown[] = [schema];

  while (stack.length) {
    const node = stack.pop();
    if (Array.isArray(node)) {
      stack.push(...node);
      continue;
    }
    if (!node || typeof node !== "object") {
      continue;
    }

    const obj = node as Record<string, unknown>;
    if (typeof obj.$ref === "string" && obj.$ref.startsWith("#/") && !jsonPointerExists(schema, obj.$ref)) {
      unresolved.add(obj.$ref);
    }
    stack.push(...Object.values(obj));
  }

  return [...unresolved].sort();
}

function jsonPointerExists(root: unknown, ref: string): boolean {
  let current = root;
  for (const segment of ref.slice(2).split("/").map(unescapeJsonPointerSegment)) {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return false;
    }
    const record = current as Record<string, unknown>;
    if (!Object.prototype.hasOwnProperty.call(record, segment)) {
      return false;
    }
    current = record[segment];
  }
  return true;
}

function unescapeJsonPointerSegment(segment: string): string {
  return segment.replace(/~1/g, "/").replace(/~0/g, "~");
}

describe("MCP Tools List", () => {
  let fixture: McpTestFixture;

  test("given no tools are registered, endpoint should return an empty list", async function() {

    // Create fake registry with no tools registered
    const fakeRegistry = new FakeToolRegistry();

    // Save original method
    const originalGetToolDefinitions = ToolRegistry.getToolDefinitions;

    // Replace with fake that returns no tools
    (ToolRegistry as any).getToolDefinitions = () => fakeRegistry.getTools();

    try {
      // Create server using createMcpServer()
      const server = createMcpServer();

      // Create linked in-memory transports for client-server communication
      const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();

      // Connect server to its transport
      await server.connect(serverTransport);

      // Create client using the linked transport
      const client = new Client({
        name: "test-client",
        version: "0.0.1"
      });

      await client.connect(clientTransport);

      // Send list_tools request
      const result = await client.request({
        method: "tools/list",
        params: {}
      }, listToolsResponseSchema);

      // Verify empty tools list
      expect(typeof result).toBe("object");
      expect(result).toHaveProperty("tools");
      expect(Array.isArray(result.tools)).toBe(true);
      expect(result.tools).toHaveLength(0);

      await client.close();
    } finally {
      // Restore the original method
      (ToolRegistry as any).getToolDefinitions = originalGetToolDefinitions;
    }
  });

  describe("with default registry", () => {
    beforeAll(async () => {
      fixture = new McpTestFixture();
      await fixture.setup();
    });

    afterAll(async () => {
      if (fixture) {
        await fixture.teardown();
      }
    });

    test("given a tool is registered, endpoint should return a list with that tool", async function() {
      const { client } = fixture.getContext();

      // Send list_tools request
      const result = await client.request({
        method: "tools/list",
        params: {}
      }, listToolsResponseSchema);

      // Verify tools list contains registered tools
      expect(typeof result).toBe("object");
      expect(result).toHaveProperty("tools");
      expect(Array.isArray(result.tools)).toBe(true);
      expect(result.tools.length).toBeGreaterThan(0);

      // Verify each tool has required properties
      result.tools.forEach(tool => {
        expect(tool).toHaveProperty("name");
        expect(tool).toHaveProperty("description");
        expect(tool).toHaveProperty("inputSchema");
        expect(typeof tool.name).toBe("string");
        expect(typeof tool.description).toBe("string");
        expect(typeof tool.inputSchema).toBe("object");
      });

      // Verify we have some expected tools (like observe, etc.)
      const toolNames = result.tools.map(tool => tool.name);
      expect(toolNames).toContain("observe");
      expect(toolNames).toContain("tapOn");
      expect(toolNames).toContain("inputText");
    });

    test("strict clients can resolve observe outputSchema local references", async function() {
      const { client } = fixture.getContext();

      const result = await client.request({
        method: "tools/list",
        params: {}
      }, listToolsResponseSchema);

      const observe = result.tools.find(tool => tool.name === "observe");

      expect(observe?.outputSchema).toBeDefined();
      expect(unresolvedLocalRefs(observe?.outputSchema)).toEqual([]);
    });
  });
});
