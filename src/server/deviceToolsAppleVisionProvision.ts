import { notifyAfterAppleSimulatorProvision } from "./appleSimulatorInventoryNotify";
import { requestAcquisitionReceipt } from "../daemon/acquisitionReceipt";
import {
  currentAutolockMcpSessionId,
  currentOneShotCli,
} from "../features/toolSelection/toolSelectionContext";
import { holderOf } from "../daemon/deviceBinding";
import { isAnonymousAcquisitionSession } from "../daemon/sessionManager";
import type { VirtualDeviceLifecycleLease } from "../devices/virtualDeviceLifecycleCoordinator";
import { errorMessage } from "../utils/describeUnknownError";
import { logger } from "../utils/logger";
import { describeDevice, projectProvisionedDevice } from "../daemon/deviceDescription";
import {
  getDeviceToolsDependencies,
  initializedDevicePool,
  provisionDeviceRegistrationSchema,
  type DeviceToolsDependencies,
  type AppleVisionProvisionDeviceRequest,
} from "../features/deviceLifecycle/deviceLifecycleCore";
import { ActionableError, toActionableError } from "../models";
import { combineAbortSignals, runWithAbortSignal } from "../utils/AbortContext";
import { DEFAULT_PROVISION_DEVICE_TIMEOUT_MS } from "../utils/deviceTimeouts";
import { SimCtlClient } from "../utils/ios-cmdline-tools/SimCtlClient";
import { AppleVisionSimulatorInventory } from "../utils/ios-cmdline-tools/AppleVisionSimulatorInventory";
import {
  AppleVisionSimulatorBoot,
  type ListedAppleVision,
  type AppleVisionBootResult,
} from "../utils/ios-cmdline-tools/AppleVisionSimulatorBoot";
import {
  AppleVisionSimulatorProvisioner,
  type AppleVisionProvisionRequest,
  type AppleVisionDiscardResult,
} from "../utils/ios-cmdline-tools/AppleVisionSimulatorProvisioner";
import { awaitWhileRequestIsLive, createStructuredToolResponse } from "../utils/toolUtils";
import { runWithAcquisitionDeadline } from "./deviceToolsAcquisition";
import { bindBootedSimulatorSession } from "./deviceToolsSimulatorSession";
import type { BindBootedSession } from "./deviceToolsWatchOs";
import { bootAdmissionServices } from "../devices/bootAdmissionServices";
import { formatToolParamError } from "./toolParamError";
import { stripInternalToolParams } from "./internalToolParams";

type AppleVisionProvisioner = ReturnType<
  NonNullable<DeviceToolsDependencies["appleVisionSimulatorProvisionerFactory"]>
>;

/** Whether a provisionDevice request names an Apple Vision Pro simulator. */
export function isAppleVisionProvisionRequest(rawArgs: object): boolean {
  return Reflect.get(Reflect.get(rawArgs, "device") ?? {}, "platform") === "visionos";
}

/**
 * provisionDevice for an Apple Vision Pro simulator. Under a lifecycle lease on the requested
 * name (rebound to the headset's UDID once resolved), adopt the exact headset or create it with
 * `simctl create`; with `boot` (the default) boot it and bind a session at readiness `booted`, as
 * startDevice does. A headset this call created is deleted again if its boot or bind fails. No
 * resources, tool grants or automation runner apply to a headset.
 */
