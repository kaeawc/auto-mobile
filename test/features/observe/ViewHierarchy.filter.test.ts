import { describe, expect, test } from "bun:test";
import { ViewHierarchy } from "../../../src/features/observe/ViewHierarchy";

const device = {
  name: "test-device",
  platform: "android",
  deviceId: "emulator-5554",
} as any;

describe("ViewHierarchy filtering", () => {
  test("preserves action-only interactive nodes", () => {
    const viewHierarchy = new ViewHierarchy(device, null);
    const result = viewHierarchy.filterViewHierarchy({
      hierarchy: {
        node: {
          bounds: "[0,0][1080,1920]",
          node: [
            {
              "resource-id": "com.example:id/icon_button",
              "view-id": "com.example:id/icon_button",
              bounds: "[900,1700][1020,1820]",
              actions: ["click"],
            },
            {
              bounds: "[0,0][10,10]",
            },
          ],
        },
      },
    });

    expect(result.hierarchy.node).toEqual({
      "resource-id": "com.example:id/icon_button",
      "view-id": "com.example:id/icon_button",
      bounds: "[900,1700][1020,1820]",
      actions: ["click"],
    });
  });
});
