/**
 * How a daemon is using a device whose CtrlProxy forwarding lease it holds
 * (issue #10497). One snapshot feeds both this daemon's idle releaser and its
 * `daemon/deviceLeaseStatus` answer to a would-be lease taker, so both agree.
 */
export interface DeviceLeaseActivity {
  sessionId: string | null;
  /** Tool executions bound to the device. */
  activeExecutions: number;
  /**
   * CtrlProxy requests in flight through this process's clients for the device,
   * including resource reads and observation frames no tool call is bound to.
   */
  inFlightRequests: number;
  /** A device-data stream subscriber (e.g. the IDE plugin) is watching it. */
  streaming: boolean;
  /** Time since the latest tool call, CtrlProxy request, or lease acquisition; null when none. */
  idleForMs: number | null;
}

export interface DeviceLeaseActivitySources {
  sessionForDevice(deviceId: string): string | null;
  activeExecutionCount(deviceId: string): number;
  toolIdleForMs(deviceId: string): number | null;
  hasStreamSubscriber(deviceId: string): boolean;
  clientActivity(deviceId: string): { inFlightRequests: number; idleForMs: number | null };
}

function minIdle(a: number | null, b: number | null): number | null {
  if (a === null) {
    return b;
  }
  return b === null ? a : Math.min(a, b);
}

export function readDeviceLeaseActivity(
  sources: DeviceLeaseActivitySources,
  deviceId: string,
): DeviceLeaseActivity {
  const client = sources.clientActivity(deviceId);
  return {
    sessionId: sources.sessionForDevice(deviceId),
    activeExecutions: sources.activeExecutionCount(deviceId),
    inFlightRequests: client.inFlightRequests,
    streaming: sources.hasStreamSubscriber(deviceId),
    idleForMs: minIdle(sources.toolIdleForMs(deviceId), client.idleForMs),
  };
}

export function isDeviceLeaseBusy(activity: DeviceLeaseActivity): boolean {
  return (
    activity.sessionId !== null ||
    activity.activeExecutions > 0 ||
    activity.inFlightRequests > 0 ||
    activity.streaming
  );
}
