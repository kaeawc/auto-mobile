import { requestAcquisitionReceipt } from "../daemon/acquisitionReceipt";
import {
  currentAutolockMcpSessionId,
  currentOneShotCli,
} from "../features/toolSelection/toolSelectionContext";
import { holderOf } from "../daemon/deviceBinding";
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
import { runWithAbortSignal } from "../utils/AbortContext";
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
import { createStructuredToolResponse } from "../utils/toolUtils";
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
              return headsetProvisionResponse(args, headset, created, undefined);
            }
            const booted = await bootAndBind(
              { rawArgs, headset, created, lease, discardCreated, bindSession },
              deps,
              deadlineMs,
              { signal: requestSignal, stage },
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
    const reusableSessionId = currentOneShotCli()
      ? undefined
      : initializedDevicePool()?.resolveOwnedDeviceSessionForMcpSession(
          currentAutolockMcpSessionId(),
          headset.deviceId,
        );
    assertVisionUnclaimed(headset.deviceId, deps, lease, reusableSessionId);
    stage.current = "booting the Apple Vision Pro simulator";
    const lifecycle = (deps.appleVisionSimulatorBootFactory ?? defaultAppleVisionBoot)();
    const boot = await lifecycle.boot(headset, {
      timeoutMs: Math.max(1, deadlineMs - deps.timer.now()),
    });
    stage.current = "binding the device session";
    const sessionId = await bindBootedSimulatorSession(
      { device: headset, boot, rawArgs, operation: "provisionDevice" },
      bindSession,
      deps.timer,
      { deadlineMs, signal },
    );
    return { boot, sessionId };
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
    return await provisioner.discardCreated(headset);
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
