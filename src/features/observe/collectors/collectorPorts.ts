import type { HierarchyCollector } from "./HierarchyCollector";
import type { DeviceStateCollector } from "./DeviceStateCollector";

/** The hierarchy collector surface observe consumers call; satisfied by the real class and fakes. */
export type HierarchyCollectorPort = Pick<
  HierarchyCollector,
  "collect" | "collectRaw" | "extractScreenSize" | "reconcileScreenDimensions"
>;

/** The device-state collector surface observe consumers call; satisfied by the real class and fakes. */
export type DeviceStateCollectorPort = Pick<
  DeviceStateCollector,
  | "collectWakefulness"
  | "collectDeviceLock"
  | "collectBackStack"
  | "collectForegroundIdentity"
  | "collectForegroundSnapshot"
  | "collectFocusedSystemUiSurface"
  | "collectActiveWindow"
>;
