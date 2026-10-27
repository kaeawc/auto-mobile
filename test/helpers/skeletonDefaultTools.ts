import { ToolRegistry } from "../../src/server/toolRegistry";
import { registerAppTools } from "../../src/server/appTools";
import { registerInteractionTools } from "../../src/server/interactionTools";
import { registerSwipeAtTools } from "../../src/server/swipeAtTools";
import { registerMultiTouchTools } from "../../src/server/multiTouchTools";
import { registerBiometricTools } from "../../src/server/biometricTools";

/**
 * The tools declaring the `defaultsToSkeletonObservation` trait (#11825), derived from the
 * registry. Callers must wrap their file in `isolateToolRegistry()`.
 */
export function skeletonDefaultActionTools(): ReadonlySet<string> {
  registerAppTools();
  registerInteractionTools();
  registerSwipeAtTools();
  registerMultiTouchTools();
  registerBiometricTools();
  return new Set(
    [...ToolRegistry["tools"].values()]
      .filter((tool) => tool.defaultsToSkeletonObservation === true)
      .map((tool) => tool.name),
  );
}
