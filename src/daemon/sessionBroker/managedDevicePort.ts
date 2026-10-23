import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import { defaultTimer, type Timer } from "../../utils/SystemTimer";
import { raceWithDeadline } from "../../utils/raceWithDeadline";
import { combineAbortSignals } from "../../utils/AbortContext";
import { DEFAULT_PROVISION_DEVICE_TIMEOUT_MS } from "../../utils/deviceTimeouts";
import { DEFAULT_RUNNER_PROVISION_TIMEOUT_MS } from "../../utils/runnerReadinessConfig";
import type { BrokerExecutionRelease } from "./provisioning/executionRelease";
import type { BrokerDeviceAcquisition } from "./provisioning/deviceAcquisition";
import type { BindingJournal } from "./registry/bindingJournal";
import { defaultBindingExecOwnerLiveness } from "./registry/ownerLiveness";
import { runAsBindingReconciler } from "./provisioning/exclusion";
import { brokerSessionMutationScope, iosMutationIncarnation } from "./mutations/recorder";
import type { DeviceMutationScope } from "./mutations/types";
import {
  computeBindingScopeKey,
  journalOwnersEqual,
  sameBinding,
  type BindingAssignmentRecord,
  type BindingKey,
  type BindingRegistry,
  type BindingScopeIdentity,
  type BindingExecOwnerLiveness,
} from "./registry/bindingRegistry";
import { type BrokerProvisionRequest } from "./provisioning/provisionRequest";
import { ActionableError, toActionableError } from "../../models/ActionableError";
import type { DeviceIncarnationScope } from "./mutations/types";
import type { DeviceMutationResetContext } from "./mutations/reset";
import type { BootedDevice } from "../../models/DeviceInfo";
import { parseAndroidSystemImageRuntime } from "../../utils/android-cmdline-tools/AndroidSystemImageRuntime";
import {
  SessionBrokerFailureError,
  type SessionBrokerDevicePort,
  type SessionDevicePreparationOptions,
  type ResetResult,
  type ResetOutcome,
  type ResetBootRunner,
  type SessionPreparationTiming,
} from "./devicePort";
import { nativeProfile, type BrokerNativeProfile } from "./profile";
import type { BrokerResourceRecord } from "./store";
import { preparationTiming } from "./preparationTiming";
import {
  defaultManufacturerProfileApplier,
  type ManufacturerProfileApplier,
} from "../../features/utility/personaExecutors";

import { BROKER_BINDING_ROLE } from "./persistedIdentity";
import type { AndroidBaselineReset } from "./androidBaselineReset";
import type { TaskLeaseKeepalive } from "../tasks/taskLeaseKeepalive";

type ManagedDevicePortRegistry = Pick<
  BindingRegistry,
  "getAssignment" | "listOpenBindingJournal" | "openBindingJournal"
>;
type BrokerDeviceAcquisitionResult = Awaited<ReturnType<BrokerDeviceAcquisition["acquire"]>>;
type BrokerDeviceAcquisitionEntry = BrokerDeviceAcquisitionResult["bindings"][number];
type DestructionProgress = "absent" | "pending";

export interface ManagedDevicePortDependencies {
  bindMutationRecorder?: (scope: DeviceMutationScope) => void;
  /** Stable provider-owned identity. Consumer requests never choose this scope or a binding index. */
  scope: BindingScopeIdentity;
  timer?: Pick<Timer, "now" | "sleep" | "setTimeout" | "clearTimeout">;
  /** Renews the acquired session while baseline preparation delays the client grant. */
  leaseKeepalive?: TaskLeaseKeepalive;
  brokerDeviceAcquisition: Pick<BrokerDeviceAcquisition, "acquire">;
  brokerExecutionRelease: Pick<BrokerExecutionRelease, "releaseExecution">;
  registry: ManagedDevicePortRegistry;
  bindingJournal: Pick<BindingJournal, "owner" | "redriveBinding">;
  /** Defaults to the binding PID plus process-generation liveness check. */
  isExecOwnerLive?: BindingExecOwnerLiveness;
  /** Applies a requested `deviceProfile` after readiness (#14058); defaults to production. */
  manufacturerProfileApplier?: ManufacturerProfileApplier;
  /** Supplied only for qualified platform reset implementations. */
  resetBaseline?: {
    ios?: (
      device: BootedDevice,
      profile: Extract<BrokerNativeProfile, { platform: "ios" }>,
      assertOwned: () => Promise<void>,
      signal?: AbortSignal,
      context?: {
        resource: BrokerResourceRecord;
        scope: DeviceIncarnationScope;
        runResetBoot?: ResetBootRunner;
      },
    ) => Promise<"clean" | ResetOutcome>;
    android?: Pick<AndroidBaselineReset, "canCapture" | "capture" | "reset" | "forget">;
  };
  captureIosBaseline?: (context: DeviceMutationResetContext) => Promise<void>;
  /** Durable request/revision fence; a stale reset must not act on a later session's resource. */
  isCurrentReset?: (resource: BrokerResourceRecord) => Promise<boolean>;
}

