import { isAndroidEmulatorSerial } from "../../../utils/androidSerial";
import { emulatorProcessEscapeHint } from "../../../utils/android-cmdline-tools/EmulatorStillRunningError";
import { runWithinShutdownDeadline } from "../core/deadlines";
import { defaultDaemonContext } from "../../../daemon/daemonContext";
import {
  type BootedDeviceDiscovery,
  type DeviceImageDiscovery,
} from "../../../devices/deviceUtils";
import { type BootedDevice } from "../../../models";
import { AndroidCtrlProxyManager } from "../../../ctrlProxy/CtrlProxyManager";
import { unregisterDirectSessionsForStableIdentity } from "../../../utils/directSessionDeviceRegistry";
import { type DevicePool, type PooledDevice } from "../../../daemon/devicePool";
import {
  type TeardownContext,
  type TeardownResolution,
  completedInventoryFor,
  createTeardownFailureResponse,
  createTeardownResponse,
  type TeardownResolvedTarget,
  findInventoryTeardownTarget,
  captureTeardownInitialAndroidScan,
  findMatchingBootedTeardownDevices,
  findBootedTeardownTarget,
  type TeardownToolResponse,
} from "./teardownContracts";
import {
  findAbsentTeardownPooledDevices,
  evictTeardownManagers,
  notifyResourcesAfterShutdown,
} from "./shutdownPreparation";
import { probeForeignUnnamedRuntimes } from "./foreignRuntimeProbe";
import { retireTeardownPooledOwnership } from "./shutdownOwnership";
import { readTeardownInventory, readTeardownTargetDiscovery } from "./teardownDiscovery";
import {
  matchesIosTeardownIdentity,
  type PooledAvdCaptureResult,
  capturePooledAvdIdentity,
  pooledAvdNameRefusalMessage,
  pooledAvdCaptureRequiringConfirmation,
  isVirtualAndroidDevice,
  isUnknownAndroidRuntimeName,
} from "../identity/androidIdentity";

export async function retireAbsentTeardownOwnership(context: TeardownContext): Promise<void> {
  const devicePool = defaultDaemonContext.devicePool();
  if (!devicePool) {
    return;
  }
  const expectedPooledDevices = findAbsentTeardownPooledDevices(devicePool, context.args.target);
  for (const expectedPooledDevice of expectedPooledDevices) {
    await retireTeardownPooledOwnership(
      context,
      expectedPooledDevice,
      expectedPooledDevice.platform === "android"
        ? (expectedPooledDevice.avdName ?? expectedPooledDevice.name)
        : expectedPooledDevice.name,
    );
  }
}

export async function resolveAbsentTeardownTarget(
  context: TeardownContext,
  booted: BootedDeviceDiscovery,
  inventory: DeviceImageDiscovery,
): Promise<TeardownResolution> {
  const bootedComplete = completedInventoryFor(booted, context.args.target.platform);
  const inventoryComplete = completedInventoryFor(inventory, context.args.target.platform);
  if (!bootedComplete || !inventoryComplete) {
    return {
      response: createTeardownFailureResponse(
        context.args,
        "precondition",
        "inventory_incomplete",
        "Cannot prove the target is absent because one or more platform inventories did not complete.",
      ),
    };
  }
  const runtimeRefusal = await refuseLiveStoppedAndroidTarget(context, {
    device: {
      platform: context.args.target.platform,
      name: context.args.target.stableName ?? context.args.target.stableId,
      isRunning: false,
    },
    wasBooted: false,
  });
  if (runtimeRefusal) {
    return { response: runtimeRefusal };
  }
  const absentDevicePool = defaultDaemonContext.devicePool();
  const runtimeId = absentDevicePool
    ? findAbsentTeardownPooledDevices(absentDevicePool, context.args.target)[0]?.id
    : undefined;
  const androidManager =
    context.args.target.platform === "android" && runtimeId
      ? AndroidCtrlProxyManager.getExistingInstance(runtimeId)
      : undefined;
  await retireAbsentTeardownOwnership(context);
  if (androidManager) {
    AndroidCtrlProxyManager.evictInstance(androidManager);
  } else {
    await evictTeardownManagers(context, runtimeId);
  }
  unregisterDirectSessionsForStableIdentity(
    context.args.target.platform,
    context.args.target.stableId,
  );
  void notifyResourcesAfterShutdown(context.dependencies);
  return {
    response: createTeardownResponse(
      context.args,
      "already_absent",
      { stop: "not_required", destroy: "not_required" },
      { notRunning: "confirmed", inventory: "complete_absence_confirmed" },
    ),
  };
}

