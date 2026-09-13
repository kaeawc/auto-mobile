import type { BootedDevice } from "../../models";
import type { AdbExecutor } from "./interfaces/AdbExecutor";
import { AdbClient } from "./AdbClient";
import type { RetryExecutor } from "../retry/RetryExecutor";
import { daemonDeviceAdmissionGate } from "../../daemon/deviceAdmissionGate";

/**
 * Factory interface for creating AdbClient instances.
 * Enables dependency injection for testing.
 */
export interface AdbClientFactory {
  /**
   * Create an AdbClient for the given device.
   * @param device - The target device (optional for device-independent operations)
   * @param retryExecutor - Optional retry executor for command retries
   * @returns An AdbExecutor instance
   */
  create(device?: BootedDevice | null, retryExecutor?: RetryExecutor): AdbExecutor;
}

/**
 * Default factory that creates real AdbClient instances.
 */
class DefaultAdbClientFactory implements AdbClientFactory {
  create(device?: BootedDevice | null, retryExecutor?: RetryExecutor): AdbExecutor {
    if (retryExecutor) {
      return new AdbClient(device ?? null, null, null, retryExecutor);
    }
    return new AdbClient(device ?? null);
  }
}

/** Completes the FUNNEL 2 refusal: "Refusing `<purpose>` on device '<serial>'". */
const ADB_CLIENT_PURPOSE = "to run an adb command";

/**
 * FUNNEL 2 at the seam every Android device-addressed operation crosses.
 *
 * Binding a serial to an `AdbClient` is the single act that turns "a caller named
 * this device" into "this process is driving that device", and every route into
 * the daemon converges on it: an MCP tool call with a session and one without,
 * with autolock on or off; an MCP resource read; a stream or recording
 * subscription; each target an all-device fan-out expands to. Gating the entry
 * points one at a time never finished, because each review found another route
 * that reached a device without passing the one that had been gated
 * ([#6888](https://github.com/kaeawc/auto-mobile/pull/6888) review).
 *
 * Android-only is complete coverage, not a gap: the quarantine is a statement
 * about a serial that can be REASSIGNED, and `DevicePool.hasReusableSerial`
 * restricts that to Android emulator serials. An iOS UDID is never reused, so no
 * iOS device-client seam can ever face a quarantined entry.
 *
 * The exception is {@link unadmittedAdbClientFactory}, for the machinery that has
 * to reach a quarantined serial precisely BECAUSE it is quarantined.
 */
class AdmittingAdbClientFactory implements AdbClientFactory {
  constructor(private readonly delegate: AdbClientFactory) {}

  create(device?: BootedDevice | null, retryExecutor?: RetryExecutor): AdbExecutor {
    if (device) {
      daemonDeviceAdmissionGate.assertDeviceActionable(device.deviceId, ADB_CLIENT_PURPOSE);
    }
    return this.delegate.create(device, retryExecutor);
  }
}

/**
 * The identity, lifecycle and teardown machinery's factory: it is BELOW the
 * admission gate rather than behind it.
 *
 * Discovery reading the AVD name on a quarantined serial is the only event that
 * can LIFT the quarantine, and `emu kill` on one is how the pool settles a serial
 * it can no longer identify — gating either would wedge the entry permanently.
 * Nothing here acts on the pooled LABEL; it acts on the runtime in order to
 * establish what that label should be.
 */
export const unadmittedAdbClientFactory: AdbClientFactory = new DefaultAdbClientFactory();

/**
 * Singleton instance of the default factory.
 */
export const defaultAdbClientFactory: AdbClientFactory = new AdmittingAdbClientFactory(
  unadmittedAdbClientFactory,
);