/**
 * Bounded native bridge for the session broker's private bindings.
 *
 * The binding reconciler owns provisioning and readiness, the execution release owns the
 * bounded drain, and the durable binding journal owns destructive convergence. This adapter adds no
 * allocator, journal, pool, process, or background work.
 */
export class ManagedDevicePort implements SessionBrokerDevicePort {
  readonly managesResetBootSlots = true;
  private readonly androidDevices = new Map<
    string,
    {
      device: BootedDevice;
      generation: number;
      stableDeviceId: string;
    }
  >();
  private readonly scope: BindingScopeIdentity;
  private readonly scopeKey: string;
  private readonly isExecOwnerLive: BindingExecOwnerLiveness;

  constructor(private readonly dependencies: ManagedDevicePortDependencies) {
    this.scope = { ...dependencies.scope };
    this.scopeKey = computeBindingScopeKey(this.scope);
    this.isExecOwnerLive = dependencies.isExecOwnerLive ?? defaultBindingExecOwnerLiveness;
  }

  async prepare(
    resource: BrokerResourceRecord,
    options: SessionDevicePreparationOptions,
  ): Promise<{
    sessionId: string;
    profile: BrokerNativeProfile;
    timing?: SessionPreparationTiming;
  }> {
    this.assertResource(resource, "reserved");
    if (!resource.requestId) {
      throw new ActionableError("A broker device reservation must belong to a session request");
    }
    const profile = nativeProfile(resource);
    const requestedSpec = this.requestedSpec(profile);
    const timer = this.dependencies.timer ?? defaultTimer;
    const deadlineMs =
      timer.now() + (options.preparationTimeoutMs ?? DEFAULT_PROVISION_DEVICE_TIMEOUT_MS);
    const acquire = (preparationTimeoutMs: number, createRetryReserveMs = 0) => {
      const config = this.bindingConfig(resource, profile, requestedSpec, {
        ...options,
        preparationTimeoutMs: Math.max(1, preparationTimeoutMs),
      });
      return this.dependencies.brokerDeviceAcquisition.acquire(
        createRetryReserveMs > 0 ? { ...config, createRetryReserveMs } : config,
        {
          livenessOwnerToken: options.livenessOwnerToken,
          ...(options.signal ? { signal: options.signal } : {}),
        },
      );
    };
    // Only an empty iOS binding's create path can retain a device for one warm readiness retry.
    // Reserve one third (at most a runner provisioning window) for that retry, but spend it only
    // once provisioning actually chooses to create (#14643): adopting a leftover simulator or
    // reusing a bound device keeps the caller's full timeout for its boot wait.
    const remainingMs = deadlineMs - timer.now();
    const retryReserveMs =
      profile.platform === "ios"
        ? Math.min(remainingMs / 3, DEFAULT_RUNNER_PROVISION_TIMEOUT_MS)
        : 0;
    let result = await acquire(remainingMs, retryReserveMs);
    if (
      this.canRetryReadiness(result, resource, profile) &&
      !this.preparationStopped(deadlineMs, options.signal)
    ) {
      // The created journal still owns this simulator. Keep the intermediate failure inside
      // prepare so the broker does not destroy it before this single adoption retry.
      await this.waitForRetry(Math.min(deadlineMs - timer.now(), 25), options.signal);
      if (!this.preparationStopped(deadlineMs, options.signal)) {
        result = await acquire(deadlineMs - timer.now());
      }
    }
    const sessionId = await this.readySessionId(result, resource, profile);
    await this.captureBaselinesHoldingLease(resource, result, profile, sessionId, {
      signal: options.signal,
      deadlineMs,
      deviceProfileOptions: options,
    });
    const binding = result.bindings.find(
      (entry) => entry.bindingIndex === resource.allocationIndex,
    );
    return { sessionId, profile, timing: preparationTiming(binding?.lifecycle) };
  }

