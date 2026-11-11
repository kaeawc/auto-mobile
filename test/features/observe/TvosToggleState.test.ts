import { expect, test } from "bun:test";
import capture from "../../fixtures/tvos-xcuitest/tvos-runner-hierarchy-tvdog-settings-toggle.json";
import { FakeTvosRunnerClient } from "../../fakes/FakeTvosRunnerClient";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeScreenshotFileWriter } from "../../fakes/FakeScreenshotFileWriter";
import { FakeScreenshotPathProtection } from "../../fakes/FakeScreenshotPathProtection";
import { CountingIdGenerator } from "../../../src/utils/CountingIdGenerator";
import { tvosRunners } from "../../../src/features/tvos/TvosRunnerRegistry";
import { observeWatch } from "../../../src/server/observeWatch";
import { getStructuredPayload } from "../../../src/utils/toolUtils";
import { sanitizeObserveResult } from "../../../src/features/observe/output/ObserveResultOutput";
import type { ObserveResult } from "../../../src/models";
import type { CtrlProxyNode } from "../../../src/features/observe/ios/types";

function nodes(node: CtrlProxyNode): CtrlProxyNode[] {
  const children = node.node ? (Array.isArray(node.node) ? node.node : [node.node]) : [];
  return [node, ...children.flatMap(nodes)];
}

test.each(["true", "false", undefined])(
  "observe exposes captured nested toggle state %s",
  async (checked) => {
    const replay = new FakeTvosRunnerClient(structuredClone(capture.data));
    const switches = nodes(replay.tree.hierarchy).filter((node) => node.className === "40");
    expect(switches).toHaveLength(2);
    // The old runner capture has no state. Model the new wire fields ONLY, preserving its geometry and focus.
    if (checked !== undefined) {
      switches[0].checkable = "true";
      switches[0].checked = checked;
    }
    const device = { deviceId: "toggle-observe", platform: "tvos", name: "Apple TV" } as const;
    const unregister = tvosRunners.register(device.deviceId, replay);
    const timer = new FakeTimer();
    try {
      const response = await observeWatch(device, { project: "full" }, undefined, {
        screenshots: {
          capture: async () =>
            Buffer.from(
              "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
              "base64",
            ),
        },
        timer,
        idGenerator: new CountingIdGenerator("toggle"),
        fileWriter: new FakeScreenshotFileWriter(),
        pathProtection: new FakeScreenshotPathProtection(timer),
        cacheDir: () => "/cache/screenshots",
      });
      const result = getStructuredPayload<ObserveResult>(response);
      expect(result?.focusedElement).toMatchObject({ text: "Autoplay", class: "75" });
      expect(result?.focusedElement?.checked).toBe(checked);
      expect(result).toBeDefined();
      const projected = sanitizeObserveResult(result!, {
        dropElements: false,
        project: "skeleton",
      });
      expect(projected.focusedElement?.checked).toBe(checked);
      if (checked !== undefined) {
        const rows = [...(projected.skeleton ?? []), ...(projected.context ?? [])];
        expect(rows.filter((row) => row.label === "Autoplay")).toContainEqual(
          expect.objectContaining({ checked: checked === "true" }),
        );
      }
    } finally {
      unregister();
    }
  },
);
