/**
 * Ids of the OEM manufacturer-profile catalog (#14055) and of the OEM capabilities no profile can
 * emulate. They live in this leaf so every tier can validate a `deviceProfile` selector
 * (#14058); the catalog itself (`features/utility/OemPersonas`) keys its entries by these.
 */
export const MANUFACTURER_PROFILE_IDS = [
  "pixel-baseline",
  "samsung-oneui",
  "xiaomi-hyperos",
  "oneplus-oxygenos",
  "oppo-coloros",
  "motorola",
] as const;

export type ManufacturerProfileId = (typeof MANUFACTURER_PROFILE_IDS)[number];

export const NON_EMULATABLE_CAPABILITY_IDS = [
  "samsung-dex",
  "knox",
  "flip-cover-screen",
  "spen-air-actions",
  "oem-systemui",
  "oem-unused-app-triggers",
  "firmware-update-exemption-reset",
  "xiaomi-proprietary-appops",
] as const;

export type NonEmulatableCapability = (typeof NON_EMULATABLE_CAPABILITY_IDS)[number];

/** A `deviceProfile` selector: the profile to apply and the OEM capabilities the task needs. */
export interface DeviceProfileSelector {
  manufacturerProfile: ManufacturerProfileId;
  requires?: NonEmulatableCapability[];
}
