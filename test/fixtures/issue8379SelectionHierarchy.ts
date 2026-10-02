import type { BootedDevice, ViewHierarchyResult } from "../../src/models";
import { nodeBounds } from "../../src/models/ViewHierarchyResult";
import { parseBounds } from "../../src/utils/bounds";
import { issue8379Hierarchy } from "./issue8379Hierarchy";

export const duoSelectionText = "Derived right-hand navigation target";
export const duoSelectionBounds = { left: 700, top: 24, right: 800, bottom: 82 };

/** Derived geometry/affordances, not an additional device capture. */
export function issue8379SelectionHierarchy(): ViewHierarchyResult {
  const hierarchy = issue8379Hierarchy();
  const root = hierarchy.hierarchy.node!;
  const navigation = root.node![0];
  const target = structuredClone(navigation);
  // Crop the captured navigation bar to a right-hand 100-point selection region.
  target.$ = {
    ...target.$,
    bounds: { ...duoSelectionBounds },
    text: duoSelectionText,
    clickable: "true",
    enabled: "true",
  };
  const bounds = parseBounds(nodeBounds(navigation))!;
  // Translate the captured bar upwards; projection prunes this overflow evidence.
  navigation.$ = {
    ...navigation.$,
    bounds: { ...bounds, top: bounds.top - 200, bottom: bounds.bottom - 200 },
  };
  root.node = [navigation, target];
  delete hierarchy.pixelWidth;
  delete hierarchy.pixelHeight;
  return hierarchy;
}

export function selectionFixtureDevice(
  platform: "ios" | "android" = "ios",
  panels = 2,
): BootedDevice {
  return {
    platform,
    deviceId: "fixture-selection-screen",
    name: "Fixture selection screen",
    displays: {
      panels: Array.from({ length: panels }, (_, index) => ({
        key: String(index),
        role: index === 0 ? "inner" : "cover",
        sizePx: { width: 2853, height: 2007 },
      })),
      postures: ["opened", "closed"],
    },
  };
}
