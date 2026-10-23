import type { DeviceInfo } from "../../../models/index";
import { deviceStableId } from "./deviceIdentity";
import {
  journalCreationPlatform,
  sameBinding,
  type BindingJournalEntry,
  type BindingRegistry,
} from "./bindingRegistry";
import type { BindingJournalBlockReason } from "./bindingJournal";
import { checkCancellation, findByStableId } from "./bindingJournalSupport";
import type { BindingJournalStageRunner } from "./BindingJournalStageRunner";

/**
 * Finds the devices a journal entry acts on (to release, delete or adopt), treating incomplete or
 * failed discovery and live claims as blocks, never as absence.
 */
export class BindingJournalDeviceLocator {
  constructor(
    private readonly registry: Pick<BindingRegistry, "findDeviceHolder">,
    private readonly stages: Pick<BindingJournalStageRunner, "listInventory" | "describeClaim">,
  ) {}

  /** The released device must be listed and unclaimed, or proven absent, before reuse. */
  async checkDeviceFree(
    entry: BindingJournalEntry,
    stableId: string,
    signal?: AbortSignal,
  ): Promise<
    { kind: "free" } | { kind: "blocked"; reason: BindingJournalBlockReason; message: string }
  > {
    const inventory = await this.stages.listInventory(entry, entry.platform, signal);
    if (!inventory) {
      return {
        kind: "blocked",
        reason: "discovery_incomplete",
        message: "Device discovery failed.",
      };
    }
    const device = findByStableId(inventory, entry.platform, stableId);
    if (!device) {
      return inventory.complete
        ? { kind: "free" }
        : {
            kind: "blocked",
            reason: "discovery_incomplete",
            message: `Device '${stableId}' was not listed and discovery was incomplete.`,
          };
    }
    const claim = await this.stages.describeClaim(entry, device, signal);
    if (claim.kind === "free") {
      return { kind: "free" };
    }
    return {
      kind: "blocked",
      reason: claim.kind === "held" ? "device_busy" : "discovery_incomplete",
      message: `Device '${stableId}' is not free: ${claim.reason}`,
    };
  }

  async locateForDeletion(
    entry: BindingJournalEntry,
    oldId: string,
    signal?: AbortSignal,
    /** Present when the caller already proved the device listed and unclaimed. */
    known?: DeviceInfo,
  ): Promise<
    | { kind: "present"; device: DeviceInfo }
    | { kind: "absent" }
    | { kind: "blocked"; reason: BindingJournalBlockReason; message: string }
  > {
    if (known) {
      return { kind: "present", device: known };
    }
    const inventory = await this.stages.listInventory(entry, entry.platform, signal);
    if (!inventory) {
      return {
        kind: "blocked",
        reason: "discovery_incomplete",
        message: "Device discovery failed.",
      };
    }
    const device = findByStableId(inventory, entry.platform, oldId);
    if (!device) {
      // Only complete discovery proves absence.
      return inventory.complete
        ? { kind: "absent" }
        : {
            kind: "blocked",
            reason: "discovery_incomplete",
            message: `Device '${oldId}' was not listed and discovery was incomplete.`,
          };
    }
    const claim = await this.stages.describeClaim(entry, device, signal);
    if (claim.kind !== "free") {
      return {
        kind: "blocked",
        reason: claim.kind === "held" ? "device_busy" : "discovery_incomplete",
        message: `Device '${oldId}' cannot be deleted: ${claim.reason}`,
      };
    }
    const holder = await this.registry.findDeviceHolder(entry.platform, oldId);
    checkCancellation(signal);
    if (
      holder?.kind !== "binding" ||
      holder.assignment.scopeKey !== entry.scopeKey ||
      holder.assignment.bindingIndex !== entry.bindingIndex ||
      !sameBinding(holder.assignment, entry.binding)
    ) {
      return {
        kind: "blocked",
        reason: "reconcile_in_progress",
        message: `Device '${oldId}' is no longer this binding's device.`,
      };
    }
    return { kind: "present", device };
  }

  async locateCreated(
    entry: BindingJournalEntry,
    signal?: AbortSignal,
  ): Promise<
    | { kind: "present"; device: DeviceInfo; stableId: string }
    | { kind: "absent" }
    | { kind: "blocked"; reason: BindingJournalBlockReason; message: string }
  > {
    const { newStableId, newName } = entry.target;
    if (!newStableId && !newName) {
      return { kind: "absent" };
    }
    const platform = journalCreationPlatform(entry);
    const inventory = await this.stages.listInventory(entry, platform, signal);
    if (!inventory) {
      return {
        kind: "blocked",
        reason: "discovery_incomplete",
        message: "Device discovery failed.",
      };
    }
    const candidates = inventory.devices.filter(
      (device) =>
        device.platform === platform &&
        (newStableId ? deviceStableId(device) === newStableId : device.name === newName),
    );
    if (candidates.length === 0) {
      return inventory.complete
        ? { kind: "absent" }
        : {
            kind: "blocked",
            reason: "discovery_incomplete",
            message: `Created device '${newStableId ?? newName}' was not listed and discovery was incomplete.`,
          };
    }
    const stableId = candidates.length === 1 ? deviceStableId(candidates[0]) : undefined;
    if (!stableId) {
      return {
        kind: "blocked",
        reason: "discovery_incomplete",
        message: `Created device '${newName}' is ambiguous (${candidates.length} listed).`,
      };
    }
    return { kind: "present", device: candidates[0], stableId };
  }
}
