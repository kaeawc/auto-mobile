import type { DeviceDiscoveryError } from "../devices/deviceUtils";
import { ActionableError } from "./ActionableError";
import type { Platform } from "./Platform";

/**
 * Booted-device discovery did not complete this sweep (adb/simctl
 * unavailable/failed). A transient failure must never be treated as an
 * authoritative empty result — that would let boot or adoption proceed
 * without having proven identity uniqueness (issue #7179). The failure is
 * retryable: callers should re-attempt discovery rather than fall back to
 * an unqualified boot/adopt decision.
 */
export class BootedDeviceDiscoveryIncompleteError extends ActionableError {
  readonly code = "discovery_incomplete";
  readonly retryable = true;

  constructor(
    readonly platform: Platform,
    readonly discoveryError: DeviceDiscoveryError | undefined,
  ) {
    super(
      `discovery_incomplete: ${platform === "android" ? "Android" : "iOS"} booted-device ` +
        "discovery was incomplete and is retryable" +
        (discoveryError ? `: ${discoveryError.message}` : "."),
    );
  }
}

/** Android flavour of {@link BootedDeviceDiscoveryIncompleteError}. */
export class AndroidBootedDeviceDiscoveryIncompleteError extends BootedDeviceDiscoveryIncompleteError {
  constructor(discoveryError: DeviceDiscoveryError | undefined) {
    super("android", discoveryError);
  }
}
