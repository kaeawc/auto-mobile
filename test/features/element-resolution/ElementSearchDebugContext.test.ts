import { expect, test } from "bun:test";
import type { BootedDevice, Element } from "../../../src/models";
import { buildElementSearchDebugContext } from "../../../src/features/utility/ElementSearchDebugContext";
import { toSearchable, type SearchableEntry } from "../../../src/features/utility/SearchableNode";
import type { HierarchyCapture } from "../../../src/features/observe/HierarchyCapture";
import { isDebugModeEnabled, setDebugModeEnabled } from "../../../src/utils/debug";

const bounds = { left: 0, top: 0, right: 20, bottom: 20 };
const device = { platform: "android", name: "test", deviceId: "test" } satisfies BootedDevice;

function entry(text: string, index: number): SearchableEntry {
  const element: Element = { text, bounds, clickable: true };
  return {
    ...toSearchable(element),
    source: { bounds },
    properties: element,
    element,
    depth: 0,
    index,
    rootGroup: 0,
    windowRank: 0,
  };
}

function capture(nodes: SearchableEntry[]): HierarchyCapture {
  return {
    capture: async (request) => {
      expect(request.freshness).toBe("fresh");
      return {
        captureId: "context",
        platform: "android",
        requestedFreshness: request.freshness,
        receivedAt: 0,
        hierarchy: { hierarchy: {} },
        nodes,
      };
    },
  };
}

async function inDebugMode(run: () => Promise<void>): Promise<void> {
  const original = isDebugModeEnabled();
  setDebugModeEnabled(true);
  try {
    await run();
  } finally {
    setDebugModeEnabled(original);
  }
}

test("exact match reports criteria and checked count without near misses", async () => {
  await inDebugMode(async () => {
    expect(
      await buildElementSearchDebugContext(device, { text: "Save" }, capture([entry("Save", 0)])),
    ).toEqual({
      searchCriteria: { text: "Save" },
      nearMisses: undefined,
      totalElementsChecked: 1,
    });
  });
});

test("near miss reports source element, property, value, reason, and checked count", async () => {
  await inDebugMode(async () => {
    const nodes = [entry("SaveNow", 0), entry("Save", 1), entry("Open", 2)];
    expect(
      await buildElementSearchDebugContext(device, { text: "SaveNow" }, capture(nodes)),
    ).toEqual({
      searchCriteria: { text: "SaveNow" },
      nearMisses: [
        {
          element: nodes[1].element,
          property: "text",
          value: "Save",
          reason: "Similar but did not match the selected mode",
        },
      ],
      totalElementsChecked: 3,
    });
  });
});