/**
 * Delete-by-name reserves the teardown lease under the supplied display
 * name, but iOS start/provision paths reserve the same simulator by UDID
 * (#6250 review). Rebind to the resolved UDID once the name has resolved to
 * a real device so the lease actually shares a keyspace with — and mutually
 * excludes — a concurrent start/provision of that simulator.
 */
export async function rebindIosTeardownLease(
  context: TeardownContext,
  target: TeardownResolvedTarget,
): Promise<void> {
  const resolvedUdid = target.device.deviceId;
  if (
    target.device.platform !== "ios" ||
    !resolvedUdid ||
    context.args.target.stableId === resolvedUdid ||
    !context.lifecycleLease
  ) {
    return;
  }
  await context.lifecycleLease.bindCanonicalIdentity({
    platform: "ios",
    stableId: resolvedUdid,
  });
}

export async function resolveInventoryTeardownTarget(
  context: TeardownContext,
  booted: BootedDeviceDiscovery,
  inventory: DeviceImageDiscovery,
): Promise<TeardownResolution> {
  const resolution = findInventoryTeardownTarget(inventory, context.args);
  if (resolution.conflict) {
    return {
      response: createTeardownFailureResponse(
        context.args,
        "precondition",
        "target_identity_conflict",
        resolution.conflict,
      ),
    };
  }
  const target = resolution.target;
  if (!target) {
    return await resolveAbsentTeardownTarget(context, booted, inventory);
  }
  if (!completedInventoryFor(booted, target.device.platform)) {
    return {
      response: createTeardownFailureResponse(
        context.args,
        "precondition",
        "booted_inventory_incomplete",
        `Cannot confirm ${target.device.platform} target '${target.device.name}' is not running.`,
        target.device,
      ),
    };
  }
  // findInventoryTeardownTarget already deduped this match against the
  // complete iOS inventory, so only the UDID rebind remains here.
  await rebindIosTeardownLease(context, target);
  return { target };
}

/**
 * A booted-device match found via the iOS name fallback only checked the
 * *booted* device list, so a name that also matches a distinct *stopped*
 * simulator was never detected as ambiguous (#6250 review). Re-check the
 * requested name against the complete iOS inventory (booted + stopped)
 * before committing to it, and rebind the teardown lifecycle lease to the
 * resolved UDID so it shares the same keyspace as start/provision leases.
 */
export async function finalizeIosNameResolvedTeardownTarget(
  context: TeardownContext,
  target: TeardownResolvedTarget,
): Promise<TeardownResolution> {
  if (target.device.platform !== "ios" || context.args.target.stableId === target.device.deviceId) {
    return { target };
  }
  const inventory = await readTeardownInventory(
    context,
    "ios",
    "platform inventory precondition did not complete",
  );
  if (!completedInventoryFor(inventory, "ios")) {
    return {
      response: createTeardownFailureResponse(
        context.args,
        "precondition",
        "inventory_incomplete",
        "Cannot resolve the requested iOS device name against the complete inventory because platform discovery did not complete.",
        target.device,
      ),
    };
  }
  const matches = inventory.devices.filter(
    (device) =>
      device.platform === "ios" && matchesIosTeardownIdentity(device, context.args.target.stableId),
  );
  if (matches.length > 1) {
    return {
      response: createTeardownFailureResponse(
        context.args,
        "precondition",
        "target_identity_conflict",
        "Multiple iOS devices matched the requested stable name; refusing to guess which one to delete.",
        target.device,
      ),
    };
  }
  await rebindIosTeardownLease(context, target);
  return { target };
}

/**
 * Refuse the stopped-image path while a booted emulator that could not name itself might be the
 * AVD about to be destroyed (#6863).
 *
 * An emulator another daemon owns is the one exception that can be settled without trusting a
 * cache: its name was deliberately not read by discovery (the foreign-serial skip), so the
 * placeholder says nothing about the runtime. Left as an unconditional veto, one such emulator
 * stalled every broker destruction until its owner shut it down (#15213). A `named` teardown asks
 * the runtime once, within its own deadline, and refuses only when the answer is missing or is
 * the target. A `serial-only` (`force`) teardown never probes -- that mode exists to escape wedged
 * consoles (#6874) -- so it keeps the unconditional refusal.
 */
