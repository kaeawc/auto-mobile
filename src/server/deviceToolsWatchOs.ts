import { bindBootedSimulatorSession } from "./deviceToolsSimulatorSession";
import { z } from "zod/v4";
import { describeDevice, projectBootedDevice } from "../daemon/deviceDescription";
import {
  getDeviceToolsDependencies,
  initializedDevicePool,
  mergeLegacyStartDevicePayload,
  reserveStableDeviceLifecycle,
  watchStartDeviceSchema,
  type DeviceToolsDependencies,
  type WatchStartDeviceArgs,
  type WatchStartDeviceRequest,
} from "../features/deviceLifecycle/deviceLifecycleCore";
import { bootAdmissionServices } from "../devices/bootAdmissionServices";
import { ActionableError } from "../models";
import { combineAbortSignals, runWithAbortSignal } from "../utils/AbortContext";
import { DEFAULT_START_DEVICE_TIMEOUT_MS } from "../utils/deviceTimeouts";
import { SimCtlClient } from "../utils/ios-cmdline-tools/SimCtlClient";
import {
  WatchSimulatorInventory,
  type WatchSimulatorSimctl,
} from "../utils/ios-cmdline-tools/WatchSimulatorInventory";
import {
  WatchSimulatorLifecycle,
  type ListedWatch,
  type WatchLifecycleSimctl,
  type WatchBootResult,
} from "../utils/ios-cmdline-tools/WatchSimulatorLifecycle";
import { createStructuredToolResponse } from "../utils/toolUtils";
import { runWithAcquisitionDeadline } from "./deviceToolsAcquisition";
import type { bindBootedDeviceSession } from "./deviceToolsStartDevice";
import { stripInternalToolParams } from "./internalToolParams";
import {
  getWatchRunnerLifecycle,
  type WatchRunnerLifecycle,
} from "../features/watch/WatchRunnerLifecycle";
import { logger } from "../utils/logger";
import { errorMessage } from "../utils/describeUnknownError";

/** startDevice's session binder, passed in so this module does not import its file at runtime. */
export type BindBootedSession = typeof bindBootedDeviceSession;

/** Whether a startDevice request names an Apple Watch simulator (top-level or legacy `device`). */
export function isWatchStartRequest(rawArgs: object): rawArgs is WatchStartDeviceRequest {
  const merged = mergeLegacyStartDevicePayload(rawArgs);
  return !!merged && typeof merged === "object" && Reflect.get(merged, "platform") === "watchos";
}

/**
 * startDevice for an Apple Watch simulator (#14908): resolve the exact watch, boot it (or adopt it
 * already booted) under its stable lifecycle lease, then prepare its watch runner before binding
 * a session at readiness `booted` and attaching runner ownership to it;
 * unavailable automation leaves the booted session usable for screenshot-only observation.
 */
export async function startWatchDevice(
  rawArgs: object,
  bindSession: BindBootedSession,
  signal?: AbortSignal,
) {
  const args = parseWatchStartArgs(rawArgs);
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
          const lifecycle = (deps.watchSimulatorLifecycleFactory ?? defaultWatchLifecycle)();
          stage.current = "resolving the Apple Watch simulator";
          const watch = await lifecycle.findWatch(
            { deviceId: args.deviceId, name: args.name },
            requestSignal,
          );
          stage.current = "waiting for the device lifecycle lease";
          const lease = await reserveWatchLifecycle(watch, deps, deadlineMs, requestSignal);
          let stopLaunchedRunner: (() => void) | undefined;
          let completed = false;
          try {
            const lifecycleSignal =
              combineAbortSignals(requestSignal, lease.signal) ?? lease.signal;
            stage.current = "booting the Apple Watch simulator";
            const boot = await lifecycle.boot(watch, {
              timeoutMs: Math.max(1, deadlineMs - deps.timer.now()),
            });
            stage.current = "starting the Apple Watch automation runner";
            let runnerUnavailable: string | undefined;
            let runner: Pick<WatchRunnerLifecycle, "start" | "attach" | "stop"> | undefined;
            const sessions = deps.daemonState.isInitialized()
              ? deps.daemonState.getSessionManager()
              : undefined;
            try {
              if (!sessions) {
                throw new ActionableError(
                  "Watch runner ownership requires a daemon-managed session; start the daemon and retry startDevice.",
                );
              }
              runner = (deps.watchRunnerLifecycleFactory ?? getWatchRunnerLifecycle)();
              const started = await runner.start({
                deviceId: watch.deviceId,
                sessions,
                signal: lifecycleSignal,
              });
              runnerUnavailable = started.runnerUnavailable;
              stopLaunchedRunner = started.stop;
            } catch (error) {
              runnerUnavailable = errorMessage(error);
              logger.warn(
                `[WatchRunner] Runner unavailable for ${watch.deviceId}: ${runnerUnavailable}`,
                error,
              );
            }
            lifecycleSignal.throwIfAborted();
            stage.current = "binding the device session";
            const sessionId = await bindWatchSession(
              { watch, boot, rawArgs, operation: "startDevice" },
              bindSession,
              deps.timer,
              { deadlineMs, signal: lifecycleSignal },
            );
            if (runner && sessions) {
              runnerUnavailable =
                runner.attach({ deviceId: watch.deviceId, ownerSession: sessionId, sessions }) ??
                runnerUnavailable;
            }
            lifecycleSignal.throwIfAborted();
            const response = watchStartResponse(watch, boot, sessionId, {
              elapsedMs: deps.timer.now() - startedAtMs,
              runnerUnavailable,
            });
            completed = true;
            return response;
          } finally {
            if (!completed) {
              stopLaunchedRunner?.();
            }
            lease.release();
          }
        }),
    },
  );
}

