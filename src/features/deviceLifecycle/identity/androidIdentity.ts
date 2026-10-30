import { BootedDevice } from "../../../models";
import { isAndroidEmulatorSerial } from "../../../utils/androidSerial";
import { type DevicePoolReads } from "../../../daemon/daemonContext";
import { type PooledDevice, type DevicePool } from "../../../daemon/devicePool";
import {
  type EmulatorProcessStopper,
  emulatorProcessEscapeHint,
} from "../../../utils/android-cmdline-tools/EmulatorProcessStop";
import { type Timer } from "../../../utils/SystemTimer";
import { logger } from "../../../utils/logger";
import { type StableDeviceTarget } from "../core/deadlines";
import { type PooledAvdCapture } from "../teardown/teardownContracts";
import {
  type DeviceToolsDependencies,
  POOLED_AVD_NAME_VERIFICATION_TIMEOUT_MS,
} from "../core/dependencies";

export function isVirtualAndroidDevice(device: BootedDevice): boolean {
  return device.platform === "android" && isAndroidEmulatorSerial(device.deviceId);
}

export function isUnknownAndroidRuntimeName(device: BootedDevice): boolean {
  return device.name === `Unknown (${device.deviceId})`;
}

/**
 * The same lookup WITHOUT rule 3, for the one caller that must still see a
 * QUARANTINED entry: the destructive identity check.
 *
 * Every other consumer reads a quarantined entry as "no label" and stops there,
 * which is right for routing, publishing and matching. A kill cannot stop
 * there: dropping the entry also dropped the CONFIRMATION the label exists to
 * trigger, so the quarantined emulator fell back to the same unchecked path as
 * a runtime that named itself and a sessionless `killDevice` carrying
 * `Unknown (<serial>)` reached `AndroidEmulatorClient.killDevice` on nothing
 * but that placeholder. Quarantine is the state in which the runtime MUST be
 * made to name itself, so the check takes the entry and
 * {@link capturePooledAvdIdentity} marks the capture `quarantined`
 * ([#6863](https://github.com/kaeawc/auto-mobile/pull/6863) review).
 */
export function getPooledAndroidEntryForIdentityCheck(
  device: BootedDevice,
  devicePool: DevicePoolReads | undefined,
): PooledDevice | undefined {
  if (device.platform !== "android" || !isUnknownAndroidRuntimeName(device)) {
    return undefined;
  }
  if (!isAndroidEmulatorSerial(device.deviceId)) {
    // A handset's name is `ro.product.model`, not an AVD; there is nothing to
    // substitute and nothing that would make a pooled label trustworthy.
    return undefined;
  }
  return devicePool?.getDevice(device.deviceId) ?? undefined;
}

/**
 * The AVD name the pool holds for an emulator whose runtime name could not be
 * read (`Unknown (<serial>)`), or undefined when the pool cannot vouch for one.
 *
 * The rule, now that the identity model has no ADB transport id:
 *  1. the serial must be an emulator serial (`isAndroidEmulatorSerial`) — a
 *     handset's name is `ro.product.model` and there is no AVD to substitute;
 *  2. the pool must still hold a LIVE entry for that serial. The pool evicts an
 *     entry the moment discovery observes the serial disappear and re-adds it
 *     under a fresh `incarnation`, so a surviving entry is the pool's statement
 *     that it has observed no boundary for this serial — the only continuity
 *     evidence left;
 *  3. that entry must not be QUARANTINED. Once a discovery sweep observes the
 *     `Unknown (<serial>)` placeholder on a live entry, the pool flags it
 *     `identityUnresolved` (`DevicePool.isPooledIdentityUnresolved`) and its
 *     label stops standing for the runtime: the serial may have been taken over
 *     by a different AVD that simply cannot name itself either. Returning the
 *     cached label there is what let a teardown of the NEW AVD miss the booted
 *     runtime and fall through to the stopped-image inventory path. The one
 *     caller that must still SEE a quarantined entry is the destructive
 *     identity check, which reads it through
 *     {@link getPooledAndroidEntryForIdentityCheck} and turns it into a
 *     `quarantined` capture whose runtime confirmation is mandatory;
 *  4. that entry must carry an `avdName`, which the pool writes only from the
 *     AVD it itself started (`recordSourceAndroidAvd`), never from discovery.
 *
 * This is a best-effort LABEL, never proof of identity: a same-serial restart
 * faster than one discovery interval never reaches the pool, so the cached name
 * can belong to the previous occupant of the serial. Every DESTRUCTIVE caller
 * (killDevice, deleteDevice) must therefore run {@link
 * capturePooledAvdIdentity} at preflight and {@link confirmPooledAvdIdentity}
 * immediately before the platform kill, which re-resolves the name from the
 * runtime and fails closed on a mismatch -- and on a probe that does not
 * answer.
 */
