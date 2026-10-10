/**
 * One cold boot admitted by a boot admission gate (#11181). `release` is idempotent. `handOff`
 * may be repeated while the slot is held (the later call can supply the device id) and does
 * nothing once the slot was released.
 */
export interface BootAdmission {
  /** Frees the slot at once: the boot failed, was cancelled, or adopted a running device. */
  release(): void;
  /**
   * The device process exists and is booting as `deviceId` (when known). Call it as soon as the
   * process is spawned: until then the gate counts the boot as one with no process yet. The
   * gate keeps counting it until the platform listing shows it, the gate's boot deadline passes,
   * or {@link release} is called, whichever is first.
   */
  handOff(deviceId: string | undefined): void;
}

/** Takes an admission before a cold boot; rejects at once with `BootCapacityExhaustedError` when the platform is at its limit. */
export type AdmitColdBoot = () => Promise<BootAdmission>;
