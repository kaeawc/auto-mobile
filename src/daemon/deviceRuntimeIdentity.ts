import { DeviceIdentityQuarantinedError } from "../models/DeviceIdentityQuarantinedError";
import { ActionableError, type BootedDevice } from "../models";
import { isAndroidEmulatorSerial } from "../utils/androidSerial";
import { getAbortSignal } from "../utils/AbortContext";
import type { PlatformDeviceManager } from "../devices/deviceUtils";
import { hasMutableDisplayName } from "../utils/ios-cmdline-tools/iosDeviceType";
import { logger } from "../utils/logger";
import { DEFAULT_RETRY_OPTIONS, type RetryExecutor } from "../utils/retry/RetryExecutor";
import type { Timer } from "../utils/SystemTimer";
import { deviceLossCancellationReason } from "./emulatorLossIncident";
import {
  compareIdentityEvidence,
  deriveEvidenceFromBootedDevice,
  deriveEvidenceFromPooledDevice,
  isUnresolvedAndroidEmulatorName,
  type IdentityEvidence,
} from "../devices/deviceIdentityEvidence";
import { DevicePoolError, type DiscoveryReconcileOptions, type PooledDevice } from "./devicePool";

const POOLED_IDENTITY_RECONCILE_MAX_ATTEMPTS = DEFAULT_RETRY_OPTIONS.maxAttempts;
type MutableMetadataSource = "refresh" | "snapshot";

export type DeviceRetirementOptions = Pick<DiscoveryReconcileOptions, "excludeExecutionId"> & {
  /** ANR failure releases session work separately and retains sessionless work. */
  cancelDeviceBoundExecutions?: boolean;
};

function unknownAndroidRuntimeName(deviceId: string): string {
  return `Unknown (${deviceId})`;
}

/** Mutable pool state is read at use time, including after every await. */
export interface DeviceRuntimeIdentityPoolPort {
  getAmbientExecutionId?(): string | undefined;
  getDevices(): Map<string, PooledDevice>;
  notifyDeviceFramesInvalidated?(deviceId: string): void;
  getDeviceManager(): PlatformDeviceManager;
  getRetryExecutor(): RetryExecutor;
  getTimer(): Timer;
  getRefreshGeneration(): number;
  hasReusableSerial(device: PooledDevice): boolean;
  isReservedForShutdown(device: PooledDevice): boolean;
  cancelDeviceExecutions?(
    deviceId: string,
    reason: ReturnType<typeof deviceLossCancellationReason>,
    options: { excludeExecutionId?: string },
  ): Promise<number>;
  cancelDeviceSessionExecutions(
    sessionId: string,
    reason: ReturnType<typeof deviceLossCancellationReason>,
    options: { excludeExecutionId?: string },
  ): Promise<number>;
}

/** Resolves and caches pooled runtime identity without deciding pool membership. */
export class DeviceRuntimeIdentity {
  // Quarantine still withholds identity trust during shutdown. Remember only
  // its deferred cancellation, not another shutdown fence; the existing
  // reservation decides when cancellation is safe. Removed entries are not held.
  private readonly deferredQuarantineCancellations = new WeakSet<PooledDevice>();
  private readonly pendingIdentityReplacements = new Map<string, BootedDevice>();
  private readonly pendingIdentityReplacementUnresolvedObservations = new Map<
    string,
    IdentityEvidence
  >();

  constructor(private readonly pool: DeviceRuntimeIdentityPoolPort) {}

  beginPendingReplacement(device: BootedDevice): void {
    this.pendingIdentityReplacements.set(device.deviceId, device);
    this.pendingIdentityReplacementUnresolvedObservations.delete(device.deviceId);
  }

  getPendingReplacement(deviceId: string): BootedDevice | undefined {
    return this.pendingIdentityReplacements.get(deviceId);
  }

  getPendingUnresolvedEvidence(deviceId: string): IdentityEvidence | undefined {
    return this.pendingIdentityReplacementUnresolvedObservations.get(deviceId);
  }

  clearPendingReplacement(deviceId: string): void {
    this.pendingIdentityReplacements.delete(deviceId);
    this.pendingIdentityReplacementUnresolvedObservations.delete(deviceId);
  }

  assertRuntimeIdentity(
    pooled: PooledDevice,
    expected: Pick<BootedDevice, "deviceId" | "name" | "platform" | "observedAt"> | undefined,
  ): void {
    if (!expected || this.matchesRuntimeIdentity(pooled, expected)) {
      // A tolerated match is still an opportunity to reconcile: every caller
      // runs under the assignment mutex, and leaving the mutable name stale
      // would make pool consumers (DeviceCriteriaMatcher.filterDevices) match
      // the obsolete label until the next refresh (#5690).
      if (expected) {
        this.applyMutableRuntimeMetadata(pooled, expected, "snapshot");
      }
      return;
    }
    throw new ActionableError(
      `Device pool identity mismatch for '${expected.deviceId}': ` +
        `resolved=[${expected.name} platform=${expected.platform}] ` +
        `pooled=[${pooled.name} platform=${pooled.platform} incarnation=${pooled.incarnation}].`,
    );
  }

