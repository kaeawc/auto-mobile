import type { BootSlotReservation } from "../../../devices/bootAdmission/BootSlotReservation";
import { classifySqliteError } from "../../../db/databaseFailureClassification";
import type { DeviceInfo } from "../../../models/index";
import { errorMessage } from "../../../utils/describeUnknownError";
import { defaultIdGenerator, type IdGenerator } from "../../../utils/IdGenerator";
import { logger } from "../../../utils/logger";
import { raceWithDeadline } from "../../../utils/raceWithDeadline";
import { stableStringify } from "../../../utils/stableStringify";
import { isProductBrokerDevice } from "../persistedIdentity";
import { BindingJournal, BindingJournalRemovalRegistryTimeout } from "../registry/bindingJournal";
import type {
  BindingAssignmentRecord,
  BindingExecOwnerLiveness,
  BindingJournalEntry,
  BindingKey,
} from "../registry/bindingRegistry";
import { deviceStableId } from "../registry/deviceIdentity";
import {
  defaultBindingExecOwnerLiveness,
  inFlightBindingReservations,
  type InFlightBindingReservations,
} from "../registry/ownerLiveness";
import { BindingDeviceCreation } from "./BindingDeviceCreation";
import { provisionableSpec } from "./DefaultManagedSpecResolver";
import { ReconcileAbort, type BindingReconcileFailure } from "./ReconcileAbort";
import {
  bindingId,
  processJournalOwner,
  type BindingDisposition,
  type BindingInventorySnapshot,
  type BindingProvisionedDevice,
  type BindingReconcileEvidence,
  type BindingReconcileRequest,
  type BindingReconcileResult,
  type BindingReconcilerDependencies,
  type BindingResolvedSpec,
} from "./reconcilerContracts";
import {
  bindingDeviceNameSuffix,
  casFailure,
  claimFailure,
  encodeManagedSpecFingerprint,
  expectationOf,
  failure,
  managedRequestOrAbort,
  provisionFailure,
  withCreateDeadline,
  type ReadyResult,
  type ReconcileContext,
} from "./reconcilerSupport";
export {
  processJournalOwner,
  type BindingBootCapacity,
  type BindingCapacityCheck,
  type BindingDeletionResult,
  type BindingDeletionTarget,
  type BindingDeviceClaim,
  type BindingDeviceClaims,
  type BindingDeviceDeleter,
  type BindingDeviceProvisioner,
  type BindingDisposition,
  type BindingInventory,
  type BindingInventorySnapshot,
  type BindingProvisionRequest,
  type BindingProvisionedDevice,
  type BindingReconcileEvidence,
  type BindingReconcileRequest,
  type BindingReconcileResult,
  type BindingReconcilerDependencies,
  type BindingResolvedSpec,
} from "./reconcilerContracts";

export { bindingDeviceName, encodeManagedSpecFingerprint, failure } from "./reconcilerSupport";

export { deviceStableId };

// ---------------------------------------------------------------------------------------------
// Reconciler
// ---------------------------------------------------------------------------------------------

export class BindingReconciler {
  /** Serializes reconciliations of one binding inside this process. */
  private readonly inFlight = new Map<string, Promise<unknown>>();
  private readonly isExecOwnerLive: BindingExecOwnerLiveness;
  private readonly idGenerator: IdGenerator;
  private readonly reservations: Pick<InFlightBindingReservations, "add" | "delete">;

  private readonly creation: BindingDeviceCreation;

  readonly journal: BindingJournal;

