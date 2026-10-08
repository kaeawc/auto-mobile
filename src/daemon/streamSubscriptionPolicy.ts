import { ActionableError } from "../models/ActionableError";

/**
 * Shared relay/WebRTC rule: any live, non-releasing device session or registered observer
 * session may attach read-only to any device (#10698); its owner session has owner kind.
 * Viewers cannot mutate an owner's capture parameters or control.
 * A live viewer survives ownership changes; an owner losing its device becomes a
 * read-only viewer. The subscribing identity ending terminates either kind. Device
 * removal, VM restore, identity quarantine and daemon shutdown terminate both kinds.
 * Auth-off skips ownership reconciliation entirely and retains legacy hint/control behavior.
 * WebRTC lease holders may release/renew their own leases without stream control authority.
 * Device owners may stop all WebRTC leases (stopped_by_owner); the relay has no owner stop.
 * Relay viewer hints are ignored while the device has an owner; a first owner join
 * replaces viewer-created hints and size. Fresh WebRTC viewers use capture defaults;
 * owner parameter changes replace capture and end other leases with stopped_by_owner.
 */
export type StreamSubscriptionKind = "owner" | "viewer";
export type StreamSubscriptionLifecycleEndReason =
  | "device_removed"
  | "device_restored"
  | "identity_quarantined"
  | "daemon_shutdown";
export type StreamSubscriptionEndReason =
  | StreamSubscriptionLifecycleEndReason
  | "session_ended"
  | "stopped_by_owner";
export interface StreamSubscriptionIdentity {
  authEnabled: boolean;
  /** False for an unknown, expired, unavailable or currently releasing identity. */
  sessionExists: boolean;
  ownsDevice: boolean;
  /** Internal admission fact for relay hints; absent legacy facts fail closed for viewers. */
  hasDeviceOwner?: boolean;
}
export type StreamSubscriptionDecision =
  | { action: "keep" }
  | { action: "downgrade" }
  | { action: "end"; reason: "session_ended" };

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
  event: StreamSubscriptionLifecycleEndReason;
}): { action: "end"; reason: StreamSubscriptionLifecycleEndReason } {
  return { action: "end", reason: input.event };
}

/** Unknown actions fail closed; the video relay ignores all post-handshake input without reply. */
export const STREAM_CONTROL_MESSAGE_CLASSIFICATION = {
  video_relay: { subscribe: "admission", postHandshake: "mutating" },
  webrtc: {
    start: { stream: "mutating", own_lease: "own_lease" },
    stop: { stream: "mutating", own_lease: "own_lease" },
    status: "read",
    list: "read",
    await: "read",
  },
} as const;
export type StreamControlMessage =
  | { transport: "video_relay"; action: string; postHandshake?: boolean }
  | { transport: "webrtc"; action: string; target?: "own_lease" | "stream" };
export type StreamMessageClassification = "admission" | "mutating" | "read" | "own_lease";

export function classifyStreamMessage(message: StreamControlMessage): StreamMessageClassification {
  if (message.transport === "video_relay") {
    return !message.postHandshake && message.action === "subscribe"
      ? STREAM_CONTROL_MESSAGE_CLASSIFICATION.video_relay.subscribe
      : STREAM_CONTROL_MESSAGE_CLASSIFICATION.video_relay.postHandshake;
  }
  if (message.action === "start" || message.action === "stop") {
    return STREAM_CONTROL_MESSAGE_CLASSIFICATION.webrtc[message.action][
      message.target === "own_lease" ? "own_lease" : "stream"
    ];
  }
  const table: Readonly<Record<string, StreamMessageClassification | object>> =
    STREAM_CONTROL_MESSAGE_CLASSIFICATION.webrtc;
  const classification = Object.hasOwn(table, message.action) ? table[message.action] : "mutating";
  return typeof classification === "string" ? classification : "mutating";
}

export class ViewerReadOnlyError extends ActionableError {
  readonly code = "viewer_read_only";
  constructor() {
    super(
      "Viewer subscriptions may release or renew their own leases; acquire device ownership before changing stream parameters or controlling other subscriptions.",
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