  /**
   * FUNNEL 1 — the ONE way a discovery observation enters the pool's identity
   * state.
   *
   * Every code path that discovers Android devices and then CONSULTS pooled
   * identity (publishing an epoch, resolving a label, routing a serial, admitting
   * device-addressed work) must fold its observation in here FIRST. Before this
   * funnel each such site decided for itself what to do with an
   * `Unknown (<serial>)` placeholder, so a read that was the first to see one
   * merely withheld its own output while the pool — and therefore every OTHER
   * consumer, including the admission gate — carried on trusting the stale label
   * ([#6863](https://github.com/kaeawc/auto-mobile/pull/6863) review).
   *
   * It applies exactly the transitions the refresh sweep applies to the entry's
   * IDENTITY — retry a placeholder before terminal quarantine, restore on a
   * matching resolved name, enter immediately on a disagreeing one — because it
   * shares the sweep's implementation of them
   * ({@link reconcileObservedPooledIdentity}).
   *
   * What it deliberately does NOT do is change pool MEMBERSHIP. Installing a
   * replacement evicts an incarnation and retires its session, and that belongs to
   * the paths that own allocation (the refresh sweep and the assignment-time
   * liveness check), not to a resource read or a stream request. A disagreement
   * reaching this funnel is therefore quarantined and left for those paths to
   * settle — which is the same conservative rule the sweep already applies when
   * its own replacement is deferred behind a shutdown reservation. Quarantining
   * withholds trust everywhere at once (assignment, tool admission, publishing,
   * destructive confirmation, stream routing), so nothing acts on the stale label
   * in the meantime.
   *
   * Idempotent and cheap: an observation that already {@link describesPooledRuntime}
   * transitions nothing and only advances the entry's identity-ordering stamp
   * ({@link PooledDevice.identityObservedAt}), and serials with no
   * pool entry, non-Android platforms and handsets (whose serial is never
   * reassigned) are skipped for the same reason. It takes no lock, because it
   * changes no membership — only the quarantine flag and the in-flight executions
   * that flag invalidates — so it is safe to call from a path that may already
   * hold the assignment mutex.
   *
   * Enforced by `test/lint/deviceDiscoveryReconcileFunnel.test.ts`, which fails on
   * a new direct discovery call site that is not in its allowlist.
   */
  async reconcileDiscoveryObservation(
    devices: readonly BootedDevice[],
    source: string,
    options: DiscoveryReconcileOptions = {},
  ): Promise<void> {
    const signals = [options.signal, getAbortSignal()].filter(
      (signal): signal is AbortSignal => signal !== undefined,
    );
    options = { ...options, signal: signals.length > 0 ? AbortSignal.any(signals) : undefined };
    for (const device of devices) {
      // A caller that settled its deadline/abort can no longer safely apply a
      // stale snapshot to pooled entries an unrelated acquisition may have bound
      // while this loop was draining (#6955 review).
      if (options.signal?.aborted) {
        break;
      }
      if (device.platform !== "android") {
        continue;
      }
      const pooled = this.pool.getDevices().get(device.deviceId);
      if (!pooled) {
        this.recordPendingIdentityReplacementObservation(device);
        continue;
      }
      if (this.describesPooledRuntime(device)) {
        // Nothing to transition — the observation agrees, carries a resolved name
        // and the entry is live — but it is still the newest identity evidence
        // for this entry, and a straggler that lands after it must be ordered
        // against it rather than quarantining what this observation just proved
        // ([#6888](https://github.com/kaeawc/auto-mobile/pull/6888) review).
        if (this.pool.hasReusableSerial(pooled)) {
          this.recordIdentityObservation(pooled, this.identityEvidenceForBootedDevice(device));
        }
        continue;
      }
      logger.debug(`[DevicePool] Reconciling '${device.name}' on ${device.deviceId} (${source})`);
      await this.reconcileObservedPooledIdentity(pooled, device, options);
    }
  }

  /**
   * The identity half of folding an observation into a pooled entry, shared by
   * {@link reconcileDiscoveryObservation} and the refresh sweep so the quarantine
   * rules cannot drift between them.
   *
   * Three outcomes, and only three: the observation agrees and resolves the name
   * (restore), agrees but carries the placeholder (bounded reconciliation, then
   * terminal quarantine on exhaustion), or disagrees (enter immediately).
   * Handsets short-circuit inside {@link reconcilePooledIdentityResolution} /
   * {@link quarantineDisagreeingPooledIdentity}: their serial is never reassigned
   * and their name is not identity.
   */
  private async reconcileObservedPooledIdentity(
    pooled: PooledDevice,
    device: Pick<
      BootedDevice,
      "deviceId" | "name" | "platform" | "observedAt" | "consoleBusyDuringProbe"
    >,
    options: DiscoveryReconcileOptions = {},
  ): Promise<void> {
    if (this.matchesRuntimeIdentity(pooled, device)) {
      await this.reconcilePooledIdentityResolution(pooled, device, options);
      return;
    }
    await this.quarantineDisagreeingPooledIdentity(
      pooled,
      device,
      "and the pool cannot install the replacement from this observation",
      options,
    );
  }