export function getValidatedPooledAndroidEntry(
  device: BootedDevice,
  devicePool: DevicePoolReads | undefined,
): PooledDevice | undefined {
  if (devicePool?.isPooledIdentityUnresolved(device.deviceId)) {
    return undefined;
  }
  return getPooledAndroidEntryForIdentityCheck(device, devicePool);
}

export function getValidatedPooledAndroidAvdName(
  device: BootedDevice,
  devicePool: DevicePoolReads | undefined,
): string | undefined {
  return getValidatedPooledAndroidEntry(device, devicePool)?.avdName;
}

export function resolveKillDeviceStableTarget(
  device: BootedDevice,
  devicePool: DevicePoolReads | undefined,
): StableDeviceTarget | undefined {
  // A simulator UDID, iPhone or Apple Watch, is its own stable identity (#14908).
  if (device.platform === "ios" || device.platform === "watchos") {
    return { platform: device.platform, stableId: device.deviceId };
  }
  if (!isVirtualAndroidDevice(device)) {
    return undefined;
  }
  if (!isUnknownAndroidRuntimeName(device)) {
    return { platform: "android", stableId: device.name };
  }
  const pooledAvdName = getValidatedPooledAndroidAvdName(device, devicePool);
  return pooledAvdName ? { platform: "android", stableId: pooledAvdName } : undefined;
}

export type PooledAvdNameRefusal =
  | { reason: "conflict"; pooledAvdName: string; runtimeAvdName: string }
  | {
      reason: "unresolved";
      pooledAvdName: string;
      candidates?: { pid: number; command: string }[];
      processTableStatus?: "absent" | "unreadable";
    }
  | { reason: "moved"; pooledAvdName: string };

export type PooledAvdCaptureResult =
  | { kind: "none" }
  | { kind: "capture"; capture: PooledAvdCapture }
  | { kind: "quarantined"; capture: PooledAvdCapture }
  | { kind: "refusal"; refusal: PooledAvdNameRefusal };

/**
 * The kill-time identity check `shutdownDevice` must run, carried from the
 * preflight that pinned it: the captured label + epoch, and whether the caller
 * asked to skip the console probe (#6864).
 *
 * `force` rides WITH the capture rather than beside it because the two are one
 * decision taken at one moment: whether this daemon is going to establish an
 * identity for the serial before killing it. `capture` is absent where there is
 * nothing to confirm -- an iOS target, a handset, an emulator that named itself
 * -- but `force` still travels, because it also governs the PLATFORM kill's own
 * name comparison ([#6874](https://github.com/kaeawc/auto-mobile/pull/6874)
 * review).
 */
export interface PooledAvdKillIdentity {
  capture?: PooledAvdCapture;
  force: boolean;
}

/**
 * Outcome of the kill-time identity check.
 *
 * `skipped` is not `confirmed` with a different name: nothing was confirmed, so
 * the caller must keep the target exactly as the caller gave it rather than
 * rewrite it to a label no probe stood behind (#6864).
 */
export type PooledAvdConfirmation =
  | { kind: "confirmed"; confirmedAvdName: string }
  | { kind: "skipped" }
  | { kind: "refusal"; refusal: PooledAvdNameRefusal };

/**
 * The capture a destructive action must carry into
 * {@link confirmPooledAvdIdentity}, for the two kinds that require the runtime
 * to name itself before the platform kill. `none` -- a runtime that named
 * itself, and every physical handset -- carries nothing.
 */
export function pooledAvdCaptureRequiringConfirmation(
  result: PooledAvdCaptureResult,
): PooledAvdCapture | undefined {
  return result.kind === "capture" || result.kind === "quarantined" ? result.capture : undefined;
}

/**
 * The same capture, paired with the caller's `force` flag, in the shape
 * `shutdownDevice` carries into its execute step (#6864).
 */
export function pooledAvdKillIdentity(
  result: PooledAvdCaptureResult,
  force: boolean,
): PooledAvdKillIdentity {
  return { capture: pooledAvdCaptureRequiringConfirmation(result), force };
}