  /**
   * Apply the request's manufacturer profile to the prepared session's device (#14058). Its
   * release restores what it changed; a failure fails preparation like a readiness failure.
   */
  private async applyDeviceProfile(
    resource: BrokerResourceRecord,
    result: BrokerDeviceAcquisitionResult,
    sessionId: string,
    options: SessionDevicePreparationOptions,
  ): Promise<void> {
    const deviceProfile = options.deviceProfile;
    if (!deviceProfile) {
      return;
    }
    const device =
      this.androidDevices.get(resource.resourceId)?.device ?? acquiredAndroidDevice(result);
    const applier =
      this.dependencies.manufacturerProfileApplier ?? defaultManufacturerProfileApplier;
    const applied = await applier.apply(device, deviceProfile, sessionId, options.signal);
    if (applied.status === "route_to_real_device") {
      throw new ActionableError(applied.message);
    }
    logger.info(`[SessionBroker] ${applied.message}`);
  }

  /**
   * Keeps the acquired session's lease renewed while baseline capture and the manufacturer
   * profile apply delay the client grant.
   */
  private async captureBaselinesHoldingLease(
    resource: BrokerResourceRecord,
    result: BrokerDeviceAcquisitionResult,
    profile: BrokerNativeProfile,
    sessionId: string,
    options: {
      signal?: AbortSignal;
      deadlineMs: number;
      deviceProfileOptions: SessionDevicePreparationOptions;
    },
  ): Promise<void> {
    const release = this.dependencies.leaseKeepalive?.hold({
      taskId: resource.requestId!,
      ownerKey: "session-broker",
      sessionUuid: sessionId,
    });
    try {
      await this.captureAndroidBaseline(resource, result, profile, sessionId, options);
      if (profile.platform === "ios" && this.dependencies.captureIosBaseline) {
        await this.capturePoolEntryBaseline(resource, sessionId, options);
      }
      // After the reset baseline is captured, so a keep-booted reset returns to pre-profile state.
      await this.applyDeviceProfile(resource, result, sessionId, options.deviceProfileOptions);
    } finally {
      release?.();
    }
  }

  private async captureAndroidBaseline(
    resource: BrokerResourceRecord,
    result: BrokerDeviceAcquisitionResult,
    profile: BrokerNativeProfile,
    sessionId: string,
    options: { signal?: AbortSignal; deadlineMs: number },
  ): Promise<void> {
    const android = this.dependencies.resetBaseline?.android;
    if (profile.platform !== "android" || !android || !android.canCapture) {
      return;
    }
    this.androidDevices.delete(resource.resourceId);
    try {
      const entry = result.bindings[0];
      const binding = entry?.device;
      if (!binding?.transportId || typeof entry?.assignmentGeneration !== "number") {
        throw new ActionableError("Android reset baseline requires the acquired emulator serial");
      }
      const device: BootedDevice = {
        platform: "android",
        name: binding.name,
        deviceId: binding.transportId,
      };
      this.androidDevices.set(resource.resourceId, {
        device,
        generation: entry.assignmentGeneration,
        stableDeviceId: binding.stableId,
      });
      await runAsBindingReconciler(this.key(resource), () =>
        android.capture(resource.resourceId, device, profile, sessionId, {
          fresh: entry.disposition === "created" || entry.disposition === "replaced",
          signal: options.signal,
          timeoutMs: Math.max(
            0,
            options.deadlineMs - (this.dependencies.timer ?? defaultTimer).now(),
          ),
          timer: this.dependencies.timer ?? defaultTimer,
          incarnation: JSON.stringify([resource.resourceId, binding.stableId]),
          assertOwned: async () => {
            options.signal?.throwIfAborted();
            const current = await this.dependencies.registry.getAssignment(this.key(resource));
            if (
              !current ||
              !sameBinding(current, {
                generation: entry.assignmentGeneration!,
                stableDeviceId: binding.stableId,
              }) ||
              current.state !== "ready" ||
              current.deviceName !== device.name ||
              current.execOwner?.sessionUuid !== sessionId ||
              current.settler !== null ||
              (await this.hasOpenJournal(this.key(resource)))
            ) {
              throw new ActionableError(
                "Android baseline capture lost exclusive binding ownership",
              );
            }
          },
        }),
      );
    } catch (error) {
      await this.handleAndroidBaselineCaptureFailure(resource.resourceId, android, options, error);
    }
  }