  constructor(private readonly deps: BindingReconcilerDependencies) {
    this.isExecOwnerLive = deps.isExecOwnerLive ?? defaultBindingExecOwnerLiveness;
    this.idGenerator = deps.idGenerator ?? defaultIdGenerator;
    this.reservations = deps.reservations ?? inFlightBindingReservations;
    this.journal = new BindingJournal({
      registry: deps.registry,
      inventory: deps.inventory,
      matcher: deps.matcher,
      deleter: deps.deleter,
      claims: deps.claims,
      isBusy: deps.isBusy,
      timer: deps.timer,
      owner: deps.journal?.owner ?? processJournalOwner(),
      isExecOwnerLive: this.isExecOwnerLive,
      ...(deps.journal?.isOwnerLive ? { isOwnerLive: deps.journal.isOwnerLive } : {}),
      ...(deps.journal?.inFlight ? { inFlight: deps.journal.inFlight } : {}),
      ...(deps.journal?.backoff !== undefined ? { backoff: deps.journal.backoff } : {}),
    });
    this.creation = new BindingDeviceCreation(
      {
        registry: deps.registry,
        inventory: deps.inventory,
        provisioner: deps.provisioner,
        resolver: deps.resolver,
        claims: deps.claims,
        capacity: deps.capacity,
        resourceBudget: deps.resourceBudget,
        idGenerator: this.idGenerator,
        timer: deps.timer,
        journal: this.journal,
      },
      {
        checkBudget: (request) => this.checkBudget(request),
        isAutomationReady: (provisioned) => this.isAutomationReady(provisioned),
        releaseSession: (sessionUuid) => this.releaseSession(sessionUuid),
        readyOrReleaseOnBusy: (provisioned, publish) =>
          this.readyOrReleaseOnBusy(provisioned, publish),
        claimAndReady: (context, disposition, assignment, { provisioned, reservation }) =>
          this.claimAndReady(context, disposition, assignment, { provisioned, reservation }),
      },
    );
  }

  async reconcile(request: BindingReconcileRequest): Promise<BindingReconcileResult> {
    const id = bindingId(request.key);
    const previous = this.inFlight.get(id);
    // A caller that stopped waiting (deadline or abort) must not run its reconcile afterwards.
    let abandoned = false;
    const run: Promise<BindingReconcileResult | undefined> = (previous ?? Promise.resolve())
      .then(
        () => undefined,
        () => undefined,
      )
      .then(() => (abandoned ? undefined : this.reconcileSerialized(request)));
    this.inFlight.set(id, run);
    try {
      if (previous) {
        const waitFailure = await this.waitForQueue(previous, request);
        if (waitFailure) {
          abandoned = true;
          // The queued deadline has passed or waiting was aborted; allow the fixed read cap.
          return {
            outcome: "failed",
            failure: waitFailure,
            assignment: await this.failedResultAssignment(request, undefined),
            evidence: { initial: null, inventoryComplete: null },
          };
        }
      }
      return (await run) as BindingReconcileResult;
    } finally {
      const release = () => {
        if (this.inFlight.get(id) === run) {
          this.inFlight.delete(id);
        }
      };
      if (abandoned) {
        // An abandoned waiter's run settles only after every earlier run has, so it keeps the
        // binding's queue entry until then: a later caller must still queue behind the running one.
        void run.then(release, release);
      } else {
        release();
      }
    }
  }

  /**
   * Wait behind the binding's in-flight reconcile for at most the request's own deadline and abort
   * signal (#11342): a duplicate acquisition reports `timeout` or `cancelled` on time instead of
   * after the first one finishes. Undefined when the queue cleared in time.
   */
  private async waitForQueue(
    previous: Promise<unknown>,
    request: BindingReconcileRequest,
  ): Promise<BindingReconcileFailure | undefined> {
    try {
      await raceWithDeadline(
        previous.then(
          () => undefined,
          () => undefined,
        ),
        {
          timer: this.deps.timer,
          timeoutMs: Math.max(0, request.deadlineMs - this.deps.timer.now()),
          ...(request.signal ? { signal: request.signal } : {}),
          label: "Waiting for the binding's in-flight reconcile",
        },
      );
      return undefined;
    } catch (error) {
      logger.debug(`[Bindings] queued reconcile stopped waiting: ${errorMessage(error)}`);
      return request.signal?.aborted
        ? failure("cancelled", "Binding preparation was cancelled.")
        : failure("timeout", "Binding preparation deadline passed.");
    }
  }

  private async failedResultAssignment(
    request: BindingReconcileRequest,
    deadlineMs: number | undefined,
  ): Promise<BindingAssignmentRecord | null> {
    try {
      return await this.journal.removalRegistryStage(
        () => this.deps.registry.getAssignment(request.key),
        deadlineMs,
      );
    } catch (error) {
      if (
        error instanceof BindingJournalRemovalRegistryTimeout ||
        classifySqliteError(error) === "retryable"
      ) {
        logger.warn(
          `[Bindings] failed result assignment unavailable: ${errorMessage(error)}`,
          error,
        );
        return null;
      }
      throw error;
    }
  }

