import type { Platform } from "./Platform";

/**
 * Display and system settings a session can change on a device (#11145). They are not restored
 * when the session releases the device; the next acquisition by a different session resets each
 * one that differs from the value recorded before any session first changed it.
 */
export const DEVICE_SETTING_KEYS = [
  "fontScale",
  // The iOS Simulator's Dynamic Type category (#14087); Android records fontScale instead.
  "contentSize",
  "density",
  "nightMode",
  "locale",
  "timeFormat",
  "calendarSystem",
  // Accessibility display preferences (#14088), recorded as their raw platform setting.
  "increaseContrast",
  "reduceMotion",
  "boldText",
  // Android accessibility display settings (#14076), recorded as their raw platform setting.
  "colorInversion",
  "colorCorrection",
  "magnification",
  "magnificationScale",
  "extraDim",
] as const;

export type DeviceSettingKey = (typeof DEVICE_SETTING_KEYS)[number];

/** A setting's value in the form its writer accepts back; `null` is an unset setting. */
export type DeviceSettingValue = string | number | null;

export type DeviceSettingValues = Partial<Record<DeviceSettingKey, DeviceSettingValue>>;

export interface DeviceSettingDefaultsRecord {
  platform: Platform;
  name: string;
  /** The session that most recently changed a recorded setting. */
  sessionId: string;
  /** Per setting: the value observed before any session first changed it. */
  values: DeviceSettingValues;
}

export interface DeviceSettingDefaultsPersistence {
  get(deviceId: string): Promise<DeviceSettingDefaultsRecord | null>;
  put(deviceId: string, record: DeviceSettingDefaultsRecord): Promise<void>;
  delete(deviceId: string): Promise<void>;
}
