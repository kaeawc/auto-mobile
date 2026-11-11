import { parseBounds } from "../../src/utils/bounds";
import { readFileSync } from "node:fs";
import type { BackStackInfo, TaskInfo } from "../../src/models";

/** Captures use the public compact bounds encoding; production uses ElementBounds. */
export function xrBackStack(capture: "tap-at" | "swipe-up" = "tap-at"): BackStackInfo {
  const raw: Omit<BackStackInfo, "tasks"> & {
    tasks: Array<Omit<TaskInfo, "bounds"> & { bounds: [number, number, number, number] }>;
  } = JSON.parse(
    readFileSync(
      new URL(`../fixtures/xr-headset/${capture}-back-stack.json`, import.meta.url),
      "utf8",
    ),
  );
  return {
    ...raw,
    tasks: raw.tasks.map(({ bounds, ...task }) => ({ ...task, bounds: parseBounds(bounds)! })),
  };
}
