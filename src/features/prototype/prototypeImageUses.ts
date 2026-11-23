import { record, type Raw } from "./prototypeTemplate";

/**
 * What one image slot costs against `MAX_PROTOTYPE_IMAGES`: an asset id costs 1, and a
 * `{light, dark}` pair costs 2 when the two modes name different assets (#11218). Absent is 0.
 */
export function imageSlotUses(value: unknown): number {
  if (typeof value === "string") {
    return 1;
  }
  const pair = record(value);
  if (!pair) {
    return 0;
  }
  // A data-bound slot names a device media item, not an uploaded asset: it costs no image budget.
  if (typeof pair.data === "string") {
    return 0;
  }
  return typeof pair.light === "string" && typeof pair.dark === "string" && pair.light !== pair.dark
    ? 2
    : 1;
}

/** The node's own image slots: an `image` costs at least 1, a `videoPlayer` its `poster`. */
export function nodeImageUses(node: Raw): number {
  if (node.type === "image") {
    return (
      (node.url === undefined ? Math.max(1, imageSlotUses(node.asset)) : 0) +
      imageSlotUses(record(node.placeholder)?.asset) +
      imageSlotUses(record(node.error)?.asset)
    );
  }
  return node.type === "videoPlayer" ? imageSlotUses(node.poster) : 0;
}

export function imageUses(node: Raw): number {
  if (node.type === "image" || node.type === "videoPlayer") {
    return nodeImageUses(node);
  }
  const items = Array.isArray(node.items) ? (node.items as unknown[]) : [];
  return items.reduce<number>((sum, item) => sum + imageSlotUses(record(item)?.image), 0);
}