export async function provisionAppleVisionDevice(
  rawArgs: object,
  bindSession: BindBootedSession,
  signal?: AbortSignal,
) {
  const args = parseAppleVisionProvisionArgs(rawArgs);
  const deps = getDeviceToolsDependencies();
  const startedAtMs = deps.timer.now();
  const request: AppleVisionProvisionRequest = {
    name: args.device.name,
    ...(args.device.deviceId ? { deviceId: args.device.deviceId } : {}),
    spec: args.device.spec,
  };
  return await runWithAcquisitionDeadline(
    startedAtMs + (args.timeoutMs ?? DEFAULT_PROVISION_DEVICE_TIMEOUT_MS),
    signal,
    {
      operationName: "provisionDevice",
      operation: async (deadlineMs, requestSignal, stage) =>
        await runWithAbortSignal(requestSignal, async () => {
          stage.current = "waiting for the device lifecycle lease";
          const lease = await deps.lifecycleCoordinator.reserve(
            { kind: "selector", platform: "visionos", selector: request.deviceId ?? request.name },
            { operation: "provision", deadlineMs, signal: requestSignal },
          );
          let leaseReleased = false;
          try {
            stage.current = "resolving or creating the Apple Vision Pro simulator";
            const provisioner = (
              deps.appleVisionSimulatorProvisionerFactory ?? defaultAppleVisionProvisioner
            )();
            let resolved = await provisioner.provision(request, {
              // provisionDevice is an explicit creation request, as on Android and iOS.
              allowCreate: deps.deviceCreationGateFactory().isCreationAllowed(true),
              // A headset created only to be refused at boot would then be deleted (#11236).
              ...(args.boot === false
                ? {}
                : { assertCapacityBeforeCreate: visionBootCapacityCheck(deps) }),
              signal: requestSignal,
              discardUnconfirmed: (headset) =>
                discardUnclaimedCreatedVision(headset, provisioner, deps, lease),
            });
            const createdVision = resolved.headset;
            let cleanupNeeded = resolved.created;
            const discardCreated = async (): Promise<AppleVisionDiscardResult> => {
              if (!cleanupNeeded) {
                return { deleted: true };
              }
              const result = await discardUnclaimedCreatedVision(
                createdVision,
                provisioner,
                deps,
                leaseReleased ? undefined : lease,
              );
              if (result.deleted) {
                cleanupNeeded = false;
              }
              return result;
            };
            const receipt = requestAcquisitionReceipt();
            if (resolved.created && receipt && !receipt.started) {
              receipt.started = {
                rollBack: async () => {
                  const discarded = await discardCreated();
                  if (!discarded.deleted) {
                    throw new ActionableError(
                      `Could not undo created Apple Vision Pro simulator ${createdVision.deviceId}: ${discarded.error}; delete it with deleteDevice`,
                    );
                  }
                },
              };
            }
            try {
              await lease.bindCanonicalIdentity(
                { platform: "visionos", stableId: resolved.headset.deviceId },
                // After waiting on another lifecycle (a shutdown, say) the headset is read again, and
                // that fresh snapshot is the one booted below.
                async () => {
                  const again = await provisioner.provision(request, {
                    allowCreate: false,
                    signal: requestSignal,
                  });
                  resolved = { headset: again.headset, created: resolved.created };
                  return { platform: "visionos", stableId: again.headset.deviceId };
                },
              );
            } catch (error) {
              const discarded = resolved.created ? await discardCreated() : undefined;
              throw new ActionableError(
                `Could not bind Apple Vision Pro simulator ${createdVision.deviceId} to its lifecycle` +
                  (discarded ? `; ${discardMessage(discarded)}` : "") +
                  `: ${errorMessage(error)}`,
                { cause: error },
              );
            }
            const { headset, created } = resolved;
            if (args.boot === false) {
              notifyAfterAppleSimulatorProvision(
                `Apple Vision Pro simulator ${headset.deviceId}`,
                created,
                undefined,
              );
              return headsetProvisionResponse(args, headset, created, undefined);
            }
            const booted = await bootAndBind(
              { rawArgs, headset, created, lease, discardCreated, bindSession },
              deps,
              deadlineMs,
              { signal: requestSignal, stage },
            );
            notifyAfterAppleSimulatorProvision(
              `Apple Vision Pro simulator ${headset.deviceId}`,
              created,
              booted,
            );
            return headsetProvisionResponse(args, headset, created, booted);
          } finally {
            leaseReleased = true;
            lease.release();
          }
        }),
    },
  );
}

