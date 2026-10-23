import { ActionableError } from "../../../models/ActionableError";

export type MutationIncarnationKey =
  | { platform: "android"; resourceId: string; stableDeviceId: string; bootId: string | null }
  | { platform: "ios"; scopeKey: string; allocationIndex: number; stableDeviceId: string };

/** Shared identity for recorder rows and reset baselines; Android resource IDs lead for pruning. */
export function mutationIncarnation(key: MutationIncarnationKey): string {
  const strings =
    key.platform === "android"
      ? [key.resourceId, key.stableDeviceId, ...(key.bootId === null ? [] : [key.bootId])]
      : [key.scopeKey, key.stableDeviceId];
  if (
    strings.some((value) => typeof value !== "string" || !value.trim()) ||
    (key.platform === "ios" &&
      (!Number.isSafeInteger(key.allocationIndex) || key.allocationIndex < 0))
  ) {
    throw new ActionableError(
      "Mutation incarnation requires non-empty identities and a safe non-negative allocation index",
    );
  }
  return JSON.stringify(
    key.platform === "android"
      ? [key.resourceId, key.stableDeviceId, key.bootId]
      : [key.scopeKey, key.allocationIndex, key.stableDeviceId],
  );
}
