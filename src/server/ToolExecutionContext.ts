import { SessionManager } from "../daemon/sessionManager";
import type { Session, SessionExecutionMetadata } from "../daemon/sessionManager";
import { DevicePool } from "../daemon/devicePool";
import { AndroidCtrlProxyManager } from "../utils/CtrlProxyManager";
import { NavigationGraphManager } from "../features/navigation/NavigationGraphManager";
import { ActionableError, BootedDevice, Platform } from "../models";
import { logger } from "../utils/logger";
import { KeepScreenAwakeManager, KeepScreenAwakeState } from "../utils/KeepScreenAwakeManager";
import { AndroidCtrlProxyClient } from "../features/observe/android";
import { createPerformanceTracker, type TimingData } from "../utils/PerformanceTracker";
import { type Timer, defaultTimer } from "../utils/SystemTimer";
import type { DeviceReadinessLevel } from "../utils/DeviceSessionManager";

/**
 * Storage for accessibility service setup timing.
 * Keyed by deviceId, consumed once when observe reads it.
 */
const pendingSetupTimings = new Map<string, TimingData>();

/**
 * Store setup timing for a device.
 * Called after accessibility service setup completes.
 */
export function storeSetupTiming(deviceId: string, timing: TimingData): void {
  pendingSetupTimings.set(deviceId, timing);
  logger.info(`[ToolExecutionContext] Stored setup timing for deviceId=${deviceId}`);
}

/**
 * Get and consume the setup timing for a device.
 * Returns the timing data if present and clears it from storage.
 */
export function consumeSetupTiming(deviceId: string): TimingData | null {
  const timing = pendingSetupTimings.get(deviceId);
  const availableKeys = Array.from(pendingSetupTimings.keys());
  if (timing) {
    pendingSetupTimings.delete(deviceId);
    logger.info(`[ToolExecutionContext] Consumed setup timing for deviceId=${deviceId}`);
    return timing;
  }
  if (availableKeys.length > 0) {
    logger.warn(
      `[ToolExecutionContext] No setup timing for deviceId=${deviceId}, available keys: ${availableKeys.join(", ")}`,
    );
  }
  return null;
}

/**
 * Tool Execution Context
 *
 * Provides session and device context to tools executing within the daemon.
 * Enables tools to:
 * - Access assigned device for session
 * - Update session cache after execution
 * - Share state across tool calls within same session
 */
interface ToolExecutionContext {
  sessionId?: string;
  deviceId?: string;
  devicePlatform?: Platform;
  sessionManager?: SessionManager;
  devicePool?: DevicePool;
}

export interface SessionOptions {
  keepScreenAwake?: boolean;
  platform?: Platform;
  /**
   * `booted` skips automation-only setup (accessibility-service / CtrlProxy
   * preparation) for a tool that only needs the device connected and booted.
   * `automationReady` (the default when omitted) performs full setup, matching
   * the historical unconditional behavior. Mirrors
   * {@link DeviceReadinessLevel} so both the fresh-session (legacy) and
   * persisted daemon-session paths honor a tool's declared `deviceReadiness`
   * (#6227).
   */
  deviceReadiness?: DeviceReadinessLevel;
}

/**
 * Create tool execution context from session UUID
 *
 * Ensures session exists and device is assigned if session UUID provided.
 */