async function bootAndBind(
  {
    rawArgs,
    headset,
    created,
    lease,
    discardCreated,
    bindSession,
  }: {
    /** The request as received: the binder reads the caller's connection from its internal params. */
    rawArgs: object;
    headset: ListedAppleVision;
    created: boolean;
    lease: VirtualDeviceLifecycleLease;
    discardCreated: () => Promise<AppleVisionDiscardResult>;
    bindSession: BindBootedSession;
  },
  deps: DeviceToolsDependencies,
  deadlineMs: number,
  { signal, stage }: { signal: AbortSignal; stage: { current: string } },
): Promise<{ boot: AppleVisionBootResult; sessionId: string }> {
  try {
    return await bootAndBindHeadset(
      // A headset this call created is deleted again below, which also stops it.
      {
        rawArgs,
        headset,
        lease,
        bindSession,
        operation: "provisionDevice",
        stopColdBoot: !created,
      },
      deps,
      deadlineMs,
      { signal, stage },
    );
  } catch (error) {
    if (!created) {
      throw toActionableError(
        error,
        `Could not start Apple Vision Pro simulator ${headset.deviceId}`,
      );
    }
    const discarded = await discardCreated();
    throw new ActionableError(
      `provisionDevice created Apple Vision Pro simulator ${headset.deviceId} but could not start it; ` +
        `${discardMessage(discarded)}: ${errorMessage(error)}`,
      { cause: error },
    );
  }
}

/**
 * The boot and session bind startDevice and provisionDevice share, under the headset's canonical
 * lifecycle lease. This daemon's holders and lifecycles, then other daemons' claims, are checked
 * before the boot. A headset this call cold-booted is stopped again when the boot or bind fails or
 * is cancelled before a session holds it.
 */
export async function bootAndBindHeadset(
  {
    rawArgs,
    headset,
    lease,
    bindSession,
    operation,
    stopColdBoot = true,
  }: {
    /** The request as received: the binder reads the caller's connection from its internal params. */
    rawArgs: object;
    headset: ListedAppleVision;
    lease: VirtualDeviceLifecycleLease;
    bindSession: BindBootedSession;
    operation: "startDevice" | "provisionDevice";
    /** Whether a failure stops a headset this call cold-booted (default true). */
    stopColdBoot?: boolean;
  },
  deps: DeviceToolsDependencies,
  deadlineMs: number,
  { signal, stage }: { signal: AbortSignal; stage: { current: string } },
): Promise<{ boot: AppleVisionBootResult; sessionId: string }> {
  // A teardown that preempts this lease aborts boot admission and binding.
  const lifecycleSignal = combineAbortSignals(signal, lease.signal) ?? lease.signal;
  const reusableSessionId = reusableVisionSessionId(headset.deviceId, deps);
  assertVisionUnclaimed(headset.deviceId, deps, lease, reusableSessionId);
  await assertVisionNotClaimedByForeignDaemon(headset.deviceId, lifecycleSignal);
  lifecycleSignal.throwIfAborted();
  stage.current = "booting the Apple Vision Pro simulator";
  const lifecycle = (deps.appleVisionSimulatorBootFactory ?? defaultAppleVisionBoot)();
  let boot: AppleVisionBootResult | undefined;
  try {
    boot = await runWithAbortSignal(lifecycleSignal, () =>
      lifecycle.boot(headset, {
        timeoutMs: Math.max(1, deadlineMs - deps.timer.now()),
        signal: lifecycleSignal,
      }),
    );
    lifecycleSignal.throwIfAborted();
    stage.current = "binding the device session";
    const sessionId = await bindBootedSimulatorSession(
      { device: headset, boot, rawArgs, operation },
      bindSession,
      deps.timer,
      { deadlineMs, signal: lifecycleSignal },
    );
    lifecycleSignal.throwIfAborted();
    return { boot, sessionId };
  } catch (error) {
    if (stopColdBoot) {
      await stopUnboundColdBoot(lifecycle, boot, headset.deviceId);
    }
    throw error;
  }
}

/**
 * A cold boot no session holds yet is stopped; a headset another request bound, or another
 * daemon claims, is left alone.
 */
async function stopUnboundColdBoot(
  lifecycle: Pick<AppleVisionSimulatorBoot, "stopColdBooted">,
  boot: AppleVisionBootResult | undefined,
  udid: string,
): Promise<void> {
  if (boot?.acquisition !== "cold-boot") {
    return;
  }
  try {
    await withUnboundHeadsetFence(udid, () => lifecycle.stopColdBooted(boot));
  } catch (error) {
    logger.warn(
      `[visionOS] Leaving Apple Vision Pro simulator ${udid} running after its start failed: ${errorMessage(error)}`,
      error,
    );
  }
}

