import { AMBIENT_ENV, readEnvRaw } from "../config/env";
import type { BootAdmission } from "../models/BootAdmission";
import type { IosBootInstrumentation } from "../models/IosBootInstrumentation";
import type { Platform } from "../models/Platform";
import { logger } from "../utils/logger";

/** Admits an Android emulator cold boot once the host has capacity for it (#11181). */
export interface AndroidColdBootAdmitter {
  /** Rejects with `BootCapacityExhaustedError` when no slot frees within `timeoutMs`. */
  admit(request: {
    timeoutMs: number;
    signal?: AbortSignal;
    avdName: string;
  }): Promise<BootAdmission>;
}

/**
 * The boot-admission surface the device tier needs. The devices tier owns this interface; the
 * daemon composition root installs the real shared gates with {@link installBootAdmissionServices}
 * (see `daemon/bootAdmissionWiring`, imported first by `src/index.ts`). Until then boots are not
 * gated, which is the same behaviour as `testOverrides.bootAdmissionGatesDisabled`.
 */
export interface BootAdmissionServices {
  /** The process-wide Android gate; undefined when Android boots are not gated. */
  androidColdBootAdmitter(): AndroidColdBootAdmitter | undefined;
  /** Boot instrumentation backed by the shared iOS gate and boot-duration history. */
  iosBootInstrumentation(): IosBootInstrumentation;
  /** Throws the typed retryable capacity error when one more cold boot does not fit. */
  assertBootCapacityAvailable(
    platform: Platform,
    options?: { signal?: AbortSignal },
  ): Promise<void>;
}

let warnedUngated = false;

function warnUngatedBoot(): void {
  if (readEnvRaw(AMBIENT_ENV.NODE_ENV) === "test" || warnedUngated) {
    return;
  }
  warnedUngated = true;
  logger.warn(
    "[BootAdmission] A device boot is running without boot admission gates; the daemon wiring " +
      "(daemon/bootAdmissionWiring) was not installed in this process.",
  );
}

const ungatedServices: BootAdmissionServices = {
  androidColdBootAdmitter: () => undefined,
  iosBootInstrumentation: () => ({
    run: (request, boot) => {
      warnUngatedBoot();
      return boot(request.timeoutMs);
    },
  }),
  assertBootCapacityAvailable: async () => {},
};

let installed: BootAdmissionServices | undefined;

/** Installs the real gates; returns the previous services so a test can restore them. */
export function installBootAdmissionServices(
  services: BootAdmissionServices | undefined,
): BootAdmissionServices | undefined {
  const previous = installed;
  installed = services;
  return previous;
}

/** True once the composition root installed the real gates in this process. */
export function bootAdmissionServicesInstalled(): boolean {
  return installed !== undefined;
}

/** Resolves the installed services on every call, so modules loaded first still see them. */
export const bootAdmissionServices: BootAdmissionServices = {
  androidColdBootAdmitter: () => (installed ?? ungatedServices).androidColdBootAdmitter(),
  iosBootInstrumentation: () => (installed ?? ungatedServices).iosBootInstrumentation(),
  assertBootCapacityAvailable: (platform, options) =>
    (installed ?? ungatedServices).assertBootCapacityAvailable(platform, options),
};