  private async handleAndroidBaselineCaptureFailure(
    resourceId: string,
    android: Pick<AndroidBaselineReset, "forget">,
    options: { signal?: AbortSignal; deadlineMs: number },
    error: unknown,
  ): Promise<void> {
    await android.forget(resourceId);
    this.androidDevices.delete(resourceId);
    options.signal?.throwIfAborted();
    if (this.preparationStopped(options.deadlineMs, options.signal)) {
      throw new ActionableError("Android reset baseline capture exceeded preparation deadline");
    }
    logger.warn(
      `Android reset baseline unavailable; device will be destroyed on release: ${errorMessage(error)}`,
      error,
    );
  }

  private async capturePoolEntryBaseline(
    resource: BrokerResourceRecord,
    sessionId: string,
    options: { signal?: AbortSignal; deadlineMs: number },
  ): Promise<void> {
    const timer = this.dependencies.timer ?? defaultTimer;
    const controller = new AbortController();
    const signal = combineAbortSignals(controller.signal, options.signal) ?? controller.signal;
    let assertCaptureOwned: (() => Promise<void>) | undefined;
    try {
      signal.throwIfAborted();
      if (this.preparationStopped(options.deadlineMs, signal)) {
        throw new ActionableError("iOS reset baseline capture exceeded preparation deadline");
      }
      const key = this.key(resource);
      const assignment = await this.dependencies.registry.getAssignment(key);
      if (!assignment?.stableDeviceId || assignment.execOwner?.sessionUuid !== sessionId) {
        throw new ActionableError("iOS baseline capture requires the acquired execution binding");
      }
      const assertOwned = async () => {
        signal.throwIfAborted();
        if (this.preparationStopped(options.deadlineMs, signal)) {
          throw new ActionableError("iOS reset baseline capture exceeded preparation deadline");
        }
        const current = await this.dependencies.registry.getAssignment(key);
        if (
          !current ||
          !sameBinding(current, assignment) ||
          current.state !== "ready" ||
          current.execOwner?.sessionUuid !== sessionId ||
          current.settler !== null ||
          (await this.hasOpenJournal(key))
        ) {
          throw new ActionableError("iOS baseline capture lost execution binding ownership");
        }
      };
      assertCaptureOwned = assertOwned;
      await raceWithDeadline(
        () =>
          this.dependencies.captureIosBaseline!({
            scope: { ...this.mutationScope(resource, assignment), sessionUuid: sessionId },
            assertOwned,
            signal,
          }),
        {
          timer,
          signal,
          timeoutMs: Math.max(0, options.deadlineMs - timer.now()),
          label: "iOS pool-entry baseline capture",
          timeoutError: () =>
            new DOMException(
              "iOS reset baseline capture exceeded preparation deadline",
              "TimeoutError",
            ),
          onTimeout: () =>
            controller.abort(new DOMException("iOS baseline preparation deadline", "TimeoutError")),
        },
      );
      await assertOwned();
    } catch (error) {
      logger.warn(
        `Skipping iOS pool-entry baseline; release erases if app baseline is unavailable: ${errorMessage(error)}`,
        error,
      );
      options.signal?.throwIfAborted();
      if (this.preparationStopped(options.deadlineMs, options.signal)) {
        throw toActionableError(error, "iOS reset baseline capture exceeded preparation deadline");
      }
      if (!assertCaptureOwned) {
        throw toActionableError(
          error,
          "Cannot capture iOS pool-entry baseline after ownership loss",
        );
      }
      await assertCaptureOwned();
    }
  }

  private preparationStopped(deadlineMs: number, signal?: AbortSignal): boolean {
    return (
      signal?.aborted === true || (this.dependencies.timer ?? defaultTimer).now() >= deadlineMs
    );
  }

  private canRetryReadiness(
    result: BrokerDeviceAcquisitionResult,
    resource: BrokerResourceRecord,
    profile: BrokerNativeProfile,
  ): boolean {
    const binding = result.bindings.find(
      (entry) => entry.bindingIndex === resource.allocationIndex,
    );
    if (!binding?.failure) {
      return false;
    }
    const retry = binding.failure;
    const readinessFailure =
      retry.code === "readiness_incomplete" ||
      retry.code === "timeout" ||
      (retry.code === "provision_failed" && retry.provision?.code === "timeout");
    return [
      profile.platform === "ios",
      result.outcome === "failed",
      result.scope.scopeKey === this.scopeKey,
      result.bindings.length === 1,
      binding.sessionUuid === null,
      retry.retryable,
      retry.retainedDevice?.platform === "ios",
      readinessFailure,
    ].every(Boolean);
  }

