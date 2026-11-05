import {
  currentAutolockMcpSessionId,
  currentOneShotCli,
} from "../features/toolSelection/toolSelectionContext";
import { ActionableError, type DeviceInfo } from "../models";
import {
  getDeviceToolsDependencies,
  initializedDevicePool,
  mergeLegacyStartDevicePayload,
  reserveStableDeviceLifecycle,
  watchStartDeviceParametersSchema,
  type DeviceToolsDependencies,
} from "../features/deviceLifecycle/deviceLifecycleCore";
import { combineAbortSignals, runWithAbortSignal } from "../utils/AbortContext";
import { DEFAULT_START_DEVICE_TIMEOUT_MS } from "../utils/deviceTimeouts";
import { createStructuredToolResponse } from "../utils/toolUtils";
import { describeDevice, projectBootedDevice } from "../daemon/deviceDescription";
import { holderOf } from "../daemon/deviceBinding";
import { isAnonymousAcquisitionSession } from "../daemon/sessionManager";
import { runWithAcquisitionDeadline } from "./deviceToolsAcquisition";
import { bindBootedSimulatorSession } from "./deviceToolsSimulatorSession";
import { assertVisionUnclaimed, defaultAppleVisionBoot } from "./deviceToolsAppleVisionProvision";
import type { BindBootedSession } from "./deviceToolsWatchOs";
import { stripInternalToolParams } from "./internalToolParams";
import { z } from "zod/v4";

// The registered shape already advertises visionOS; only exact simulator selectors apply here.
const parameters = watchStartDeviceParametersSchema
  .omit({ enableTools: true })
  .extend({ platform: z.literal("visionos") });

export function isAppleVisionStartRequest(rawArgs: object): boolean {
  const merged = mergeLegacyStartDevicePayload(rawArgs);
  return !!merged && typeof merged === "object" && Reflect.get(merged, "platform") === "visionos";
}

/** Boot an existing headset and bind at booted readiness, without iOS automation preparation. */
export async function startAppleVisionDevice(
  rawArgs: object,
  bindSession: BindBootedSession,
  signal?: AbortSignal,
) {
  const merged = mergeLegacyStartDevicePayload(stripInternalToolParams(rawArgs));
  const input = { ...(merged as Record<string, unknown>) };
  delete input.device;
  const parsed = parameters.safeParse(stripInternalToolParams(input));
  if (!parsed.success) {
    throw new ActionableError(
      `Invalid visionOS startDevice request: ${z.prettifyError(parsed.error)}`,
    );
  }
  const args = parsed.data;
  if (!args.deviceId && !args.name) {
    throw new ActionableError("A visionOS startDevice request needs deviceId or name");
  }
  const deps = getDeviceToolsDependencies();
  const startedAtMs = deps.timer.now();
  return await runWithAcquisitionDeadline(
    startedAtMs + (args.timeoutMs ?? DEFAULT_START_DEVICE_TIMEOUT_MS),
    signal,
    {
      operationName: "startDevice",
      operation: async (deadlineMs, requestSignal, stage) =>
        await runWithAbortSignal(requestSignal, async () => {
          const find = async (signal: AbortSignal) => {
            signal.throwIfAborted();
            stage.current = "resolving the Apple Vision Pro simulator";
            const images = await deps.deviceManagerFactory().listDeviceImages("visionos", signal);
            return selectAppleVisionSimulator(images, args);
          };
          const headset = await find(requestSignal);
          const lease = await reserveStableDeviceLifecycle(
            { platform: "visionos", stableId: headset.deviceId },
            { platform: "visionos", name: headset.name, deviceId: headset.deviceId },
            deps.timer,
            {
              deadlineMs,
              requestAbortSignal: requestSignal,
              operation: "start",
              coordinator: deps.lifecycleCoordinator,
            },
          );
          try {
            const lifecycleSignal =
              combineAbortSignals(requestSignal, lease.signal) ?? lease.signal;
            // A shutdown may have completed while this request waited for the lease.
            const fresh = await find(lifecycleSignal);
            if (fresh.deviceId !== headset.deviceId) {
              throw new ActionableError(
                "Apple Vision Pro simulator identity changed; retry with deviceId",
              );
            }
            const reusableSessionId = reusableVisionSessionId(headset.deviceId, deps);
            assertVisionUnclaimed(headset.deviceId, deps, lease, reusableSessionId);
            lifecycleSignal.throwIfAborted();
            stage.current = "booting the Apple Vision Pro simulator";
            const boot = await (
              deps.appleVisionSimulatorBootFactory ?? defaultAppleVisionBoot
            )().boot(fresh, {
              timeoutMs: Math.max(1, deadlineMs - deps.timer.now()),
              signal: lifecycleSignal,
            });
            lifecycleSignal.throwIfAborted();
            stage.current = "binding the device session";
            const sessionId = await bindBootedSimulatorSession(
              { device: fresh, boot, rawArgs, operation: "startDevice" },
              bindSession,
              deps.timer,
              { deadlineMs, signal: lifecycleSignal },
            );
            lifecycleSignal.throwIfAborted();
            return createStructuredToolResponse({
              message: `visionos '${boot.device.name}' is booted`,
              ...projectBootedDevice(
                describeDevice({
                  kind: "booted",
                  device: boot.device,
                  discovery: fresh,
                  session: { sessionId },
                }),
              ),
              isReady: true,
              acquisition: boot.acquisition,
              readiness: {
                level: "booted",
                checks: ["bootCompleted", "sessionBound"],
                elapsedMs: Math.max(0, deps.timer.now() - startedAtMs),
              },
            });
          } finally {
            lease.release();
          }
        }),
    },
  );
}

function selectAppleVisionSimulator(images: DeviceInfo[], args: z.infer<typeof parameters>) {
  const matches = images.filter(
    (headset) =>
      headset.platform === "visionos" &&
      headset.deviceId &&
      (!args.deviceId || headset.deviceId === args.deviceId) &&
      (!args.name || headset.name === args.name),
  );
  const headset = matches[0];
  if (matches.length !== 1 || !headset?.deviceId) {
    throw new ActionableError(
      "Apple Vision Pro simulator not found or ambiguous; use an exact deviceId",
    );
  }
  return { ...headset, deviceId: headset.deviceId };
}

function reusableVisionSessionId(
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
