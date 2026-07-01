import { describe, expect, test } from "bun:test";
import { ViewHierarchy } from "../../../src/features/observe/ViewHierarchy";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";

const device = {
  name: "test-device",
  platform: "android",
  deviceId: "emulator-5554",
} as any;

describe("ViewHierarchy filtering", () => {
  test("preserves action-only interactive nodes", () => {
    const viewHierarchy = new ViewHierarchy(device, new FakeAdbClientFactory());
    const result = viewHierarchy.filterViewHierarchy({
      hierarchy: {
        node: {
          bounds: { left: 0, top: 0, right: 1080, bottom: 1920 },
          node: [
            {
              "resource-id": "com.example:id/icon_button",
              "view-id": "com.example:id/icon_button",
              "bounds": { left: 900, top: 1700, right: 1020, bottom: 1820 },
              "actions": ["click"],
            },
            {
              bounds: { left: 0, top: 0, right: 10, bottom: 10 },
            },
          ],
        },
      },
    });

    expect(result.hierarchy.node).toEqual({
      "resource-id": "com.example:id/icon_button",
      "view-id": "com.example:id/icon_button",
      "bounds": { left: 900, top: 1700, right: 1020, bottom: 1820 },
      "actions": ["click"],
    });
  });
});
