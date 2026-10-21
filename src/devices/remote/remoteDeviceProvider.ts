/**
 * Contract for renting a real Android device from a remote lab (#14054). The first provider is
 * Android Device Streaming through the DDP Device Streaming API. Connecting the reserved device to
 * adb is a separate step, added with the ADB transport.
 */
import type { RemoteDeviceCostEstimate } from "./remoteDeviceCostPolicy";

export type RemoteDeviceSessionState =
  | "requested"
  | "pending"
  | "active"
  | "finished"
  | "expired"
  | "unavailable"
  | "error"
  | "unknown";

const TERMINAL_STATES: ReadonlySet<RemoteDeviceSessionState> = new Set([
  "finished",
  "expired",
  "unavailable",
  "error",
]);

export function isTerminalRemoteSessionState(state: RemoteDeviceSessionState): boolean {
  return TERMINAL_STATES.has(state);
}

export interface RemoteDeviceSession {
  /** Provider resource name, e.g. `projects/<project>/deviceSessions/<id>`. */
  id: string;
  state: RemoteDeviceSessionState;
  /** The provider's explanation of the current state, when it gives one. */
  stateMessage?: string;
  activeStartTimeMs?: number;
  expireTimeMs?: number;
}

export interface RemoteDeviceRequest {
  /** Provider model id, e.g. a Device Streaming `androidModelId`. */
  modelId: string;
  /** Provider OS version id, e.g. a Device Streaming `androidVersionId`. */
  osVersionId: string;
  /** Requested session length. Bounded by the configured guards. */
  minutes: number;
  locale?: string;
  orientation?: string;
}

export interface RemoteDeviceReservation {
  session: RemoteDeviceSession;
  /** Cost of the minutes this call reserved, not of the whole session. */
  cost: RemoteDeviceCostEstimate;
}

export interface RemoteDeviceProvider {
  /** Reserves a device and resolves once it is active; cancels the session if it never gets there. */
  reserve(request: RemoteDeviceRequest, signal?: AbortSignal): Promise<RemoteDeviceReservation>;
  /** Adds `minutes` to an active session. */
  extend(sessionId: string, minutes: number): Promise<RemoteDeviceReservation>;
  get(sessionId: string): Promise<RemoteDeviceSession>;
  /** Ends the session. Releasing a session that has already ended succeeds. */
  release(sessionId: string): Promise<void>;
}

/** Milliseconds left before the session expires, or undefined when the provider gave no end time. */
export function remainingSessionMs(
  session: Pick<RemoteDeviceSession, "state" | "expireTimeMs">,
  nowMs: number,
): number | undefined {
  if (isTerminalRemoteSessionState(session.state)) {
    return 0;
  }
  if (session.expireTimeMs === undefined) {
    return undefined;
  }
  return Math.max(0, session.expireTimeMs - nowMs);
}
