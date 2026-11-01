import { bootCapacityOwnershipNote } from "../../../devices/bootAdmission/BootAdmissionGate";
import type { BootSlotReservation } from "../../../devices/bootAdmission/BootSlotReservation";
import { withVerifiedBootCapacity } from "../../../devices/bootAdmission/VerifiedBootCapacity";
import { bootGatePlatform } from "../../../features/bootAdmission/sharedBootAdmissionGates";
import {
  BindingJournalRemovalRegistryTimeout,
  type BindingJournal,
} from "../registry/bindingJournal";
import { classifySqliteError } from "../../../db/databaseFailureClassification";
import {
  ProvisionDeviceError,
  type ResolvedExactDeviceSpecification,
} from "../../../devices/exactDeviceProvisioning";
import { budgetRefusal, type BindingResourceAdmission } from "./resourceBudget";
import type { DeviceInfo } from "../../../models/index";
import { OCCUPYING_SIMULATOR_STATES } from "../../../features/iosSimFleet/FleetCostCollector";
import { errorMessage } from "../../../utils/describeUnknownError";
import type { IdGenerator } from "../../../utils/IdGenerator";
import type { Timer } from "../../../utils/SystemTimer";
import { logger } from "../../../utils/logger";
import {
  bindingMatches,
  type BindingAssignmentRecord,
  type BindingJournalEntry,
  type BindingPlatform,
} from "../registry/bindingRegistry";
import { bindingReadinessLabel } from "./bindingReadiness";
import { deviceStableId } from "../registry/deviceIdentity";
import { provisionableSpec } from "./DefaultManagedSpecResolver";
import { ReconcileAbort, type BindingReconcileFailure } from "./ReconcileAbort";
import type {
  BindingCapacityCheck,
  BindingDisposition,
  BindingProvisionedDevice,
  BindingReconcileRequest,
  BindingReconcilerDependencies,
} from "./reconciler";
import {
  bindingDeviceName,
  claimFailure,
  encodeManagedSpecFingerprint,
  expectationOf,
  externalDevicesField,
  failure,
  provisionFailure,
  type ReadyResult,
  type ReconcileContext,
} from "./reconcilerSupport";

/** Only the ports used by journaled creation and replacement. */
export interface BindingDeviceCreationDependencies {
  registry: Pick<
    BindingReconcilerDependencies["registry"],
    "openBindingJournal" | "removeUnboundBinding" | "findDeviceHolder"
  >;
  provisioner: Pick<BindingReconcilerDependencies["provisioner"], "provision">;
  inventory: Pick<BindingReconcilerDependencies["inventory"], "runtimeDeviceId">;
  resolver: Pick<BindingReconcilerDependencies["resolver"], "checkCreatable">;
  claims: Pick<BindingReconcilerDependencies["claims"], "describe">;
  capacity?: BindingReconcilerDependencies["capacity"];
  resourceBudget?: Pick<
    NonNullable<BindingReconcilerDependencies["resourceBudget"]>,
    "admitCreation"
  >;
  idGenerator: Pick<IdGenerator, "next">;
  timer: Pick<Timer, "now">;
  journal: Pick<
    BindingJournal,
    | "owner"
    | "inFlight"
    | "advance"
    | "markRemovalIntended"
    | "close"
    | "settleCreation"
    | "requestRemoval"
    | "removalRegistryStage"
    | "driveDeletion"
  >;
}

/** Publishing and session ownership remain with the reconciler. */
export interface BindingDeviceCreationHost {
  checkBudget(request: BindingReconcileRequest): void;
  /** Automation readiness on Android and iOS; booted with a session on watchOS. */
  isBindingReady(platform: BindingPlatform, provisioned: BindingProvisionedDevice): boolean;
  releaseSession(sessionUuid: string): Promise<void>;
  readyOrReleaseOnBusy(
    provisioned: BindingProvisionedDevice,
    publish: (release: () => Promise<void>) => Promise<ReadyResult>,
  ): Promise<ReadyResult>;
  claimAndReady(
    context: ReconcileContext,
    disposition: BindingDisposition,
    assignment: BindingAssignmentRecord,
    options: { provisioned: BindingProvisionedDevice; reservation?: string },
  ): Promise<ReadyResult>;
}

