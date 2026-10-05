import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { registerHighlightTools } from "../../src/server/highlightTools";
import { VisualHighlightClient } from "../../src/features/debug/VisualHighlight";
import { SearchableHierarchy } from "../../src/features/utility/SearchableNode";
import { ToolRegistry } from "../../src/server/toolRegistry";
import type { BootedDevice, HighlightShape, ViewHierarchyResult } from "../../src/models";
import { innerBounds, nestedClickableHierarchy } from "../fixtures/nestedClickableHierarchy";

describe("Highlight Tools Registration", () => {
  beforeEach(() => {
    (ToolRegistry as any).tools.clear();
  });

  afterEach(() => {
    (ToolRegistry as any).tools.clear();
  });

  test.each(["failure", "throw", "success"])(
    "highlight %s preserves its payload",
    async (outcome) => {
      registerHighlightTools({
        generateHighlightId: () => "fake-highlight",
        highlightClientFactory: () =>
          Object.assign(new VisualHighlightClient(), {
            addHighlight: async () => {
              if (outcome === "throw") {
                throw new Error("Highlight unavailable");
              }
              return outcome === "failure"
                ? { success: false, error: "Highlight unavailable" }
                : { success: true };
            },
          }),
      });
      const tool = ToolRegistry.getTool("highlight")!;
      const response = await tool.deviceAwareHandler!(
        { deviceId: "fake", platform: "android", name: "Fake" },
        tool.schema.parse({
          shape: { type: "circle", bounds: { x: 0, y: 0, width: 10, height: 10 } },
        }),
      );
      expect(response.isError).toBe(outcome === "success" ? undefined : true);
      expect(JSON.parse(response.content[0].text)).toEqual(
        outcome === "success"
          ? { success: true }
          : {
              success: false,
              error: outcome === "throw" ? "Error: Highlight unavailable" : "Highlight unavailable",
            },
      );
    },
  );

  test("registers highlight tool", () => {
    registerHighlightTools();

    const toolNames = ToolRegistry.getToolDefinitions().map((tool) => tool.name);
    expect(toolNames).toContain("highlight");
  });
  test.each([
    [false, { x: 0, y: 0, width: 100, height: 100 }],
    [true, { x: 0, y: 0, width: 100, height: 100 }],
  ])("text highlight containerOf=%s targets the clickable row", async (containerOf, bounds) => {
    const hierarchy: ViewHierarchyResult = {
      hierarchy: {
        node: {
          bounds: { left: 0, top: 0, right: 200, bottom: 200 },
          node: [
            {
              clickable: true,
              bounds: { left: 0, top: 0, right: 100, bottom: 100 },
              node: [{ text: "Target", bounds: { left: 20, top: 40, right: 80, bottom: 60 } }],
            },
          ],
        },
      },
    };
    const shapes: HighlightShape[] = [];
    registerHighlightTools({
      generateHighlightId: () => "text-highlight",
      viewHierarchyClientFactory: () => ({
        requestHierarchySync: async () => ({ hierarchy }),
        convertToViewHierarchyResult: () => hierarchy,
      }),
      highlightClientFactory: () =>
        ({
          addHighlight: async (_id, shape) => {
            shapes.push(shape);
            return { success: true };
          },
        }) as any,
    });
    const tool = ToolRegistry.getTool("highlight")!;
    const response = await tool.deviceAwareHandler!(
      { deviceId: "test", platform: "android", name: "Test" } as BootedDevice,
      tool.schema.parse({ platform: "android", text: "Target", containerOf }),
    );
    expect(JSON.parse(response.content[0].text).success).toBe(true);
    expect(response.isError).toBeUndefined();
    expect(shapes[0]).toEqual({ type: "circle", bounds });
  });

  test("Android text highlight chooses the same nested clickable ancestor as tap", async () => {
    let shape: HighlightShape | undefined;
    registerHighlightTools({
      generateHighlightId: () => "nested-highlight",
      hierarchyCaptureFactory: () => ({
        capture: async (request) => ({
          captureId: "nested",
          platform: "android",
          requestedFreshness: request.freshness,
          receivedAt: 0,
          hierarchy: nestedClickableHierarchy,
          nodes: new SearchableHierarchy().project(nestedClickableHierarchy),
        }),
      }),
      highlightClientFactory: () =>
        Object.assign(new VisualHighlightClient(), {
          addHighlight: async (_id: string, value: HighlightShape) => {
            shape = value;
            return { success: true };
          },
        }),
    });
    const tool = ToolRegistry.getTool("highlight")!;
    const response = await tool.deviceAwareHandler!(
      { deviceId: "android-test", platform: "android", name: "test" },
      tool.schema.parse({ text: "Wi-Fi" }),
    );
    expect(JSON.parse(response.content[0].text).success).toBe(true);
    expect(response.isError).toBeUndefined();
    expect(shape).toEqual({
      type: "circle",
      bounds: {
        x: innerBounds.left,
        y: innerBounds.top,
        width: innerBounds.right - innerBounds.left,
        height: innerBounds.bottom - innerBounds.top,
      },
    });
  });

  test("Android element ID highlight keeps the bounded label inside a clickable row", async () => {
    const labelBounds = { left: 20, top: 30, right: 120, bottom: 60 };
    const hierarchy: ViewHierarchyResult = {
      hierarchy: {
        node: {
          "resource-id": "app:id/row",
          clickable: true,
          bounds: { left: 0, top: 0, right: 200, bottom: 100 },
          node: [{ "resource-id": "app:id/label", bounds: labelBounds, text: "Wi-Fi" }],
        },
      },
    };
    let shape: HighlightShape | undefined;
    registerHighlightTools({
      hierarchyCaptureFactory: () => ({
        capture: async (request) => ({
          captureId: "id-highlight",
          platform: "android",
          requestedFreshness: request.freshness,
          receivedAt: 0,
          hierarchy,
          nodes: new SearchableHierarchy().project(hierarchy),
        }),
      }),
      highlightClientFactory: () =>
        Object.assign(new VisualHighlightClient(), {
          addHighlight: async (_id: string, value: HighlightShape) => {
            shape = value;
            return { success: true };
          },
        }),
    });

    const tool = ToolRegistry.getTool("highlight")!;
    const response = await tool.deviceAwareHandler!(
      { deviceId: "android-test", platform: "android", name: "test" },
      tool.schema.parse({ elementId: "app:id/label" }),
    );
    expect(JSON.parse(response.content[0].text).success).toBe(true);
    expect(response.isError).toBeUndefined();
    expect(shape).toEqual({
      type: "circle",
      bounds: { x: 20, y: 30, width: 100, height: 30 },
    });
  });

  test("validates highlight schema for add action", () => {
    registerHighlightTools();

    const tool = ToolRegistry.getTool("highlight");
    expect(tool).toBeDefined();

    const validShape = {
      type: "circle",
      bounds: {
        x: 10,
        y: 20,
        width: 100,
        height: 50,
      },
    };

    expect(() =>
      tool!.schema.parse({
        platform: "android",
        shape: validShape,
      }),
    ).not.toThrow();

    expect(() =>
      tool!.schema.parse({
        platform: "android",
      }),
    ).toThrow();

    // #6154: platform is optional wherever deviceId/session resolves it, so
    // omitting it (with a valid shape) no longer throws — only `shape` is
    // actually required.
    expect(() =>
      tool!.schema.parse({
        shape: validShape,
      }),
    ).not.toThrow();
  });

  test("rejects invalid highlight shapes", () => {
    registerHighlightTools();

    const tool = ToolRegistry.getTool("highlight");
    expect(tool).toBeDefined();

    expect(() =>
      tool!.schema.parse({
        platform: "android",
        shape: {
          type: "circle",
          bounds: {
            x: 10,
            y: 20,
            width: 0,
            height: 50,
          },
        },
      }),
    ).toThrow();
  });

  test("dispatches iOS shape highlights through the device-aware handler", async () => {
    const addCalls: Array<{ id: string; shape: HighlightShape; platform: string }> = [];
    registerHighlightTools({
      generateHighlightId: () => "highlight-ios-shape",
      highlightClientFactory: () =>
        ({
          addHighlight: async (id, shape, options) => {
            addCalls.push({ id, shape, platform: options.platform });
            return { success: true };
          },
        }) as any,
    });

    const tool = ToolRegistry.getTool("highlight");
    expect(tool).toBeDefined();
    expect(tool!.deviceAwareHandler).toBeDefined();

    const validShape = {
      type: "circle",
      bounds: {
        x: 10,
        y: 20,
        width: 100,
        height: 50,
      },
    };

    const parsed = tool!.schema.parse({
      platform: "ios",
      shape: validShape,
    });

    const response = await tool!.deviceAwareHandler!(
      {
        deviceId: "ios-device",
        platform: "ios",
        name: "iPhone Simulator",
      } as BootedDevice,
      parsed,
    );
    const payload = JSON.parse(response.content[0].text);

    expect(payload.success).toBe(true);
    expect(addCalls).toEqual([{ id: "highlight-ios-shape", shape: validShape, platform: "ios" }]);
  });

  test("iOS selector highlights omit offscreen nodes from the shared projection", async () => {
    let highlighted = false;
    const hierarchy = {
      updatedAt: 1,
      screenWidth: 100,
      screenHeight: 100,
      hierarchy: {
        bounds: [0, 0, 100, 100],
        node: [
          { text: "Visible", bounds: [0, 0, 20, 20] },
          { text: "Offscreen", bounds: [0, 500, 20, 520] },
        ],
      },
    };
    registerHighlightTools({
      viewHierarchyClientFactory: () => ({
        requestHierarchySync: async () => ({ hierarchy }),
        convertToViewHierarchyResult: () => hierarchy as ViewHierarchyResult,
      }),
      highlightClientFactory: () =>
        ({
          addHighlight: async () => {
            highlighted = true;
            return { success: true };
          },
        }) as any,
    });
    const tool = ToolRegistry.getTool("highlight")!;
    const response = await tool.deviceAwareHandler!(
      { deviceId: "ios-test", platform: "ios", name: "test" },
      tool.schema.parse({ text: "Offscreen" }),
    );
    expect(JSON.parse(response.content[0].text).success).toBe(false);
    expect(response.isError).toBe(true);
    expect(highlighted).toBe(false);
  });

  test("Android selector highlights choose the visible duplicate", async () => {
    let shape: HighlightShape | undefined;
    const hierarchy: ViewHierarchyResult = {
      screenWidth: 100,
      screenHeight: 100,
      hierarchy: {
        node: [
          { text: "X", bounds: [0, 200, 20, 220] },
          { text: "X", bounds: [0, 10, 20, 30] },
        ],
      },
    };
    registerHighlightTools({
      hierarchyCaptureFactory: () => ({
        capture: async (request) => ({
          captureId: "highlight",
          platform: "android",
          requestedFreshness: request.freshness,
          receivedAt: 0,
          hierarchy,
          nodes: new (
            await import("../../src/features/utility/SearchableNode")
          ).SearchableHierarchy().project(hierarchy),
        }),
      }),
      highlightClientFactory: () =>
        ({
          addHighlight: async (_id, value) => {
            shape = value;
            return { success: true };
          },
        }) as any,
    });
    const tool = ToolRegistry.getTool("highlight")!;
    const response = await tool.deviceAwareHandler!(
      { deviceId: "android-test", platform: "android", name: "test" },
      tool.schema.parse({ text: "X" }),
    );
    expect(JSON.parse(response.content[0].text).success).toBe(true);
    expect(response.isError).toBeUndefined();
    expect(shape?.bounds.y).toBe(10);
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
            },
          ],
        },
      },
      packageName: "com.apple.Preferences",
      updatedAt: 123,
    };
    const addCalls: Array<{ shape: HighlightShape }> = [];
    registerHighlightTools({
      generateHighlightId: () => "highlight-ios-selector",
      viewHierarchyClientFactory: () => ({
        requestHierarchySync: async () => ({ hierarchy }),
        convertToViewHierarchyResult: (source) => source as ViewHierarchyResult,
      }),
      highlightClientFactory: () =>
        ({
          addHighlight: async (_id, shape) => {
            addCalls.push({ shape });
            return { success: true };
          },
        }) as any,
    });

    const tool = ToolRegistry.getTool("highlight");
    expect(tool).toBeDefined();

    const parsed = tool!.schema.parse({
      platform: "ios",
      text: "General",
    });

    const response = await tool!.deviceAwareHandler!(
      {
        deviceId: "ios-device",
        platform: "ios",
        name: "iPhone Simulator",
      } as BootedDevice,
      parsed,
    );
    const payload = JSON.parse(response.content[0].text);

    expect(payload.success).toBe(true);
    // iOS selector path must attach source dims so the in-app SDK can map
    // device-coordinate bounds into its own view space (issue #2682).
    expect(addCalls[0]?.shape).toEqual({
      type: "circle",
      bounds: { x: 12, y: 124, width: 366, height: 44, sourceWidth: 390, sourceHeight: 844 },
    });
  });

  test("uses observe root dimensions over stale iOS screen metadata", async () => {
    const hierarchy: ViewHierarchyResult = {
      hierarchy: {
        node: {
          text: "Root",
          bounds: { left: 0, top: 0, right: 390, bottom: 844 },
          node: [
            {
              text: "General",
              bounds: { left: 12, top: 124, right: 378, bottom: 168 },
            },
          ],
        },
      },
      packageName: "com.apple.Preferences",
      updatedAt: 123,
      screenWidth: 402,
      screenHeight: 874,
    };
    const addCalls: Array<{ shape: HighlightShape }> = [];
    registerHighlightTools({
      generateHighlightId: () => "highlight-ios-screen",
      viewHierarchyClientFactory: () => ({
        requestHierarchySync: async () => ({ hierarchy }),
        convertToViewHierarchyResult: (source) => source as ViewHierarchyResult,
      }),
      highlightClientFactory: () =>
        ({
          addHighlight: async (_id, shape) => {
            addCalls.push({ shape });
            return { success: true };
          },
        }) as any,
    });

    const tool = ToolRegistry.getTool("highlight");
    const parsed = tool!.schema.parse({ platform: "ios", text: "General" });
    await tool!.deviceAwareHandler!(
      {
        deviceId: "ios-device",
        platform: "ios",
        name: "iPhone Simulator",
      } as BootedDevice,
      parsed,
    );

    expect(addCalls[0]?.shape).toEqual({
      type: "circle",
      bounds: { x: 12, y: 124, width: 366, height: 44, sourceWidth: 390, sourceHeight: 844 },
    });
  });

  test("does not attach source dims for Android selector highlights", async () => {
    const hierarchy: ViewHierarchyResult = {
      hierarchy: {
        node: {
          text: "Root",
          bounds: { left: 0, top: 0, right: 1080, bottom: 2400 },
          node: [
            {
              text: "Settings",
              bounds: { left: 24, top: 200, right: 1056, bottom: 320 },
            },
          ],
        },
      },
      packageName: "com.android.settings",
      updatedAt: 123,
    };
    const addCalls: Array<{ shape: HighlightShape }> = [];
    registerHighlightTools({
      generateHighlightId: () => "highlight-android-selector",
      viewHierarchyClientFactory: () => ({
        requestHierarchySync: async () => ({ hierarchy }),
        convertToViewHierarchyResult: (source) => source as ViewHierarchyResult,
      }),
      highlightClientFactory: () =>
        ({
          addHighlight: async (_id, shape) => {
            addCalls.push({ shape });
            return { success: true };
          },
        }) as any,
    });

    const tool = ToolRegistry.getTool("highlight");
    const parsed = tool!.schema.parse({ platform: "android", text: "Settings" });
    await tool!.deviceAwareHandler!(
      {
        deviceId: "android-device",
        platform: "android",
        name: "Android Emulator",
      } as BootedDevice,
      parsed,
    );

    expect(addCalls[0]?.shape).toEqual({
      type: "circle",
      bounds: { x: 24, y: 200, width: 1032, height: 120 },
    });
  });
});
