/**
 * What a snapshot fixture depends on (#14065): reloading it after any of these change would load a
 * device state built for a different AVD, image, hardware config, emulator or userdata image.
 */
export type FixtureIdentity = {
  avdName: string;
  systemImageId: string;
  avdConfigHash: string;
  emulatorVersion: string;
  /**
   * Which userdata image the AVD has: `-wipe-data` re-creates it, which discards the persisted
   * writable-system overlay and the snapshots alike (owner decision 2026-10-31). `"none"` before
   * the AVD's first boot.
   */
  userdataGeneration: string;
};

export type FixtureInvalidationReason =
  | "avd-changed"
  | "system-image-changed"
  | "avd-config-changed"
  | "emulator-version-changed"
  | "userdata-wiped";