/**
 * Whether the device counts toward its platform's boot limit, by the gates' own definition: a
 * simulator (iPhone or Apple Watch, both counted by the simulator gate) that is booting or shutting
 * down holds its binding although it is not listed as running.
 */
function holdsBootBinding(device: DeviceInfo): boolean {
  return (
    device.isRunning ||
    (device.platform !== "android" &&
      device.state !== undefined &&
      OCCUPYING_SIMULATOR_STATES.has(device.state))
  );
}

/** Journaled device creation, replacement and rollback for a binding. */
export class BindingDeviceCreation {
  constructor(
    private readonly deps: BindingDeviceCreationDependencies,
    private readonly host: BindingDeviceCreationHost,
  ) {}

  /**
   * Create a device under the binding's next generated name and commit it, journaled so an
   * interruption at any boundary converges: `creating` (provision issued) → `created` (device
   * exists) → `committed` together with the binding. `replacing` continues a replacement entry that
   * already verified the old device's absence.
   */
  async createAndCommit(
    context: ReconcileContext,
    assignment: BindingAssignmentRecord,
    disposition: "created" | "replaced",
    {
      replacing,
      ...options
    }: { bootReservation?: BootSlotReservation } & { replacing?: BindingJournalEntry } = {},
  ): Promise<ReadyResult> {
    const { request } = context;
    let capacityVerifiedAtMs: number | undefined;
    if (replacing === undefined) {
      try {
        this.host.checkBudget(request);
        await this.assertCreatable(context);
        if (!options.bootReservation) {
          // Fail before journal/resource admission; only this create may reuse the fresh verdict.
          capacityVerifiedAtMs = await this.assertBootCapacity(request);
        }
      } catch (error) {
        // No provisioning or journal entry exists yet; preserve the original refusal unchanged.
        await this.removeNeverBoundBinding(context, assignment, "pre-provision refusal");
        throw error;
      }
    } else {
      this.host.checkBudget(request);
      // A replacement holds its boot admission across deletion. The provision-path gate consumes
      // that same reservation, so neither this probe nor the boot can refuse its held slot.
      if (!options.bootReservation) {
        capacityVerifiedAtMs = await this.assertBootCapacity(request);
      }
    }
    const name = bindingDeviceName(
      request.key,
      assignment.generation + 1,
      this.deps.idGenerator.next(),
    );
    context.evidence.createdName = name;
    let entry = replacing
      ? await this.advanceToCreating(context, replacing, name)
      : await this.openCreateEntry(context, assignment, name);
    this.deps.journal.inFlight.add(entry.id);
    try {
      if (replacing === undefined && this.deps.resourceBudget) {
        await this.admitFreshCreation(context, assignment, entry);
      }
      let provisioned: BindingProvisionedDevice;
      try {
        const provisionDevice = () =>
          this.deps.provisioner.provision({
            platform: request.platform,
            name,
            // "Any model" creates the model the resolver chose (and recorded).
            spec: {
              ...provisionableSpec(request.requestedSpec),
              deviceType: context.resolvedSpec.deviceType,
            },
            mode: "create",
            deadlineMs: request.deadlineMs,
            signal: request.signal,
          });
        const platform = request.platform;
        const provision = () =>
          platform === "watchos"
            ? // Only the Android/iOS exact provisioner consumes a pre-create capacity proof; a
              // watch's boot is admitted (or refused at the limit) by the simulator boot gate.
              provisionDevice()
            : withVerifiedBootCapacity(
                {
                  platform,
                  name,
                  spec: {
                    runtime: request.requestedSpec.runtime,
                    deviceType: context.resolvedSpec.deviceType,
                  },
                },
                capacityVerifiedAtMs,
                this.deps.timer,
                provisionDevice,
              );
        provisioned = options.bootReservation
          ? await options.bootReservation.run(provision)
          : await provision();
      } catch (error) {
        return await this.failedCreate(context, assignment, entry, {
          fresh: replacing === undefined,
          error,
        });
      }
      const ready = this.host.isBindingReady(request.platform, provisioned);
      return await this.host.readyOrReleaseOnBusy(provisioned, async (release) => {
        if (provisioned.created && !ready) {
          this.deps.journal.markRemovalIntended(entry);
        }
        entry = await this.recordCreated(context, entry, provisioned.device, {
          release,
          removalRequested: provisioned.created && !ready,
        });
        if (!ready) {
          return await this.discardUncommitted(context, provisioned, entry, {
            release,
            reason: failure(
              "readiness_incomplete",
              `Device '${name}' did not reach ${bindingReadinessLabel(request.platform)}.`,
            ),
          });
        }
        const committed = await this.deps.journal.advance(entry, {
          expectedPhase: "created",
          phase: "committed",
          assignment: {
            kind: "commit",
            expected: entry.binding,
            next: {
              stableDeviceId: provisioned.device.stableId,
              deviceName: provisioned.device.name,
              requestedSpec: request.requestedSpec,
              resolvedSpec: context.resolvedSpec,
              specFingerprint: encodeManagedSpecFingerprint(context.fingerprint),
              state: "ready",
            },
          },
        });
        if (committed.kind === "journal_conflict") {
          // Another driver took the entry over; it owns the device's fate now.
          await this.host.releaseSession(provisioned.sessionUuid);
          throw new ReconcileAbort(
            failure("concurrent_modification", "The binding's journal entry was taken over."),
          );
        }
        if (committed.kind !== "advanced") {
          return await this.discardUncommitted(context, provisioned, entry, {
            release,
            reason: claimFailure(committed, "create commit"),
          });
        }
        this.noteJournal(context, committed.entry);
        return await this.host.claimAndReady(context, disposition, committed.assignment!, {
          provisioned,
        });
      });
    } finally {
      this.deps.journal.inFlight.delete(entry.id);
    }
  }

