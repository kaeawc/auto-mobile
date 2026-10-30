import { describeDevice, projectProvisionedDevice } from "../daemon/deviceDescription";
import {
  getDeviceToolsDependencies,
  initializedDevicePool,
  provisionDeviceRegistrationSchema,
  type DeviceToolsDependencies,
  type WatchProvisionDeviceRequest,
} from "../features/deviceLifecycle/deviceLifecycleCore";
import { ActionableError, toActionableError } from "../models";
import { runWithAbortSignal } from "../utils/AbortContext";
import { DEFAULT_PROVISION_DEVICE_TIMEOUT_MS } from "../utils/deviceTimeouts";
import { SimCtlClient } from "../utils/ios-cmdline-tools/SimCtlClient";
import { WatchSimulatorInventory } from "../utils/ios-cmdline-tools/WatchSimulatorInventory";
import type {
  ListedWatch,
  WatchBootResult,
} from "../utils/ios-cmdline-tools/WatchSimulatorLifecycle";
import {
  WatchSimulatorProvisioner,
  type WatchProvisionRequest,
} from "../utils/ios-cmdline-tools/WatchSimulatorProvisioner";
import { createStructuredToolResponse } from "../utils/toolUtils";
import { runWithAcquisitionDeadline } from "./deviceToolsAcquisition";
import {
  bindWatchSession,
  defaultWatchLifecycle,
  type BindBootedSession,
} from "./deviceToolsWatchOs";
import { formatToolParamError } from "./toolParamError";
import { stripInternalToolParams } from "./internalToolParams";

type WatchProvisioner = ReturnType<
  NonNullable<DeviceToolsDependencies["watchSimulatorProvisionerFactory"]>
>;

/** Whether a provisionDevice request names an Apple Watch simulator. */
export function isWatchProvisionRequest(rawArgs: object): boolean {
  return Reflect.get(Reflect.get(rawArgs, "device") ?? {}, "platform") === "watchos";
}

/**
 * provisionDevice for an Apple Watch simulator (#15882). Under a lifecycle lease on the requested
 * name (rebound to the watch's UDID once resolved), adopt the exact watch or create it with
 * `simctl create`; with `boot` (the default) boot it and bind a session at readiness `booted`, as
 * startDevice does. A watch this call created is deleted again if its boot or bind fails. No
 * resources, tool grants or automation runner apply to a watch.
 */
export async function provisionWatchDevice(
  rawArgs: object,
  bindSession: BindBootedSession,
  signal?: AbortSignal,
) {
  const args = parseWatchProvisionArgs(rawArgs);
  const deps = getDeviceToolsDependencies();
  const startedAtMs = deps.timer.now();
  const request: WatchProvisionRequest = {
    name: args.device.name,
    ...(args.device.deviceId ? { deviceId: args.device.deviceId } : {}),
    spec: args.device.spec,
  };
  return await runWithAcquisitionDeadline(
    rawArgs,
    startedAtMs + (args.timeoutMs ?? DEFAULT_PROVISION_DEVICE_TIMEOUT_MS),
    signal,
    "provisionDevice",
    async (deadlineMs, requestSignal, stage) =>
      await runWithAbortSignal(requestSignal, async () => {
        stage.current = "waiting for the device lifecycle lease";
        const lease = await deps.lifecycleCoordinator.reserve(
          { kind: "selector", platform: "watchos", selector: request.deviceId ?? request.name },
          { operation: "provision", deadlineMs, signal: requestSignal },
        );
        try {
          stage.current = "resolving or creating the Apple Watch simulator";
          const provisioner = (deps.watchSimulatorProvisionerFactory ?? defaultWatchProvisioner)();
          const { watch, created } = await provisioner.provision(request, {
            // provisionDevice is an explicit creation request, as on Android and iOS.
            allowCreate: deps.deviceCreationGateFactory().isCreationAllowed(true),
            signal: requestSignal,
          });
          await lease.bindCanonicalIdentity(
            { platform: "watchos", stableId: watch.deviceId },
            async () => ({
              platform: "watchos",
              stableId: (
                await provisioner.provision(request, { allowCreate: false, signal: requestSignal })
              ).watch.deviceId,
            }),
          );
          if (args.boot === false) {
            return watchProvisionResponse(args, watch, created, undefined);
          }
          const booted = await bootAndBind(
            { args, watch, created, provisioner, bindSession },
            deps,
            deadlineMs,
            requestSignal,
            stage,
          );
          return watchProvisionResponse(args, watch, created, booted);
        } finally {
          lease.release();
        }
      }),
  );
}

async function bootAndBind(
  {
    args,
    watch,
    created,
    provisioner,
    bindSession,
  }: {
    args: WatchProvisionDeviceRequest;
    watch: ListedWatch;
    created: boolean;
    provisioner: WatchProvisioner;
    bindSession: BindBootedSession;
  },
  deps: DeviceToolsDependencies,
  deadlineMs: number,
  signal: AbortSignal,
  stage: { current: string },
): Promise<{ boot: WatchBootResult; sessionId: string }> {
  try {
    stage.current = "booting the Apple Watch simulator";
    const lifecycle = (deps.watchSimulatorLifecycleFactory ?? defaultWatchLifecycle)();
    const boot = await lifecycle.boot(watch, {
      timeoutMs: Math.max(1, deadlineMs - deps.timer.now()),
    });
    stage.current = "binding the device session";
    const sessionId = await bindWatchSession(
      { watch, boot, rawArgs: args, operation: "provisionDevice" },
      bindSession,
      deps.timer,
      deadlineMs,
      signal,
    );
    return { boot, sessionId };
  } catch (error) {
    if (!created) {
      throw error;
    }
    const discarded = await provisioner.discardCreated(watch);
    throw toActionableError(
      error,
      `provisionDevice created Apple Watch simulator ${watch.deviceId} but could not start it; ` +
        (discarded.deleted
          ? "the watch was deleted again"
          : `deleting it again failed (${discarded.error}); delete it with deleteDevice`),
    );
  }
}

function watchProvisionResponse(
  args: WatchProvisionDeviceRequest,
  watch: ListedWatch,
  created: boolean,
  booted: { boot: WatchBootResult; sessionId: string } | undefined,
) {
  const resolvedSpec = { ...args.device.spec, displayCutout: "unknown" as const };
  const description = describeDevice({
    kind: "provisioned",
    provisioned: { device: watch, created, resolvedSpec },
    booted: booted?.boot.device,
    pooled: booted ? (initializedDevicePool()?.getDevice(watch.deviceId) ?? undefined) : undefined,
    discovery: watch,
    session: booted ? { sessionId: booted.sessionId } : undefined,
  });
  const lifecycleState = booted ? "ready" : created ? "created" : "adopted";
  return createStructuredToolResponse({
    message: `watchos '${watch.name}' provisioned (${lifecycleState})`,
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

function parseWatchProvisionArgs(rawArgs: object): WatchProvisionDeviceRequest {
  const input = stripInternalToolParams(rawArgs);
  const parsed = provisionDeviceRegistrationSchema.safeParse(input);
  if (parsed.success) {
    if (parsed.data.device.platform !== "watchos") {
      throw new ActionableError("provisionDevice: the watchOS path received a non-watch request.");
    }
    return parsed.data as WatchProvisionDeviceRequest;
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

function defaultWatchProvisioner(): WatchSimulatorProvisioner {
  const simctl = new SimCtlClient();
  return new WatchSimulatorProvisioner(new WatchSimulatorInventory(simctl), simctl);
}
