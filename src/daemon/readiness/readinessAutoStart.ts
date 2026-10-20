import { ActionableError, type DeviceInfo } from "../../models";
import { isExcludedFromAutoStart } from "../deviceAutoStartExclusion";
import type { BindingExclusion } from "../sessionBroker/provisioning/exclusion";

/** Called only for implicit cold boots, after preserving existing-device selection. */
export async function selectReadinessAutoStartImage(
  images: readonly DeviceInfo[],
  bindingExclusion: Pick<BindingExclusion, "refresh" | "holderOf">,
): Promise<DeviceInfo> {
  await bindingExclusion.refresh({ requireCurrent: true });
  const candidates = images.filter((image) => !isExcludedFromAutoStart(image, bindingExclusion));
  if (candidates.length === 0) {
    throw new ActionableError(
      "Cannot automatically start a device: all available images are broker-managed or held by a binding. Pass a deviceId to select an explicit target, or start a non-broker device and retry.",
    );
  }
  return candidates[0];
}