/**
 * The caller's own deadline for the destructive action, which the verification
 * probe borrows rather than starting a timer of its own.
 */
export interface PooledAvdNameProbeBudget {
  processStopper?: EmulatorProcessStopper;
  timer: Timer;
  deadlineMs: number;
  signal?: AbortSignal;
}

/**
 * PREFLIGHT half of the identity check: pin the pooled label to its epoch.
 *
 * Returns `none` for every target whose name did NOT come from the pool -- a
 * runtime that named itself, and every physical handset, because
 * `ro.product.model` is not an AVD name and is not unique.
 *
 * A budget that is already spent refuses right here: with no time left the
 * runtime can never be asked to name itself, so the label can never be tied to
 * the emulator running on the serial, and refusing with the identity message is
 * strictly more actionable than the shutdown timeout that would otherwise
 * follow.
 */
export function capturePooledAvdIdentity(
  device: BootedDevice,
  devicePool: DevicePoolReads | undefined,
  budget: PooledAvdNameProbeBudget,
): PooledAvdCaptureResult {
  const pooled = getPooledAndroidEntryForIdentityCheck(device, devicePool);
  const avdName = pooled?.avdName;
  if (!pooled || !avdName) {
    return { kind: "none" };
  }
  if (budget.deadlineMs - budget.timer.now() <= 0) {
    return { kind: "refusal", refusal: { reason: "unresolved", pooledAvdName: avdName } };
  }
  const quarantined = devicePool?.isPooledIdentityUnresolved(device.deviceId) === true;
  return quarantined
    ? {
        kind: "quarantined",
        capture: { avdName, incarnation: pooled.incarnation, quarantined: true },
      }
    : { kind: "capture", capture: { avdName, incarnation: pooled.incarnation } };
}

export async function confirmPooledAvdFromProcessTable(
  device: BootedDevice,
  pooledAvdName: string,
  budget: PooledAvdNameProbeBudget,
): Promise<PooledAvdConfirmation> {
  const processIdentity = await budget.processStopper?.identify(
    { serial: device.deviceId, avdName: pooledAvdName },
    { deadlineMs: budget.deadlineMs, signal: budget.signal },
  );
  if (processIdentity?.kind === "match") {
    logger.info(
      `[DeviceTools] Confirmed ${device.deviceId} as AVD '${pooledAvdName}' from process table pid ${processIdentity.pid}`,
    );
    return { kind: "confirmed", confirmedAvdName: pooledAvdName };
  }
  if (processIdentity?.kind === "mismatch") {
    return {
      kind: "refusal",
      refusal: {
        reason: "conflict",
        pooledAvdName,
        runtimeAvdName: processIdentity.runningAvdName,
      },
    };
  }
  const candidates = processIdentity?.kind === "ambiguous" ? processIdentity.candidates : undefined;
  logger.warn(
    `[DeviceTools] Could not confirm that ${device.deviceId} is still AVD '${pooledAvdName}': ` +
      "the emulator console did not report a name.",
  );
  const processTableStatus =
    processIdentity?.kind === "absent" || processIdentity?.kind === "unreadable"
      ? processIdentity.kind
      : undefined;
  return {
    kind: "refusal",
    refusal: { reason: "unresolved", pooledAvdName, candidates, processTableStatus },
  };
}

