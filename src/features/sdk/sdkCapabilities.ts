import { z } from "zod";

/**
 * Host-side model of the Android SDK's versioned capability and capture-policy snapshot
 * (issue #5191). The Kotlin source of truth is `SdkCapabilityDocument`.
 */

export const SDK_CAPABILITY_STATES = [
  "SUPPORTED",
  "DISABLED",
  "UNSUPPORTED",
  "PERMISSION_DENIED",
  "NOT_INITIALIZED",
  "UNKNOWN",
] as const;

const sdkCapabilityDescriptorSchema = z.object({
  id: z.string().min(1),
  // A string state written by a newer SDK degrades to UNKNOWN, as the Kotlin decoder does. A missing
  // or non-string state is a malformed descriptor and fails the whole snapshot.
  state: z.string().transform((value): (typeof SDK_CAPABILITY_STATES)[number] => {
    return SDK_CAPABILITY_STATES.find((known) => known === value) ?? "UNKNOWN";
  }),
  reason: z.string().nullable().optional(),
});

const sdkCapturePolicySchema = z.object({
  captureHeaders: z.boolean().default(false),
  captureBodies: z.boolean().default(false),
  allowMutations: z.boolean().default(false),
});

/** Snapshot schema. Versions >= 1 share the version 1 structure; unknown keys are dropped. */
export const sdkCapabilitySnapshotSchema = z.object({
  schemaVersion: z.number().int().min(1),
  capabilities: z.array(sdkCapabilityDescriptorSchema),
  policy: sdkCapturePolicySchema,
});
export type SdkCapabilitySnapshot = z.infer<typeof sdkCapabilitySnapshotSchema>;
export type SdkCapabilityDescriptor = SdkCapabilitySnapshot["capabilities"][number];

/** Why no snapshot could be read; never conflated with an empty capability set. */
export const SDK_CAPABILITIES_UNAVAILABLE_REASONS = [
  /** The connected CtrlProxy APK predates `get_sdk_capabilities`. */
  "CTRLPROXY_UNSUPPORTED",
  /** CtrlProxy could not be reached on the device. */
  "CTRLPROXY_UNREACHABLE",
  /** The app does not ship a debug SDK that exposes the snapshot (older SDK or release build). */
  "BRIDGE_NOT_INSTALLED",
  /** The app's bridge exists but did not answer. */
  "BRIDGE_UNAVAILABLE",
  /** The bridge answered with data that does not match the snapshot schema. */
  "MALFORMED_RESPONSE",
  /** The app runs in another Android user and CtrlProxy lacks INTERACT_ACROSS_USERS. */
  "CROSS_USER_UNSUPPORTED",
  /** CtrlProxy did not answer in time. */
  "REQUEST_TIMEOUT",
  /** No app id was supplied and no foreground app could be determined. */
  "NO_APP",
  /** The device platform has no Android SDK bridge. */
  "UNSUPPORTED_PLATFORM",
] as const;
export type SdkCapabilitiesUnavailableReason =
  (typeof SDK_CAPABILITIES_UNAVAILABLE_REASONS)[number];

export type SdkCapabilitiesResult =
  | { status: "available"; snapshot: SdkCapabilitySnapshot }
  | { status: "unavailable"; reason: SdkCapabilitiesUnavailableReason };

export function sdkCapabilitiesUnavailable(
  reason: SdkCapabilitiesUnavailableReason,
): SdkCapabilitiesResult {
  return { status: "unavailable", reason };
}

/** Loose wire envelope; the nested snapshot is validated separately so one bad field is typed. */
const wireStateSchema = z.object({
  outcome: z.string(),
  reason: z.string().nullable().optional(),
  snapshot: z.unknown().optional(),
});

/** Converts the CtrlProxy `sdk_capabilities` state into a typed result. Never throws. */
export function parseSdkCapabilitiesState(raw: unknown): SdkCapabilitiesResult {
  const envelope = wireStateSchema.safeParse(raw);
  if (!envelope.success) {
    return sdkCapabilitiesUnavailable("MALFORMED_RESPONSE");
  }
  const { outcome, reason, snapshot } = envelope.data;
  if (outcome === "ok") {
    const parsed = sdkCapabilitySnapshotSchema.safeParse(snapshot);
    return parsed.success
      ? { status: "available", snapshot: parsed.data }
      : sdkCapabilitiesUnavailable("MALFORMED_RESPONSE");
  }
  if (outcome !== "unavailable") {
    // The wire contract defines only `ok` and `unavailable`; anything else is a corrupt or
    // version-skewed frame, not a statement about the bridge.
    return sdkCapabilitiesUnavailable("MALFORMED_RESPONSE");
  }
  const known = SDK_CAPABILITIES_UNAVAILABLE_REASONS.find((candidate) => candidate === reason);
  return sdkCapabilitiesUnavailable(known ?? "BRIDGE_UNAVAILABLE");
}

/** Existing Android test-control boundary; resources inject a fake instead of connecting. */
export interface SdkCapabilitiesReader {
  /** `userId` is the app's Android user; omitted reads CtrlProxy's own user. */
  getSdkCapabilities(packageName: string, userId?: number): Promise<SdkCapabilitiesResult>;
}