  private async waitForRetry(delayMs: number, signal?: AbortSignal): Promise<void> {
    const timer = this.dependencies.timer ?? defaultTimer;
    let handle: NodeJS.Timeout | undefined;
    try {
      await raceWithDeadline(
        () =>
          new Promise<void>((resolve) => {
            handle = timer.setTimeout(resolve, delayMs);
          }),
        { timer, signal, label: "Managed device readiness retry" },
      );
    } catch (error) {
      throw new SessionBrokerFailureError({
        code: signal?.aborted ? "cancelled" : "session_preparation_failed",
        retryable: signal?.aborted === true,
        message: signal?.aborted ? "The binding acquisition was cancelled." : errorMessage(error),
      });
    } finally {
      if (handle !== undefined) {
        timer.clearTimeout(handle);
      }
    }
  }

  private async readySessionId(
    result: BrokerDeviceAcquisitionResult,
    resource: BrokerResourceRecord,
    profile: BrokerNativeProfile,
  ): Promise<string> {
    const binding = result.bindings.find(
      (entry) => entry.bindingIndex === resource.allocationIndex,
    );
    const resultReady = [
      result.outcome === "ready",
      result.scope.scopeKey === this.scopeKey,
      result.bindings.length === 1,
    ].every(Boolean);
    if (resultReady && this.isReadyBinding(binding, profile)) {
      if (this.dependencies.bindMutationRecorder) {
        try {
          this.dependencies.bindMutationRecorder(
            brokerSessionMutationScope({
              platform: profile.platform,
              sessionUuid: binding.sessionUuid,
              resource,
              stableDeviceId: binding.device!.stableId,
              transportId: binding.device!.transportId,
              assignmentGeneration: binding.assignmentGeneration,
            }),
          );
        } catch (error) {
          logger.warn(
            "Failed to bind broker device mutation recorder; acquiring without recording",
            error,
          );
        }
      }
      return binding.sessionUuid;
    }
    const sessionId = binding === undefined ? null : binding.sessionUuid;
    if (typeof sessionId === "string" && sessionId.length > 0) {
      await this.dependencies.brokerExecutionRelease.releaseExecution(sessionId);
    }
    const { code, retryable, message } = result.failure ??
      binding?.failure ?? {
        code: "session_preparation_failed",
        retryable: false,
        message: "Managed device preparation did not return an automation-ready session",
      };
    throw new SessionBrokerFailureError({ code, retryable, message });
  }

  private isReadyBinding(
    binding: BrokerDeviceAcquisitionEntry | undefined,
    profile: BrokerNativeProfile,
  ): binding is BrokerDeviceAcquisitionEntry & { sessionUuid: string } {
    if (binding === undefined || binding.readiness === null) {
      return false;
    }
    if (typeof binding.sessionUuid !== "string" || binding.sessionUuid.length === 0) {
      return false;
    }
    return [
      binding.platform === profile.platform,
      binding.failure === undefined,
      binding.device !== null,
      binding.readiness.mode === "automation",
      binding.readiness.status === "automation_ready",
    ].every(Boolean);
  }

  async release(sessionId: string): Promise<{ settled: boolean }> {
    if (!sessionId.trim()) {
      throw new ActionableError("A managed execution session UUID must be non-empty");
    }
    const result = await this.dependencies.brokerExecutionRelease.releaseExecution(sessionId);
    return {
      settled:
        result.outcome === "reusable_for_this_binding" &&
        result.settlement === "confirmed" &&
        result.bindingFailures.length === 0,
    };
  }

