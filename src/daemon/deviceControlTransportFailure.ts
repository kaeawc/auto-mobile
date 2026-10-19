import { getToolTransportRecovery } from "./toolTransportRecovery";

/**
 * The `device_control_transport_failure` wire type (#11820). The daemon stopped producing it when
 * control-socket forwards moved in process (there is no loopback transport left to fail), but the
 * proxy and the daemon client still read it from a daemon of an older version, so the type, its
 * sanitizer and the proxy's tool result stay.
 */
export const DEVICE_CONTROL_TRANSPORT_FAILURE_CODE = "device_control_transport_failure";

export type DeviceControlTransportPhase = "connect" | "response";

export interface DeviceControlTransportFailure {
  code: typeof DEVICE_CONTROL_TRANSPORT_FAILURE_CODE;
  transport: "daemon_loopback_http";
  toolName: string;
  deviceId?: string;
  deviceSessionUuid?: string;
  sessionUuid?: string;
  routingSessionUuid?: string;
  /** Whether the captured daemon session still exists and retains its device assignment. */
  sessionValid: boolean;
  /** Whether the captured device epoch is still current for the target device. */
  deviceSessionValid: boolean;
  phase: DeviceControlTransportPhase;
  retryable: boolean;
  reconnectAttempted: boolean;
  replayAttempted: boolean;
}

export class DeviceControlTransportError extends Error {
  constructor(
    message: string,
    readonly failure: DeviceControlTransportFailure,
  ) {
    super(message);
    this.name = "DeviceControlTransportError";
  }
}

function hasTransportFailureHeader(record: Record<string, unknown>): record is Record<
  string,
  unknown
> & {
  code: typeof DEVICE_CONTROL_TRANSPORT_FAILURE_CODE;
  transport: "daemon_loopback_http";
  toolName: string;
} {
  return (
    record.code === DEVICE_CONTROL_TRANSPORT_FAILURE_CODE &&
    record.transport === "daemon_loopback_http" &&
    typeof record.toolName === "string" &&
    record.toolName.length > 0
  );
}

function sanitizeTransportFailureIdentity(
  record: Record<string, unknown>,
):
  | Pick<
      DeviceControlTransportFailure,
      "deviceId" | "deviceSessionUuid" | "sessionUuid" | "routingSessionUuid"
    >
  | undefined {
  const identity: Pick<
    DeviceControlTransportFailure,
    "deviceId" | "deviceSessionUuid" | "sessionUuid" | "routingSessionUuid"
  > = {};
  if (record.deviceId !== undefined) {
    if (typeof record.deviceId !== "string") {
      return undefined;
    }
    identity.deviceId = record.deviceId;
  }
  if (record.deviceSessionUuid !== undefined) {
    if (typeof record.deviceSessionUuid !== "string") {
      return undefined;
    }
    identity.deviceSessionUuid = record.deviceSessionUuid;
  }
  if (record.sessionUuid !== undefined) {
    if (typeof record.sessionUuid !== "string") {
      return undefined;
    }
    identity.sessionUuid = record.sessionUuid;
  }
  if (record.routingSessionUuid !== undefined) {
    if (typeof record.routingSessionUuid !== "string") {
      return undefined;
    }
    identity.routingSessionUuid = record.routingSessionUuid;
  }
  return identity;
}

function hasTransportFailureState(record: Record<string, unknown>): record is Record<
  string,
  unknown
> & {
  sessionValid: boolean;
  deviceSessionValid: boolean;
  phase: DeviceControlTransportPhase;
  retryable: boolean;
  reconnectAttempted: boolean;
  replayAttempted: boolean;
} {
  return (
    typeof record.sessionValid === "boolean" &&
    typeof record.deviceSessionValid === "boolean" &&
    (record.phase === "connect" || record.phase === "response") &&
    typeof record.retryable === "boolean" &&
    typeof record.reconnectAttempted === "boolean" &&
    typeof record.replayAttempted === "boolean"
  );
}

export function sanitizeDeviceControlTransportFailure(
  value: unknown,
): DeviceControlTransportFailure | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const identity = sanitizeTransportFailureIdentity(record);
  if (!hasTransportFailureHeader(record) || !identity || !hasTransportFailureState(record)) {
    return undefined;
  }
  return {
    code: DEVICE_CONTROL_TRANSPORT_FAILURE_CODE,
    transport: "daemon_loopback_http",
    toolName: record.toolName,
    ...identity,
    sessionValid: record.sessionValid,
    deviceSessionValid: record.deviceSessionValid,
    phase: record.phase,
    retryable: record.retryable,
    reconnectAttempted: record.reconnectAttempted,
    replayAttempted: record.replayAttempted,
  };
}

/**
 * Tools whose re-execution after an ambiguous delivery cannot change device
 * state: what the proxy's reconnect replay may run twice (issue #6382).
 */
export function isReplaySafeToolName(toolName: unknown): boolean {
  return typeof toolName === "string" && getToolTransportRecovery(toolName) === "replay";
}
