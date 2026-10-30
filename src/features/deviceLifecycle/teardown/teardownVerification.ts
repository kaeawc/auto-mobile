import { probeForeignUnnamedRuntimes } from "./foreignRuntimeProbe";
import { BootedDevice } from "../../../models";
import { logger } from "../../../utils/logger";
import { type BootedDeviceDiscovery } from "../../../devices/deviceUtils";
import { defaultDaemonContext } from "../../../daemon/daemonContext";
import {
  type TeardownContext,
  type TeardownResolvedTarget,
  type TeardownToolResponse,
  createTeardownFailureResponse,
  teardownProbeBudget,
  completedInventoryFor,
  findMatchingBootedTeardownDevices,
  inventoryContainsTarget,
  createTeardownResponse,
} from "./teardownContracts";
import { runWithinShutdownDeadline, sleepUnlessAborted } from "../core/deadlines";
import {
  isVirtualAndroidDevice,
  isUnknownAndroidRuntimeName,
  getValidatedPooledAndroidAvdName,
} from "../identity/androidIdentity";
import {
  readTeardownBootedDiscovery,
  type TeardownInventoryDiscovery,
  readTeardownInventory,
} from "./teardownDiscovery";
import { isShutdownTimeoutError, notifyResourcesAfterShutdown } from "./shutdownPreparation";
import { DEVICE_SHUTDOWN_POLL_INTERVAL_MS } from "./shutdownDiscovery";

export async function destroyTeardownTarget(
  context: TeardownContext,
  target: TeardownResolvedTarget,
  retainStableLifecycleUntil: (operation: Promise<unknown>) => void,
  onLateSuccess: () => void,
): Promise<void> {
  const deadlineTarget: BootedDevice = {
    name: target.device.name,
    platform: target.device.platform,
    deviceId: target.device.deviceId ?? context.args.target.stableId,
  };
  let destroy: Promise<void> | undefined;
  try {
    await runWithinShutdownDeadline(
      deadlineTarget,
      context.dependencies.timer,
      context.deadlineMs,
      "platform deletion command did not complete",
      {
        requestAbortSignal: context.requestAbortSignal,
        operation: async (signal, timeoutMs) => {
          destroy = context.deviceManager.destroyDevice(target.device, {
            signal,
            timeoutMs,
            lifecycleLease: context.lifecycleLease,
          });
          return await destroy;
        },
        timeoutMs: context.timeoutMs,
      },
    );
  } catch (error) {
    if (destroy) {
      retainStableLifecycleUntil(destroy);
      if (!context.cancelOnRequestAbort || target.device.platform === "ios") {
        void destroy.then(
          () => onLateSuccess(),
          () => {
            // A rejected late destroy did not remove the platform device, so no eviction is safe.
            logger.debug("[DeviceTools] Late platform deletion rejected; retaining teardown state");
          },
        );
      } else {
        // A deadline-critical Android teardown keeps the identity reservation
        // until the command settles, but a late completion cannot safely evict a
        // later AVD incarnation with the same replaceable name. iOS uses an
        // immutable UDID, so its late-success path still finalizes stale state.
        void destroy.catch(() => undefined);
      }
    }
    throw error;
  }
}

export function serialOnlyAndroidTeardownRestartFailure(
  context: TeardownContext,
  target: TeardownResolvedTarget,
  phase: "stop" | "verification",
  suspect: BootedDevice,
  probedName: string | undefined,
): TeardownToolResponse | undefined {
  if (probedName === undefined) {
    return createTeardownFailureResponse(
      context.args,
      phase,
      phase === "stop" ? "target_restarted" : "target_still_running",
      phase === "stop"
        ? `Android peer emulator '${suspect.deviceId}' could not identify its AVD while the target's ` +
            "original serial disappeared; refusing deletion rather than assuming the target did not restart there."
        : `The Android AVD may have reappeared on peer emulator '${suspect.deviceId}' after deletion, ` +
            "but its AVD name could not be resolved; refusing to report success rather than assuming inventory absence is durable.",
      { resolved: target.device },
    );
  }
  if (probedName !== context.args.target.stableId) {
    return undefined;
  }
  return createTeardownFailureResponse(
    context.args,
    phase,
    phase === "stop" ? "target_restarted" : "target_still_running",
    phase === "stop"
      ? "The Android AVD restarted after shutdown confirmation; refusing deletion."
      : `The Android AVD reappeared on peer emulator '${suspect.deviceId}' after deletion; ` +
          "refusing to report success rather than assuming inventory absence is durable.",
    { resolved: target.device },
  );
}

