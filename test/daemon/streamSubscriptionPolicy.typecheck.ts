import {
  decideLifecycleEvent,
  type StreamSubscriptionEndReason,
  type StreamSubscriptionDecision,
} from "../../src/daemon/streamSubscriptionPolicy";
import type {
  endWebRtcStreamsForDevice,
  stopAllWebRtcStreams,
} from "../../src/server/webrtcStreamManager";

const reason: StreamSubscriptionEndReason = "stopped_by_owner";
// @ts-expect-error Owner stop is not a device lifecycle event.
const event: Parameters<typeof decideLifecycleEvent>[0]["event"] = reason;
// @ts-expect-error Owner stop is not an ownership reconciliation outcome.
const decision: StreamSubscriptionDecision = { action: "end", reason };
// @ts-expect-error Device cleanup excludes owner control reasons.
const deviceEnd: Parameters<typeof endWebRtcStreamsForDevice>[0]["reason"] = reason;
// @ts-expect-error Shutdown cleanup excludes owner control reasons.
const shutdown: Parameters<typeof stopAllWebRtcStreams>[0] = reason;
void [event, decision, deviceEnd, shutdown];
