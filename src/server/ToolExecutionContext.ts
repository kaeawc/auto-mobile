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
  // `undefined` means this session was never routed through this module's own
  // setup — e.g. a test (or another internal caller) that tracks a session
  // directly via `SessionManager.createSession`. Trust the existing-session
  // fast path exactly as it behaved before #6227 rather than forcing setup
  // on a session this code has no record of ever needing it.
  if (achieved === undefined) {
    return true;
  }
  // `booted` is satisfied by either recorded level; `automationReady` needs
  // the higher level to have actually been achieved.
  return required === "booted" || achieved === "automationReady";
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
    // disconnected/unprepared device.
    if (
      !isReadinessSatisfied(sessionManager.getDeviceReadiness(session.sessionId), requiredReadiness)
    ) {
      await runDeviceReadinessSetup(session, sessionManager, requiredReadiness);
    }
    return;
  }

  ensureSessionIsCurrent(session, sessionManager);
  await runDeviceReadinessSetup(session, sessionManager, requiredReadiness);
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