async function refuseUnresolvedAndroidRuntime(
  context: TeardownContext,
  booted: BootedDeviceDiscovery,
): Promise<TeardownToolResponse | undefined> {
  const unresolvedRuntimes = booted.devices.filter(
    (device) =>
      device.platform === "android" &&
      isVirtualAndroidDevice(device) &&
      isUnknownAndroidRuntimeName(device),
  );
  const unresolvedRefusal = (runtime: BootedDevice) =>
    createTeardownFailureResponse(
      context.args,
      "precondition",
      "target_identity_unresolved",
      `Android emulator runtime '${runtime.deviceId}' has no resolvable AVD name; refusing deletion.`,
    );
  // A runtime this daemon could have read, or any runtime of a `force` teardown, stays a veto
  // without spending a probe on the others.
  const unprobeable = unresolvedRuntimes.find(
    (runtime) => !runtime.foreignOwned || context.mode !== "named",
  );
  if (unprobeable) {
    return unresolvedRefusal(unprobeable);
  }
  const probe = await probeForeignUnnamedRuntimes(context, unresolvedRuntimes);
  if (probe.kind === "unresolved") {
    return unresolvedRefusal(probe.runtime);
  }
  if (probe.kind === "runs-target") {
    return createTeardownFailureResponse(
      context.args,
      "precondition",
      "target_identity_conflict",
      `Android AVD '${probe.avdName}' is running on emulator '${probe.runtime.deviceId}', which ` +
        "another AutoMobile daemon owns; refusing deletion.",
    );
  }
  context.clearedForeignSerials = new Set(unresolvedRuntimes.map((runtime) => runtime.deviceId));
  return undefined;
}

export async function resolveTeardownTarget(context: TeardownContext): Promise<TeardownResolution> {
  const devicePool = defaultDaemonContext.devicePool();
  const booted = await readTeardownTargetDiscovery(context, devicePool);
  context.initialScan = captureTeardownInitialAndroidScan(booted, devicePool);
  // A booted emulator only matches this teardown by its POOLED AVD name when its
  // runtime name is unknown. Pin that label to its epoch here; the runtime is
  // made to confirm it immediately before the stop's platform kill, which is
  // also where `createBootedTeardownTarget` has already rewritten the target's
  // name to the pooled label (#6863 review).
  const [matchedBootedCandidate] = findMatchingBootedTeardownDevices(
    booted,
    context.args,
    devicePool,
  );
  const pooledAvdCapture: PooledAvdCaptureResult = matchedBootedCandidate
    ? capturePooledAvdIdentity(matchedBootedCandidate, devicePool, {
        timer: context.dependencies.timer,
        deadlineMs: context.deadlineMs,
        signal: context.requestAbortSignal,
      })
    : { kind: "none" };
  if (matchedBootedCandidate && pooledAvdCapture.kind === "refusal") {
    return {
      response: createTeardownFailureResponse(
        context.args,
        "precondition",
        "target_identity_unresolved",
        pooledAvdNameRefusalMessage(matchedBootedCandidate, pooledAvdCapture.refusal),
      ),
    };
  }
  const bootedTarget = findBootedTeardownTarget(booted, context.args, devicePool);
  if (bootedTarget.conflict) {
    return {
      response: createTeardownFailureResponse(
        context.args,
        "precondition",
        "target_identity_conflict",
        bootedTarget.conflict,
      ),
    };
  }
  if (bootedTarget.unsupported) {
    return {
      response: createTeardownFailureResponse(
        context.args,
        "precondition",
        "target_not_destroyable",
        bootedTarget.unsupported,
      ),
    };
  }
  if (bootedTarget.target) {
    const captureRequiringConfirmation = pooledAvdCaptureRequiringConfirmation(pooledAvdCapture);
    const resolvedTarget: TeardownResolvedTarget =
      bootedTarget.target.wasBooted && captureRequiringConfirmation
        ? { ...bootedTarget.target, pooledAvdCapture: captureRequiringConfirmation }
        : bootedTarget.target;
    return await finalizeIosNameResolvedTeardownTarget(context, resolvedTarget);
  }
  // Nothing booted matched this teardown, so the next step is the STOPPED-image
  // inventory path -- and a booted emulator that could not name itself may be
  // the very AVD whose image is about to be destroyed.
  //
  // The question is answered from THIS discovery, not from the pool. The pool's
  // quarantine encodes exactly this observation, but only from the sweep that
  // FOLLOWS it: on the first discovery after a different AVD takes a pooled
  // serial, the pool still holds the previous occupant's label and reading it
  // here would treat the placeholder as resolved -- which is what let a
  // teardown of the new AVD miss the booted runtime and destroy its image while
  // it was running. The teardown's own observation is the newer evidence of the
  // two, so it decides ([#6863](https://github.com/kaeawc/auto-mobile/pull/6863)
  // review).
  const unresolvedRuntimeRefusal = await refuseUnresolvedAndroidRuntime(context, booted);
  if (unresolvedRuntimeRefusal) {
    return { response: unresolvedRuntimeRefusal };
  }
  const inventory = await readTeardownInventory(
    context,
    context.args.target.platform,
    "platform inventory precondition did not complete",
  );
  return await resolveInventoryTeardownTarget(context, booted, inventory);
}

