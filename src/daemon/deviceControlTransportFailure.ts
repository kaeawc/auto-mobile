import type { DaemonRequest } from "./types";
import { McpError } from "@modelcontextprotocol/sdk/types.js";

export const DEVICE_CONTROL_TRANSPORT_FAILURE_CODE = "device_control_transport_failure";

export type DeviceControlTransportPhase = "connect" | "response";

export interface DeviceControlTransportFailure {
  code: typeof DEVICE_CONTROL_TRANSPORT_FAILURE_CODE;
  transport: "daemon_loopback_http";
  toolName: string;
  deviceId?: string;
  deviceSessionUuid?: string;
  sessionUuid?: string;
  sessionValid: boolean;
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

export function isUnexpectedSocketClosure(error: unknown): boolean {
  if (error instanceof McpError) {
    return false;
  }
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("The socket connection was closed unexpectedly");
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
