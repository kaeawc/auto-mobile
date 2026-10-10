/**
 * One cold boot admitted by a boot admission gate (#11181). Idempotent: every
 * method may be called more than once, and only the first call counts.
 */
export interface BootAdmission {
  /** Frees the slot at once: the boot failed, was cancelled, or adopted a running device. */
  release(): void;
  /**
   * The device was launched and is booting as `deviceId` (when known): keep
   * counting it until the platform listing shows it, the gate's boot deadline
   * passes, or {@link release} is called, whichever is first.
   */
  handOff(deviceId: string | undefined): void;
}

/** Takes an admission before a cold boot; rejects at once with `BootCapacityExhaustedError` when the platform is at its limit. */
export type AdmitColdBoot = () => Promise<BootAdmission>;
