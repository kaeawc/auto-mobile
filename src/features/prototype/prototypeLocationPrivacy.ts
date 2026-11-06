import type { PrototypeEvent } from "../observe/android/ctrlProxyProtocol";
import type { PrototypeJson } from "./prototypeJson";
import type { PrototypeLocationFix } from "./prototypeLocationOutcome";
import { isPrototypePlatformDeliveredEventName } from "./prototypePlatformEvent";
import { logger } from "../../utils/logger";

/**
 * Location privacy (#16463). A `location.updated` event reaches the host as an accuracy-only summary:
 * coordinates leave the device only when the spec emits them or writes them into `/data`.
 *
 * - {@link prototypeLocationEventSummary} is the reference the Android and iOS runtimes copy to build
 *   the delivered event's `data` from a fix; the shared cases live in
 *   `test/fixtures/prototype-location/event-summary.json`.
 * - {@link redactPrototypeLocationEvent} is the host's second layer: every decoded
 *   `prototype_platform_event` for `location.updated` keeps only the summary fields, whatever the
 *   device sent.
 */

export const PROTOTYPE_LOCATION_UPDATED_EVENT = "location.updated";

export interface PrototypeLocationEventSummary {
  accuracyM: number;
  approximate: boolean;
}

/** The delivered `location.updated` data for one fix: its accuracy and whether it is approximate. */
export function prototypeLocationEventSummary(
  fix: Pick<PrototypeLocationFix, "accuracyM" | "approximate">,
): PrototypeLocationEventSummary {
  return { accuracyM: fix.accuracyM, approximate: fix.approximate };
}

function isRecord(value: PrototypeJson): value is { [key: string]: PrototypeJson } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Keeps only a finite `accuracyM` and a boolean `approximate` from delivered `location.updated`
 * data. Anything else (coordinates, altitude, speed, bearing, unknown keys, a non-object) is dropped,
 * so the result never holds more than the summary.
 */
export function redactPrototypeLocationEventData(
  data: PrototypeJson,
): Partial<PrototypeLocationEventSummary> {
  if (!isRecord(data)) {
    return {};
  }
  const { accuracyM, approximate } = data;
  return {
    ...(typeof accuracyM === "number" && Number.isFinite(accuracyM) ? { accuracyM } : {}),
    ...(typeof approximate === "boolean" ? { approximate } : {}),
  };
}

function deliveredLocationPayload(
  event: Pick<PrototypeEvent, "kind" | "name" | "payload">,
): { [key: string]: PrototypeJson } | undefined {
  const payload = event.payload;
  return isPrototypePlatformDeliveredEventName(event) &&
    isRecord(payload) &&
    payload.event === PROTOTYPE_LOCATION_UPDATED_EVENT
    ? payload
    : undefined;
}

/**
 * The event with a delivered `location.updated` payload's `data` reduced to the summary; any other
 * event is returned unchanged. A device that sent more than the summary is a runtime bug, so the
 * drop is logged with the removed key names (never their values).
 */
export function redactPrototypeLocationEvent<
  E extends Pick<PrototypeEvent, "kind" | "name" | "payload">,
>(event: E): E {
  const payload = deliveredLocationPayload(event);
  if (payload === undefined) {
    return event;
  }
  const data = payload.data ?? null;
  const redacted = redactPrototypeLocationEventData(data);
  const dropped = isRecord(data)
    ? Object.keys(data).filter((key) => !Object.hasOwn(redacted, key))
    : data === null
      ? []
      : ["<non-object>"];
  if (dropped.length > 0) {
    logger.warn(
      `[prototype] Dropped location.updated fields the host never receives: ${dropped.join(", ")}`,
    );
  }
  return { ...event, payload: { ...payload, data: redacted } };
}