export async function checkForSerialOnlyAndroidTeardownRestart(
  context: TeardownContext,
  target: TeardownResolvedTarget,
  booted: BootedDeviceDiscovery,
  phase: "stop" | "verification",
): Promise<TeardownToolResponse | undefined> {
  if (context.mode !== "serial-only" || target.device.platform !== "android") {
    return undefined;
  }
  const targetOriginalSerial = target.wasBooted ? target.bootedDevice.deviceId : undefined;
  if (!targetOriginalSerial) {
    return undefined;
  }
  if (
    targetOriginalSerial &&
    booted.devices.some((device) => device.deviceId === targetOriginalSerial)
  ) {
    return undefined;
  }
  const suspectPeers = booted.devices.filter(
    (device) =>
      device.platform === "android" &&
      isVirtualAndroidDevice(device) &&
      isUnknownAndroidRuntimeName(device) &&
      device.deviceId !== targetOriginalSerial &&
      (context.initialScan.serials.has(device.deviceId) ||
        (context.initialScan.pooledEntries.some((pooled) => pooled.id === device.deviceId) &&
          !context.initialScan.serials.has(device.deviceId))),
  );
  for (const suspect of suspectPeers) {
    const probeBudget = teardownProbeBudget(context);
    if (probeBudget.remainingMs <= 0) {
      break;
    }
    const probedName = await context.dependencies.resolveRunningAndroidAvdName(
      suspect,
      probeBudget.remainingMs,
      probeBudget.signal,
    );
    const refusal = serialOnlyAndroidTeardownRestartFailure(
      context,
      target,
      phase,
      suspect,
      probedName,
    );
    if (refusal) {
      return refusal;
    }
  }
  return undefined;
}

/**
 * The resolution step cleared unnamed foreign emulators by reading their names; a serial can be
 * reused after that read, so ask again right before the image is deleted. Only the pre-delete
 * `stop` phase can still prevent anything, and `force` never probes consoles.
 */
async function checkForeignRuntimesBeforeDestroy(
  context: TeardownContext,
  target: TeardownResolvedTarget,
  booted: BootedDeviceDiscovery,
  phase: "stop" | "verification",
): Promise<TeardownToolResponse | undefined> {
  if (phase !== "stop" || context.mode !== "named") {
    return undefined;
  }
  const foreignRuntimes = booted.devices.filter(
    (device) =>
      device.platform === "android" &&
      (device.foreignOwned === true || context.clearedForeignSerials?.has(device.deviceId)) &&
      isVirtualAndroidDevice(device) &&
      isUnknownAndroidRuntimeName(device),
  );
  if (foreignRuntimes.length === 0) {
    return undefined;
  }
  const probe = await probeForeignUnnamedRuntimes(context, foreignRuntimes);
  if (probe.kind === "unresolved") {
    return createTeardownFailureResponse(
      context.args,
      phase,
      "target_identity_unresolved",
      `Android emulator runtime '${probe.runtime.deviceId}' has no resolvable AVD name; refusing deletion.`,
      { resolved: target.device },
    );
  }
  if (probe.kind === "runs-target") {
    return createTeardownFailureResponse(
      context.args,
      phase,
      "target_restarted",
      `Android AVD '${probe.avdName}' is running on emulator '${probe.runtime.deviceId}', which ` +
        "another AutoMobile daemon owns; refusing deletion.",
      { resolved: target.device },
    );
  }
  return undefined;
}