/**
 * KILL-TIME half of the identity check, run immediately before the platform
 * kill on an emulator whose discovered name is `Unknown (<serial>)` and whose
 * AVD name therefore comes from the pool -- including a pool entry that is
 * QUARANTINED, where the label is not the pool's statement about the runtime
 * and this probe is the only identity evidence there is.
 *
 * Two things must still hold:
 *  - the pool must still hold the CAPTURED incarnation under that label. A new
 *    incarnation means the serial was re-allocated while this shutdown was
 *    being set up, so the captured label no longer describes the target;
 *  - the runtime must name the SAME AVD. A different AVD can take over a reused
 *    serial before discovery observes the previous one disappear, leaving the
 *    pool holding the OLD label -- and a kill issued against that label would
 *    stop the NEW emulator (#6863 review).
 *
 * Returns the CONFIRMED name so the caller can put it in the kill target:
 * `AndroidEmulatorClient.killDevice` re-discovers the serial and refuses a
 * target whose name differs from the discovered one, so handing it the
 * `Unknown (<serial>)` placeholder would throw away the proof this probe just
 * obtained.
 *
 * There is no fail-open branch. `Unknown (<serial>)` means "no information", and
 * a console probe that does not answer needs process-table evidence instead.
 * Without either source, acting would use a label this daemon cannot tie to the
 * runtime. The refusal names a checked process kill as the manual escape.
 *
 * `force` is the TOOL-level escape from that same dead end (#6864), for a client
 * with no shell access. It skips the console probe and NOTHING else, which makes
 * the shape of what it can and cannot clear exact:
 *  - it does not override the `conflict` refusal, it removes the evidence a
 *    conflict is detected from. With no probe there is nothing to compare, so
 *    the whole contract becomes "kill whatever emulator currently occupies this
 *    serial", including a different AVD that took the serial over. The caller is
 *    told so at warn, naming the serial and the label being left unconfirmed;
 *  - it does NOT clear the `moved` refusal above, which is checked first and is
 *    not a probe failure at all: the pool RETIRED the captured epoch under this
 *    daemon's own eyes, so the target the caller named no longer exists and
 *    "act on the serial as given" would be acting on a target the caller never
 *    asked about. Re-resolving is the only correct response;
 *  - it does not reach the preflight refusal in {@link capturePooledAvdIdentity}
 *    either. That one fires only when the action's deadline is ALREADY spent, in
 *    which case nothing downstream of it can finish either.
 *
 * It DOES clear the mandatory confirmation a QUARANTINED capture otherwise
 * carries. That case is the wedged-console kill this flag exists for: the pool
 * cannot name the serial either; the console or process table must provide
 * runtime identity evidence. Skipping confirmation leaves the caller's own
 * target (the `Unknown (<serial>)` placeholder) in place, which is what the
 * serial-scoped `emu kill` needs.
 *
 * `force` never reaches here at all where there is no pooled label to skip
 * verifying -- an iOS target, a handset, or an emulator that named itself --
 * because none of those produce a capture. It is accepted and changes nothing.
 *
 * The probe is bounded by whichever is smaller, the verification ceiling or the
 * caller's REMAINING deadline: it runs inside a lifecycle lease that is already
 * on the clock, so it must never start an independent timer that can outlast it.
 */
export async function confirmPooledAvdIdentity(
  device: BootedDevice,
  capture: PooledAvdCapture,
  devicePool: DevicePool | undefined,
  resolveRunningAvdName: DeviceToolsDependencies["resolveRunningAndroidAvdName"],
  budget: PooledAvdNameProbeBudget,
  force: boolean,
): Promise<PooledAvdConfirmation> {
  const pooledAvdName = capture.avdName;
  const pooled = devicePool?.getDevice(device.deviceId);
  if (!pooled || pooled.incarnation !== capture.incarnation || pooled.avdName !== pooledAvdName) {
    logger.warn(
      `[DeviceTools] The pool no longer holds incarnation ${capture.incarnation} of ` +
        `${device.deviceId} under AVD '${pooledAvdName}'; refusing the destructive action.`,
    );
    return { kind: "refusal", refusal: { reason: "moved", pooledAvdName } };
  }
  if (force) {
    logger.warn(
      `[DeviceTools] force=true: skipping AVD-name verification for Android emulator ` +
        `'${device.deviceId}', which this daemon has recorded as AVD '${pooledAvdName}'. ` +
        "The emulator console was not asked which AVD is running there, so this acts on " +
        `whatever now occupies '${device.deviceId}' -- including a different AVD that took ` +
        "the serial over.",
    );
    return { kind: "skipped" };
  }
  if (capture.quarantined) {
    // Not an extra check, a louder one: a quarantined entry needs fresh runtime
    // evidence from the console or process table, and a refusal is the fail-closed
    // outcome rather than a surprising one (#6863 review).
    logger.warn(
      `[DeviceTools] The pooled identity of ${device.deviceId} is quarantined; the runtime must ` +
        `name itself before this action may act on '${pooledAvdName}'.`,
    );
  }
  const remainingMs = budget.deadlineMs - budget.timer.now();
  if (remainingMs <= 0) {
    return { kind: "refusal", refusal: { reason: "unresolved", pooledAvdName } };
  }
  const runtimeAvdName = await resolveRunningAvdName(
    device,
    Math.min(POOLED_AVD_NAME_VERIFICATION_TIMEOUT_MS, remainingMs),
    budget.signal,
  );
  if (runtimeAvdName === undefined) {
    return confirmPooledAvdFromProcessTable(device, pooledAvdName, budget);
  }
  return runtimeAvdName === pooledAvdName
    ? { kind: "confirmed", confirmedAvdName: runtimeAvdName }
    : { kind: "refusal", refusal: { reason: "conflict", pooledAvdName, runtimeAvdName } };
}