/**
 * Runs a stop or delete of a headset that no session of this daemon holds and no other daemon
 * claims. After the claim read, the pool's shutdown reservation re-checks the holder under the
 * assignment mutex and keeps a concurrent bind (setActiveDevice) off the headset until
 * `operation` ends, as killDevice does. Throws, without running `operation`, when a session holds
 * the headset or a claim refuses it.
 */
async function withUnboundHeadsetFence<T>(udid: string, operation: () => Promise<T>): Promise<T> {
  const pool = initializedDevicePool();
  const assertUnheld = () => {
    const holder = holderOf(pool?.getDevice(udid));
    if (holder) {
      throw new ActionableError(`session ${holder} holds it now`);
    }
  };
  assertUnheld();
  // A bind refused for another daemon's claim leaves no local holder: the headset is theirs.
  await assertVisionNotClaimedByForeignDaemon(udid);
  const reservation = await pool?.reserveDeviceForShutdown(udid, undefined, undefined, {
    assertHolder: assertUnheld,
    fenceUnpooled: true,
  });
  try {
    return await operation();
  } finally {
    await reservation?.release();
    if (!reservation) {
      pool?.settleUnpooledShutdown(udid);
    }
  }
}

/**
 * Another daemon's claim refuses a boot or a cleanup delete before it runs. The session bind
 * refuses it too, but only after the boot; this daemon's own holder passes.
 */
export async function assertVisionNotClaimedByForeignDaemon(
  udid: string,
  signal?: AbortSignal,
): Promise<void> {
  await awaitWhileRequestIsLive(
    initializedDevicePool()?.assertNotClaimedByForeignDaemon(udid, "visionos", undefined, 0) ??
      Promise.resolve(),
    signal,
  );
}

/**
 * The pool holder a boot may reuse: the caller's own MCP session, or under one-shot CLI an
 * anonymous acquisition session an earlier one-shot call left on the headset.
 */
export function reusableVisionSessionId(
  deviceId: string,
  deps: DeviceToolsDependencies,
): string | undefined {
  return currentOneShotCli()
    ? reusableAnonymousSessionId(deviceId, deps)
    : initializedDevicePool()?.resolveOwnedDeviceSessionForMcpSession(
        currentAutolockMcpSessionId(),
        deviceId,
      );
}

function reusableAnonymousSessionId(
  deviceId: string,
  deps: DeviceToolsDependencies,
): string | undefined {
  if (!deps.daemonState.isInitialized()) {
    return undefined;
  }
  const holder = holderOf(deps.daemonState.getDevicePool().getDevice(deviceId));
  const session = holder ? deps.daemonState.getSessionManager().getSession(holder) : null;
  return holder && session && isAnonymousAcquisitionSession(session) ? holder : undefined;
}

/** The canonical lease owns the UDID; only boot may reuse the caller's own pool holder. */
export function assertVisionUnclaimed(
  udid: string,
  deps: DeviceToolsDependencies,
  lease?: VirtualDeviceLifecycleLease,
  reusableSessionId?: string,
): void {
  const held = holderOf(initializedDevicePool()?.getDevice(udid));
  const ownsIdentity =
    lease?.identity.kind === "stable" &&
    lease.identity.platform === "visionos" &&
    lease.identity.stableId === udid;
  if (
    (held && held !== reusableSessionId) ||
    (!ownsIdentity &&
      deps.lifecycleCoordinator.isReserved({
        kind: "stable",
        platform: "visionos",
        stableId: udid,
      }))
  ) {
    throw new ActionableError(
      `Apple Vision Pro simulator ${udid} is held by ${held ? `session ${held}` : "another lifecycle"}; retry after it is released`,
    );
  }
}

