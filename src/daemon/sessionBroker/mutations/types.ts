import { z } from "zod/v4";
import { ActionableError } from "../../../models/ActionableError";

export const mutationValueSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("absent") }),
  z.object({ state: z.literal("present"), value: z.json() }),
  z.object({ state: z.literal("unobservable") }),
]);

export type MutationValue = z.infer<typeof mutationValueSchema>;

export function observableMutationValue(value: unknown): MutationValue {
  const parsed = mutationValueSchema.safeParse({ state: "present", value });
  return parsed.success ? parsed.data : { state: "unobservable" };
}

export interface DeviceIncarnationScope {
  deviceId: string;
  incarnation: string;
}

export interface DeviceMutationScope extends DeviceIncarnationScope {
  sessionUuid: string;
}

export function assertDeviceMutationScope(
  scope: DeviceIncarnationScope,
  sessionUuid?: string,
): void {
  const parts = [
    scope.deviceId,
    scope.incarnation,
    ...(sessionUuid === undefined ? [] : [sessionUuid]),
  ];
  if (parts.some((part) => part.trim().length === 0)) {
    throw new ActionableError("Device mutation journal requires a durable, non-empty identity");
  }
}

export interface DeviceMutationInput {
  kind: string;
  key: string;
  priorValue: MutationValue;
  toolName: string;
}

export interface DeviceMutationEntry extends DeviceMutationInput {
  sequence: number;
  appliedAt: number;
}

export const deviceBaselineSchema = z.object({
  completeKinds: z.array(z.string().min(1)),
  observations: z.array(
    z.object({ kind: z.string().min(1), key: z.string().min(1), value: mutationValueSchema }),
  ),
  unobservable: z.array(z.string().min(1)),
  unobservableReasons: z.record(z.string(), z.string()).optional(),
});

export type DeviceBaseline = z.infer<typeof deviceBaselineSchema>;
export type DeviceStateObservation = DeviceBaseline["observations"][number];

export interface DeviceMutationJournal {
  record(scope: DeviceMutationScope, mutation: DeviceMutationInput): Promise<void>;
  list(scope: DeviceMutationScope): Promise<readonly DeviceMutationEntry[]>;
  /** Same device/session rows whose incarnation differs from the requested reset scope. */
  listStrayIncarnations(scope: DeviceMutationScope): Promise<readonly DeviceMutationEntry[]>;
  deleteSession(scope: DeviceMutationScope): Promise<void>;
  captureBaseline(scope: DeviceIncarnationScope, baseline: DeviceBaseline): Promise<void>;
  getBaseline(scope: DeviceIncarnationScope): Promise<DeviceBaseline | null>;
  deleteResource(resourceId: string): Promise<void>;
}

export const DEVICE_MUTATION_KINDS = [
  "installed-app",
  "app-group",
  "keychain",
  "permission",
  "device-setting",
  "keep-awake",
  "rotation",
  "screen-reader",
  "clipboard",
  "location",
  "status-bar",
  "notification",
  "media",
  "contact",
  "calendar",
  "keyboard",
  "clock",
  "network-condition",
  "biometric-enrollment",
  "profile",
  "certificate",
  "opened-url",
  "preference",
  "shared-file",
  "account",
] as const;

export async function applyJournaledMutation<Result>(
  journal: Pick<DeviceMutationJournal, "record">,
  scope: DeviceMutationScope,
  mutation: DeviceMutationInput,
  apply: () => Promise<Result>,
): Promise<Result> {
  await journal.record(scope, mutation);
  return apply();
}

/**
 * Key prefix of an opaque intent whose effect neither a journal revert nor the keep-booted
 * baseline clean can undo (app-owned data, a broadcast's side effects). Keep-booted reset must
 * escalate to its baseline fallback once such a row is journaled, the way it does for
 * `deviceSnapshot` (#14359). Other `opaque` rows stay best-effort breadcrumbs.
 */
export const FALLBACK_OPAQUE_KEY_PREFIX = "fallback:";

export function opaqueIntentKey(...parts: readonly unknown[]): string {
  return `${FALLBACK_OPAQUE_KEY_PREFIX}${JSON.stringify(parts)}`;
}

export function opaqueForcesFallback(entry: Pick<DeviceMutationInput, "kind" | "key">): boolean {
  return entry.kind === "opaque" && entry.key.startsWith(FALLBACK_OPAQUE_KEY_PREFIX);
}