  /**
   * Whether this pool's entry for a serial describes the runtime a discovery
   * listing just reported on it — false when there is no entry at all.
   *
   * Public because consumers JOIN discovery to pool state by serial alone, and a
   * serial can be reused by a different runtime before the next refresh. A join
   * that has not been checked this way must not publish pool-derived epoch
   * information about the discovered runtime (#6863 review).
   *
   * `Unknown (<serial>)` answers this question with NO. The placeholder means
   * the emulator console did not answer `avd name`, so it is not information:
   * {@link matchesRuntimeIdentity} tolerates it in the direction that matters
   * there (it must never evict a live entry), but tolerance is not agreement,
   * and this predicate exists precisely to gate what gets PUBLISHED about the
   * discovered runtime. Same rule, both directions: a placeholder is never
   * evidence of a replacement and never evidence of continuity.
   */
  describesPooledRuntime(expected: Pick<BootedDevice, "deviceId" | "name" | "platform">): boolean {
    const pooled = this.pool.getDevices().get(expected.deviceId);
    if (pooled === undefined || !this.matchesRuntimeIdentity(pooled, expected)) {
      return false;
    }
    // Read the quarantine state, plus this observation's own placeholder: a
    // caller can reach here with a discovery listing the pool has not folded in
    // yet, and that listing is the newer evidence of the two.
    return !pooled.identityUnresolved && !this.hasUnresolvedEmulatorName(expected);
  }

  /**
   * Whether the pool has an entry for `deviceId` whose identity is currently
   * QUARANTINED — see {@link PooledDevice.identityUnresolved}.
   *
   * Public because the tool layer refuses serial-addressed work on a quarantined
   * entry: the serial resolves, but which AVD answers on it does not, and every
   * destructive or stateful action would be acting on a label the pool can no
   * longer tie to the runtime ([#6863](https://github.com/kaeawc/auto-mobile/pull/6863) review).
   */
  isPooledIdentityUnresolved(deviceId: string): boolean {
    return this.pool.getDevices().get(deviceId)?.identityUnresolved === true;
  }

  /**
   * FUNNEL 2 — the ONE admission gate every device-addressed operation at the
   * daemon boundary passes, with or without a session.
   *
   * Refuses a serial whose pooled identity is QUARANTINED: the serial resolves,
   * but which AVD answers on it does not, so any action addressed to it would be
   * acting on a label the pool can no longer tie to the runtime.
   *
   * `purpose` completes the refusal ("Refusing `<purpose>` on device '<serial>'"),
   * so a tap, an observation and a stored-value mutation are all refused in the
   * same words with the same two facts: the serial, and the label the daemon can
   * no longer tie to it.
   *
   * This exists because the quarantine was first enforced only at
   * {@link assertSessionReadyForAutomation}, which is keyed on a SESSION. An
   * explicit-`deviceId` request against an idle quarantined emulator has no
   * session, so it bypassed the gate entirely and executed against whatever now
   * answers on the serial. `assertSessionReadyForAutomation` is now one caller of
   * this gate rather than the gate itself
   * ([#6863](https://github.com/kaeawc/auto-mobile/pull/6863) review).
   *
   * A serial with no pool entry passes: the quarantine is a statement about a
   * pooled entry, and refusing an unpooled serial would break direct-mode and
   * pre-allocation paths that legitimately address a device the pool never held.
   *
   * Reached directly by the pool's own callers, through `DeviceSessionResolver`
   * by the push servers that already hold one, and through
   * `DeviceAdmissionGate` (src/daemon/deviceAdmissionGate.ts) by the capture and
   * recording servers, which hold no pool reference. Authorization is never a
   * substitute for it: the quarantine deliberately PRESERVES the owning session,
   * so an authorized subscribe, stream start or recording start still passes and
   * would act on whichever replacement AVD now answers on the serial
   * ([#6888](https://github.com/kaeawc/auto-mobile/pull/6888) review).
   *
   * Enforced by `test/lint/deviceAddressedAdmissionGate.test.ts`, which fails on a
   * device-addressed socket handler that does not reach this gate.
   */
  assertDeviceActionable(deviceId: string, purpose: string): void {
    const pooled = this.pool.getDevices().get(deviceId);
    if (pooled?.identityUnresolved !== true) {
      return;
    }
    throw new DeviceIdentityQuarantinedError(
      this.describeUnresolvedPooledIdentity(pooled, `Refusing ${purpose} on device`),
    );
  }

  /**
   * The single wording for every refusal the quarantine produces, so assignment,
   * tool execution and their tests all name the same two facts: the serial, and
   * the label the daemon can no longer tie to the runtime on it.
   */
  describeUnresolvedPooledIdentity(device: PooledDevice, refusal: string): string {
    return (
      `${refusal} '${device.id}': this daemon has it recorded as AVD ` +
      `'${device.avdName ?? device.name}', but discovery could not read the AVD name from the ` +
      "runtime, so its identity is unresolved. Retry after the next device discovery resolves " +
      "it, or re-acquire the device."
    );
  }

  /**
   * The quarantine half of the shared assignability gate: an entry that is — or
   * that the liveness check just made — quarantined is not assignable, and is
   * reported exactly as a missing device is, so the operation that ENTERS the
   * quarantine fails at assignment instead of handing back a session that would
   * then fail every tool at {@link assertSessionReadyForAutomation}
   * ([#6863](https://github.com/kaeawc/auto-mobile/pull/6863) review).
   */
  isPooledDeviceIdentityAssignable(device: PooledDevice): boolean {
    if (device.identityUnresolved !== true) {
      return true;
    }
    logger.warn(
      this.describeUnresolvedPooledIdentity(device, "[DevicePool] Cannot hand out device"),
    );
    return false;
  }