export function pooledAvdNameRefusalMessage(
  device: BootedDevice,
  refusal: PooledAvdNameRefusal,
): string {
  if (refusal.reason === "moved") {
    return (
      `Refusing to act on Android emulator '${device.deviceId}': this daemon had it recorded as ` +
      `AVD '${refusal.pooledAvdName}', but that connection epoch was retired while this action ` +
      "was being prepared, so the emulator now on that serial is a different run. Re-resolve " +
      "the target and retry."
    );
  }
  if (refusal.reason === "conflict") {
    return (
      `Refusing to act on Android emulator '${device.deviceId}': this daemon has it recorded as ` +
      `AVD '${refusal.pooledAvdName}', but the emulator now running on that serial reports ` +
      `AVD '${refusal.runtimeAvdName}'. The serial was reused by a different AVD; re-resolve ` +
      "the target and retry."
    );
  }
  return (
    `Refusing to act on Android emulator '${device.deviceId}': this daemon has it recorded as ` +
    `AVD '${refusal.pooledAvdName}', but the emulator console on that serial did not answer, so ` +
    "the AVD actually running there could not be confirmed. Acting on the recorded name could " +
    "stop a different emulator that took the serial. Resolve the target and retry. " +
    emulatorProcessEscapeHint(device.deviceId, refusal.candidates, refusal.processTableStatus)
  );
}

/**
 * The stable AVD label a booted emulator is matched and acted on by: the name
 * the runtime gave, or the pool's label when the runtime could not name itself.
 *
 * This is the NON-DESTRUCTIVE reading: a quarantined entry reads as "no
 * label" -- rule 3 of {@link getValidatedPooledAndroidEntry} -- which is right
 * for every consumer that only needs a display name, not a target to act on.
 * The destructive teardown path uses {@link getBootedAndroidTeardownStableName}
 * instead, which sees through the quarantine.
 */
export function getBootedAndroidStableName(
  device: BootedDevice,
  devicePool: DevicePoolReads | undefined,
): string {
  const pooledAvdName = getValidatedPooledAndroidAvdName(device, devicePool);
  return pooledAvdName ?? device.name;
}

/**
 * The same stable name for the DESTRUCTIVE path, which sees through the
 * quarantine.
 *
 * FUNNEL 1 folds a teardown's own discovery into the pool before this runs, so a
 * runtime that answers `Unknown (<serial>)` is quarantined BY THAT OBSERVATION --
 * which is the state in which every other consumer must read the pooled label as
 * "no label". Reading it that way HERE would mean a teardown could never match
 * the emulator by its pooled label at all, and the mandatory runtime
 * confirmation that exists precisely for this case
 * ({@link capturePooledAvdIdentity} -> {@link confirmPooledAvdIdentity}) would
 * become unreachable: the teardown would instead fall through to the
 * stopped-image inventory path, the failure the confirmation was built to
 * prevent.
 *
 * So the destructive path matches on the quarantine-visible label and then makes
 * the runtime name itself before the platform kill -- a strictly stronger gate
 * than refusing on the quarantine flag would be
 * ([#6863](https://github.com/kaeawc/auto-mobile/pull/6863) review).
 */
export function getBootedAndroidTeardownStableName(
  device: BootedDevice,
  devicePool: DevicePoolReads | undefined,
): string {
  return getPooledAndroidEntryForIdentityCheck(device, devicePool)?.avdName ?? device.name;
}

// iOS `deleteDevice` targets are frequently expressed by name (the identifier
// `provisionDevice` echoes back), not by UDID. Matching only on `deviceId`
// leaves a name-based lookup unresolved even though the simulator is present,
// which upstream callers treat as proof of absence (#6250). Match on either
// the UDID or the display name so name-based delete resolves to the real
// device, and only a lookup that matches neither is treated as "not found".
export function matchesIosTeardownIdentity(
  device: { deviceId?: string; name: string },
  stableId: string,
) {
  return device.deviceId === stableId || device.name === stableId;
}