  private async reconcileSerialized(
    request: BindingReconcileRequest,
  ): Promise<BindingReconcileResult> {
    const evidence: BindingReconcileEvidence = { initial: null, inventoryComplete: null };
    try {
      return await this.reconcileSteps(request, evidence);
    } catch (error) {
      if (error instanceof ReconcileAbort || classifySqliteError(error) === "retryable") {
        // Busy writes opened no transaction; accepted journal work stays durable for redrive.
        // Return through acquisition's normal failure path so earlier sessions are backed out.
        return {
          outcome: "failed",
          failure:
            error instanceof ReconcileAbort
              ? error.failure
              : failure("discovery_incomplete", errorMessage(error)),
          assignment: await this.failedResultAssignment(request, request.deadlineMs),
          evidence,
        };
      }
      throw error;
    }
  }

  private async reconcileSteps(
    requested: BindingReconcileRequest,
    evidence: BindingReconcileEvidence,
  ): Promise<BindingReconcileResult> {
    const { registry } = this.deps;
    this.checkBudget(requested);
    const request = managedRequestOrAbort(requested);
    // Resolve first: an unsupported spec fails before any registry or device mutation.
    const resolution = await this.deps.resolver.resolve(request.platform, request.requestedSpec, {
      signal: request.signal,
    });
    if (resolution.kind === "unsupported") {
      throw new ReconcileAbort(failure(resolution.code, resolution.message));
    }
    if (resolution.kind === "unresolved") {
      throw new ReconcileAbort(failure("discovery_incomplete", resolution.message));
    }
    const context: ReconcileContext = {
      request,
      resolvedSpec: resolution.resolvedSpec,
      fingerprint: resolution.fingerprint,
      evidence,
    };

    const init = await registry.initBinding(request.key, {
      role: request.role,
      platform: request.platform,
      requestedSpec: request.requestedSpec,
    });
    if (init.kind === "scope_not_valid") {
      throw new ReconcileAbort(failure("scope_not_valid", "Binding scope is not valid."));
    }
    const redriven = await this.redriveUnfinished(request, init.assignment, evidence);
    const assignment = await this.recoverIfSettled(request, redriven);
    evidence.initial = {
      generation: assignment.generation,
      stableDeviceId: assignment.stableDeviceId,
      state: assignment.state,
    };
    this.assertBindingAcceptsWork(request, assignment);
    if (assignment.platform !== request.platform) {
      return await this.changePlatform(context, assignment);
    }

    const discover = async () => {
      const inventory = await this.deps.inventory.list(request.platform, {
        signal: request.signal,
      });
      evidence.inventoryComplete = inventory.complete;
      this.checkBudget(request);
      return inventory;
    };
    const inventory =
      assignment.stableDeviceId === null
        ? await this.withEmptyBindingCleanup(context, assignment, discover)
        : await discover();

    if (assignment.stableDeviceId === null) {
      return await this.fillEmptyBinding(context, assignment, inventory);
    }
    const assigned = inventory.devices.find(
      (device) =>
        device.platform === request.platform &&
        deviceStableId(device) === assignment.stableDeviceId,
    );
    if (!assigned) {
      if (!inventory.complete) {
        throw new ReconcileAbort(
          failure(
            "discovery_incomplete",
            `Assigned device '${assignment.stableDeviceId}' was not listed and discovery was incomplete.`,
          ),
        );
      }
      // Removed out of band: complete discovery proves absence, so create at generation + 1.
      evidence.assignedMissing = true;
      return await this.createAndCommit(context, assignment, "created");
    }
    const match = await this.deps.matcher.matches(assigned, request.requestedSpec);
    evidence.assignedMatch = match;
    if (match === "unknown") {
      throw new ReconcileAbort(
        failure(
          "discovery_incomplete",
          `Configuration of assigned device '${assignment.stableDeviceId}' could not be read.`,
        ),
      );
    }
    if (match === "match") {
      return await this.reuseAssigned(context, assignment, assigned);
    }
    return await this.replaceAssigned(context, assignment, assigned, inventory.complete);
  }

  /**
   * Converge an earlier attempt's unfinished journaled work on this binding (a crash mid-replace,
   * mid-create or mid-release) before deciding anything, then re-read the binding.
   */
  private async redriveUnfinished(
    request: BindingReconcileRequest,
    assignment: BindingAssignmentRecord,
    evidence: BindingReconcileEvidence,
  ): Promise<BindingAssignmentRecord> {
    const redrive = await this.journal.redriveBinding(request.key);
    if (redrive.redriven.length > 0) {
      evidence.redriven = redrive.redriven;
    }
    if (redrive.kind === "blocked") {
      throw new ReconcileAbort(failure(redrive.reason, redrive.message));
    }
    if (redrive.redriven.length === 0) {
      return assignment;
    }
    const current = await this.deps.registry.getAssignment(request.key);
    if (!current) {
      throw new ReconcileAbort(failure("scope_not_valid", "Binding disappeared during redrive."));
    }
    return current;
  }