  /**
   * Enter or leave the unresolved-identity quarantine for a live entry a
   * discovery sweep just observed under a TOLERATED name match.
   *
   * Entering: the observation is the `Unknown (<serial>)` placeholder. The entry
   * stays exactly as it is — same session, same `incarnation` — because the
   * placeholder is not evidence that the serial was reused; it is only evidence
   * that the pool can no longer prove it was not.
   *
   * Leaving: the observation carries a RESOLVED name. Reaching here at all means
   * {@link namesAgreeOnIdentity} accepted it, i.e. it is the pooled label (or the
   * AVD this pool started), which is proof of continuity — so the entry goes back
   * to live, unchanged. A resolved name that DISAGREES never reaches this method:
   * {@link matchesRuntimeIdentity} rejects it upstream and the entry is replaced
   * under a fresh incarnation, retiring the old session exactly as an observed
   * disappearance does.
   *
   * Guarded by {@link hasReusableSerial}: a handset's serial is never reassigned
   * and its name (`ro.product.model`) is not identity, so there is no continuity
   * question for the placeholder to leave open.
   */
  async reconcilePooledIdentityResolution(
    pooled: PooledDevice,
    discovered: Pick<
      BootedDevice,
      "deviceId" | "name" | "platform" | "observedAt" | "consoleBusyDuringProbe"
    >,
    options: DiscoveryReconcileOptions = {},
  ): Promise<void> {
    if (options.namesResolved === false) {
      return;
    }
    if (
      !this.pool.hasReusableSerial(pooled) ||
      this.comparePooledIdentityEvidence(pooled, discovered) === "stale"
    ) {
      return;
    }
    if (this.shouldReconcileUnresolvedEmulatorName(pooled, discovered)) {
      await this.reconcileUnresolvedEmulatorName(pooled, discovered, options);
      return;
    }
    if (this.shouldQuarantineUnresolvedEmulatorName(pooled, discovered)) {
      await this.enterPooledIdentityQuarantine(
        pooled,
        "discovery could not read the AVD name, so the pooled identity " +
          `'${pooled.avdName ?? pooled.name}' can no longer be tied to the runtime`,
        this.identityEvidenceForBootedDevice(discovered),
        options,
      );
      return;
    }
    if (this.hasUnresolvedEmulatorName(discovered)) {
      logger.debug(
        `[DevicePool] Retaining ${pooled.id}: discovery observation has no AVD identity evidence`,
      );
      return;
    }
    // The resolved name is the newest identity evidence for this entry whether or
    // not it is quarantined; recording it on the LIVE path too is what lets a
    // later straggler be recognised as stale before it quarantines anything.
    this.recordIdentityObservation(pooled, this.identityEvidenceForBootedDevice(discovered));
    this.clearPooledIdentityReconciliation(pooled);
    if (pooled.identityUnresolved !== true) {
      return;
    }
    delete pooled.identityUnresolved;
    this.deferredQuarantineCancellations.delete(pooled);
    // Full: quarantine hid an untrusted runtime; lifting it needs a fresh trusted screen.
    this.pool.notifyDeviceFramesInvalidated?.(pooled.id);
    logger.info(
      `[DevicePool] Lifting the identity quarantine on ${pooled.id}: discovery read ` +
        `'${discovered.name}'`,
    );
  }

  /**
   * Whether an unreadable runtime name should get the bounded continuity check
   * instead of immediately destroying trust in a confirmed AVD mapping.
   */
  private shouldReconcileUnresolvedEmulatorName(
    pooled: PooledDevice,
    discovered: Pick<BootedDevice, "deviceId" | "name" | "platform" | "consoleBusyDuringProbe">,
  ): boolean {
    return (
      pooled.avdName !== undefined &&
      pooled.identityUnresolved !== true &&
      this.hasUnresolvedEmulatorName(discovered) &&
      discovered.name !== discovered.deviceId &&
      !discovered.consoleBusyDuringProbe
    );
  }

