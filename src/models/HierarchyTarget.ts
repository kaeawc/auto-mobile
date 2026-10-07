/**
 * Which part of the screen a call resolves against while AutoMobile's own
 * overlay window is showing (issue #9305). Omitted keeps the default: overlay
 * and app nodes together, topmost window first.
 *
 * - `app`: the overlay's windows and nodes are excluded.
 * - `overlay`: only the overlay's windows and nodes are considered.
 */
export const HIERARCHY_TARGETS = ["app", "overlay"] as const;

export type HierarchyTarget = (typeof HIERARCHY_TARGETS)[number];
