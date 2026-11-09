import type { BootedDevice } from "../../models";
import {
  resolveActionDisplayId,
  type ActionDisplayDependencies,
} from "../action/TargetDisplayAction";

export type PrototypeDisplayDependencies = ActionDisplayDependencies;

/**
 * Resolve the prototype's `display` argument to an Android logical display id; see
 * {@link resolveActionDisplayId}. Undefined means the default display and returns undefined.
 */
export async function resolvePrototypeDisplayId(
  device: BootedDevice,
  display: string | undefined,
  dependencies: PrototypeDisplayDependencies,
): Promise<number | undefined> {
  return resolveActionDisplayId(device, display, dependencies);
}