export async function createToolExecutionContext(
  sessionUuid: string | undefined,
  sessionManager: SessionManager,
  devicePool: DevicePool,
  sessionOptions: SessionOptions = {},
  execution?: SessionExecutionMetadata,
  admittedSession?: Session,
  // #6069: set by the device-tool path so the getOrCreateSession fallback below
  // cannot mint a brand-new pooled session for a never-issued sessionUuid. Only a
  // live session (resolved via admittedSession / getSessionForNewExecution) or a
  // persisted, non-terminal row (restart recovery) is admissible. Internal callers
  // that intentionally mint fresh derived sessions (device labels) leave it false.
  requireIssuedSession = false,
): Promise<ToolExecutionContext> {
  if (!sessionUuid) {
    return {};
  }

  if (admittedSession && !sessionManager.isAdmittedForAutomation(admittedSession)) {
    throw new ActionableError(`Session ${sessionUuid} was released during setup`);
  }
  devicePool.assertSessionReadyForAutomation(sessionUuid);
  const existingSession =
    admittedSession ?? sessionManager.getSessionForNewExecution(sessionUuid, execution);

  // Get or create session
  const session =
    admittedSession ??
    (await sessionManager.getOrCreateSession(
      sessionUuid,
      devicePool,
      sessionOptions.platform,
      execution,
      requireIssuedSession,
    ));

  if (!sessionManager.isAdmittedForAutomation(session)) {
    throw new ActionableError(`Session ${sessionUuid} was released during setup`);
  }

  await sessionManager.trackSessionSetup(session, () =>
    setupSession(session, existingSession === session, sessionManager, sessionOptions),
  );
  ensureSessionIsCurrent(session, sessionManager);

  return {
    sessionId: sessionUuid,
    deviceId: session.assignedDevice,
    devicePlatform: session.platform,
    sessionManager,
    devicePool,
  };
}

function isReadinessSatisfied(
  achieved: DeviceReadinessLevel | undefined,
  required: DeviceReadinessLevel,
): boolean {
  // #6227 P1 follow-up: `undefined` must NOT be treated as satisfied here.
  // A recovered/newly-published session becomes visible to a concurrent
  // `getSessionForNewExecution` lookup (`this.sessions.set(...)` in
  // `persistAndPublishSession`) *before* this module's own setup path gets a
  // chance to call `setDeviceReadiness` (setup runs later, inside
  // `setupSession` -> `runDeviceReadinessSetup`, after `getOrCreateSession`
  // has already returned). A concurrent call that lands in that window would
  // see the session as "existing" with `achieved === undefined` and — if we
  // treated that as satisfied — skip CtrlProxy/accessibility-service setup
  // entirely, running automation against an unprepared device.
  //
  // Treating `undefined` as NOT satisfied closes that hole: the
  // `existingSession` branch below always runs `runDeviceReadinessSetup` for
  // a session whose readiness has never been recorded, which is safe because
  // that setup is idempotent (redundant concurrent runs are harmless, merely
  // wasteful). Callers that track a session directly (e.g.
  // `SessionManager.createSession` in tests) and want to skip this module's
  // setup must record an explicit readiness level via `setDeviceReadiness`
  // rather than relying on `undefined` meaning "already satisfied".
  if (achieved === undefined) {
    return false;
  }
  // `booted` is satisfied by either recorded level; `automationReady` needs
  // the higher level to have actually been achieved.
  return required === "booted" || achieved === "automationReady";
}

/**
 * Per-session in-flight readiness setup (#6227 P1 follow-ups: single-flight).
 *
 * A recovered/newly-published session can be observed by two concurrent
 * `automationReady` calls (e.g. reaching the daemon through different
 * queues) before either has recorded a readiness level. Without
 * serialization both calls would see the same insufficient
 * `getDeviceReadiness` result and both invoke `runDeviceReadinessSetup`,
 * which calls `AndroidCtrlProxyManager.resetSetupState()` on the *shared*
 * per-device manager — the second caller's reset can land mid-setup for the
 * first, corrupting both. Keying by session UUID and having a concurrent
 * caller await the same in-flight promise (rather than starting its own)
 * closes that race; each waiter re-checks the achieved readiness once the
 * in-flight setup settles, upgrading further only if still insufficient.
 *
 * This map is shared by BOTH the fresh-session setup path (`setupSession`'s
 * `!existingSession` branch) and the existing-session upgrade path
 * (`ensureReadinessUpgraded`). A second P1 follow-up closed a further race:
 * two post-restart calls racing for the same recovered UUID can each compute
 * `existingSession` before the session is published, then one takes the
 * fresh path and the other the existing-session path — if only the upgrade
 * path went through this map, the fresh-path call would run
 * `runDeviceReadinessSetup` directly and unguarded, concurrently with a
 * guarded upgrade for the very same session. Routing the fresh path through
 * `ensureReadinessUpgraded` too (keyed by the same `session.sessionId`)
 * ensures any concurrent caller — fresh or existing — for that session joins
 * the one in-flight setup instead of starting a second.
 */