/**
 * The bind as a deadline-bound operation on the request's acquisition receipt, like the ordinary
 * start path: a request cancelled or timed out once the bind minted a session never delivers that
 * session's UUID, so the session it minted (and its claim) is released again (#11565).
 */
export async function bindWatchSession(
  args: { watch: ListedWatch; boot: WatchBootResult; rawArgs: object; operation: string },
  bindSession: BindBootedSession,
  timer: DeviceToolsDependencies["timer"],
  options: { deadlineMs: number; signal: AbortSignal },
): Promise<string> {
  return await bindBootedSimulatorSession(
    { ...args, device: args.watch },
    bindSession,
    timer,
    options,
  );
}

async function reserveWatchLifecycle(
  watch: ListedWatch,
  deps: DeviceToolsDependencies,
  deadlineMs: number,
  signal: AbortSignal,
) {
  return await reserveStableDeviceLifecycle(
    { platform: "watchos", stableId: watch.deviceId },
    { name: watch.name, platform: "watchos", deviceId: watch.deviceId },
    deps.timer,
    {
      deadlineMs,
      requestAbortSignal: signal,
      operation: "start",
      coordinator: deps.lifecycleCoordinator,
    },
  );
}

function watchStartResponse(
  watch: ListedWatch,
  boot: WatchBootResult,
  sessionId: string,
  { elapsedMs, runnerUnavailable }: { elapsedMs: number; runnerUnavailable?: string },
) {
  const description = describeDevice({
    kind: "booted",
    device: boot.device,
    pooled: initializedDevicePool()?.getDevice(watch.deviceId) ?? undefined,
    discovery: watch,
    session: { sessionId },
  });
  const how = boot.acquisition === "cold-boot" ? "started by this call" : "already booted";
  return createStructuredToolResponse({
    message:
      `watchos '${boot.device.name}' is booted (${how})` +
      (runnerUnavailable ? `; watch runner unavailable: ${runnerUnavailable}` : ""),
    ...projectBootedDevice(description),
    isReady: true,
    acquisition: boot.acquisition,
    readiness: {
      level: "booted",
      checks: ["bootCompleted", "sessionBound"],
      elapsedMs: Math.max(0, elapsedMs),
    },
  });
}

/** Strict watch parse: every Android/iOS-only startDevice option is named in the refusal. */
function parseWatchStartArgs(rawArgs: object): WatchStartDeviceArgs {
  const parsed = watchStartDeviceSchema.safeParse(stripInternalToolParams(rawArgs));
  if (parsed.success) {
    return parsed.data;
  }
  const unsupported = parsed.error.issues.flatMap((issue) =>
    issue.code === "unrecognized_keys" ? issue.keys : [],
  );
  if (unsupported.length > 0) {
    throw new ActionableError(
      "startDevice for watchOS accepts only deviceId, name and timeoutMs; " +
        `unsupported option(s): ${unsupported.join(", ")}.`,
    );
  }
  throw new ActionableError(
    `Invalid watchOS startDevice request: ${z.prettifyError(parsed.error)}`,
  );
}

export function defaultWatchLifecycle(): WatchSimulatorLifecycle {
  return watchLifecycleOver(new SimCtlClient());
}

/** The watch lifecycle over `simctl`; a cold watch boot is admitted like an iPhone boot. */
export function watchLifecycleOver(
  simctl: WatchLifecycleSimctl & WatchSimulatorSimctl,
): WatchSimulatorLifecycle {
  return new WatchSimulatorLifecycle(simctl, new WatchSimulatorInventory(simctl), {
    run: (request, boot) => bootAdmissionServices.iosBootInstrumentation().run(request, boot),
  });
}
