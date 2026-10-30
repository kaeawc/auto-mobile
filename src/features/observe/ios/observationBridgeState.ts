import { z } from "zod";

/**
 * Whether the foreground iOS app's SDK observation bridge can serve observations and actions
 * (#5159). The Swift source of truth is `ObservationBridgeState` in `ios/sdk-wire`; CtrlProxy
 * carries it in the `get_sdk_capabilities` reply.
 */
export const IOS_OBSERVATION_BRIDGE_UNAVAILABLE_REASONS = [
  /** The app's SDK has no bridge registered. */
  "NOT_REGISTERED",
  /** The app's SDK (or the runner) predates observation-bridge discovery. */
  "SDK_TOO_OLD",
  /** The foreground app does not embed the SDK, or its server did not answer. */
  "SDK_UNAVAILABLE",
  /** The bridge object does not match the schema. */
  "MALFORMED_RESPONSE",
  /** A reason written by a newer SDK. */
  "UNKNOWN",
] as const;
export type IosObservationBridgeUnavailableReason =
  (typeof IOS_OBSERVATION_BRIDGE_UNAVAILABLE_REASONS)[number];

export type IosObservationBridgeState =
  | { status: "available"; schemaVersion: number; supportedActions: string[] }
  | { status: "unavailable"; reason: IosObservationBridgeUnavailableReason };

const observationBridgeWireSchema = z.object({
  schemaVersion: z.number().int().min(1),
  available: z.boolean(),
  reason: z.string().nullable().optional(),
  supportedActions: z.array(z.string()).default([]),
});

export function observationBridgeUnavailable(
  reason: IosObservationBridgeUnavailableReason,
): IosObservationBridgeState {
  return { status: "unavailable", reason };
}

/** Parse the bridge object from a `get_sdk_capabilities` reply whose SDK is available. */
export function parseObservationBridgeState(value: unknown): IosObservationBridgeState {
  if (value === undefined || value === null) {
    return observationBridgeUnavailable("SDK_TOO_OLD");
  }
  const parsed = observationBridgeWireSchema.safeParse(value);
  if (!parsed.success) {
    return observationBridgeUnavailable("MALFORMED_RESPONSE");
  }
  const { schemaVersion, available, reason, supportedActions } = parsed.data;
  if (available) {
    return { status: "available", schemaVersion, supportedActions: [...supportedActions].sort() };
  }
  const known = IOS_OBSERVATION_BRIDGE_UNAVAILABLE_REASONS.find(
    (candidate) => candidate === reason,
  );
  return observationBridgeUnavailable(known ?? "UNKNOWN");
}
