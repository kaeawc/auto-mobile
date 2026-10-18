import type { ViewHierarchyResult } from "../../src/models";

/**
 * Synthetic launcher pin dialog: one clickable 100x60 button per label, 200 px apart. The real
 * API 37 dialog is captured in test/fixtures/android-pin-dialog; this only drives control flow and label variants.
 */
export function pinDialogTree(labels: string[]): ViewHierarchyResult {
  const hierarchy: ViewHierarchyResult["hierarchy"] = {
    node: {
      bounds: { left: 0, top: 0, right: 1000, bottom: 2000 },
      node: labels.map((text, index) => ({
        text,
        clickable: "true",
        bounds: { left: index * 200, top: 100, right: index * 200 + 100, bottom: 160 },
      })),
    },
  };
  return { hierarchy };
}
