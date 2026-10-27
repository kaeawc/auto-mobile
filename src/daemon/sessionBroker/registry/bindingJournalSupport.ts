import type { DeviceInfo } from "../../../models/index";
import type { BindingInventorySnapshot } from "../provisioning/reconciler";
import { deviceStableId } from "./deviceIdentity";
import type { BindingJournalEntry } from "./bindingRegistry";
import { BindingJournalDriveCancelled } from "./BindingJournalDriveCancelled";

/** Unwinds a journal-owned drive whose caller cancelled it. */
export function checkCancellation(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new BindingJournalDriveCancelled(signal.reason);
  }
}

export function findByStableId(
  inventory: BindingInventorySnapshot,
  platform: BindingJournalEntry["platform"],
  stableId: string,
): DeviceInfo | undefined {
  return inventory.devices.find(
    (device) => device.platform === platform && deviceStableId(device) === stableId,
  );
}

export const BINDING_JOURNAL_OVERDUE_DELETE_GRACE_MS = 1_000;
export const BINDING_JOURNAL_MAX_ABANDONED_DELETES = 3;
export const BINDING_JOURNAL_REMOVAL_FLAG_MAX_ATTEMPTS = 6;
/** Durability gets one caller-independent attempt without indefinitely holding its session. */
export const BINDING_JOURNAL_REMOVAL_FLAG_WRITE_BUDGET_MS = 500;
