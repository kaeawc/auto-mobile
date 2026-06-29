import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { registerHighlightTools } from "../../src/server/highlightTools";
import { ToolRegistry } from "../../src/server/toolRegistry";
import type { BootedDevice, HighlightShape, ViewHierarchyResult } from "../../src/models";

describe("Highlight Tools Registration", () => {
  beforeEach(() => {
    (ToolRegistry as any).tools.clear();
  });

  afterEach(() => {
    (ToolRegistry as any).tools.clear();
  });

  test("registers highlight tool", () => {
    registerHighlightTools();

    const toolNames = ToolRegistry.getToolDefinitions().map(tool => tool.name);
    expect(toolNames).toContain("highlight");
  });

  test("validates highlight schema for add action", () => {
    registerHighlightTools();

    const tool = ToolRegistry.getTool("highlight");
    expect(tool).toBeDefined();

    const validShape = {
      type: "box",
      bounds: {
        x: 10,
        y: 20,
        width: 100,
        height: 50
      },
      style: {
        strokeColor: "#FF0000"
      }
    };

    expect(() => tool!.schema.parse({
      platform: "android",
      shape: validShape
    })).not.toThrow();

    expect(() => tool!.schema.parse({
      platform: "android"
    })).toThrow();

    expect(() => tool!.schema.parse({
      shape: validShape
    })).toThrow();
  });

  test("rejects invalid highlight shapes", () => {
    registerHighlightTools();

    const tool = ToolRegistry.getTool("highlight");
    expect(tool).toBeDefined();

    expect(() => tool!.schema.parse({
      platform: "android",
      shape: {
        type: "box",
        bounds: {
          x: 10,
          y: 20,
          width: 0,
          height: 50
        }
      }
    })).toThrow();
  });

  test("dispatches iOS shape highlights through the device-aware handler", async () => {
    const addCalls: Array<{ id: string; shape: HighlightShape; platform: string }> = [];
    registerHighlightTools({
      generateHighlightId: () => "highlight-ios-shape",
      highlightClientFactory: () => ({
        addHighlight: async (id, shape, options) => {
          addCalls.push({ id, shape, platform: options.platform });
          return { success: true };
        }
      } as any),
    });

    const tool = ToolRegistry.getTool("highlight");
    expect(tool).toBeDefined();
    expect(tool!.deviceAwareHandler).toBeDefined();

    const validShape = {
      type: "box",
      bounds: {
        x: 10,
        y: 20,
        width: 100,
        height: 50
      }
    };

    const parsed = tool!.schema.parse({
      platform: "ios",
      shape: validShape
    });

    const response = await tool!.deviceAwareHandler!({
      deviceId: "ios-device",
      platform: "ios",
      name: "iPhone Simulator",
    } as BootedDevice, parsed);
    const payload = JSON.parse(response.content[0].text);

    expect(payload.success).toBe(true);
    expect(addCalls).toEqual([
      { id: "highlight-ios-shape", shape: validShape, platform: "ios" }
    ]);
  });

  test("resolves iOS selector highlights from the iOS hierarchy", async () => {
    const hierarchy: ViewHierarchyResult = {
      hierarchy: {
        node: {
          text: "Root",
          bounds: { left: 0, top: 0, right: 390, bottom: 844 },
          node: [
            {
              text: "General",
              bounds: { left: 12, top: 124, right: 378, bottom: 168 },
            }
          ]
        }
      },
      packageName: "com.apple.Preferences",
      updatedAt: 123,
    };
    const addCalls: Array<{ shape: HighlightShape }> = [];
    registerHighlightTools({
      generateHighlightId: () => "highlight-ios-selector",
      viewHierarchyClientFactory: () => ({
        requestHierarchySync: async () => ({ hierarchy }),
        convertToViewHierarchyResult: source => source as ViewHierarchyResult,
      }),
      highlightClientFactory: () => ({
        addHighlight: async (_id, shape) => {
          addCalls.push({ shape });
          return { success: true };
        }
      } as any),
    });

    const tool = ToolRegistry.getTool("highlight");
    expect(tool).toBeDefined();

    const parsed = tool!.schema.parse({
      platform: "ios",
      text: "General"
    });

    const response = await tool!.deviceAwareHandler!({
      deviceId: "ios-device",
      platform: "ios",
      name: "iPhone Simulator",
    } as BootedDevice, parsed);
    const payload = JSON.parse(response.content[0].text);

    expect(payload.success).toBe(true);
    expect(addCalls[0]?.shape).toEqual({
      type: "circle",
      bounds: { x: 12, y: 124, width: 366, height: 44 }
    });
  });
});
