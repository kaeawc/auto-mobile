import { toActionableError } from "../../../models/ActionableError";
import { logger } from "../../../utils/logger";

/** CtrlProxy's SDK batch retrieval decoder, shared with serialized contract tests. */
export interface DecodedSdkEvent {
  eventType: string;
  applicationId: string | undefined;
  payload: Record<string, unknown>;
  timestamp: number;
  sequenceNumber: number | undefined;
}

export interface SdkEventBatchWire {
  bundleId?: string;
  events?: Array<{ eventType: string; payload: string }>;
}

export interface DecodedSdkEventBatches {
  events: DecodedSdkEvent[];
  malformedErrors: unknown[];
}

export function decodeSdkEventBatches(
  batches: SdkEventBatchWire[],
  now: () => number,
  isCurrent: () => boolean = () => true,
): DecodedSdkEventBatches {
  const events: DecodedSdkEvent[] = [];
  const malformedErrors: unknown[] = [];
  for (const batch of batches) {
    if (!isCurrent()) {
      return { events: [], malformedErrors };
    }
    for (const envelope of batch.events ?? []) {
      try {
        events.push(decodeSdkEventEnvelope(batch.bundleId, envelope, now));
      } catch (error) {
        logger.warn("[IOSCtrlProxy] skipping malformed SDK event envelope", error);
        malformedErrors.push(error);
      }
    }
  }
  return { events, malformedErrors };
}

/** Pure envelope decoder; the batch boundary logs failures and retains valid neighbors. */
export function decodeSdkEventEnvelope(
  applicationId: string | undefined,
  envelope: { eventType: string; payload: string },
  now: () => number,
): DecodedSdkEvent {
  try {
    const decodedPayload = JSON.parse(Buffer.from(envelope.payload, "base64").toString("utf-8"));
    if (!decodedPayload || typeof decodedPayload !== "object" || Array.isArray(decodedPayload)) {
      throw new Error("SDK event payload must be an object");
    }
    const payload = decodedPayload as Record<string, unknown>;
    return {
      eventType: envelope.eventType,
      applicationId,
      payload,
      timestamp:
        typeof payload.timestamp === "number" && Number.isFinite(payload.timestamp)
          ? payload.timestamp
          : now(),
      sequenceNumber:
        typeof payload.sequenceNumber === "number" && Number.isSafeInteger(payload.sequenceNumber)
          ? payload.sequenceNumber
          : undefined,
    };
  } catch (error) {
    throw toActionableError(
      error,
      "Unable to decode SDK event envelope; check the SDK wire payload",
    );
  }
}