/** Cleanup requires an unclaimed pool entry and the canonical lifecycle lease. */
async function discardUnclaimedCreatedVision(
  headset: Pick<ListedAppleVision, "deviceId">,
  provisioner: AppleVisionProvisioner,
  deps: DeviceToolsDependencies,
  lease?: VirtualDeviceLifecycleLease,
): Promise<AppleVisionDiscardResult> {
  let cleanupLease: VirtualDeviceLifecycleLease | undefined;
  try {
    assertVisionUnclaimed(headset.deviceId, deps, lease);
    if (lease?.identity.kind !== "stable" || lease.identity.stableId !== headset.deviceId) {
      cleanupLease = await deps.lifecycleCoordinator.reserve(
        { kind: "stable", platform: "visionos", stableId: headset.deviceId },
        { operation: "start", deadlineMs: deps.timer.now() + 30_000 },
      );
    }
    assertVisionUnclaimed(headset.deviceId, deps, cleanupLease ?? lease);
    return await withUnboundHeadsetFence(headset.deviceId, () =>
      provisioner.discardCreated(headset),
    );
  } catch (error) {
    logger.warn(
      `[visionOS] Leaving created Apple Vision Pro simulator ${headset.deviceId}: ${errorMessage(error)}`,
      error,
    );
    return { deleted: false, error: errorMessage(error) };
  } finally {
    cleanupLease?.release();
  }
}

function visionBootCapacityCheck(
  deps: DeviceToolsDependencies,
): (signal?: AbortSignal) => Promise<void> {
  return async (signal) => {
    await (deps.checkBootCapacity
      ? deps.checkBootCapacity("visionos", signal)
      : bootAdmissionServices.assertBootCapacityAvailable("visionos", { signal }));
  };
}

function discardMessage(discarded: AppleVisionDiscardResult): string {
  return discarded.deleted
    ? "the headset was deleted again"
    : `deleting it again failed (${discarded.error}); delete it with deleteDevice`;
}

function headsetProvisionResponse(
  args: AppleVisionProvisionDeviceRequest,
  headset: ListedAppleVision,
  created: boolean,
  booted: { boot: AppleVisionBootResult; sessionId: string } | undefined,
) {
  const resolvedSpec = { ...args.device.spec, displayCutout: "unknown" as const };
  const description = describeDevice({
    kind: "provisioned",
    provisioned: { device: headset, created, resolvedSpec },
    booted: booted?.boot.device,
    pooled: booted
      ? (initializedDevicePool()?.getDevice(headset.deviceId) ?? undefined)
      : undefined,
    discovery: headset,
    session: booted ? { sessionId: booted.sessionId } : undefined,
  });
  const lifecycleState = booted ? "ready" : created ? "created" : "adopted";
  return createStructuredToolResponse({
    message: `visionos '${headset.name}' provisioned (${lifecycleState})`,
    device: projectProvisionedDevice(description),
    requestedSpec: args.device.spec,
    resolvedSpec,
    displayCutout: "unknown",
    created,
    adopted: !created,
    lifecycleState,
    readiness: { mode: "none", status: booted ? "device_ready" : "not_requested" },
    ...(booted ? { sessionId: booted.sessionId, acquisition: booted.boot.acquisition } : {}),
    timing: {},
  });
}

function parseAppleVisionProvisionArgs(rawArgs: object): AppleVisionProvisionDeviceRequest {
  const input = stripInternalToolParams(rawArgs);
  const parsed = provisionDeviceRegistrationSchema.safeParse(input);
  if (parsed.success) {
    if (parsed.data.device.platform !== "visionos") {
      throw new ActionableError(
        "provisionDevice: the visionOS path received a non-headset request.",
      );
    }
    return parsed.data as AppleVisionProvisionDeviceRequest;
  }
  throw new ActionableError(
    `Invalid parameters for tool provisionDevice: ${formatToolParamError(
      "provisionDevice",
      parsed.error,
      input,
      provisionDeviceRegistrationSchema,
    )}`,
  );
}

function defaultAppleVisionProvisioner(): AppleVisionSimulatorProvisioner {
  const simctl = new SimCtlClient();
  return new AppleVisionSimulatorProvisioner(new AppleVisionSimulatorInventory(simctl), simctl);
}

export function defaultAppleVisionBoot(): AppleVisionSimulatorBoot {
  return new AppleVisionSimulatorBoot(new SimCtlClient(), {
    run: (request, boot) => bootAdmissionServices.iosBootInstrumentation().run(request, boot),
  });
}