  async reset(
    resource: BrokerResourceRecord,
    signal?: AbortSignal,
    runResetBoot?: ResetBootRunner,
  ): Promise<ResetResult> {
    this.assertResource(resource, "resetting");
    const profile = nativeProfile(resource);
    const ios = this.dependencies.resetBaseline?.ios;
    const android = this.dependencies.resetBaseline?.android;
    const isCurrent = this.dependencies.isCurrentReset;
    if (!isCurrent || (profile.platform === "ios" ? !ios : !android)) {
      return "pending";
    }
    const key = this.key(resource);
    const assignment = await this.dependencies.registry.getAssignment(key);
    if (!assignment?.stableDeviceId || !assignment.deviceName) {
      throw new ActionableError("Reset requires a current bound native device");
    }
    const name = assignment.deviceName;
    const expected = {
      generation: assignment.generation,
      stableDeviceId: assignment.stableDeviceId,
    };
    const assertOwned = async () => {
      signal?.throwIfAborted();
      if (!(await isCurrent(resource))) {
        throw new ActionableError("Clean reset no longer owns its durable resource revision");
      }
      const current = await this.dependencies.registry.getAssignment(key);
      const valid =
        current &&
        sameBinding(current, expected) &&
        current.state === "ready" &&
        current.execOwner === null &&
        current.settler === null &&
        current.deviceName === name &&
        this.belongsToResource(current, profile, this.requestedSpec(profile));
      if (!valid || (await this.hasOpenJournal(key))) {
        throw new ActionableError("Clean reset lost exclusive native binding ownership");
      }
    };
    await assertOwned();
    const result = await runAsBindingReconciler(key, async () => {
      if (profile.platform === "ios" && ios) {
        return ios(
          { platform: "ios", deviceId: expected.stableDeviceId, name },
          profile,
          assertOwned,
          signal,
          { resource, scope: this.mutationScope(resource, assignment), runResetBoot },
        );
      }
      if (!android || profile.platform !== "android") {
        throw new ActionableError(
          "Android reset dispatch requires an Android reset implementation and profile",
        );
      }
      if (!android.canCapture) {
        throw new ActionableError(
          "Android reset is destruction-only: no androidResetMode reset strategy is configured",
        );
      }
      const device = this.androidResetTarget(resource, assignment, name);
      return android.reset(resource.resourceId, device, profile, assertOwned);
    });
    await assertOwned();
    return result;
  }

  private androidResetTarget(
    resource: BrokerResourceRecord,
    assignment: BindingAssignmentRecord,
    name: string,
  ): BootedDevice {
    const acquired = this.androidDevices.get(resource.resourceId);
    if (!acquired) {
      throw new ActionableError("Android reset baseline was not captured at acquisition");
    }
    const fields: string[] = [];
    if (!this.sameReleasedBinding(assignment, acquired)) {
      fields.push("generation");
    }
    if (acquired.stableDeviceId !== assignment.stableDeviceId) {
      fields.push("stableDeviceId");
    }
    if (acquired.device.name !== name) {
      fields.push("deviceName");
    }
    if (assignment.stableDeviceId !== name) {
      fields.push("avdName");
    }
    if (fields.length > 0) {
      logger.warn(`Android reset acquired transport identity mismatch: ${fields.join(", ")}`, {
        resourceId: resource.resourceId,
        fields,
        acquired: {
          generation: acquired.generation,
          stableDeviceId: acquired.stableDeviceId,
          deviceName: acquired.device.name,
        },
        expected: {
          generation: assignment.generation,
          stableDeviceId: assignment.stableDeviceId,
          deviceName: name,
        },
      });
      throw new ActionableError(
        `Android reset lacks its original acquired transport identity (mismatched: ${fields.join(", ")})`,
      );
    }
    return acquired.device;
  }

  private mutationScope(
    resource: BrokerResourceRecord,
    assignment: BindingAssignmentRecord,
  ): DeviceIncarnationScope {
    if (!assignment.stableDeviceId) {
      throw new ActionableError("iOS mutation scope requires an exact bound device");
    }
    return {
      deviceId: assignment.stableDeviceId,
      incarnation: iosMutationIncarnation(
        resource.scopeKey,
        resource.allocationIndex,
        assignment.stableDeviceId,
      ),
    };
  }

  async destroy(
    resource: BrokerResourceRecord,
    signal?: AbortSignal,
  ): Promise<DestructionProgress> {
    signal?.throwIfAborted();
    this.assertResource(resource, "destroying");
    const profile = nativeProfile(resource);
    if (profile.platform === "android") {
      await this.dependencies.resetBaseline?.android?.forget(resource.resourceId);
      this.androidDevices.delete(resource.resourceId);
    }
    const requestedSpec = this.requestedSpec(profile);
    const key = this.key(resource);

    if ((await this.redriveOpenJournal(key, signal)) === "pending") {
      return "pending";
    }

    signal?.throwIfAborted();
    const current = await this.destroyableAssignment(key, profile, requestedSpec);
    if (typeof current === "string") {
      return current;
    }
    signal?.throwIfAborted();
    const drained = await this.drainAssignment(key, current, profile, requestedSpec);
    signal?.throwIfAborted();
    return typeof drained === "string" ? drained : this.deleteAssignment(key, drained, signal);
  }