  /**
   * A `settling` binding whose settler is gone is settled (its work died with that process): recover
   * it to `ready` and continue. One whose settler still runs refuses retryable `binding_settling`.
   */
  private async recoverIfSettled(
    request: BindingReconcileRequest,
    assignment: BindingAssignmentRecord,
  ): Promise<BindingAssignmentRecord> {
    if (assignment.state !== "settling") {
      return assignment;
    }
    const recovered = (await this.deps.registry.recoverSettledBindings(request.key.scopeKey)).find(
      (binding) => binding.bindingIndex === request.key.bindingIndex,
    );
    if (recovered) {
      return recovered;
    }
    throw new ReconcileAbort(
      failure(
        "binding_settling",
        `Binding ${request.key.bindingIndex} is settling the released work of its previous execution.`,
      ),
    );
  }

  private assertBindingAcceptsWork(
    request: BindingReconcileRequest,
    assignment: BindingAssignmentRecord,
  ): void {
    if (assignment.execOwner && this.isExecOwnerLive(assignment.execOwner)) {
      throw new ReconcileAbort(
        failure(
          "binding_in_use",
          `Binding ${request.key.bindingIndex} is held by live session ${assignment.execOwner.sessionUuid}.`,
        ),
      );
    }
    if (assignment.state === "cleanup_pending") {
      throw new ReconcileAbort(
        failure(
          "cleanup_pending",
          `Binding ${request.key.bindingIndex} still holds device '${assignment.stableDeviceId}' pending cleanup.`,
        ),
      );
    }
    if (assignment.state === "replacing") {
      // The journal redrive above already converged any dead owner's replacement (#11179); one
      // still replacing here is being driven by a live owner, so never guess.
      throw new ReconcileAbort(
        failure(
          "reconcile_in_progress",
          `Binding ${request.key.bindingIndex} is mid-replacement of '${assignment.stableDeviceId}'.`,
        ),
      );
    }
  }

  // --- platform change -------------------------------------------------------------------------

  /**
   * The binding is requested on another platform (owner decision 2026-10-09, #11232): a replacement
   * like any spec change. The old platform's device is deleted and verified absent under the
   * journaled replace (its entry records both platforms), the binding moves to the new platform with
   * an empty binding, and a device of the new platform is created into the same binding.
   */
  private async changePlatform(
    context: ReconcileContext,
    assignment: BindingAssignmentRecord,
  ): Promise<ReadyResult> {
    const { request, evidence } = context;
    if (assignment.stableDeviceId === null) {
      const inventory = await this.withEmptyBindingCleanup(context, assignment, async () => {
        const inventory = await this.deps.inventory.list(request.platform, {
          signal: request.signal,
        });
        evidence.inventoryComplete = inventory.complete;
        this.checkBudget(request);
        return inventory;
      });
      return await this.fillEmptyBinding(context, assignment, inventory);
    }
    const inventory = await this.deps.inventory.list(assignment.platform, {
      signal: request.signal,
    });
    evidence.inventoryComplete = inventory.complete;
    this.checkBudget(request);
    const assigned = inventory.devices.find(
      (device) =>
        device.platform === assignment.platform &&
        deviceStableId(device) === assignment.stableDeviceId,
    );
    if (!assigned) {
      if (!inventory.complete) {
        throw new ReconcileAbort(
          failure(
            "discovery_incomplete",
            `Assigned device '${assignment.stableDeviceId}' was not listed and discovery was incomplete.`,
          ),
        );
      }
      // Removed out of band: complete discovery proves absence, so nothing is left to delete.
      evidence.assignedMissing = true;
      await this.assertCreatable(context);
      const moved = await this.emptyOnRequestedPlatform(context, assignment);
      return await this.createAndCommit(context, moved, "created");
    }
    // A device of another platform can never satisfy the spec.
    evidence.assignedMatch = "mismatch";
    return await this.replaceAssigned(context, assignment, assigned, inventory.complete);
  }