  /**
   * Preserve the last confirmed AVD identity while retrying an unreadable probe.
   * The retry executor's three-attempt default is deliberately the whole bound:
   * the caller's observation is attempt one and two cache-bypassing Android
   * discovery calls are attempts two and three. Delays are zero because each
   * discovery performs the runtime probes itself; this keeps admission latency
   * bounded by those probes and unit tests below the repository's 100ms budget.
   */
  private async reconcileUnresolvedEmulatorName(
    pooled: PooledDevice,
    discovered: Pick<
      BootedDevice,
      "deviceId" | "name" | "platform" | "observedAt" | "consoleBusyDuringProbe"
    >,
    options: DiscoveryReconcileOptions,
  ): Promise<void> {
    if (pooled.identityReconcileAttempts !== undefined) {
      logger.debug(
        `[DevicePool] Retaining ${pooled.id}: bounded AVD-name reconciliation is already in progress`,
      );
      return;
    }

    const owner = Symbol("identity-reconciliation");
    pooled.identityReconcileOwner = owner;
    pooled.identityReconcileAttempts = 0;
    pooled.identityReconcileStartedAt = this.pool.getTimer().now();
    let latestUnresolved = discovered;
    const result = await this.pool.getRetryExecutor().execute(
      async (attempt) => {
        if (
          this.pool.getDevices().get(pooled.id) !== pooled ||
          pooled.identityReconcileOwner !== owner
        ) {
          return { kind: "superseded" } as const;
        }
        pooled.identityReconcileAttempts = attempt;
        const observation =
          attempt === 1 ? discovered : await this.rediscoverPooledAndroidIdentity(pooled, options);

        // A concurrent resolved observation clears the attempt state. Likewise,
        // replacing/removing the entry makes this retry belong to an old epoch.
        if (
          this.pool.getDevices().get(pooled.id) !== pooled ||
          pooled.identityReconcileOwner !== owner
        ) {
          return { kind: "superseded" } as const;
        }

        if (observation !== undefined) {
          if (this.comparePooledIdentityEvidence(pooled, observation) === "stale") {
            return { kind: "superseded" } as const;
          }
          if (!this.hasUnresolvedEmulatorName(observation)) {
            return { kind: "resolved", observation } as const;
          }
          if (observation.name === observation.deviceId || observation.consoleBusyDuringProbe) {
            return { kind: "no-evidence" } as const;
          }
          latestUnresolved = observation;
        }

        logger.debug(
          `[DevicePool] Retaining ${pooled.id} under confirmed AVD '${pooled.avdName}': ` +
            `runtime name unreadable on reconciliation attempt ${attempt}/${POOLED_IDENTITY_RECONCILE_MAX_ATTEMPTS}`,
        );
        throw new DevicePoolError(`Runtime AVD name for '${pooled.id}' remains unreadable`, true);
      },
      {
        maxAttempts: POOLED_IDENTITY_RECONCILE_MAX_ATTEMPTS,
        delays: 0,
        signal: options.signal,
      },
    );

    if (pooled.identityReconcileOwner !== owner) {
      return;
    }
    if (result.success) {
      this.clearPooledIdentityReconciliation(pooled);
      if (result.value?.kind === "resolved") {
        await this.reconcileObservedPooledIdentity(pooled, result.value.observation, options);
      }
      return;
    }
    if (
      options.signal?.aborted ||
      this.pool.getDevices().get(pooled.id) !== pooled ||
      pooled.identityReconcileAttempts !== POOLED_IDENTITY_RECONCILE_MAX_ATTEMPTS
    ) {
      this.clearPooledIdentityReconciliation(pooled);
      return;
    }

    const elapsedMs =
      this.pool.getTimer().now() -
      (pooled.identityReconcileStartedAt ?? this.pool.getTimer().now());
    this.clearPooledIdentityReconciliation(pooled);
    await this.enterPooledIdentityQuarantine(
      pooled,
      `discovery could not read the AVD name after ${POOLED_IDENTITY_RECONCILE_MAX_ATTEMPTS} ` +
        `attempts (${elapsedMs}ms), so the pooled identity '${pooled.avdName}' can no longer be ` +
        "tied to the runtime",
      this.identityEvidenceForBootedDevice(latestUnresolved),
      options,
    );
  }

  private async rediscoverPooledAndroidIdentity(
    pooled: PooledDevice,
    options: DiscoveryReconcileOptions,
  ): Promise<BootedDevice | undefined> {
    const discovery = await this.pool.getDeviceManager().getBootedDevicesDetailed("android", {
      bypassAndroidDeviceListCache: true,
      signal: options.signal,
    });
    return discovery.devices.find((device) => device.deviceId === pooled.id);
  }

  private clearPooledIdentityReconciliation(pooled: PooledDevice): void {
    delete pooled.identityReconcileOwner;
    delete pooled.identityReconcileAttempts;
    delete pooled.identityReconcileStartedAt;
  }

  private shouldQuarantineUnresolvedEmulatorName(
    pooled: PooledDevice,
    discovered: Pick<BootedDevice, "deviceId" | "name" | "platform" | "consoleBusyDuringProbe">,
  ): boolean {
    if (!this.hasUnresolvedEmulatorName(discovered)) {
      return false;
    }
    if (discovered.name === discovered.deviceId) {
      // ADB's serial-only listing did not probe an AVD label at all. It is
      // unresolved evidence, but not a failed identity probe that should
      // quarantine an otherwise labelled entry.
      return false;
    }
    if (!discovered.consoleBusyDuringProbe) {
      // A confirmed mapping takes the bounded retry path above. Entries without
      // one have no stable identity evidence to preserve and still quarantine
      // immediately, as do already-terminal entries being observed again.
      return pooled.avdName === undefined || pooled.identityUnresolved === true;
    }
    // `adb devices` already proved this serial is present. A daemon-owned VM
    // snapshot command monopolizes the emulator console, so its timed-out
    // `emu avd name` probe supplies no identity evidence (#6961).
    logger.debug(
      `[DevicePool] Retaining ${pooled.id}: discovery could not read its AVD name while ` +
        "a console-exclusive operation is in flight",
    );
    return false;
  }

  /**
   * Whether `discovered` is OLDER than the newest identity observation already
   * folded into this entry — the out-of-order straggler described on
   * {@link PooledDevice.identityObservedAt}. Only a comparison of two stamped
   * observations decides it; an unstamped observation on either side is
   * unorderable and is not treated as stale.
   *
   * Asked before BOTH identity transitions, so a straggler can neither lift a
   * newer quarantine nor quarantine a newer resolution.
   */
  comparePooledIdentityEvidence(
    pooled: PooledDevice,
    discovered: Pick<BootedDevice, "deviceId" | "name" | "platform" | "observedAt">,
  ) {
    const comparison = compareIdentityEvidence(
      deriveEvidenceFromPooledDevice(pooled),
      this.identityEvidenceForBootedDevice(discovered),
    );
    if (comparison === "stale") {
      logger.debug(
        `[DevicePool] Ignoring '${discovered.name}' for ${pooled.id}: observation ` +
          `${discovered.observedAt} is older than the ${pooled.identityObservedAt} identity ` +
          "observation already folded in",
      );
    }
    return comparison;
  }

