import {
  getTvosRunnerLifecycle,
  type TvosRunnerLifecycle,
} from "../features/tvos/TvosRunnerLifecycle";
import { logger } from "../utils/logger";
import { errorMessage } from "../utils/describeUnknownError";
import { ActionableError } from "../models";
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
import { assertTvUnclaimed, defaultAppleTvBoot } from "./deviceToolsAppleTvProvision";
import type { BindBootedSession } from "./deviceToolsWatchOs";
import {
  internalMcpSessionId,
  internalOneShotCli,
  stripInternalToolParams,
} from "./internalToolParams";
import { z } from "zod/v4";

// The registered shape already advertises tvOS; only exact simulator selectors apply here.
const parameters = watchStartDeviceParametersSchema
  .omit({ enableTools: true })
  .extend({ platform: z.literal("tvos") });

export function isAppleTvStartRequest(rawArgs: object): boolean {
  const merged = mergeLegacyStartDevicePayload(rawArgs);
  return !!merged && typeof merged === "object" && Reflect.get(merged, "platform") === "tvos";
}

/** Boot an existing TV and bind at booted readiness, without iOS automation preparation. */
export async function startAppleTvDevice(
  rawArgs: object,
  bindSession: BindBootedSession,
  signal?: AbortSignal,
) {
  const merged = mergeLegacyStartDevicePayload(stripInternalToolParams(rawArgs));
  const input = { ...(merged as Record<string, unknown>) };
  delete input.device;
  const parsed = parameters.safeParse(stripInternalToolParams(input));
  if (!parsed.success) {
    throw new ActionableError(`Invalid tvOS startDevice request: ${z.prettifyError(parsed.error)}`);
  }
  const args = parsed.data;
  if (!args.deviceId && !args.name) {
    throw new ActionableError("A tvOS startDevice request needs deviceId or name");
  }
  const deps = getDeviceToolsDependencies();
  const startedAtMs = deps.timer.now();
  return await runWithAcquisitionDeadline(
    rawArgs,
    startedAtMs + (args.timeoutMs ?? DEFAULT_START_DEVICE_TIMEOUT_MS),
    signal,
    {
      operationName: "startDevice",
      operation: async (deadlineMs, requestSignal, stage) =>
        await runWithAbortSignal(requestSignal, async () => {
          const find = async (signal: AbortSignal) => {
            signal.throwIfAborted();
            stage.current = "resolving the Apple TV simulator";
            const matches = (
              await deps.deviceManagerFactory().listDeviceImages("tvos", signal)
            ).filter(
              (tv) =>
                tv.platform === "tvos" &&
                tv.deviceId &&
                (!args.deviceId || tv.deviceId === args.deviceId) &&
                (!args.name || tv.name === args.name),
            );
            const tv = matches[0];
            if (matches.length !== 1 || !tv?.deviceId) {
              throw new ActionableError(
                "Apple TV simulator not found or ambiguous; use an exact deviceId",
              );
            }
            return { ...tv, deviceId: tv.deviceId };
          };
          const tv = await find(requestSignal);
          const lease = await reserveStableDeviceLifecycle(
            { platform: "tvos", stableId: tv.deviceId },
            { platform: "tvos", name: tv.name, deviceId: tv.deviceId },
            deps.timer,
            {
              deadlineMs,
              requestAbortSignal: requestSignal,
              operation: "start",
              coordinator: deps.lifecycleCoordinator,
            },
          );
          let stopLaunchedRunner: (() => void) | undefined;
          let completed = false;
          try {
            const lifecycleSignal =
              combineAbortSignals(requestSignal, lease.signal) ?? lease.signal;
            // A shutdown may have completed while this request waited for the lease.
            const fresh = await find(lifecycleSignal);
            if (fresh.deviceId !== tv.deviceId) {
              throw new ActionableError("Apple TV simulator identity changed; retry with deviceId");
            }
            const reusableSessionId = internalOneShotCli(rawArgs)
              ? reusableAnonymousSessionId(tv.deviceId, deps)
              : initializedDevicePool()?.resolveOwnedDeviceSessionForMcpSession(
                  internalMcpSessionId(rawArgs),
                  tv.deviceId,
                );
            assertTvUnclaimed(tv.deviceId, deps, lease, reusableSessionId);
            lifecycleSignal.throwIfAborted();
            stage.current = "booting the Apple TV simulator";
            const boot = await (deps.appleTvSimulatorBootFactory ?? defaultAppleTvBoot)().boot(
              fresh,
              {
                timeoutMs: Math.max(1, deadlineMs - deps.timer.now()),
                signal: lifecycleSignal,
              },
            );
            lifecycleSignal.throwIfAborted();
            stage.current = "starting the Apple TV automation runner";
            let runnerUnavailable: string | undefined;
            let runner: Pick<TvosRunnerLifecycle, "start" | "attach" | "stop"> | undefined;
            const sessions = deps.daemonState.isInitialized()
              ? deps.daemonState.getSessionManager()
              : undefined;
            try {
              if (!sessions)
                throw new ActionableError(
                  "tvOS runner ownership requires a daemon-managed session; start the daemon and retry startDevice.",
                );
              runner = (deps.tvosRunnerLifecycleFactory ?? getTvosRunnerLifecycle)();
              const started = await runner.start({
                deviceId: tv.deviceId,
                sessions,
                signal: lifecycleSignal,
              });
              runnerUnavailable = started.runnerUnavailable;
              stopLaunchedRunner = started.stop;
            } catch (error) {
              runnerUnavailable = errorMessage(error);
              logger.warn(
                `[TvosRunner] Runner unavailable for ${tv.deviceId}: ${runnerUnavailable}`,
                error,
              );
            }
            lifecycleSignal.throwIfAborted();
            stage.current = "binding the device session";
            const sessionId = await bindBootedSimulatorSession(
              { device: fresh, boot, rawArgs, operation: "startDevice" },
              bindSession,
              deps.timer,
              { deadlineMs, signal: lifecycleSignal },
            );
            if (runner && sessions) {
              const attachError = runner.attach({
                deviceId: tv.deviceId,
                ownerSession: sessionId,
                sessions,
              });
              if (attachError)
                throw new ActionableError(
                  "The tvOS session ended before runner startup; retry startDevice.",
                );
            }
            lifecycleSignal.throwIfAborted();
            completed = true;
            return createStructuredToolResponse({
              message:
                `tvos '${boot.device.name}' is booted` +
                (runnerUnavailable ? `; tvOS runner unavailable: ${runnerUnavailable}` : ""),
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
            if (!completed) stopLaunchedRunner?.();
            lease.release();
          }
        }),
    },
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
