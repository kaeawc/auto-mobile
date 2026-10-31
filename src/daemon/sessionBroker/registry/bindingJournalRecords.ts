import {
  androidBindingSpecSchema,
  iosBindingSpecSchema,
  watchBindingSpecSchema,
} from "../../../utils/provisionDeviceSpecSchemas";
import type { BindingRequestedSpec } from "../provisioning/reconciler";
import {
  type BindingJournalBlockReason,
  type BindingJournalRedriveRecord,
  type Step,
} from "./bindingJournalTypes";
import {
  journalCreationPlatform,
  type BindingBindingCommit,
  type BindingPlatform,
  type BindingJournalEntry,
} from "./bindingRegistry";
export function skippedReason(entry: BindingJournalEntry): BindingJournalBlockReason {
  if (entry.kind === "release") {
    return "binding_settling";
  }
  if (entry.phase !== "deleting") {
    return "reconcile_in_progress";
  }
  return entry.target.quarantinedAtMs === undefined ? "cleanup_pending" : "cleanup_quarantined";
}

export function emptyBindingCommit(requestedSpec: unknown): BindingBindingCommit {
  return {
    stableDeviceId: null,
    deviceName: null,
    requestedSpec,
    resolvedSpec: null,
    specFingerprint: null,
    state: "provisioning",
  };
}

export function toRecord(
  result: Extract<Step, { kind: "settled" | "blocked" }>,
): BindingJournalRedriveRecord {
  return {
    entryId: result.entry.id,
    kind: result.entry.kind,
    phase: result.entry.phase,
    outcome: result.kind,
    ...(result.kind === "blocked" ? { reason: result.reason } : {}),
  };
}

/** A watch spec is never read with the iOS schema: it has its own exact runtime + device type. */
const SPEC_SCHEMAS = {
  android: androidBindingSpecSchema,
  ios: iosBindingSpecSchema,
  watchos: watchBindingSpecSchema,
} as const satisfies Record<BindingPlatform, unknown>;

/**
 * The entry's recorded requested spec, validated; undefined when it no longer parses. A managed
 * binding's requested spec may omit `deviceType` (owner decision Q4), so it is read with the managed
 * schema: reading it as an exact spec would turn an adoptable create into a deletion.
 */
export function recordedSpec(
  entry: Pick<BindingJournalEntry, "platform" | "target">,
): BindingRequestedSpec | undefined {
  const parsed = SPEC_SCHEMAS[journalCreationPlatform(entry)].safeParse(entry.target.requestedSpec);
  return parsed.success ? parsed.data : undefined;
}
