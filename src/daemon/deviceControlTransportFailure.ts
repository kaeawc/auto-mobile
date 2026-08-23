import type { DaemonRequest } from "./types";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { errorMessage } from "../utils/describeUnknownError";

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

function hasTransportFailureHeader(
  record: Record<string, unknown>,
): record is Record<string, unknown> & {
  code: typeof DEVICE_CONTROL_TRANSPORT_FAILURE_CODE;
  transport: "daemon_loopback_http";
  toolName: string;
} {
  return (
    record.code === DEVICE_CONTROL_TRANSPORT_FAILURE_CODE
    && record.transport === "daemon_loopback_http"
    && typeof record.toolName === "string"
    && record.toolName.length > 0
  );
}

function sanitizeTransportFailureIdentity(
  record: Record<string, unknown>,
): Pick<
  DeviceControlTransportFailure,
  "deviceId" | "deviceSessionUuid" | "sessionUuid" | "routingSessionUuid"
> | undefined {
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

function hasTransportFailureState(
  record: Record<string, unknown>,
): record is Record<string, unknown> & {
  sessionValid: boolean;
  deviceSessionValid: boolean;
  phase: DeviceControlTransportPhase;
  retryable: boolean;
  reconnectAttempted: boolean;
  replayAttempted: boolean;
} {
  return (
    typeof record.sessionValid === "boolean"
    && typeof record.deviceSessionValid === "boolean"
    && (record.phase === "connect" || record.phase === "response")
    && typeof record.retryable === "boolean"
    && typeof record.reconnectAttempted === "boolean"
    && typeof record.replayAttempted === "boolean"
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
  if (
    !hasTransportFailureHeader(record)
    || !identity
    || !hasTransportFailureState(record)
  ) {
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

export function isUnexpectedSocketClosure(error: unknown): boolean {
  if (error instanceof McpError) {
    return false;
  }
  return errorMessage(error).includes("The socket connection was closed unexpectedly");
}

export function isDeviceControlTransportRequest(request: DaemonRequest): boolean {
  if (request.method !== "tools/call") {
    return false;
  }
  const toolName = request.params?.name;
  return toolName === "launchApp" || toolName === "observe";
}

export function isReplaySafeAfterResponseClosure(request: DaemonRequest): boolean {
  return request.method === "tools/call" && request.params?.name === "observe";
}

export function deviceControlToolName(request: DaemonRequest): string {
  const name = request.method === "tools/call" ? request.params?.name : undefined;
  return typeof name === "string" && name.length > 0 ? name : request.method;
}