const readinessUpgradeInFlight = new Map<string, Promise<void>>();

async function ensureReadinessUpgraded(
  session: Session,
  sessionManager: SessionManager,
  requiredReadiness: DeviceReadinessLevel,
): Promise<void> {
  for (;;) {
    if (
      isReadinessSatisfied(sessionManager.getDeviceReadiness(session.sessionId), requiredReadiness)
    ) {
      return;
    }

    const inFlight = readinessUpgradeInFlight.get(session.sessionId);
    if (inFlight) {
      // Another caller is already upgrading this session's readiness — wait
      // for it rather than racing a second `runDeviceReadinessSetup` call,
      // then loop back to re-check whether it reached the level we need.
      await inFlight;
      continue;
    }

    const setupPromise = runDeviceReadinessSetup(
      session,
      sessionManager,
      requiredReadiness,
    ).finally(() => {
      if (readinessUpgradeInFlight.get(session.sessionId) === setupPromise) {
        readinessUpgradeInFlight.delete(session.sessionId);
      }
    });
    readinessUpgradeInFlight.set(session.sessionId, setupPromise);
    await setupPromise;
    return;
  }
}

async function setupSession(
  session: Session,
  existingSession: boolean,
  sessionManager: SessionManager,
  sessionOptions: SessionOptions,
): Promise<void> {
  await ensureKeepScreenAwake(session, sessionManager, sessionOptions);
  const requiredReadiness: DeviceReadinessLevel =
    sessionOptions.deviceReadiness ?? "automationReady";

  if (existingSession) {
    // #6227: `existingSession` only means this call reused an already-tracked
    // session — it says nothing about which readiness level that session's
    // prior setup actually reached. A session first touched by a `booted`
    // tool leaves CtrlProxy/accessibility-service setup unprepared; a later
    // call on the same UUID that needs `automationReady` must run that setup
    // now rather than trusting the fast path and returning early against a
    // disconnected/unprepared device. `ensureReadinessUpgraded` serializes
    // concurrent upgrades for the same session (single-flight, #6227 P1
    // follow-up) so two racing callers can't both trigger setup.
    await ensureReadinessUpgraded(session, sessionManager, requiredReadiness);
    return;
  }

  ensureSessionIsCurrent(session, sessionManager);
  // #6227 P1 follow-up: route the fresh-session setup through the same
  // single-flight map used by the existing-session upgrade path (keyed by
  // `session.sessionId`) so a concurrent caller racing for the same
  // recovered session — whether it takes the fresh or existing-session path
  // — joins the one in-flight setup instead of starting a second.
  await ensureReadinessUpgraded(session, sessionManager, requiredReadiness);
  ensureSessionIsCurrent(session, sessionManager);

  // Start test coverage session for navigation graph tracking
  // This enables automatic tracking of screens and transitions during test execution
  const navManager = NavigationGraphManager.getInstanceForSession(session.sessionId);
  if (navManager.getCurrentAppId()) {
    ensureSessionIsCurrent(session, sessionManager);
    await navManager.startTestSession(session.sessionId);
    ensureSessionIsCurrent(session, sessionManager);
    logger.info(
      `[ToolExecutionContext] Started test coverage tracking for session ${session.sessionId}`,
    );
  }
}

/**
 * Run the automation-only setup (CtrlProxy / accessibility service) needed to
 * reach `requiredReadiness` for `session`, then record the achieved level
 * (#6227). Only android needs the extra setup for `automationReady`; every
 * other case is a no-op setup that still records the level so a later
 * `existingSession` call can compare against it.
 */
async function runDeviceReadinessSetup(
  session: Session,
  sessionManager: SessionManager,
  requiredReadiness: DeviceReadinessLevel,
): Promise<void> {
  if (session.platform === "android" && requiredReadiness !== "booted") {
    await ensureAccessibilityServiceReady(
      session.assignedDevice,
      session.sessionId,
      session.platform,
    );
  }
  ensureSessionIsCurrent(session, sessionManager);
  sessionManager.setDeviceReadiness(session.sessionId, requiredReadiness);
}

