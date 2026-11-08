import { afterEach, describe, expect, test } from "bun:test";
import { registerHighlightTools } from "../../src/server/highlightTools";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { VisualHighlightClient } from "../../src/features/debug/VisualHighlightClient";
import type { HighlightShape } from "../../src/models";
import { ElementResolver } from "../../src/features/utility/ElementResolver";
import { FakeHierarchyCapture } from "../fakes/FakeHierarchyCapture";
import { convertIosHierarchy } from "../helpers/iosHierarchyConverter";
import { isolateToolRegistry } from "../helpers/withTemporaryTool";
import { toolJson } from "../helpers/toolResponse";
import generalPage from "../fixtures/ios/ctrlproxy-golden/settings-tap-general/0014-request_hierarchy_if_stale.json";

isolateToolRegistry();

// Captured iOS Settings > General: the navigation bar's inert "General" title sits at
// [170,73,232,94]; the tappable "General" card (PLACARD) holds the same label below it.
const capturedGeneralPage = () =>
  convertIosHierarchy({
    hierarchy: generalPage.response.data.hierarchy,
    packageName: generalPage.response.data.packageName,
    updatedAt: generalPage.response.data.updatedAt,
  });

describe("highlight text selection (#17365)", () => {
  afterEach(() => ToolRegistry.clearTools());

  test("prefers the visible actionable match tapOn picks over an inert navigation title", async () => {
    const capture = new FakeHierarchyCapture(capturedGeneralPage, "ios");
    const shapes: HighlightShape[] = [];
    registerHighlightTools({
      hierarchyCaptureFactory: () => capture,
      generateHighlightId: () => "general",
      highlightClientFactory: () =>
        Object.assign(new VisualHighlightClient(), {
          addHighlight: async (_id: string, shape: HighlightShape) => {
            shapes.push(shape);
            return { success: true };
          },
        }),
    });

    const result = await ToolRegistry.getTool("highlight")!.deviceAwareHandler!(
      { deviceId: "captured-device", name: "Captured iOS", platform: "ios" },
      { text: "General" },
    );

    expect(toolJson(result).success).toBe(true);
    const snapshot = await capture.capture({ freshness: "fresh" });
    const tapTarget = new ElementResolver().resolve(
      { id: snapshot.captureId, nodes: snapshot.nodes },
      { text: "General" },
      { action: "tap" },
    ).chosen!;
    expect(tapTarget.nativeId).toBe("PLACARD");
    const [shape] = shapes;
    const { left, top, right, bottom } = tapTarget.bounds!;
    // The circle lands on the "General" label inside the card tapOn would tap, not the title.
    expect(shape.bounds.y).toBeGreaterThanOrEqual(top);
    expect(shape.bounds.y + shape.bounds.height).toBeLessThanOrEqual(bottom);
    expect(shape.bounds.x).toBeGreaterThanOrEqual(left);
    expect(shape.bounds.x + shape.bounds.width).toBeLessThanOrEqual(right);

    // #17385: the result reports the circled label so callers can check the ranking.
    const element = toolJson(result).element as {
      text?: string;
      bounds: { left: number; top: number; right: number; bottom: number };
    };
    expect(element.text).toBe("General");
    expect(element.bounds).toEqual({
      left: shape.bounds.x,
      top: shape.bounds.y,
      right: shape.bounds.x + shape.bounds.width,
      bottom: shape.bounds.y + shape.bounds.height,
    });
  });
});
