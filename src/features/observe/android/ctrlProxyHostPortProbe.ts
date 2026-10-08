import {
  NetDaemonPortAvailabilityChecker,
  type DaemonPortAvailabilityChecker,
} from "../../../daemon/portAvailability";

let probe: DaemonPortAvailabilityChecker = new NetDaemonPortAvailabilityChecker();

/**
 * Async bind probe run immediately before an `adb forward`, closing the window
 * between port allocation and use (#10795). Unit tests replace it so no real
 * socket is bound.
 */
export function isCtrlProxyHostPortFree(port: number, host = "127.0.0.1"): Promise<boolean> {
  return probe.isPortFree(port, host);
}

export function setCtrlProxyHostPortProbeForTesting(
  next: DaemonPortAvailabilityChecker | null,
): void {
  probe = next ?? new NetDaemonPortAvailabilityChecker();
}