  /** Empty the binding onto the requested platform (generation + 1); only when no device is bound. */
  private async emptyOnRequestedPlatform(
    context: ReconcileContext,
    assignment: BindingAssignmentRecord,
  ): Promise<BindingAssignmentRecord> {
    const { request } = context;
    const emptied = await this.deps.registry.commitBinding(request.key, expectationOf(assignment), {
      platform: request.platform,
      stableDeviceId: null,
      deviceName: null,
      requestedSpec: request.requestedSpec,
      resolvedSpec: null,
      specFingerprint: null,
      state: "provisioning",
    });
    if (emptied.kind !== "committed") {
      throw new ReconcileAbort(casFailure(emptied, "platform change"));
    }
    return emptied.assignment;
  }

  // --- reuse -----------------------------------------------------------------------------------

  private async reuseAssigned(
    context: ReconcileContext,
    assignment: BindingAssignmentRecord,
    device: DeviceInfo,
  ): Promise<ReadyResult> {
    // No capacity pre-check: booting the binding's own device is the provision path's decision, which
    // exempts a boot target that already holds its binding (booted, booting, or running unseen).
    // Before reserving: a reservation would take the binding over from the live execution's record.
    this.assertNoLiveExecutionOn(context, device);
    // Reserve the binding before binding a session to its device, so a concurrent replacement can
    // neither fence nor delete the device while this attempt provisions it.
    const reservation = await this.reserveExecution(context, assignment);
    try {
      return await this.reuseReserved(context, assignment, device, reservation);
    } catch (error) {
      if (reservation) {
        await this.releaseReservation(context.request.key, reservation);
      }
      throw error;
    } finally {
      // Superseded by the real claim or released: it no longer keeps the binding in use (#11339).
      if (reservation) {
        this.reservations.delete(reservation);
      }
    }
  }

  private async reuseReserved(
    context: ReconcileContext,
    assignment: BindingAssignmentRecord,
    device: DeviceInfo,
    reservation: string | undefined,
  ): Promise<ReadyResult> {
    context = { ...context, resolvedSpec: await this.existingSpec(device) };
    // The binding's own device is excluded from every other caller and the registry records no live
    // execution, so any session on it is an earlier execution's leftover, unless this daemon still
    // holds it as a live execution (#11275), which refuses with binding_in_use instead.
    const provisioned = await this.provisionExisting(context, device);
    return await this.readyOrReleaseOnBusy(provisioned, async () => {
      const expected = expectationOf(assignment);
      const fingerprint = encodeManagedSpecFingerprint(context.fingerprint);
      const unchanged =
        assignment.state === "ready" &&
        assignment.specFingerprint === fingerprint &&
        stableStringify(assignment.requestedSpec) ===
          stableStringify(context.request.requestedSpec) &&
        this.resolvedIdentityMatches(assignment.resolvedSpec, context.resolvedSpec);
      // Repair an older binding's creation-default metadata once; subsequent identical requests
      // retain the generation. A full AVD config read adds detail beyond the resolver's fields,
      // without changing the binding. The fingerprint still describes the resolver's creation choice.
      // An unchanged ready binding is only re-verified; a new spec or a not-yet-ready binding is
      // recorded as a new generation of the same device.
      const committed = unchanged
        ? await this.deps.registry.updateBindingState(context.request.key, expected, "ready")
        : await this.deps.registry.commitBinding(context.request.key, expected, {
            stableDeviceId: assignment.stableDeviceId,
            deviceName: provisioned.device.name,
            requestedSpec: context.request.requestedSpec,
            resolvedSpec: context.resolvedSpec,
            specFingerprint: fingerprint,
            state: "ready",
          });
      if (committed.kind !== "updated" && committed.kind !== "committed") {
        await this.releaseSession(provisioned.sessionUuid);
        throw new ReconcileAbort(claimFailure(committed, "reuse"));
      }
      return await this.claimAndReady(context, "reused", committed.assignment, {
        provisioned,
        reservation,
      });
    });
  }

  private resolvedIdentityMatches(stored: unknown, actual: BindingResolvedSpec): boolean {
    if (stored === null || typeof stored !== "object") {
      return false;
    }
    return (["runtime", "deviceType", "displayCutout"] as const).every(
      (key) => Reflect.get(stored, key) === actual[key],
    );
  }