  private async destroyableAssignment(
    key: BindingKey,
    profile: BrokerNativeProfile,
    requestedSpec: BrokerProvisionRequest["requests"][number]["requestedSpec"],
  ): Promise<BindingAssignmentRecord | DestructionProgress> {
    const assignment = await this.dependencies.registry.getAssignment(key);
    if (!assignment || assignment.stableDeviceId === null) {
      return this.confirmNoBinding(key);
    }
    return this.belongsToResource(assignment, profile, requestedSpec) ? assignment : "pending";
  }

  private async drainAssignment(
    key: BindingKey,
    assignment: BindingAssignmentRecord,
    profile: BrokerNativeProfile,
    requestedSpec: BrokerProvisionRequest["requests"][number]["requestedSpec"],
  ): Promise<BindingAssignmentRecord | DestructionProgress> {
    if (!assignment.execOwner) {
      return assignment;
    }
    if (!journalOwnersEqual(assignment.execOwner, this.dependencies.bindingJournal.owner)) {
      return this.isExecOwnerLive(assignment.execOwner) ? "pending" : assignment;
    }
    const released = await this.release(assignment.execOwner.sessionUuid);
    if (!released.settled) {
      return "pending";
    }
    const after = await this.dependencies.registry.getAssignment(key);
    if (!after) {
      return this.confirmNoBinding(key);
    }
    const unchanged = [
      this.sameReleasedBinding(after, assignment),
      after.state === "ready",
      after.settler === null,
      after.execOwner === null,
      this.belongsToResource(after, profile, requestedSpec),
    ].every(Boolean);
    return unchanged ? after : "pending";
  }

  private sameReleasedBinding(
    assignment: BindingAssignmentRecord,
    acquired: { generation: number; stableDeviceId: string | null },
  ): boolean {
    return (
      sameBinding(assignment, acquired) ||
      sameBinding(assignment, { ...acquired, generation: acquired.generation + 1 })
    );
  }

  private async deleteAssignment(
    key: BindingKey,
    assignment: BindingAssignmentRecord,
    signal?: AbortSignal,
  ): Promise<DestructionProgress> {
    if (assignment.stableDeviceId === null) {
      return this.confirmNoBinding(key);
    }
    const stableDeviceId = assignment.stableDeviceId;
    signal?.throwIfAborted();
    const opened = await this.dependencies.registry.openBindingJournal(key, {
      kind: "replace",
      phase: "deleting",
      owner: this.dependencies.bindingJournal.owner,
      target: {
        oldStableId: stableDeviceId,
        oldName: assignment.deviceName,
        newName: null,
        newStableId: null,
        requestedSpec: assignment.requestedSpec,
        resolvedSpec: assignment.resolvedSpec,
        specFingerprint: assignment.specFingerprint,
      },
      assignment: {
        kind: "state",
        expected: {
          generation: assignment.generation,
          stableDeviceId,
        },
        state: "replacing",
      },
    });
    if (opened.kind !== "opened" && opened.kind !== "journal_open") {
      return "pending";
    }
    signal?.throwIfAborted();
    const redriven = await this.dependencies.bindingJournal.redriveBinding(key, { signal });
    signal?.throwIfAborted();
    if (redriven.kind === "blocked" || (await this.hasOpenJournal(key))) {
      return "pending";
    }
    const after = await this.dependencies.registry.getAssignment(key);
    return !after || after.stableDeviceId === null ? "absent" : "pending";
  }

  private async confirmNoBinding(key: BindingKey): Promise<DestructionProgress> {
    const assignment = await this.dependencies.registry.getAssignment(key);
    if (
      assignment !== null &&
      (assignment.stableDeviceId !== null ||
        assignment.execOwner !== null ||
        assignment.settler !== null)
    ) {
      return "pending";
    }
    return (await this.hasOpenJournal(key)) ? "pending" : "absent";
  }

