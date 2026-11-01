import { cleanupSessionProfiling } from "../features/profiling/profilingCleanup";
import type { ProfilingRegistry } from "../features/profiling/ProfilingRegistry";
import type { PerfettoAdb } from "../features/performanceTrace/perfettoDevice";
import { ActionableError } from "../models/ActionableError";
import { logger } from "../utils/logger";
import type { Timer } from "../utils/SystemTimer";
import { isLiveOn, type PowerSessionView, type SessionPowerHost } from "./sessionPower";

/** What a session-tracked recorder start needs besides the session host. */
export interface TrackedTraceStartDeps {
  host: SessionPowerHost<PowerSessionView> | undefined;
  registry: ProfilingRegistry;
  adb: PerfettoAdb;
  timer: Pick<Timer, "sleep">;
}

/**
 * Run a `captureTrace` start as admitted session setup (the power mutation wrapper's pattern,
 * #14084): release drains tracked setup before its cleanup looks for the recorder, so the
 * recorder is registered by the time cleanup runs. A start that finishes after the session was
 * released or rebound anyway (the drain is bounded) is stopped and its device file removed
 * instead of being left registered to an ended session. Sessionless calls run untracked.
 */
export async function runTrackedTraceStart<T extends { traceId: string }>(
  deps: TrackedTraceStartDeps,
  sessionUuid: string | undefined,
  deviceId: string,
  start: () => Promise<T>,
): Promise<T> {
  const { host } = deps;
  if (!host || !sessionUuid) {
    return start();
  }
  const session = host.getSession(sessionUuid);
  if (!session || !isLiveOn(host, sessionUuid, session, deviceId)) {
    throw new ActionableError(
      "Cannot start a trace: session is released, releasing, rebound, or replaced.",
    );
  }
  let result: T | undefined;
  await host.trackSessionSetup(session, async () => {
    result = await start();
  });
  if (result === undefined) {
    throw new ActionableError(
      "Session began releasing or rebinding before the trace started; nothing was recorded.",
    );
  }
  if (!isLiveOn(host, sessionUuid, session, deviceId)) {
    logger.warn(
      `[profiling] Session ${session.sessionId} ended while starting trace ${result.traceId} on ${deviceId}; stopping it`,
    );
    const orphaned = deps.registry.takeOwnedBy(deviceId, session.sessionId);
    const teardown = cleanupSessionProfiling(deviceId, orphaned, deps.adb, { timer: deps.timer });
    // Release may already have finished: the next session must not acquire the device while the
    // old recorder is still being stopped (the power restore wrapper's pattern).
    host.registerPendingDeviceCleanup(deviceId, teardown, {
      name: "stop released session's trace recorder and remove its file",
      leftover: "a perfetto recorder the released session started",
    });
    await teardown;
    throw new ActionableError(
      "The session ended while the trace was starting; the recorder was stopped and its file removed.",
    );
  }
  return result;
}