  /** Claim a ready, assigned binding for a placeholder session before provisioning, when owned. */
  private async reserveExecution(
    context: ReconcileContext,
    assignment: BindingAssignmentRecord,
  ): Promise<string | undefined> {
    const { owner, key } = context.request;
    if (!owner || assignment.state !== "ready") {
      return undefined;
    }
    const reservation = `reserve-${this.idGenerator.next()}`;
    // Recorded before the claim: the registry judges the new record by this set (#11339).
    this.reservations.add(reservation);
    try {
      const claimed = await this.deps.registry.claimExecution(key, expectationOf(assignment), {
        ...owner,
        sessionUuid: reservation,
      });
      if (claimed.kind !== "claimed") {
        throw new ReconcileAbort(claimFailure(claimed, "reservation"));
      }
    } catch (error) {
      this.reservations.delete(reservation);
      throw error;
    }
    return reservation;
  }

  private async releaseReservation(key: BindingKey, reservation: string): Promise<void> {
    try {
      await this.deps.registry.releaseExecution(key, reservation);
    } catch (error) {
      // The reservation is no longer in flight, so the registry judges a leaked record dead and
      // the next claim takes the binding over (#11339); log it so a stuck binding has a trace.
      logger.warn(
        `[Bindings] releasing reservation ${reservation} failed: ${errorMessage(error)}`,
        error,
      );
    }
  }

  // --- empty binding: journaled orphan reclaim or create (#14788) ---------------------------------

  private async fillEmptyBinding(
    context: ReconcileContext,
    assignment: BindingAssignmentRecord,
    inventory: BindingInventorySnapshot,
  ): Promise<ReadyResult> {
    const candidate = await this.withEmptyBindingCleanup(context, assignment, async () => {
      if (!inventory.complete) {
        // Without complete discovery we can neither find reclaimable orphans nor rule out a
        // leftover of this binding, so do nothing rather than create a duplicate.
        throw new ReconcileAbort(
          failure("discovery_incomplete", "Device discovery was incomplete for an empty binding."),
        );
      }
      const candidate = await this.findAdoptionCandidate(context, inventory.devices);
      // Both fresh creation and orphan reclamation require a creatable resolved spec.
      if (assignment.platform !== context.request.platform) {
        await this.assertCreatable(context);
      }
      return candidate;
    });
    if (assignment.platform !== context.request.platform) {
      assignment = await this.emptyOnRequestedPlatform(context, assignment);
    }
    // Both the journaled orphan replacement (#14799) and a fresh create make a new device, so
    // both spend the create deadline's retry reserve (#14643).
    const createContext = withCreateDeadline(context);
    if (candidate) {
      return await this.creation.replaceOrphan(createContext, assignment, candidate);
    }
    return await this.createAndCommit(createContext, assignment, "created");
  }

  private async findAdoptionCandidate(
    context: ReconcileContext,
    devices: DeviceInfo[],
  ): Promise<DeviceInfo | undefined> {
    const { request } = context;
    const suffix = bindingDeviceNameSuffix(request.key);
    const hint = request.priorDeviceHint?.stableId;
    const listed = devices
      .filter((device) => device.platform === request.platform)
      .map((device) => ({ device, stableId: deviceStableId(device) }))
      .filter((entry): entry is { device: DeviceInfo; stableId: string } => !!entry.stableId)
      .sort(
        (a, b) =>
          Number(b.stableId === hint) - Number(a.stableId === hint) ||
          a.stableId.localeCompare(b.stableId),
      );
    for (const { device, stableId } of listed) {
      // Preserve the binding-specific orphan fence across both product name generations.
      if (
        !isProductBrokerDevice(device.name) ||
        !device.name.slice(device.name.indexOf("-") + 1).startsWith(suffix)
      ) {
        continue;
      }
      // Reclaim only an unheld orphan: no registry binding, local session or external claim.
      // Unknown claim ownership must never authorize deletion.
      const holder = await this.deps.registry.findDeviceHolder(request.platform, stableId);
      if (
        holder ||
        this.sessionsOn(device).length > 0 ||
        (await this.deps.claims.describe(device)).kind !== "free"
      ) {
        continue;
      }
      if ((await this.deps.matcher.matches(device, request.requestedSpec)) === "match") {
        return device;
      }
    }
    return undefined;
  }

  private async existingSpec(device: DeviceInfo): Promise<BindingResolvedSpec> {
    const spec = await this.deps.provisioner.readExistingSpec(device);
    if (!spec) {
      throw new ReconcileAbort(
        failure(
          "discovery_incomplete",
          `The configuration of device '${device.name}' could not be read.`,
        ),
      );
    }
    return spec;
  }

