import { type OwnedTermination } from "./coldBootProcessTermination";
import type { DeviceBootRequest } from "./deviceBootService";
import { type VirtualDeviceLifecycleLease } from "./virtualDeviceLifecycleCoordinator";
export interface BootDeadlineContext {
  request: DeviceBootRequest;
  operationName: string;
  startedAtMs: number;
  deadlineMs: number;
  /** Name of the device being booted, once resolved; named by a timeout error (#11548). */
  deviceLabel?: string;
  signal?: AbortSignal;
  lifecycleLease?: VirtualDeviceLifecycleLease;
  ownsLifecycleLease: boolean;
  /** Exit promises of owned emulators that could not be confirmed dead; the lease outlives them. */
  unconfirmedProcessExits: Promise<void>[];
  /**
   * Terminations the request stopped waiting for (it was cancelled or out of budget). Each
   * settles only once its AVD is free, so the lease outlives them (#9920).
   */
  pendingTerminations: Promise<void>[];
  /**
   * The termination of a cancelled launch's child when this service cannot hold the lease for it.
   * The start phase rejects on the abort regardless, so the boot awaits this before it rejects.
   */
  unheldLaunchTermination?: Promise<OwnedTermination>;
  /** A fresh provision's cold boot opts Android readiness into offline recovery (#7054). */
  freshProvision?: boolean;
}
