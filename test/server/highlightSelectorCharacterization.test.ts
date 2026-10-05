import { afterEach, describe, expect, test } from "bun:test";
import { registerHighlightTools } from "../../src/server/highlightTools";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { VisualHighlightClient } from "../../src/features/debug/VisualHighlight";
import { FakeHierarchyCapture } from "../fakes/FakeHierarchyCapture";
import { issue8379Hierarchy } from "../fixtures/issue8379Hierarchy";
import capturedAndroid from "../fixtures/android-focus/playground-text-field-pre-tap.json";
import type { ViewHierarchyResult } from "../../src/models";

describe("highlight selector failures", () => {
  afterEach(() => ToolRegistry.clearTools());

  test.each([
    [{}, "highlight requires elementId or text when shape is not provided."],
    [
      { text: "missing captured label" },
      "Unable to find an element that matches the highlight selector.",
    ],
    [
      { text: "missing captured label", container: { text: "missing container" } },
      "Container level 1 not found",
    ],
  ])("returns a failure for selector %j", async (args, message) => {
    const capture = new FakeHierarchyCapture(() => issue8379Hierarchy(), "ios");
    let additions = 0;
    registerHighlightTools({
      hierarchyCaptureFactory: () => capture,
      generateHighlightId: () => "characterization",
      highlightClientFactory: () =>
        Object.assign(new VisualHighlightClient(), {
          addHighlight: async () => {
            additions++;
            return { success: true };
          },
        }),
    });
    const result = await ToolRegistry.getTool("highlight")!.deviceAwareHandler!(
      { deviceId: "captured-device", name: "Captured iOS", platform: "ios" },
      args,
    );
    const response = JSON.parse(result.content[0].text);
    expect(response.success).toBe(false);
    expect(response.error).toContain(message);
    expect(additions).toBe(0);
    expect(capture.requests).toHaveLength("text" in args ? 1 : 0);
  });

  test("a captured root has no enclosing highlight container", async () => {
    const capture = new FakeHierarchyCapture(
      () => capturedAndroid.viewHierarchy as ViewHierarchyResult,
    );
    const snapshot = await capture.capture({ freshness: "fresh" });
    const root = snapshot.nodes.find((node) => node.parentIndex === undefined && node.element)!;
    registerHighlightTools({
      hierarchyCaptureFactory: () => capture,
      generateHighlightId: () => "root-container",
      highlightClientFactory: () => new VisualHighlightClient(),
    });
    const result = await ToolRegistry.getTool("highlight")!.deviceAwareHandler!(
      { deviceId: "captured-device", name: "Captured Android", platform: "android" },
      { elementId: root.nodeKey, containerOf: true },
    );
    expect(JSON.parse(result.content[0].text)).toEqual({
      success: false,
      error: "Unable to resolve a container for the selected element.",
    });
  });
});