  /**
   * Advance {@link PooledDevice.identityObservedAt} to the newest stamp seen.
   * Monotonic: an unstamped or older observation leaves it where it is, so the
   * entry's ordering evidence can only move forward.
   */
  private recordIdentityObservation(pooled: PooledDevice, evidence: IdentityEvidence): void {
    const comparison = compareIdentityEvidence(deriveEvidenceFromPooledDevice(pooled), evidence);
    if (
      evidence.observedAt !== undefined &&
      (comparison === "newer" || comparison === "unresolved-newer")
    ) {
      pooled.identityObservedAt = evidence.observedAt;
    }
  }

  /**
   * Keep only a strictly newer stamped identity while removeDevice has made its
   * serial temporarily absent from the pool during a runtime replacement.
   */
  recordPendingIdentityReplacementObservation(device: BootedDevice): void {
    const pending = this.pendingIdentityReplacements.get(device.deviceId);
    if (!pending) {
      return;
    }
    const evidence = this.identityEvidenceForBootedDevice(device);
    const pendingEvidence = this.identityEvidenceForBootedDevice(pending);
    if (evidence.unresolved) {
      if (device.name === device.deviceId) {
        // ADB's raw serial listing did not attempt an AVD-name probe, so it
        // cannot supersede the identity evidence already pending replacement.
        logger.debug(
          `[DevicePool] Ignoring raw serial observation for pending replacement ${device.deviceId}`,
        );
        return;
      }
      const currentUnresolved = this.pendingIdentityReplacementUnresolvedObservations.get(
        device.deviceId,
      );
      const comparison = compareIdentityEvidence(currentUnresolved ?? pendingEvidence, evidence);
      if (comparison === "newer" || comparison === "unresolved-newer") {
        this.pendingIdentityReplacementUnresolvedObservations.set(device.deviceId, evidence);
      }
      return;
    }
    const unresolvedEvidence = this.pendingIdentityReplacementUnresolvedObservations.get(
      device.deviceId,
    );
    if (unresolvedEvidence) {
      // Only a strictly newer resolved probe can confirm the identity again.
      // Equal and older probes must leave unresolved evidence in place.
      if (compareIdentityEvidence(unresolvedEvidence, evidence) !== "newer") {
        return;
      }
      this.pendingIdentityReplacementUnresolvedObservations.delete(device.deviceId);
    }
    if (compareIdentityEvidence(pendingEvidence, evidence) !== "newer") {
      return;
    }
    this.pendingIdentityReplacements.set(device.deviceId, device);
  }

  /**
   * Quarantine a pooled entry a discovery observation DISAGREES with, in the two
   * cases where the pool cannot install the replacement that disagreement calls
   * for.
   *
   * Case one, the refresh sweep: {@link replacePooledDeviceForRuntimeIdentity}
   * evicts the old incarnation before adding the discovered runtime, and
   * {@link evictMissingPooledDevice} DEFERS that eviction while killDevice holds a
   * shutdown reservation. The refresh then reloads the same old entry, and the
   * discovered name -- which disagrees with it -- would otherwise reach
   * {@link reconcilePooledIdentityResolution} and read as proof of continuity.
   *
   * Case two, {@link reconcileDiscoveryObservation}: the observation came from a
   * path that does not own pool membership, so it may not evict an incarnation or
   * retire its session at all.
   *
   * A disagreement is never proof of continuity. The entry is held in quarantine
   * until the replacement actually installs, which is the only event that retires
   * the old session and mints the new incarnation
   * ([#6863](https://github.com/kaeawc/auto-mobile/pull/6863) review).
   */
  async quarantineDisagreeingPooledIdentity(
    pooled: PooledDevice,
    discovered: Pick<BootedDevice, "deviceId" | "name" | "platform" | "observedAt">,
    because: string,
    options: DiscoveryReconcileOptions = {},
  ): Promise<void> {
    if (
      !this.pool.hasReusableSerial(pooled) ||
      this.comparePooledIdentityEvidence(pooled, discovered) === "stale"
    ) {
      return;
    }
    await this.enterPooledIdentityQuarantine(
      pooled,
      `discovery reports '${discovered.name}' on this serial while the pooled identity is ` +
        `'${pooled.avdName ?? pooled.name}', ${because}`,
      this.identityEvidenceForBootedDevice(discovered),
      options,
    );
  }