  private async createAndCommit(
    context: ReconcileContext,
    assignment: BindingAssignmentRecord,
    disposition: "created" | "replaced",
    {
      replacing,
      ...options
    }: {
      bootReservation?: BootSlotReservation;
    } & { replacing?: BindingJournalEntry } = {},
  ): Promise<ReadyResult> {
    return this.creation.createAndCommit(context, assignment, disposition, {
      replacing,
      ...options,
    });
  }

  private async withEmptyBindingCleanup<T>(
    context: ReconcileContext,
    assignment: BindingAssignmentRecord,
    operation: () => Promise<T>,
  ): Promise<T> {
    return this.creation.withEmptyBindingCleanup(context, assignment, operation);
  }

  private async replaceAssigned(
    context: ReconcileContext,
    assignment: BindingAssignmentRecord,
    device: DeviceInfo,
    inventoryComplete: boolean,
  ): Promise<ReadyResult> {
    return this.creation.replaceAssigned(context, assignment, device, inventoryComplete);
  }

  private async assertCreatable(context: ReconcileContext): Promise<void> {
    return this.creation.assertCreatable(context);
  }

  /** Sessions this daemon holds on `device` (none when the claims port cannot tell). */
  private sessionsOn(device: DeviceInfo): string[] {
    return this.deps.claims.sessionsOn?.(device) ?? [];
  }

  /**
   * Every execution gets a fresh session: end the sessions earlier executions left on the device
   * (or refuse, when they are not ours to end) before provisioning binds it, and refuse a provision
   * that still hands one of them back.
   */
  private async releaseStaleSessions(
    context: ReconcileContext,
    device: DeviceInfo,
  ): Promise<ReadonlySet<string>> {
    const stale = this.sessionsOn(device);
    if (stale.length === 0) {
      return new Set();
    }
    this.assertNoLiveExecutionOn(context, device, stale);
    try {
      await Promise.all(
        stale.map((sessionUuid) => this.deps.provisioner.releaseSession(sessionUuid)),
      );
    } catch (error) {
      logger.warn(
        `[Bindings] releasing stale session(s) on '${device.name}' failed: ${errorMessage(error)}`,
        error,
      );
      throw new ReconcileAbort(
        failure(
          "stale_session",
          `An earlier execution's session on '${device.name}' could not be released: ${errorMessage(error)}`,
        ),
      );
    }
    context.evidence.releasedStaleSessions = stale;
    return new Set(stale);
  }

  /**
   * Refuse with a retryable `binding_in_use` when this daemon still holds a session on the device as a
   * live managed execution (#11275): a duplicate acquisition must never release it.
   */
  private assertNoLiveExecutionOn(
    context: ReconcileContext,
    device: DeviceInfo,
    sessions: readonly string[] = this.sessionsOn(device),
  ): void {
    const live = sessions.find((sessionUuid) => this.deps.claims.isLiveExecution?.(sessionUuid));
    if (live !== undefined) {
      throw new ReconcileAbort(
        failure(
          "binding_in_use",
          `Binding ${context.request.key.bindingIndex} is held by live session ${live} on '${device.name}'.`,
        ),
      );
    }
  }

  private async provisionExisting(
    context: ReconcileContext,
    device: DeviceInfo,
  ): Promise<BindingProvisionedDevice> {
    const { request } = context;
    const stale = await this.releaseStaleSessions(context, device);
    let provisioned: BindingProvisionedDevice;
    try {
      provisioned = await this.deps.provisioner.provision({
        platform: request.platform,
        name: device.name,
        ...(request.platform === "ios" && device.deviceId ? { deviceId: device.deviceId } : {}),
        spec: provisionableSpec(request.requestedSpec),
        mode: "adopt",
        deadlineMs: request.deadlineMs,
        signal: request.signal,
      });
    } catch (error) {
      throw new ReconcileAbort(provisionFailure(error));
    }
    if (stale.has(provisioned.sessionUuid)) {
      // Never hand an earlier execution's session to this one.
      await this.releaseSession(provisioned.sessionUuid);
      throw new ReconcileAbort(
        failure(
          "stale_session",
          `Provisioning '${device.name}' returned earlier session ${provisioned.sessionUuid}.`,
        ),
      );
    }
    if (!this.isAutomationReady(provisioned)) {
      await this.releaseSession(provisioned.sessionUuid);
      throw new ReconcileAbort(
        failure(
          "readiness_incomplete",
          `Device '${device.name}' did not reach automation readiness.`,
        ),
      );
    }
    return provisioned;
  }

