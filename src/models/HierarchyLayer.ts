/**
 * Which part of the screen a call resolves against while AutoMobile's own
 * prototype window is showing (issue #9305). Omitted keeps the default: prototype
 * and app nodes together, topmost window first.
 *
 * - `app`: the prototype's windows and nodes are excluded.
 * - `prototype`: only the prototype's windows and nodes are considered.
 */
export const HIERARCHY_LAYERS = ["app", "prototype"] as const;

export type HierarchyLayer = (typeof HIERARCHY_LAYERS)[number];
