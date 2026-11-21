import type { BootedDevice, ObserveResult } from "../../../models";
import type { HierarchyLayer } from "../../../models/HierarchyLayer";
import { requireAndroidOrIosPlatform } from "../../../models/Platform";
import {
  inputFocusedPrototypeLayer,
  scopeObserveResultToLayer,
} from "../../observe/hierarchyLayer";

/**
 * Scope a sendKeys observation to the layer whose window receives the typed text. An explicit
 * `prototype` layer scopes to the prototype. Without a layer on Android, a prototype window that
 * holds input focus receives the text while the app's field keeps its own focus underneath, so
 * the observation is scoped to the prototype too (#18895); otherwise it is returned unchanged.
 */
export function scopeToInputLayer(
  observation: ObserveResult,
  targetLayer: HierarchyLayer | undefined,
  platform: BootedDevice["platform"],
): ObserveResult {
  if (targetLayer === undefined && platform === "android") {
    return inputFocusedPrototypeLayer(observation.viewHierarchy) === undefined
      ? observation
      : scopeObserveResultToLayer(observation, "prototype", "android");
  }
  if (targetLayer !== "prototype") {
    return observation;
  }
  return observation.viewHierarchy
    ? scopeObserveResultToLayer(
        observation,
        "prototype",
        requireAndroidOrIosPlatform(platform, "sendKeys"),
      )
    : { ...observation, focusedElement: undefined, accessibilityFocusedElement: undefined };
}
