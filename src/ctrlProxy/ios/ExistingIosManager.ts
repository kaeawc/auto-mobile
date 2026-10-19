import type { IOSCtrlProxyManager } from "../IOSCtrlProxyManager";

/** What device removal and reappearance need of an already-created manager. */
export type ExistingIosManager = Pick<
  IOSCtrlProxyManager,
  "suspendForDeviceRemoval" | "rearmAfterDeviceReappearance"
>;
