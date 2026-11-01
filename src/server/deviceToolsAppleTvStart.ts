import { ActionableError } from "../models";
import {
  getDeviceToolsDependencies,
  initializedDevicePool,
  mergeLegacyStartDevicePayload,
  reserveStableDeviceLifecycle,
  watchStartDeviceParametersSchema,
} from "../features/deviceLifecycle/deviceLifecycleCore";
import { runWithAbortSignal } from "../utils/AbortContext";
import { DEFAULT_START_DEVICE_TIMEOUT_MS } from "../utils/deviceTimeouts";
import { createStructuredToolResponse } from "../utils/toolUtils";
import { describeDevice, projectBootedDevice } from "../daemon/deviceDescription";
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
          const find = async () => {
            stage.current = "resolving the Apple TV simulator";
            const matches = (
              await deps.deviceManagerFactory().listDeviceImages("tvos", requestSignal)
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
          const tv = await find();
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
          try {
            // A shutdown may have completed while this request waited for the lease.
            const fresh = await find();
            if (fresh.deviceId !== tv.deviceId) {
              throw new ActionableError("Apple TV simulator identity changed; retry with deviceId");
            }
            const reusableSessionId = internalOneShotCli(rawArgs)
              ? undefined
              : initializedDevicePool()?.resolveOwnedDeviceSessionForMcpSession(
                  internalMcpSessionId(rawArgs),
                  tv.deviceId,
                );
            assertTvUnclaimed(tv.deviceId, deps, lease, reusableSessionId);
            stage.current = "booting the Apple TV simulator";
            const boot = await (deps.appleTvSimulatorBootFactory ?? defaultAppleTvBoot)().boot(
              fresh,
              {
                timeoutMs: Math.max(1, deadlineMs - deps.timer.now()),
                signal: requestSignal,
              },
            );
            stage.current = "binding the device session";
            const sessionId = await bindBootedSimulatorSession(
              { device: fresh, boot, rawArgs, operation: "startDevice" },
              bindSession,
              deps.timer,
              { deadlineMs, signal: requestSignal },
            );
            return createStructuredToolResponse({
              message: `tvos '${boot.device.name}' is booted`,
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
