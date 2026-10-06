import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { z } from "zod/v4";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { FakeMcpServer } from "../fakes/FakeMcpServer";
import { ToolRegistry } from "../../src/server/toolRegistry";

describe("ToolRegistry reachability", () => {
  beforeEach(() => {
    ToolRegistry.clearTools();
  });

  afterEach(() => {
    ToolRegistry.clearTools();
    ToolRegistry.clearServersForTesting();
  });

  test("discovery, direct lookup, registration, and call resolution share the intended gates", async () => {
    const cases = [
      { name: "hidden", options: { hidden: true }, planOnly: false, reachable: true },
      { name: "planOnly", options: {}, planOnly: true, reachable: false },
      { name: "debugOnly", options: { debugOnly: true }, planOnly: false, reachable: false },
      { name: "plain", options: {}, planOnly: false, reachable: true },
    ] as const;

    for (const entry of cases) {
      ToolRegistry.clearTools();
      let calls = 0;
      ToolRegistry.register(
        entry.name,
        "Reachability probe",
        z.object({}),
        async () => {
          calls++;
          return { content: [{ type: "text", text: "called" }] };
        },
        entry.options,
      );
      if (entry.planOnly) {
        const registered = ToolRegistry.getRegisteredTool(entry.name);
        if (!registered) {
          throw new Error(`test tool ${entry.name} was not registered`);
        }
        registered.planOnly = true;
      }

      const tool = ToolRegistry.getRegisteredTool(entry.name);
      if (!tool) {
        throw new Error(`test tool ${entry.name} was not registered`);
      }
      const shouldDiscover = entry.name !== "hidden" && entry.reachable;
      expect(ToolRegistry.getAllTools().includes(tool)).toBe(shouldDiscover);

      // index.ts resolves tools/call by calling getTool(name), then invokes its handler.
      // Exercise that same dispatch seam here without starting a full MCP server.
      const callResolution = ToolRegistry.getTool(entry.name);
      expect(callResolution).toBe(entry.reachable ? tool : undefined);
      if (callResolution) {
        await callResolution.handler({});
        expect(calls).toBe(1);
      } else {
        expect(calls).toBe(0);
      }

      const server = new FakeMcpServer();
      ToolRegistry.registerWithServer(server as unknown as McpServer);
      expect(server.registeredTools.some((registered) => registered.name === entry.name)).toBe(
        shouldDiscover,
      );
    }
  });

  test("a hidden tool is a valid plan step and only the catalog generator lists it", () => {
    ToolRegistry.register(
      "hiddenStep",
      "Hidden but plan-executable",
      z.object({}),
      async () => ({}),
      { hidden: true },
    );

    expect(ToolRegistry.getToolForPlan("hiddenStep")).toBeDefined();
    expect(ToolRegistry.getToolDefinitions().map((tool) => tool.name)).toEqual([]);
    expect(
      ToolRegistry.getToolDefinitions({ includeUnavailable: true }).map((tool) => tool.name),
    ).toEqual([]);
    const catalog = ToolRegistry.getToolDefinitions({
      includeUnavailable: true,
      includeHidden: true,
    });
    expect(catalog.map((tool) => tool._meta)).toEqual([{ "automobile/hidden": true }]);
  });
});