  private async openCreateEntry(
    context: ReconcileContext,
    assignment: BindingAssignmentRecord,
    name: string,
  ): Promise<BindingJournalEntry> {
    const { request } = context;
    const opened = await this.deps.registry.openBindingJournal(request.key, {
      kind: "create",
      phase: "creating",
      owner: this.deps.journal.owner,
      target: this.journalTarget(context, assignment, name),
      assignment: { kind: "state", expected: expectationOf(assignment), state: "provisioning" },
    });
    if (opened.kind === "journal_open") {
      throw new ReconcileAbort(
        failure(
          "reconcile_in_progress",
          `Binding ${request.key.bindingIndex} has unfinished work.`,
        ),
      );
    }
    if (opened.kind !== "opened") {
      throw new ReconcileAbort(claimFailure(opened, "create"));
    }
    this.noteJournal(context, opened.entry);
    return opened.entry;
  }

  private async advanceToCreating(
    context: ReconcileContext,
    entry: BindingJournalEntry,
    name: string,
  ): Promise<BindingJournalEntry> {
    const advanced = await this.deps.journal.advance(entry, {
      expectedPhase: "deleted",
      phase: "creating",
      target: { newName: name },
    });
    if (advanced.kind !== "advanced") {
      throw new ReconcileAbort(
        failure("concurrent_modification", `Replacement journal changed: ${advanced.kind}.`),
      );
    }
    this.noteJournal(context, advanced.entry);
    return advanced.entry;
  }

  private async failedCreate(
    context: ReconcileContext,
    assignment: BindingAssignmentRecord,
    entry: BindingJournalEntry,
    { fresh, error }: { fresh: boolean; error: unknown },
  ): Promise<never> {
    const { request } = context;
    if (
      error instanceof ProvisionDeviceError &&
      error.retryable &&
      error.code === "timeout" &&
      error.diagnostics.retainedDevice &&
      error.diagnostics.retainedDevice.name === entry.target.newName &&
      error.diagnostics.retainedDevice.platform === "ios" &&
      request.platform === "ios" &&
      !request.signal?.aborted
    ) {
      // Redrive adopts the existing created phase as provisioning, then reuse readies it.
      try {
        await this.recordCreated(context, entry, error.diagnostics.retainedDevice);
      } catch (journalError) {
        // The creating entry still fences cleanup by name; preserve the original readiness error.
        logger.warn(
          `[Bindings] retaining created device failed: ${errorMessage(journalError)}`,
          journalError,
        );
        throw new ReconcileAbort(provisionFailure(error));
      }
      throw new ReconcileAbort({
        ...provisionFailure(error),
        retainedDevice: error.diagnostics.retainedDevice,
      });
    }
    // Other provision failures roll back; retain cleanup for redrive if absence is unproven.
    const settled = await this.settleFailedCreate(context, entry);
    if (fresh) {
      await this.removeFailedUnboundBinding(context, assignment, settled);
    }
    throw new ReconcileAbort(provisionFailure(error));
  }

