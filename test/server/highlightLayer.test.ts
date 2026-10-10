import { afterEach, describe, expect, test } from "bun:test";
import { VisualHighlightClient } from "../../src/features/debug/VisualHighlight";
import type { HighlightShape, ViewHierarchyResult } from "../../src/models";
import { highlightSchema, registerHighlightTools } from "../../src/server/highlightTools";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { FakeHierarchyCapture } from "../fakes/FakeHierarchyCapture";
import {
  RELABELLED_CAPTURE,
  capturedPrototypeHierarchy,
  capturedTwoWindowHierarchy,
} from "../helpers/prototypeWindowCapture";

// Captured Recents overview with its floating window relabelled as the CtrlProxy
// prototype; see test/helpers/prototypeWindowCapture.ts.
async function highlight(hierarchy: ViewHierarchyResult, args: Record<string, unknown>) {
  const shapes: HighlightShape[] = [];
  registerHighlightTools({
    hierarchyCaptureFactory: () => new FakeHierarchyCapture(() => hierarchy),
    generateHighlightId: () => "layer",
    highlightClientFactory: () =>
      Object.assign(new VisualHighlightClient(), {
        addHighlight: async (_id: string, shape: HighlightShape) => {
          shapes.push(shape);
          return { success: true };
        },
      }),
  });
  const result = await ToolRegistry.getTool("highlight")!.deviceAwareHandler!(
    { deviceId: "captured-device", name: "Captured Android", platform: "android" },
    args,
  );
  return { response: JSON.parse(result.content[0].text), shapes };
}

function prototypeTop(hierarchy: ViewHierarchyResult): number {
  return hierarchy.windows!.find((window) => window.id === RELABELLED_CAPTURE.prototypeWindowId)!
    .bounds!.top;
}

describe("highlight layer (#9305)", () => {
  afterEach(() => ToolRegistry.clearTools());

  test("text in both windows highlights the prototype by default and the app for app", async () => {
    const hierarchy = capturedPrototypeHierarchy();
    const byDefault = await highlight(hierarchy, { text: "Settings" });
    const forApp = await highlight(hierarchy, { text: "Settings", layer: "app" });

    expect(byDefault.response.success).toBe(true);
    expect(forApp.response.success).toBe(true);
    expect(byDefault.shapes[0].bounds.y).toBeGreaterThanOrEqual(prototypeTop(hierarchy));
    expect(forApp.shapes[0].bounds.y).toBeLessThan(prototypeTop(hierarchy));
  });

  test('"prototype" with no prototype showing fails without drawing', async () => {
    const { response, shapes } = await highlight(capturedTwoWindowHierarchy(), {
      text: "Settings",
      layer: "prototype",
    });

    expect(response.success).toBe(false);
    expect(response.error).toContain("no AutoMobile prototype is showing");
    expect(shapes).toEqual([]);
  });

  test("layer requires a selector", () => {
    const parsed = highlightSchema.safeParse({
      platform: "android",
      shape: { type: "circle", bounds: { x: 0, y: 0, width: 10, height: 10 } },
      layer: "app",
    });
    expect(parsed.success).toBe(false);
  });
});
