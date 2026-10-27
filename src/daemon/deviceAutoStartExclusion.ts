import { isTemplateSimName } from "../utils/ios-cmdline-tools/SimulatorTemplateKey";
import type { DeviceInfo } from "../models";
import { isProductBrokerDevice } from "./sessionBroker/persistedIdentity";
import type { BindingExclusion } from "./sessionBroker/provisioning/exclusion";

/** Refresh before lookup: broker inventory is never implicit boot capacity (#13859). */
export function isExcludedFromAutoStart(
  image: DeviceInfo,
  bindingExclusion: Pick<BindingExclusion, "holderOf"> | undefined,
): boolean {
  return (
    isProductBrokerDevice(image.name) ||
    isTemplateSimName(image.name) ||
    bindingExclusion?.holderOf({
      platform: image.platform,
      // Names cover iOS creation before its UDID has been recorded (#11174).
      stableIds: [image.name, image.deviceId],
    }) !== undefined
  );
}