export function findStoppedTeardownPooledDevices(
  devicePool: Pick<DevicePool, "getAllDevices">,
  target: TeardownResolvedTarget,
): PooledDevice[] {
  return devicePool
    .getAllDevices()
    .filter(
      (device) =>
        device.platform === target.device.platform &&
        (device.platform === "ios"
          ? device.id === target.device.deviceId
          : (device.avdName ?? device.name) === target.device.name),
    );
}

/** A missing online row does not prove a stopped AVD: adb can still list it offline. */
export async function refuseLiveStoppedAndroidTarget(
  context: TeardownContext,
  target: TeardownResolvedTarget,
): Promise<TeardownToolResponse | undefined> {
  if (target.device.platform !== "android") {
    return undefined;
  }
  const pool = defaultDaemonContext.devicePool();
  const serials = pool
    ? findStoppedTeardownPooledDevices(pool, target).map((device) => device.id)
    : [];
  // Inventory and explicit target serials remain witnesses without a pooled incarnation.
  for (const serial of [target.device.deviceId, context.args.target.stableId]) {
    if (serial && isAndroidEmulatorSerial(serial)) {
      serials.push(serial);
    }
  }
  return await runWithinShutdownDeadline(
    context.deadlineDevice,
    context.dependencies.timer,
    context.deadlineMs,
    "Android stopped-image runtime check did not complete",
    {
      requestAbortSignal: context.requestAbortSignal,
      timeoutMs: context.timeoutMs,
      operation: async (signal, timeoutMs) => {
        const states = await context.deviceManager.getAndroidListedDeviceStates?.(serials, {
          signal,
          timeoutMs,
        });
        const processes = await context.dependencies.androidEmulatorProcessStopper.describeAvd(
          target.device.name,
          { signal, deadlineMs: context.deadlineMs },
        );
        if (
          (states?.size ?? 0) > 0 ||
          processes.kind === "unreadable" ||
          (processes.kind === "read" && processes.candidates.length > 0)
        ) {
          return createTeardownFailureResponse(
            context.args,
            "stop",
            "runtime_stop_unproven",
            `Cannot prove Android AVD '${target.device.name}' has stopped; retaining its image and pool ownership. ` +
              emulatorProcessEscapeHint(
                serials[0] ?? target.device.name,
                processes.kind === "read" ? processes.candidates : [],
                processes.kind === "unreadable" ? "unreadable" : undefined,
              ),
            target.device,
          );
        }
        return undefined;
      },
    },
  );
}

export async function retireStoppedTeardownOwnership(
  context: TeardownContext,
  target: TeardownResolvedTarget,
): Promise<void> {
  const devicePool = defaultDaemonContext.devicePool();
  if (!devicePool) {
    return;
  }
  const expectedPooledDevices = findStoppedTeardownPooledDevices(devicePool, target);
  for (const expectedPooledDevice of expectedPooledDevices) {
    await retireTeardownPooledOwnership(context, expectedPooledDevice, target.device.name);
  }
}