export async function checkForRestartedTeardownTarget(
  context: TeardownContext,
  target: TeardownResolvedTarget,
  phase: "stop" | "verification",
): Promise<TeardownToolResponse | undefined> {
  if (target.device.platform !== "android") {
    return undefined;
  }
  const booted = await readTeardownBootedDiscovery(
    context,
    phase === "stop"
      ? "post-shutdown booted-device discovery did not complete"
      : "post-delete booted-device discovery did not complete",
  );
  if (!completedInventoryFor(booted, target.device.platform)) {
    return createTeardownFailureResponse(
      context.args,
      phase,
      "booted_inventory_incomplete",
      "Cannot confirm the Android AVD is not running.",
      { resolved: target.device },
    );
  }
  const devicePool = defaultDaemonContext.devicePool();
  const newlyAppearedUnresolvedRuntime = booted.devices.find(
    (device) =>
      device.platform === "android" &&
      isVirtualAndroidDevice(device) &&
      isUnknownAndroidRuntimeName(device) &&
      !getValidatedPooledAndroidAvdName(device, devicePool) &&
      (!context.initialScan.serials.has(device.deviceId) ||
        (target.wasBooted && device.deviceId === target.bootedDevice.deviceId)),
  );
  if (newlyAppearedUnresolvedRuntime) {
    return createTeardownFailureResponse(
      context.args,
      phase,
      "target_identity_unresolved",
      `A new Android emulator runtime '${newlyAppearedUnresolvedRuntime.deviceId}' appeared ` +
        "without a resolvable AVD name; refusing deletion.",
      { resolved: target.device },
    );
  }
  const foreignRestart = await checkForeignRuntimesBeforeDestroy(context, target, booted, phase);
  if (foreignRestart) {
    return foreignRestart;
  }
  const serialOnlyRestart = await checkForSerialOnlyAndroidTeardownRestart(
    context,
    target,
    booted,
    phase,
  );
  if (serialOnlyRestart) {
    return serialOnlyRestart;
  }
  const replacement = findMatchingBootedTeardownDevices(booted, context.args, devicePool)[0];
  if (!replacement) {
    return undefined;
  }
  return createTeardownFailureResponse(
    context.args,
    phase,
    phase === "stop" ? "target_restarted" : "target_still_running",
    phase === "stop"
      ? "The Android AVD restarted after shutdown confirmation; refusing deletion."
      : "The Android AVD is still running after deletion.",
    { resolved: target.device },
  );
}

export function androidInventorySourcesListingTarget(
  inventory: TeardownInventoryDiscovery,
  targetName: string,
): string[] {
  const sources = inventory.androidSources;
  if (!sources) {
    return [];
  }
  return [
    ...(sources.emulatorAvdNames.has(targetName) ? ["emulator -list-avds"] : []),
    ...(sources.avdManagerAvdNames.has(targetName) ? ["avdmanager list avd"] : []),
  ];
}

export function teardownInventoryVerificationFailure(
  context: TeardownContext,
  target: TeardownResolvedTarget,
  inventory: TeardownInventoryDiscovery,
): TeardownToolResponse | undefined {
  const targetName = target.device.name;
  const listedBy = androidInventorySourcesListingTarget(inventory, targetName);
  if (!completedInventoryFor(inventory, target.device.platform)) {
    const incompleteSources = inventory.androidSources?.incompleteSources ?? [];
    const sourceDetail =
      incompleteSources.length > 0 ? ` Incomplete checks: ${incompleteSources.join(", ")}.` : "";
    const diagnosticDetail = inventory.discoveryErrors?.[target.device.platform]?.message
      ? ` ${inventory.discoveryErrors[target.device.platform]?.message}`
      : "";
    const presenceDetail =
      listedBy.length > 0
        ? ` Target '${targetName}' remained listed by ${listedBy.join(" and ")}.`
        : "";
    return createTeardownFailureResponse(
      context.args,
      "verification",
      "inventory_incomplete",
      "The platform deletion command completed, but durable absence could not be verified." +
        sourceDetail +
        diagnosticDetail +
        presenceDetail,
      { resolved: target.device },
    );
  }
  if (!inventoryContainsTarget(inventory, target)) {
    return undefined;
  }
  const sourceDetail =
    listedBy.length > 0 ? ` It remained listed by ${listedBy.join(" and ")}.` : "";
  return createTeardownFailureResponse(
    context.args,
    "verification",
    "target_still_present",
    `The platform deletion command completed, but target '${targetName}' is still present in inventory.${sourceDetail}`,
    { resolved: target.device },
  );
}