  private async recordCreated(
    context: ReconcileContext,
    entry: BindingJournalEntry,
    device: Pick<BindingProvisionedDevice["device"], "stableId" | "name">,
    {
      release,
      removalRequested = false,
    }: { release?: () => Promise<void>; removalRequested?: boolean } = {},
  ): Promise<BindingJournalEntry> {
    const recorded = await this.deps.journal
      .advance(entry, {
        expectedPhase: "creating",
        phase: "created",
        target: {
          newStableId: device.stableId,
          newName: device.name,
          ...(removalRequested ? { removalRequested: true } : {}),
        },
      })
      .catch(async (error: unknown) => {
        logger.warn(`[Bindings] recording created device failed: ${errorMessage(error)}`, error);
        await release?.();
        throw error;
      });
    if (recorded.kind !== "advanced") {
      // Another driver took the entry over and will settle the device by its recorded name.
      await release?.();
      throw new ReconcileAbort(
        failure("concurrent_modification", "The binding's journal entry was taken over."),
      );
    }
    this.noteJournal(context, recorded.entry);
    return recorded.entry;
  }

  /** Reserve total-resource capacity before any native creation. */
  private async admitFreshCreation(
    context: ReconcileContext,
    assignment: BindingAssignmentRecord,
    entry: BindingJournalEntry,
  ): Promise<void> {
    let admission: BindingResourceAdmission;
    try {
      admission = await this.deps.resourceBudget!.admitCreation({
        journalEntryId: entry.id,
        deadlineMs: context.request.deadlineMs,
        signal: context.request.signal,
      });
      // Admission can consume the remaining preparation time even when it finds room.
      this.host.checkBudget(context.request);
    } catch (error) {
      const settled = await this.settleFailedCreate(context, entry, true);
      await this.removeFailedUnboundBinding(context, assignment, settled);
      // Cancellation retains its identity for the reconciler's existing handling.
      throw error;
    }
    if (admission.kind === "admitted") {
      return;
    }
    // Native creation has not been called: absence is already proven, including when discovery
    // itself is incomplete. Close directly rather than rediscovering a device that never existed.
    const settled = await this.settleFailedCreate(context, entry, true);
    await this.removeFailedUnboundBinding(context, assignment, settled);
    if (admission.kind === "unknown") {
      throw new ReconcileAbort(failure("discovery_incomplete", admission.message));
    }
    const { message, budget } = budgetRefusal(admission);
    throw new ReconcileAbort(failure("binding_budget_exhausted", message, { budget }));
  }

  private async removeFailedUnboundBinding(
    context: ReconcileContext,
    assignment: BindingAssignmentRecord,
    settled: BindingJournalEntry | undefined,
  ): Promise<void> {
    if (settled?.phase !== "rolled_back") {
      return;
    }
    await this.removeNeverBoundBinding(context, assignment, `failed creation entry ${settled.id}`);
  }

