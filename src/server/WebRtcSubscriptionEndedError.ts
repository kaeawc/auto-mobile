import { ActionableError } from "../models/ActionableError";
import type {
  StreamSubscriptionEndReason,
  StreamSubscriptionKind,
} from "../daemon/streamSubscriptionPolicy";

/** Dependency-free typed failure for the request/response WebRTC socket boundary. */
export class WebRtcSubscriptionEndedError extends ActionableError {
  readonly reason: StreamSubscriptionEndReason;
  readonly subscriptionKind: StreamSubscriptionKind;
  constructor({
    reason,
    subscriptionKind,
  }: {
    reason: StreamSubscriptionEndReason;
    subscriptionKind: StreamSubscriptionKind;
  }) {
    super(`WebRTC subscription ended: ${reason}; call start to re-subscribe.`);
    this.name = "WebRtcSubscriptionEndedError";
    this.reason = reason;
    this.subscriptionKind = subscriptionKind;
  }
}
