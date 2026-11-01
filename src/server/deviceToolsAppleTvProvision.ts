import { requestAcquisitionReceipt } from "../daemon/acquisitionReceipt";
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
  type AppleTvProvisionDeviceRequest,
} from "../features/deviceLifecycle/deviceLifecycleCore";
import { ActionableError, toActionableError } from "../models";
import { runWithAbortSignal } from "../utils/AbortContext";
import { DEFAULT_PROVISION_DEVICE_TIMEOUT_MS } from "../utils/deviceTimeouts";
import { SimCtlClient } from "../utils/ios-cmdline-tools/SimCtlClient";
import { AppleTvSimulatorInventory } from "../utils/ios-cmdline-tools/AppleTvSimulatorInventory";
import {
  AppleTvSimulatorBoot,
  type ListedAppleTv,
  type AppleTvBootResult,
} from "../utils/ios-cmdline-tools/AppleTvSimulatorBoot";
import {
  AppleTvSimulatorProvisioner,
  type AppleTvProvisionRequest,
  type AppleTvDiscardResult,
} from "../utils/ios-cmdline-tools/AppleTvSimulatorProvisioner";
import { createStructuredToolResponse } from "../utils/toolUtils";
import { runWithAcquisitionDeadline } from "./deviceToolsAcquisition";
import { bindBootedSimulatorSession } from "./deviceToolsSimulatorSession";
import type { BindBootedSession } from "./deviceToolsWatchOs";
import { bootAdmissionServices } from "../devices/bootAdmissionServices";
import { formatToolParamError } from "./toolParamError";
import {
  internalMcpSessionId,
  internalOneShotCli,
  stripInternalToolParams,
} from "./internalToolParams";

type AppleTvProvisioner = ReturnType<
  NonNullable<DeviceToolsDependencies["appleTvSimulatorProvisionerFactory"]>
>;

/** Whether a provisionDevice request names an Apple TV simulator. */
export function isAppleTvProvisionRequest(rawArgs: object): boolean {
  return Reflect.get(Reflect.get(rawArgs, "device") ?? {}, "platform") === "tvos";
}

/**
 * provisionDevice for an Apple TV simulator (#15889). Under a lifecycle lease on the requested
 * name (rebound to the TV's UDID once resolved), adopt the exact TV or create it with
 * `simctl create`; with `boot` (the default) boot it and bind a session at readiness `booted`, as
 * startDevice does. A TV this call created is deleted again if its boot or bind fails. No
 * resources, tool grants or automation runner apply to a TV.
 */