  /**
   * Enter the quarantine, once.
   *
   * The entry keeps its session and its `incarnation` -- the quarantine
   * withholds trust, it does not retire the epoch -- but the work already IN
   * FLIGHT on the serial or bound session is not covered by any admission gate: those
   * executions are registered and keep issuing serial-addressed operations that
   * can land on whatever now answers on the serial. So they are cancelled and
   * drained through the same injected seam the ADB-reset quarantine uses, under
   * the device-loss reason so each one surfaces a typed `DeviceLostError`
   * naming the serial ([#6863](https://github.com/kaeawc/auto-mobile/pull/6863)
   * review).
   *
   * An active intentional-shutdown reservation defers cancellation, whichever
   * discovery enters quarantine. Quarantine still withholds identity trust; if
   * shutdown fails, a later unresolved observation cancels after release.
   * A confirmed retirement flushes it before detaching the pooled session.
   *
   * Exclude the explicit {@link DiscoveryReconcileOptions.excludeExecutionId},
   * or the ambient execution whose own discovery produced this observation. It is the
   * operation that is about to act on this evidence -- a session-bound
   * `killDevice` confirming its target, say -- and cancelling it would make the
   * funnel defeat the very refusal it exists to enable.
   */
  private async enterPooledIdentityQuarantine(
    pooled: PooledDevice,
    reason: string,
    evidence: IdentityEvidence,
    options: DiscoveryReconcileOptions = {},
  ): Promise<void> {
    // Re-observing the same unresolved runtime advances the evidence a later
    // lift is ordered against, so a straggler newer than the FIRST placeholder
    // but older than the latest one cannot lift the quarantine
    // ([#6888](https://github.com/kaeawc/auto-mobile/pull/6888) review).
    this.recordIdentityObservation(pooled, evidence);
    this.clearPooledIdentityReconciliation(pooled);
    if (pooled.identityUnresolved === true && !this.deferredQuarantineCancellations.has(pooled)) {
      return;
    }
    if (pooled.identityUnresolved !== true) {
      pooled.identityUnresolved = true;
      // Full: the serial may now identify another runtime, so its screen/context is untrusted.
      this.pool.notifyDeviceFramesInvalidated?.(pooled.id);
      logger.warn(`[DevicePool] Quarantining ${pooled.id}: ${reason}`);
    }
    // Discovery can see the dying emulator before the kill's own preflight.
    // Read the existing incarnation-scoped reservation synchronously: this
    // path may hold assignmentMutex, so the public accessor would re-enter it.
    if (this.pool.isReservedForShutdown(pooled)) {
      this.deferredQuarantineCancellations.add(pooled);
      return;
    }
    this.deferredQuarantineCancellations.delete(pooled);
    await this.cancelQuarantinedDeviceExecutions(pooled, options);
  }

  private async cancelQuarantinedDeviceExecutions(
    pooled: PooledDevice,
    options: DiscoveryReconcileOptions,
  ): Promise<void> {
    await this.cancelPooledDeviceExecutions(pooled, options, pooled.sessionId);
  }

  /** A confirmed shutdown retires serial-bound work even without quarantine. */
  async cancelRetiredDeviceExecutions(
    pooled: PooledDevice,
    options: DeviceRetirementOptions = {},
  ): Promise<void> {
    const deferred = this.deferredQuarantineCancellations.delete(pooled);
    if (options.cancelDeviceBoundExecutions === false) {
      return;
    }
    await this.cancelPooledDeviceExecutions(pooled, options, deferred ? pooled.sessionId : null);
  }

  private async cancelPooledDeviceExecutions(
    pooled: PooledDevice,
    options: Pick<DiscoveryReconcileOptions, "excludeExecutionId">,
    sessionId: PooledDevice["sessionId"],
  ): Promise<void> {
    const cancellationOptions = {
      excludeExecutionId: options.excludeExecutionId ?? this.pool.getAmbientExecutionId?.(),
    };
    // Invoke both cancellers before awaiting either drain: serial-bound work
    // exists without a session, and session-only work must also stop immediately.
    const counts = await Promise.all([
      this.pool.cancelDeviceExecutions?.(
        pooled.id,
        deviceLossCancellationReason(pooled.id),
        cancellationOptions,
      ) ?? Promise.resolve(0),
      sessionId
        ? this.pool.cancelDeviceSessionExecutions(
            sessionId,
            deviceLossCancellationReason(pooled.id),
            cancellationOptions,
          )
        : Promise.resolve(0),
    ]);
    const cancelled = counts[0] + counts[1];
    if (cancelled > 0) {
      logger.warn(
        `[DevicePool] Cancelled ${counts[0]} device-bound and ${counts[1]} session-bound ` +
          `in-flight execution(s) for ${pooled.id}`,
      );
    }
  }

  /**
   * Whether a discovered name is the `Unknown (<serial>)` placeholder rather
   * than a name read from the runtime. Guarded by {@link isAndroidEmulatorSerial}
   * because a handset's name is `ro.product.model` and its identity rides on its
   * globally-unique serial, not on its name.
   */
  hasUnresolvedEmulatorName(
    expected: Pick<BootedDevice, "deviceId" | "name" | "platform">,
  ): boolean {
    return this.identityEvidenceForBootedDevice(expected).unresolved;
  }

  identityEvidenceForBootedDevice(
    device: Pick<BootedDevice, "deviceId" | "name" | "platform" | "observedAt">,
  ): IdentityEvidence {
    return deriveEvidenceFromBootedDevice(device, isUnresolvedAndroidEmulatorName(device));
  }

  /**
   * Whether a discovery observation describes the same runtime as a pooled
   * entry.
   *
   * A discovery listing carries no connection-epoch token, so serial, platform
   * and name are all there is to compare; the pool's own `incarnation` is the
   * only epoch boundary, and it is minted when the pool re-creates an entry
   * (see `daemon/deviceSessionRegistry.ts`). Name handling is delegated to
   * {@link namesAgreeOnIdentity}.
   */
  matchesRuntimeIdentity(
    pooled: PooledDevice,
    expected: Pick<BootedDevice, "deviceId" | "name" | "platform">,
  ): boolean {
    return (
      pooled.id === expected.deviceId &&
      pooled.platform === expected.platform &&
      this.namesAgreeOnIdentity(pooled, expected)
    );
  }

