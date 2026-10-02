import { ActionableError } from "../models/ActionableError";

/**
 * Shared relay/WebRTC rule: admission stays transport-specific and unchanged. A live viewer
 * survives ownership changes; a live owner losing its device becomes a read-only viewer. The
 * subscribing identity ending terminates either kind. Device removal, identity quarantine and
 * daemon shutdown terminate both kinds. Auth-off skips ownership reconciliation entirely.
 * Subscribe-time capture hints are admission parameters for both kinds, not control messages.
 */
export type StreamSubscriptionKind = "owner" | "viewer";
export type StreamSubscriptionEndReason =
  | "device_removed"
  | "identity_quarantined"
  | "daemon_shutdown"
  | "session_ended";
export interface StreamSubscriptionIdentity {
  authEnabled: boolean;
  /** False for an unknown, expired, unavailable or currently releasing identity. */
  sessionExists: boolean;
  ownsDevice: boolean;
}
export type StreamSubscriptionDecision =
  | { action: "keep" }
  | { action: "downgrade" }
  | { action: "end"; reason: StreamSubscriptionEndReason };

export function subscriptionKindForIdentity(
  identity: StreamSubscriptionIdentity,
): StreamSubscriptionKind {
  return !identity.authEnabled || identity.ownsDevice ? "owner" : "viewer";
}

export function decideOwnershipChange(
  input: StreamSubscriptionIdentity & { kind: StreamSubscriptionKind },
): StreamSubscriptionDecision {
  if (!input.authEnabled) {
    return { action: "keep" };
  }
  if (!input.sessionExists) {
    return { action: "end", reason: "session_ended" };
  }
  if (input.kind === "owner" && !input.ownsDevice) {
    return { action: "downgrade" };
  }
  return { action: "keep" };
}

export function decideLifecycleEvent(input: {
  kind: StreamSubscriptionKind;
  event: Exclude<StreamSubscriptionEndReason, "session_ended">;
}): StreamSubscriptionDecision & { action: "end" } {
  return { action: "end", reason: input.event };
}

/** Unknown actions fail closed; the video relay ignores all post-handshake input without reply. */
export const STREAM_CONTROL_MESSAGE_CLASSIFICATION = {
  video_relay: { subscribe: "admission", postHandshake: "mutating" },
  webrtc: { start: "mutating", stop: "mutating", status: "read", list: "read", await: "read" },
} as const;
export type StreamControlMessage =
  | { transport: "video_relay"; action: string; postHandshake?: boolean }
  | { transport: "webrtc"; action: string };
export type StreamMessageClassification = "admission" | "mutating" | "read";

export function classifyStreamMessage(message: StreamControlMessage): StreamMessageClassification {
  if (message.transport === "video_relay") {
    return !message.postHandshake && message.action === "subscribe"
      ? STREAM_CONTROL_MESSAGE_CLASSIFICATION.video_relay.subscribe
      : STREAM_CONTROL_MESSAGE_CLASSIFICATION.video_relay.postHandshake;
  }
  const table: Readonly<Record<string, StreamMessageClassification>> =
    STREAM_CONTROL_MESSAGE_CLASSIFICATION.webrtc;
  return Object.hasOwn(table, message.action) ? table[message.action] : "mutating";
}

export class ViewerReadOnlyError extends ActionableError {
  readonly code = "viewer_read_only";
  constructor() {
    super(
      "Viewer subscriptions are read-only. Acquire device ownership before sending stream controls.",
    );
    this.name = "ViewerReadOnlyError";
  }
}

export function assertMayControl(
  kind: StreamSubscriptionKind,
  message: StreamControlMessage,
): void {
  if (kind === "viewer" && classifyStreamMessage(message) === "mutating") {
    throw new ViewerReadOnlyError();
  }
}