  private isAutomationReady(provisioned: BindingProvisionedDevice): boolean {
    return (
      provisioned.sessionUuid.length > 0 &&
      provisioned.readiness.mode === "automation" &&
      provisioned.readiness.status === "automation_ready"
    );
  }

  private async releaseSession(sessionUuid: string): Promise<void> {
    try {
      await this.deps.provisioner.releaseSession(sessionUuid);
    } catch (error) {
      logger.warn(
        `[Bindings] releasing unpublished session ${sessionUuid} failed: ${errorMessage(error)}`,
        error,
      );
    }
  }

  private checkBudget(request: BindingReconcileRequest): void {
    if (request.signal?.aborted) {
      throw new ReconcileAbort(failure("cancelled", "Binding preparation was cancelled."));
    }
    if (this.deps.timer.now() >= request.deadlineMs) {
      throw new ReconcileAbort(failure("timeout", "Binding preparation deadline passed."));
    }
  }

  /**
   * Hand the binding to the request's execution (superseding its own reservation) under the binding
   * just committed, then report ready. A lost claim releases the session it would have published.
   */
  private async claimAndReady(
    context: ReconcileContext,
    disposition: BindingDisposition,
    assignment: BindingAssignmentRecord,
    { provisioned, reservation }: { provisioned: BindingProvisionedDevice; reservation?: string },
  ): Promise<ReadyResult> {
    const { owner, key } = context.request;
    if (!owner) {
      return this.ready(context, disposition, assignment, provisioned);
    }
    const claimed = await this.deps.registry.claimExecution(
      key,
      expectationOf(assignment),
      { ...owner, sessionUuid: provisioned.sessionUuid },
      reservation ? { supersedesSessionUuid: reservation } : {},
    );
    if (claimed.kind !== "claimed") {
      await this.releaseSession(provisioned.sessionUuid);
      throw new ReconcileAbort(claimFailure(claimed, "execution claim"));
    }
    return this.ready(context, disposition, claimed.assignment, provisioned);
  }

  /** A busy publish cannot hand out its freshly provisioned session; release it before refusing. */
  private async readyOrReleaseOnBusy(
    provisioned: BindingProvisionedDevice,
    publish: (release: () => Promise<void>) => Promise<ReadyResult>,
  ): Promise<ReadyResult> {
    let released = false;
    const release = async () => {
      if (!released) {
        released = true;
        await this.releaseSession(provisioned.sessionUuid);
      }
    };
    try {
      return await publish(release);
    } catch (error) {
      if (classifySqliteError(error) === "retryable") {
        await release();
      }
      throw error;
    }
  }

  private ready(
    context: ReconcileContext,
    disposition: BindingDisposition,
    assignment: BindingAssignmentRecord,
    provisioned: BindingProvisionedDevice,
  ): ReadyResult {
    return {
      outcome: "ready",
      disposition,
      assignment,
      device: provisioned.device,
      sessionUuid: provisioned.sessionUuid,
      requestedSpec: context.request.requestedSpec,
      resolvedSpec: context.resolvedSpec,
      specFingerprint: context.fingerprint,
      readiness: provisioned.readiness,
      ...(provisioned.lifecycle !== undefined ? { lifecycle: provisioned.lifecycle } : {}),
      evidence: context.evidence,
    };
  }
}

export { DefaultManagedSpecMatcher } from "./DefaultManagedSpecMatcher";

export { DefaultManagedSpecResolver } from "./DefaultManagedSpecResolver";

export { type ManagedSpecMatcher } from "./DefaultManagedSpecMatcher";

export { type BindingRequestedSpec } from "./DefaultManagedSpecMatcher";

export { type ManagedSpecMatch } from "./DefaultManagedSpecMatcher";

export { type ManagedAndroidImageCatalog } from "./DefaultManagedSpecResolver";

export { type ManagedAndroidProfileCatalog } from "./DefaultManagedSpecResolver";

export { type DefaultManagedSpecResolverOptions } from "./DefaultManagedSpecResolver";

export { computeManagedSpecFingerprint } from "./DefaultManagedSpecResolver";

export { chooseIosDeviceType } from "./DefaultManagedSpecResolver";

export { type BindingReconcileFailure } from "./ReconcileAbort";