function ensureSessionIsCurrent(session: Session, sessionManager: SessionManager): void {
  if (!sessionManager.isAdmittedForAutomation(session)) {
    throw new ActionableError(`Session ${session.sessionId} was released during setup`);
  }
}

const A11Y_TRANSIENT_ERROR_PATTERNS = [
  "Operation aborted",
  "Operation cancelled",
  "Command timed out",
];

function isTransientA11yError(error: string): boolean {
  return A11Y_TRANSIENT_ERROR_PATTERNS.some((p) => error.includes(p));
}

async function ensureAccessibilityServiceReady(
  deviceId: string,
  sessionId: string,
  platform: Platform,
  timer: Timer = defaultTimer,
): Promise<void> {
  const device: BootedDevice = {
    name: deviceId,
    platform,
    deviceId,
  };
  logger.info(
    `[ToolExecutionContext] Ensuring accessibility service is ready for session ${sessionId}`,
  );

  const MAX_ATTEMPTS = 2;
  const RETRY_DELAY_MS = 3000;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const perf = createPerformanceTracker(true);
    perf.serial("ensureAccessibilityServiceReady");

    const serviceManager = AndroidCtrlProxyManager.getInstance(device);
    serviceManager.resetSetupState();
    const setupResult = await serviceManager.setup(false, perf);

    if (!setupResult.success) {
      perf.end();
      const timings = perf.getTimings();
      if (timings) {
        logger.info(`[ToolExecutionContext] Accessibility service setup failed`, {
          perfTiming: JSON.stringify(timings, null, 2),
        });
      }

      const errorMsg = setupResult.error || setupResult.message || "";
      if (attempt < MAX_ATTEMPTS && isTransientA11yError(errorMsg)) {
        logger.warn(
          `[A11yRetry] Transient failure on attempt ${attempt}/${MAX_ATTEMPTS}, retrying in ${RETRY_DELAY_MS}ms: ${errorMsg}`,
        );
        await timer.sleep(RETRY_DELAY_MS);
        continue;
      }

      throw new ActionableError(
        `Failed to setup accessibility service for device ${deviceId} (session ${sessionId}): ${errorMsg}`,
      );
    }

    if (attempt > 1) {
      logger.info(`[A11yRetry] Setup succeeded on attempt ${attempt}/${MAX_ATTEMPTS}`);
    }

    const accessibilityClient = AndroidCtrlProxyClient.getInstance(device);
    const connected = await perf.track("waitForConnection", () =>
      accessibilityClient.waitForConnection(),
    );

    perf.end();
    const timings = perf.getTimings();
    if (timings) {
      storeSetupTiming(deviceId, timings);
      logger.info(`[ToolExecutionContext] Accessibility service ready for session ${sessionId}`, {
        connected,
      });
    } else {
      logger.warn(
        `[ToolExecutionContext] No timing data captured for setup (deviceId=${deviceId})`,
      );
    }
    return;
  }
}

async function ensureKeepScreenAwake(
  session: Session,
  sessionManager: SessionManager,
  sessionOptions: SessionOptions,
): Promise<void> {
  if (session.platform !== "android") {
    return;
  }
  const existingState = session.cacheData.keepScreenAwake;
  if (existingState) {
    return;
  }

  const keepScreenAwake = sessionOptions.keepScreenAwake !== false;
  const device: BootedDevice = {
    name: session.assignedDevice,
    platform: session.platform,
    deviceId: session.assignedDevice,
  };
  const manager = new KeepScreenAwakeManager(device);

  let state: KeepScreenAwakeState;
  try {
    state = await manager.apply(keepScreenAwake);
  } catch (error) {
    logger.warn(
      `[ToolExecutionContext] Failed to apply keep-awake for ${device.deviceId}: ${error}`,
    );
    state = { applied: false, skipReason: "failed" };
  }

  if (!sessionManager.isAdmittedForAutomation(session)) {
    if (state.applied) {
      try {
        await manager.restore(state);
      } catch (error) {
        logger.warn(
          `[ToolExecutionContext] Failed to restore keep-awake after session release for ${device.deviceId}: ${error}`,
        );
      }
    }
    throw new ActionableError(`Session ${session.sessionId} was released during setup`);
  }

  sessionManager.setKeepScreenAwake(session.sessionId, state);
}