  /**
   * Whether a pooled label and a freshly-discovered name can be the same
   * runtime.
   *
   * Name equality is the rule, with two documented tolerances:
   *  - a device class whose name is mutable metadata (iOS physical) never
   *    carries identity in its name at all;
   *  - `Unknown (<serial>)` is the placeholder Android discovery emits when the
   *    emulator console could not answer `avd name`. It asserts nothing, so
   *    reading it as "a different AVD took this serial" would evict a live
   *    pooled emulator — and its AutoMobile ownership — on a transient console
   *    read. The tolerance is guarded by {@link isAndroidEmulatorSerial}
   *    because a handset's name is `ro.product.model`, which is not unique;
   *    handsets stay on strict name equality behind their unique serial.
   *
   * The placeholder tolerance exists ONLY to avoid that eviction. It is not
   * agreement: {@link reconcilePooledIdentityResolution} starts bounded
   * reconciliation for a confirmed mapping and quarantines on exhaustion; every
   * consumer that would ACT on a terminally untrusted identity reads that state
   * instead of this predicate.
   */
  private namesAgreeOnIdentity(
    pooled: PooledDevice,
    expected: Pick<BootedDevice, "deviceId" | "name" | "platform">,
  ): boolean {
    if (this.hasMutableDisplayName(pooled) || pooled.name === expected.name) {
      return true;
    }
    if (pooled.platform !== "android" || !isAndroidEmulatorSerial(pooled.id)) {
      return false;
    }
    const placeholder = unknownAndroidRuntimeName(pooled.id);
    if (this.hasUnresolvedEmulatorName(expected)) {
      return true;
    }
    // The pooled label is the placeholder. Accept a resolved name only when the
    // AVD this pool started says so — never on the strength of a name alone.
    return pooled.name === placeholder && pooled.avdName === expected.name;
  }

  /**
   * Whether this pooled device's name is mutable metadata rather than identity.
   * Delegates to the shared predicate so the pool and the public `startDevice`
   * validator (`validatePooledDeviceMapping`) cannot drift apart (#5690).
   */
  private hasMutableDisplayName(pooled: PooledDevice): boolean {
    return hasMutableDisplayName(pooled.platform, pooled.id);
  }

  /**
   * Upgrade a pooled emulator still labelled `Unknown (<serial>)` to the AVD
   * name a later discovery managed to read.
   *
   * {@link namesAgreeOnIdentity} tolerates the placeholder in both directions so
   * an unreadable console never evicts a live entry; without this the tolerated
   * match would also leave the pooled label stuck on the placeholder, and
   * name-based pool consumers (DeviceCriteriaMatcher.filterDevices) would never
   * match the real AVD. Only a name the pool already vouches for through
   * `avdName` is adopted, so this cannot rename an entry onto a different AVD.
   */
  private resolvePlaceholderEmulatorName(
    pooled: PooledDevice,
    discovered: Pick<BootedDevice, "name">,
  ): void {
    if (
      pooled.platform !== "android" ||
      !isAndroidEmulatorSerial(pooled.id) ||
      pooled.name !== unknownAndroidRuntimeName(pooled.id) ||
      pooled.avdName === undefined ||
      pooled.avdName !== discovered.name
    ) {
      return;
    }
    logger.info(`Device ${pooled.id} resolved its AVD name to '${discovered.name}'`);
    pooled.name = discovered.name;
  }

  /**
   * Fold a freshly-discovered display name into a pooled device whose runtime
   * identity is unchanged. No-op unless the name is mutable metadata for this
   * device class, so the pooled label tracks the source of truth instead of
   * going stale behind the tolerance in {@link matchesRuntimeIdentity}.
   */
  applyMutableRuntimeMetadata(
    pooled: PooledDevice,
    discovered: Pick<BootedDevice, "name" | "observedAt">,
    source: MutableMetadataSource,
  ): void {
    this.resolvePlaceholderEmulatorName(pooled, discovered);
    if (!this.hasMutableDisplayName(pooled)) {
      return;
    }
    if (
      discovered.observedAt !== undefined &&
      pooled.nameObservedAt !== undefined &&
      discovered.observedAt <= pooled.nameObservedAt
    ) {
      logger.debug(
        `Ignoring '${discovered.name}' for ${pooled.id}: observation ${discovered.observedAt} ` +
          `is not newer than ${pooled.nameObservedAt}`,
      );
      return;
    }
    // An unstamped start-path snapshot cannot be ordered against either a
    // legacy refresh latch or a timestamped write. Keep both as a conservative
    // boundary for legacy callers and test fakes; a stamped snapshot still uses
    // the newer-wins comparison above.
    if (
      source === "snapshot" &&
      (pooled.nameRefreshGeneration !== undefined ||
        (discovered.observedAt === undefined && pooled.nameObservedAt !== undefined))
    ) {
      logger.debug(
        `Ignoring '${discovered.name}' for ${pooled.id}: an unorderable snapshot cannot replace '${pooled.name}'`,
      );
      return;
    }
    if (pooled.name !== discovered.name) {
      logger.info(`Device ${pooled.id} renamed from '${pooled.name}' to '${discovered.name}'`);
      pooled.name = discovered.name;
    }
    if (discovered.observedAt !== undefined) {
      pooled.nameObservedAt = discovered.observedAt;
      delete pooled.nameRefreshGeneration;
    } else if (source === "refresh") {
      delete pooled.nameObservedAt;
      pooled.nameRefreshGeneration = this.pool.getRefreshGeneration();
    }
  }
}