  private assertResource(
    resource: BrokerResourceRecord,
    expectedState: "reserved" | "destroying" | "resetting",
  ): void {
    if (!resource.resourceId.trim()) {
      throw new ActionableError("A broker resource identity must be non-empty");
    }
    if (
      !Number.isSafeInteger(resource.allocationIndex) ||
      resource.allocationIndex < 0 ||
      resource.scopeKey !== this.scopeKey
    ) {
      throw new ActionableError("Broker resource does not belong to this provider-owned scope");
    }
    if (resource.state !== expectedState) {
      throw new ActionableError(
        `Broker resource '${resource.resourceId}' must be ${expectedState}, not ${resource.state}`,
      );
    }
  }

  private key(resource: BrokerResourceRecord): BindingKey {
    return { scopeKey: this.scopeKey, bindingIndex: resource.allocationIndex };
  }

  private bindingConfig(
    resource: BrokerResourceRecord,
    profile: BrokerNativeProfile,
    requestedSpec: BrokerProvisionRequest["requests"][number]["requestedSpec"],
    options: SessionDevicePreparationOptions,
  ): BrokerProvisionRequest {
    return {
      contractVersion: 1,
      ...this.scope,
      localBindingCapacity: 1,
      requests: [
        {
          bindingIndex: resource.allocationIndex,
          role: BROKER_BINDING_ROLE,
          platform: profile.platform,
          requestedSpec,
        },
      ],
      ...(options.preparationTimeoutMs === undefined
        ? {}
        : { preparationTimeoutMs: options.preparationTimeoutMs }),
      ...(options.idleTimeoutMs === undefined ? {} : { idleTimeoutMs: options.idleTimeoutMs }),
      ...(options.executionOwnerPid === undefined
        ? {}
        : { executionOwnerPid: options.executionOwnerPid }),
    };
  }

  private requestedSpec(
    profile: BrokerNativeProfile,
  ): BrokerProvisionRequest["requests"][number]["requestedSpec"] {
    if (profile.platform === "ios") {
      return {
        runtime: profile.runtimeId,
        deviceType: profile.simulatorDeviceTypeIdentifier,
      };
    }
    const runtime = parseAndroidSystemImageRuntime(profile.systemImagePackage);
    if (
      !runtime ||
      runtime.apiLevel !== profile.apiLevel ||
      runtime.abi !== profile.abi ||
      runtime.tag !== profile.flavor
    ) {
      throw new ActionableError(
        "Stored Android profile does not agree with its exact system-image package",
      );
    }
    return {
      runtime: runtime.systemImagePackage,
      deviceType: profile.profileId,
    };
  }

  private belongsToResource(
    assignment: BindingAssignmentRecord,
    profile: BrokerNativeProfile,
    requestedSpec: BrokerProvisionRequest["requests"][number]["requestedSpec"],
  ): boolean {
    if (
      assignment.scopeKey !== this.scopeKey ||
      assignment.role !== BROKER_BINDING_ROLE ||
      assignment.platform !== profile.platform
    ) {
      return false;
    }
    const stored = assignment.requestedSpec;
    if (!stored || typeof stored !== "object") {
      return false;
    }
    const candidate = stored as { runtime?: unknown; deviceType?: unknown };
    return (
      candidate.runtime === requestedSpec.runtime &&
      candidate.deviceType === requestedSpec.deviceType
    );
  }

  private async redriveOpenJournal(
    key: BindingKey,
    signal?: AbortSignal,
  ): Promise<"clear" | "pending"> {
    if (!(await this.hasOpenJournal(key))) {
      return "clear";
    }
    signal?.throwIfAborted();
    const result = await this.dependencies.bindingJournal.redriveBinding(key, { signal });
    signal?.throwIfAborted();
    return result.kind === "clear" && !(await this.hasOpenJournal(key)) ? "clear" : "pending";
  }

  private async hasOpenJournal(key: BindingKey): Promise<boolean> {
    return (await this.dependencies.registry.listOpenBindingJournal(key)).length > 0;
  }
}

/** The acquired Android emulator as a booted device, for work on the prepared session. */
function acquiredAndroidDevice(result: BrokerDeviceAcquisitionResult): BootedDevice {
  const binding = result.bindings[0]?.device;
  if (!binding?.transportId) {
    throw new ActionableError("A manufacturer profile requires the acquired emulator serial");
  }
  return { platform: "android", name: binding.name, deviceId: binding.transportId };
}