export async function provisionAppleTvDevice(
  rawArgs: object,
  bindSession: BindBootedSession,
  signal?: AbortSignal,
) {
  const args = parseAppleTvProvisionArgs(rawArgs);
  const deps = getDeviceToolsDependencies();
  const startedAtMs = deps.timer.now();
  const request: AppleTvProvisionRequest = {
    name: args.device.name,
    ...(args.device.deviceId ? { deviceId: args.device.deviceId } : {}),
    spec: args.device.spec,
  };
  return await runWithAcquisitionDeadline(
    rawArgs,
    startedAtMs + (args.timeoutMs ?? DEFAULT_PROVISION_DEVICE_TIMEOUT_MS),
    signal,
    {
      operationName: "provisionDevice",
      operation: async (deadlineMs, requestSignal, stage) =>
        await runWithAbortSignal(requestSignal, async () => {
          stage.current = "waiting for the device lifecycle lease";
          const lease = await deps.lifecycleCoordinator.reserve(
            { kind: "selector", platform: "tvos", selector: request.deviceId ?? request.name },
            { operation: "provision", deadlineMs, signal: requestSignal },
          );
          let leaseReleased = false;
          try {
            stage.current = "resolving or creating the Apple TV simulator";
            const provisioner = (
              deps.appleTvSimulatorProvisionerFactory ?? defaultAppleTvProvisioner
            )();
            let resolved = await provisioner.provision(request, {
              // provisionDevice is an explicit creation request, as on Android and iOS.
              allowCreate: deps.deviceCreationGateFactory().isCreationAllowed(true),
              signal: requestSignal,
              discardUnconfirmed: (tv) => discardUnclaimedCreatedTv(tv, provisioner, deps, lease),
            });
            const createdTv = resolved.tv;
            let cleanupNeeded = resolved.created;
            const discardCreated = async (): Promise<AppleTvDiscardResult> => {
              if (!cleanupNeeded) {
                return { deleted: true };
              }
              const result = await discardUnclaimedCreatedTv(
                createdTv,
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
                      `Could not undo created Apple TV simulator ${createdTv.deviceId}: ${discarded.error}; delete it with deleteDevice`,
                    );
                  }
                },
              };
            }
            try {
              await lease.bindCanonicalIdentity(
                { platform: "tvos", stableId: resolved.tv.deviceId },
                // After waiting on another lifecycle (a shutdown, say) the TV is read again, and
                // that fresh snapshot is the one booted below.
                async () => {
                  const again = await provisioner.provision(request, {
                    allowCreate: false,
                    signal: requestSignal,
                  });
                  resolved = { tv: again.tv, created: resolved.created };
                  return { platform: "tvos", stableId: again.tv.deviceId };
                },
              );
            } catch (error) {
              const discarded = resolved.created ? await discardCreated() : undefined;
              throw new ActionableError(
                `Could not bind Apple TV simulator ${createdTv.deviceId} to its lifecycle` +
                  (discarded ? `; ${discardMessage(discarded)}` : "") +
                  `: ${errorMessage(error)}`,
                { cause: error },
              );
            }
            const { tv, created } = resolved;
            if (args.boot === false) {
              return tvProvisionResponse(args, tv, created, undefined);
            }
            const booted = await bootAndBind(
              { rawArgs, tv, created, lease, discardCreated, bindSession },
              deps,
              deadlineMs,
              { signal: requestSignal, stage },
            );
            return tvProvisionResponse(args, tv, created, booted);
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
    tv,
    created,
    lease,
    discardCreated,
    bindSession,
  }: {
    /** The request as received: the binder reads the caller's connection from its internal params. */
    rawArgs: object;
    tv: ListedAppleTv;
    created: boolean;
    lease: VirtualDeviceLifecycleLease;
    discardCreated: () => Promise<AppleTvDiscardResult>;
    bindSession: BindBootedSession;
  },
  deps: DeviceToolsDependencies,
  deadlineMs: number,
  { signal, stage }: { signal: AbortSignal; stage: { current: string } },
): Promise<{ boot: AppleTvBootResult; sessionId: string }> {
  try {
    const reusableSessionId = internalOneShotCli(rawArgs)
      ? undefined
      : initializedDevicePool()?.resolveOwnedDeviceSessionForMcpSession(
          internalMcpSessionId(rawArgs),
          tv.deviceId,
        );
    assertTvUnclaimed(tv.deviceId, deps, lease, reusableSessionId);
    stage.current = "booting the Apple TV simulator";
    const lifecycle = (deps.appleTvSimulatorBootFactory ?? defaultAppleTvBoot)();
    const boot = await lifecycle.boot(tv, {
      timeoutMs: Math.max(1, deadlineMs - deps.timer.now()),
    });
    stage.current = "binding the device session";
    const sessionId = await bindBootedSimulatorSession(
      { device: tv, boot, rawArgs, operation: "provisionDevice" },
      bindSession,
      deps.timer,
      { deadlineMs, signal },
    );
    return { boot, sessionId };
  } catch (error) {
    if (!created) {
      throw toActionableError(error, `Could not start Apple TV simulator ${tv.deviceId}`);
    }
    const discarded = await discardCreated();
    throw new ActionableError(
      `provisionDevice created Apple TV simulator ${tv.deviceId} but could not start it; ` +
        `${discardMessage(discarded)}: ${errorMessage(error)}`,
      { cause: error },
    );
  }
}

/** The canonical lease owns the UDID; only boot may reuse the caller's own pool holder. */
function assertTvUnclaimed(
  udid: string,
  deps: DeviceToolsDependencies,
  lease?: VirtualDeviceLifecycleLease,
  reusableSessionId?: string,
): void {
  const held = holderOf(initializedDevicePool()?.getDevice(udid));
  const ownsIdentity =
    lease?.identity.kind === "stable" &&
    lease.identity.platform === "tvos" &&
    lease.identity.stableId === udid;
  if (
    (held && held !== reusableSessionId) ||
    (!ownsIdentity &&
      deps.lifecycleCoordinator.isReserved({
        kind: "stable",
        platform: "tvos",
        stableId: udid,
      }))
  ) {
    throw new ActionableError(
      `Apple TV simulator ${udid} is held by ${held ? `session ${held}` : "another lifecycle"}; retry after it is released`,
    );
  }
}

/** Cleanup requires an unclaimed pool entry and the canonical lifecycle lease. */
async function discardUnclaimedCreatedTv(
  tv: Pick<ListedAppleTv, "deviceId">,
  provisioner: AppleTvProvisioner,
  deps: DeviceToolsDependencies,
  lease?: VirtualDeviceLifecycleLease,
): Promise<AppleTvDiscardResult> {
  let cleanupLease: VirtualDeviceLifecycleLease | undefined;
  try {
    assertTvUnclaimed(tv.deviceId, deps, lease);
    if (lease?.identity.kind !== "stable" || lease.identity.stableId !== tv.deviceId) {
      cleanupLease = await deps.lifecycleCoordinator.reserve(
        { kind: "stable", platform: "tvos", stableId: tv.deviceId },
        { operation: "start", deadlineMs: deps.timer.now() + 30_000 },
      );
    }
    assertTvUnclaimed(tv.deviceId, deps, cleanupLease ?? lease);
    return await provisioner.discardCreated(tv);
  } catch (error) {
    logger.warn(
      `[tvOS] Leaving created Apple TV simulator ${tv.deviceId}: ${errorMessage(error)}`,
      error,
    );
    return { deleted: false, error: errorMessage(error) };
  } finally {
    cleanupLease?.release();
  }
}

function discardMessage(discarded: AppleTvDiscardResult): string {
  return discarded.deleted
    ? "the TV was deleted again"
    : `deleting it again failed (${discarded.error}); delete it with deleteDevice`;
}

function tvProvisionResponse(
  args: AppleTvProvisionDeviceRequest,
  tv: ListedAppleTv,
  created: boolean,
  booted: { boot: AppleTvBootResult; sessionId: string } | undefined,
) {
  const resolvedSpec = { ...args.device.spec, displayCutout: "unknown" as const };
  const description = describeDevice({
    kind: "provisioned",
    provisioned: { device: tv, created, resolvedSpec },
    booted: booted?.boot.device,
    pooled: booted ? (initializedDevicePool()?.getDevice(tv.deviceId) ?? undefined) : undefined,
    discovery: tv,
    session: booted ? { sessionId: booted.sessionId } : undefined,
  });
  const lifecycleState = booted ? "ready" : created ? "created" : "adopted";
  return createStructuredToolResponse({
    message: `tvos '${tv.name}' provisioned (${lifecycleState})`,
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

function parseAppleTvProvisionArgs(rawArgs: object): AppleTvProvisionDeviceRequest {
  const input = stripInternalToolParams(rawArgs);
  const parsed = provisionDeviceRegistrationSchema.safeParse(input);
  if (parsed.success) {
    if (parsed.data.device.platform !== "tvos") {
      throw new ActionableError("provisionDevice: the tvOS path received a non-tv request.");
    }
    return parsed.data as AppleTvProvisionDeviceRequest;
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

function defaultAppleTvProvisioner(): AppleTvSimulatorProvisioner {
  const simctl = new SimCtlClient();
  return new AppleTvSimulatorProvisioner(new AppleTvSimulatorInventory(simctl), simctl);
}

function defaultAppleTvBoot(): AppleTvSimulatorBoot {
  return new AppleTvSimulatorBoot(new SimCtlClient(), {
    run: (request, boot) => bootAdmissionServices.iosBootInstrumentation().run(request, boot),
  });
}