export async function readTeardownAbsenceFailure(
  context: TeardownContext,
  target: TeardownResolvedTarget,
): Promise<TeardownToolResponse | undefined> {
  const restarted = await checkForRestartedTeardownTarget(context, target, "verification");
  if (restarted) {
    return restarted;
  }
  const inventory = await readTeardownInventory(
    context,
    target.device.platform,
    "post-delete platform inventory did not complete",
  );
  return teardownInventoryVerificationFailure(context, target, inventory);
}

export function createTeardownVerificationDeadlineFailure(
  context: TeardownContext,
  target: TeardownResolvedTarget,
  lastFailure?: TeardownToolResponse,
): TeardownToolResponse {
  const lastFailureMessage = lastFailure
    ? (
        JSON.parse(lastFailure.content[0].text) as {
          failure?: { message?: string };
        }
      ).failure?.message
    : undefined;
  const message =
    "The teardown deadline elapsed before durable target absence could be verified." +
    (lastFailureMessage ? ` ${lastFailureMessage}` : "");
  return createTeardownFailureResponse(
    context.args,
    "verification",
    "verification_deadline_exceeded",
    message,
    { resolved: target.device },
  );
}

export function clearDeletedAndroidAvdRebootBudget(target: TeardownResolvedTarget): void {
  if (target.device.platform !== "android") {
    return;
  }
  defaultDaemonContext.devicePoolWrites()?.clearAndroidRebootBudgetForDeletedAvd(target.device);
}

export async function verifyTeardownAbsence(
  context: TeardownContext,
  target: TeardownResolvedTarget,
  stop: "accepted" | "not_required",
  onFailure?: (failure: TeardownToolResponse) => void,
): Promise<TeardownToolResponse> {
  let lastFailure: TeardownToolResponse | undefined;
  for (;;) {
    context.requestAbortSignal?.throwIfAborted();
    if (context.dependencies.timer.now() >= context.deadlineMs) {
      return createTeardownVerificationDeadlineFailure(context, target, lastFailure);
    }

    let failure: TeardownToolResponse | undefined;
    try {
      failure = await readTeardownAbsenceFailure(context, target);
    } catch (error) {
      if (context.requestAbortSignal?.aborted || !isShutdownTimeoutError(error)) {
        throw error;
      }
      logger.warn("[DeviceTools] Teardown verification read reached the shutdown deadline", error);
      return createTeardownVerificationDeadlineFailure(context, target, lastFailure);
    }
    if (!failure) {
      // Clear the name-keyed crash budget only after deletion and durable
      // absence are both confirmed. Pool re-adds and failed teardowns retain it.
      clearDeletedAndroidAvdRebootBudget(target);
      void notifyResourcesAfterShutdown(context.dependencies);
      return createTeardownResponse(
        context.args,
        "destroyed",
        { stop, destroy: "accepted" },
        { notRunning: "confirmed", inventory: "complete_absence_confirmed" },
        { resolved: target.device },
      );
    }
    lastFailure = failure;
    onFailure?.(failure);

    const remainingMs = context.deadlineMs - context.dependencies.timer.now();
    if (remainingMs <= 0) {
      return createTeardownVerificationDeadlineFailure(context, target, lastFailure);
    }
    await sleepUnlessAborted(
      context.dependencies.timer,
      Math.min(DEVICE_SHUTDOWN_POLL_INTERVAL_MS, remainingMs),
      context.requestAbortSignal,
    );
  }
}