  async withEmptyBindingCleanup<T>(
    context: ReconcileContext,
    assignment: BindingAssignmentRecord,
    operation: () => Promise<T>,
  ): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      // removeNeverBoundBinding logs cleanup failures and preserves the original refusal.
      await this.removeNeverBoundBinding(context, assignment, "empty-binding discovery refusal");
      throw error;
    }
  }

  private async removeNeverBoundBinding(
    context: ReconcileContext,
    assignment: BindingAssignmentRecord,
    reason: string,
  ): Promise<void> {
    if (assignment.generation !== 0 || assignment.stableDeviceId !== null) {
      return;
    }
    try {
      await this.deps.registry.removeUnboundBinding(context.request.key, {
        generation: assignment.generation,
        stableDeviceId: null,
      });
    } catch (error) {
      logger.warn(
        `[Bindings] removing never-bound binding after ${reason} failed: ${errorMessage(error)}`,
        error,
      );
    }
  }

  /** Roll back on proven absence; otherwise discover leftovers and retain cleanup for redrive. */
  private async settleFailedCreate(
    context: ReconcileContext,
    entry: BindingJournalEntry,
    absenceProven = false,
  ): Promise<BindingJournalEntry | undefined> {
    try {
      if (absenceProven) {
        const settled = (await this.deps.journal.close(entry, "rolled_back")).entry;
        this.noteJournal(context, settled);
        return settled;
      }
      const settled = await this.deps.journal.settleCreation(entry, {
        adopt: false,
        deadlineMs: context.request.deadlineMs,
      });
      this.noteJournal(context, settled.entry);
      return settled.entry;
    } catch (error) {
      logger.warn(
        `[Bindings] settling failed creation entry ${entry.id} failed; redrive will retry: ` +
          errorMessage(error),
        error,
      );
    }
  }

  /**
   * A device this attempt created but could not publish: release its session and remove it, unless
   * the registry says a binding (any scope) or the free pool now holds that stable id.
   */
  private async discardUncommitted(
    context: ReconcileContext,
    provisioned: BindingProvisionedDevice,
    entry: BindingJournalEntry,
    { release, reason }: { release: () => Promise<void>; reason: BindingReconcileFailure },
  ): Promise<never> {
    try {
      if (provisioned.created) {
        this.deps.journal.markRemovalIntended(entry);
        entry = await this.deps.journal.requestRemoval(entry, {
          deadlineMs: context.request.deadlineMs,
          signal: context.request.signal,
        });
      }
    } finally {
      await release();
    }
    try {
      await this.cleanupUncommitted(context, provisioned, entry);
    } catch (error) {
      if (error instanceof BindingJournalRemovalRegistryTimeout) {
        logger.warn(`[Bindings] uncommitted cleanup deferred: ${errorMessage(error)}`, error);
        context.evidence.uncommittedCleanup = {
          stableId: provisioned.device.stableId,
          removed: false,
          message: error.message,
        };
      } else if (classifySqliteError(error) !== "retryable") {
        logger.warn(`[Bindings] uncommitted cleanup failed: ${errorMessage(error)}`, error);
        throw error;
      }
      // The durable entry stays open for redrive; preserve the failure that required cleanup.
      logger.debug(`[Bindings] uncommitted cleanup deferred: ${errorMessage(error)}`);
    }
    throw new ReconcileAbort(reason);
  }

  private async cleanupUncommitted(
    context: ReconcileContext,
    provisioned: BindingProvisionedDevice,
    entry: BindingJournalEntry,
  ): Promise<void> {
    if (!provisioned.created) {
      this.noteJournal(
        context,
        (
          await this.deps.journal.removalRegistryStage(
            () => this.deps.journal.close(entry, "rolled_back"),
            context.request.deadlineMs,
          )
        ).entry,
      );
      return;
    }
    this.noteJournal(context, entry);
    if (!entry.target.removalRequested) {
      context.evidence.uncommittedCleanup = {
        stableId: provisioned.device.stableId,
        removed: false,
        message: "Removal deferred to journal redrive or its current driver.",
      };
      // The first flag write was attempted; memory fences adoption until a later redrive.
      return;
    }
    // Losing a compare-and-set never licenses deleting the device the winner committed.
    const holder = await this.deps.journal.removalRegistryStage(
      () =>
        this.deps.registry.findDeviceHolder(context.request.platform, provisioned.device.stableId),
      context.request.deadlineMs,
    );
    if (holder) {
      const heldBy =
        holder.kind === "binding"
          ? `binding ${holder.assignment.bindingIndex} of scope ${holder.assignment.scopeKey}`
          : "the managed free pool";
      context.evidence.uncommittedCleanup = {
        stableId: provisioned.device.stableId,
        removed: false,
        message: `kept: held by ${heldBy}`,
      };
      logger.warn(
        `[Bindings] not discarding '${provisioned.device.stableId}': it is held by ${heldBy}`,
      );
      this.noteJournal(
        context,
        (
          await this.deps.journal.removalRegistryStage(
            () => this.deps.journal.close(entry, "rolled_back"),
            context.request.deadlineMs,
          )
        ).entry,
      );
      return;
    }
    const settled = await this.deps.journal.settleCreation(entry, {
      adopt: false,
      deadlineMs: context.request.deadlineMs,
    });
    this.noteJournal(context, settled.entry);
    const removed = settled.kind === "settled";
    context.evidence.uncommittedCleanup = {
      stableId: provisioned.device.stableId,
      removed,
      ...(settled.kind === "blocked" ? { message: settled.message } : {}),
    };
    if (!removed) {
      // The entry stays open with the device's exact identity, so a redrive removes it later.
      logger.warn(
        `[Bindings] uncommitted device '${provisioned.device.stableId}' was not removed: ` +
          (settled.kind === "blocked" ? settled.message : "unknown"),
      );
    }
  }

  // --- replace ---------------------------------------------------------------------------------

  /** Reclaim an unheld orphan atomically with its deletion journal; never expose it unreset. */
  async replaceOrphan(
    context: ReconcileContext,
    assignment: BindingAssignmentRecord,
    device: DeviceInfo,
  ): Promise<ReadyResult> {
    const { request } = context;
    await this.assertCreatable(context);
    this.host.checkBudget(request);
    const reservation = await this.reserveReplacement(request, assignment, device);
    try {
      this.host.checkBudget(request);
      const next = {
        stableDeviceId: deviceStableId(device)!,
        deviceName: device.name,
        requestedSpec: request.requestedSpec,
        resolvedSpec: context.resolvedSpec,
        specFingerprint: encodeManagedSpecFingerprint(context.fingerprint),
        state: "replacing" as const,
      };
      const opened = await this.deps.registry.openBindingJournal(request.key, {
        kind: "replace",
        phase: "deleting",
        owner: this.deps.journal.owner,
        target: {
          ...this.journalTarget(context, assignment, null),
          oldStableId: next.stableDeviceId,
          oldName: device.name,
        },
        assignment: { kind: "commit", expected: expectationOf(assignment), next },
      });
      if (opened.kind === "journal_open") {
        throw new ReconcileAbort(
          failure(
            "reconcile_in_progress",
            `Binding ${request.key.bindingIndex} has unfinished work.`,
          ),
        );
      }
      if (opened.kind !== "opened") {
        throw new ReconcileAbort(claimFailure(opened, "reclaim"));
      }
      context.evidence.adoptedFrom = "orphan";
      return await this.finishReplacement(context, opened.entry, device, reservation);
    } finally {
      reservation?.release();
    }
  }

  async replaceAssigned(
    context: ReconcileContext,
    assignment: BindingAssignmentRecord,
    device: DeviceInfo,
    inventoryComplete: boolean,
  ): Promise<ReadyResult> {
    const { request } = context;
    // The slow catalog read must not sit between the claim checks and the journal open.
    await this.assertCreatable(context);
    await this.assertReplaceable(request, assignment, device, inventoryComplete);
    const reservation = await this.reserveReplacement(request, assignment, device);
    try {
      this.host.checkBudget(request);
      return await this.replaceReserved(context, assignment, device, reservation);
    } finally {
      reservation?.release();
    }
  }

  private async replaceReserved(
    context: ReconcileContext,
    assignment: BindingAssignmentRecord,
    device: DeviceInfo,
    reservation: BootSlotReservation | undefined,
  ): Promise<ReadyResult> {
    const { request } = context;
    // Journal the accepted deletion together with `replacing`: from here on, an interruption is
    // redriven against this exact device and binding.
    const opened = await this.deps.registry.openBindingJournal(request.key, {
      kind: "replace",
      phase: "deleting",
      owner: this.deps.journal.owner,
      target: this.journalTarget(context, assignment, null),
      assignment: { kind: "state", expected: expectationOf(assignment), state: "replacing" },
    });
    if (opened.kind === "journal_open") {
      throw new ReconcileAbort(
        failure(
          "reconcile_in_progress",
          `Binding ${request.key.bindingIndex} has unfinished work.`,
        ),
      );
    }
    if (opened.kind !== "opened") {
      // A live execution (or another attempt's reservation) claimed the device after our checks.
      throw new ReconcileAbort(claimFailure(opened, "replace"));
    }
    return await this.finishReplacement(context, opened.entry, device, reservation);
  }

  private async finishReplacement(
    context: ReconcileContext,
    entry: BindingJournalEntry,
    device: DeviceInfo,
    reservation: BootSlotReservation | undefined,
  ): Promise<ReadyResult> {
    const { request, evidence } = context;
    const oldId = entry.target.oldStableId!;
    this.noteJournal(context, entry);
    this.deps.journal.inFlight.add(entry.id);
    let deletedEntry: BindingJournalEntry;
    let emptied: BindingAssignmentRecord;
    try {
      const deletion = await this.deps.journal.driveDeletion(entry, {
        device,
        deadlineMs: request.deadlineMs,
        signal: request.signal,
      });
      this.noteJournal(context, deletion.entry);
      if (deletion.kind !== "deleted") {
        if (deletion.kind === "blocked") {
          evidence.deletion = deletion.evidence;
          throw new ReconcileAbort(failure(deletion.reason, deletion.message));
        }
        throw new ReconcileAbort(
          failure(
            "concurrent_modification",
            `Device '${oldId}' is no longer this binding's device.`,
          ),
        );
      }
      evidence.deletion = deletion.evidence;
      evidence.deletedStableId = oldId;
      deletedEntry = deletion.entry;
      emptied = deletion.assignment;
      reservation?.markReplacedDeviceGone();
    } finally {
      this.deps.journal.inFlight.delete(entry.id);
    }
    return await this.createAndCommit(context, emptied, "replaced", {
      replacing: deletedEntry,
      bootReservation: reservation,
    });
  }

  private journalTarget(
    context: ReconcileContext,
    assignment: BindingAssignmentRecord,
    newName: string | null,
  ) {
    return {
      oldStableId: assignment.stableDeviceId,
      oldName: assignment.deviceName,
      // The old device lives on the binding's platform (the entry's); a cross-platform replacement
      // records the platform it creates on (#11232).
      ...(assignment.platform !== context.request.platform
        ? { newPlatform: context.request.platform }
        : {}),
      newName,
      newStableId: null,
      requestedSpec: context.request.requestedSpec,
      resolvedSpec: context.resolvedSpec,
      specFingerprint: encodeManagedSpecFingerprint(context.fingerprint),
    };
  }

  private noteJournal(context: ReconcileContext, entry: BindingJournalEntry): void {
    context.evidence.journal = { entryId: entry.id, kind: entry.kind, phase: entry.phase };
  }

  /**
   * Every precondition for destroying the binding's device: complete discovery, no live claim, boot
   * capacity for the replacement, and the registry still naming this exact binding as its holder.
   */
  private async assertReplaceable(
    request: BindingReconcileRequest,
    assignment: BindingAssignmentRecord,
    device: DeviceInfo,
    inventoryComplete: boolean,
  ): Promise<void> {
    const oldId = assignment.stableDeviceId!;
    if (!inventoryComplete) {
      throw new ReconcileAbort(
        failure("discovery_incomplete", "Replacement requires complete device discovery."),
      );
    }
    const claim = await this.deps.claims.describe(device);
    if (claim.kind !== "free") {
      throw new ReconcileAbort(
        failure(
          claim.kind === "held" ? "device_busy" : "discovery_incomplete",
          `Device '${oldId}' cannot be replaced: ${claim.reason}`,
        ),
      );
    }
    this.host.checkBudget(request);
    const holder = await this.deps.registry.findDeviceHolder(assignment.platform, oldId);
    if (
      holder?.kind !== "binding" ||
      holder.assignment.scopeKey !== request.key.scopeKey ||
      holder.assignment.bindingIndex !== request.key.bindingIndex ||
      !bindingMatches(holder.assignment, expectationOf(assignment))
    ) {
      throw new ReconcileAbort(
        failure("concurrent_modification", `Device '${oldId}' is no longer this binding's device.`),
      );
    }
  }

  private async reserveReplacement(
    request: BindingReconcileRequest,
    assignment: BindingAssignmentRecord,
    device: DeviceInfo,
  ): Promise<BootSlotReservation | undefined> {
    if (!this.deps.capacity) {
      return undefined;
    }
    // The old device frees a slot on the gate the new boot uses: an iPhone and an Apple Watch share
    // the simulator gate, so switching a binding between them reserves against the old simulator.
    const freesSlot =
      bootGatePlatform(assignment.platform) === bootGatePlatform(request.platform) &&
      holdsBootBinding(device);
    this.host.checkBudget(request);
    const check = await this.deps.capacity.reserve(request.platform, {
      replacingDeviceId: freesSlot ? device.deviceId : undefined,
      resolveReplacingDeviceId:
        freesSlot && !device.deviceId
          ? (options) =>
              this.deps.inventory.runtimeDeviceId?.(device, options) ?? Promise.resolve(undefined)
          : undefined,
      timeoutMs: Math.max(1, request.deadlineMs - this.deps.timer.now()),
      signal: request.signal,
    });
    if (check.kind === "available") {
      return check.reservation;
    }
    this.assertCapacityCheck(request, check);
    throw new ReconcileAbort(
      failure("discovery_incomplete", "Boot capacity reservation returned no admission."),
    );
  }

  // --- shared steps ----------------------------------------------------------------------------

  /** Successful creation checks are shared by all steps of this reconcile only. */
  async assertCreatable(context: ReconcileContext): Promise<void> {
    if (context.creatabilityChecked) {
      return;
    }
    const { request } = context;
    const result = await this.deps.resolver.checkCreatable?.(
      request.platform,
      // Creation paths retain resolve()'s exact spec; only reuse can widen this type.
      context.resolvedSpec as ResolvedExactDeviceSpecification,
      { signal: request.signal },
    );
    // Cancellation or expiry while discovery was pending wins over its result.
    this.host.checkBudget(request);
    if (result?.kind === "unsupported") {
      throw new ReconcileAbort(failure(result.code, result.message));
    }
    if (result?.kind === "unresolved") {
      throw new ReconcileAbort(failure("discovery_incomplete", result.message));
    }
    context.creatabilityChecked = true;
  }

  /**
   * Fail immediately at the boot limit before creating a device (and before deleting the one it
   * replaces). Replacements instead reserve an admission before deletion.
   * Booting a device that already exists is not checked
   * here: the provision path owns that decision and its own-target exemption.
   */
  private async assertBootCapacity(request: BindingReconcileRequest): Promise<number | undefined> {
    if (!this.deps.capacity) {
      return;
    }
    this.host.checkBudget(request);
    const check = await this.deps.capacity.check(request.platform, {
      signal: request.signal,
      timeoutMs: Math.max(1, request.deadlineMs - this.deps.timer.now()),
    });
    this.assertCapacityCheck(request, check);
    return check.kind === "available" ? this.deps.timer.now() : undefined;
  }

  private assertCapacityCheck(request: BindingReconcileRequest, check: BindingCapacityCheck): void {
    if (check.kind === "unknown") {
      throw new ReconcileAbort(failure("discovery_incomplete", check.message));
    }
    if (check.kind === "exhausted" && check.booted >= check.limit) {
      throw new ReconcileAbort(
        failure(
          "capacity_exhausted",
          `${check.booted} ${request.platform} device(s) booted; limit is ${check.limit}.${bootCapacityOwnershipNote(check)}`,
          {
            capacity: {
              limit: check.limit,
              booted: check.booted,
              retryAfterMs: check.retryAfterMs,
              ...externalDevicesField(check.externalDevices),
              ...(check.heldDevices?.length ? { heldDevices: [...check.heldDevices] } : {}),
            },
          },
        ),
      );
    }
  }
}
