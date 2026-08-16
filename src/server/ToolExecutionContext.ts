import { SessionManager } from "../daemon/sessionManager";
import type { Session } from "../daemon/sessionManager";
import { DevicePool } from "../daemon/devicePool";
import { AndroidCtrlProxyManager } from "../utils/CtrlProxyManager";
import { NavigationGraphManager } from "../features/navigation/NavigationGraphManager";
import { ActionableError, BootedDevice, Platform } from "../models";
import { logger } from "../utils/logger";
import { KeepScreenAwakeManager, KeepScreenAwakeState } from "../utils/KeepScreenAwakeManager";
import { AndroidCtrlProxyClient } from "../features/observe/android";
import { createPerformanceTracker, type TimingData } from "../utils/PerformanceTracker";
import { type Timer, defaultTimer } from "../utils/SystemTimer";

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
    logger.warn(`[ToolExecutionContext] No setup timing for deviceId=${deviceId}, available keys: ${availableKeys.join(", ")}`);
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
  sessionOptions: SessionOptions = {}
): Promise<ToolExecutionContext> {
  if (!sessionUuid) {
    return {};
  }

  const existingSession = sessionManager.getSession(sessionUuid);

  // Get or create session
  const session = await sessionManager.getOrCreateSession(
    sessionUuid,
    devicePool,
    sessionOptions.platform
  );

  await sessionManager.trackSessionSetup(
    session,
    () => ensureKeepScreenAwake(session, sessionManager, sessionOptions),
  );

  if (!existingSession) {
    if (session.platform === "android") {
      await ensureAccessibilityServiceReady(session.assignedDevice, sessionUuid, session.platform);
    }

    // Start test coverage session for navigation graph tracking
    // This enables automatic tracking of screens and transitions during test execution
    const navManager = NavigationGraphManager.getInstanceForSession(sessionUuid);
    if (navManager.getCurrentAppId()) {
      await navManager.startTestSession(sessionUuid);
      logger.info(`[ToolExecutionContext] Started test coverage tracking for session ${sessionUuid}`);
    }
  }

  return {
    sessionId: sessionUuid,
    deviceId: session.assignedDevice,
    devicePlatform: session.platform,
    sessionManager,
    devicePool,
  };
}

const A11Y_TRANSIENT_ERROR_PATTERNS = [
  "Operation aborted",
  "Operation cancelled",
  "Command timed out",
];

function isTransientA11yError(error: string): boolean {
  return A11Y_TRANSIENT_ERROR_PATTERNS.some(p => error.includes(p));
}

async function ensureAccessibilityServiceReady(
  deviceId: string,
  sessionId: string,
  platform: Platform,
  timer: Timer = defaultTimer
): Promise<void> {
  const device: BootedDevice = {
    name: deviceId,
    platform,
    deviceId
  };
  logger.info(`[ToolExecutionContext] Ensuring accessibility service is ready for session ${sessionId}`);

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
        logger.info(`[ToolExecutionContext] Accessibility service setup failed`, { perfTiming: JSON.stringify(timings, null, 2) });
      }

      const errorMsg = setupResult.error || setupResult.message || "";
      if (attempt < MAX_ATTEMPTS && isTransientA11yError(errorMsg)) {
        logger.warn(
          `[A11yRetry] Transient failure on attempt ${attempt}/${MAX_ATTEMPTS}, retrying in ${RETRY_DELAY_MS}ms: ${errorMsg}`
        );
        await timer.sleep(RETRY_DELAY_MS);
        continue;
      }

      throw new ActionableError(
        `Failed to setup accessibility service for device ${deviceId} (session ${sessionId}): ${errorMsg}`
      );
    }

    if (attempt > 1) {
      logger.info(`[A11yRetry] Setup succeeded on attempt ${attempt}/${MAX_ATTEMPTS}`);
    }

    const accessibilityClient = AndroidCtrlProxyClient.getInstance(device);
    const connected = await perf.track("waitForConnection", () => accessibilityClient.waitForConnection());

    perf.end();
    const timings = perf.getTimings();
    if (timings) {
      storeSetupTiming(deviceId, timings);
      logger.info(`[ToolExecutionContext] Accessibility service ready for session ${sessionId}`, { connected });
    } else {
      logger.warn(`[ToolExecutionContext] No timing data captured for setup (deviceId=${deviceId})`);
    }
    return;
  }
}

async function ensureKeepScreenAwake(
  session: Session,
  sessionManager: SessionManager,
  sessionOptions: SessionOptions
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
    deviceId: session.assignedDevice
  };
  const manager = new KeepScreenAwakeManager(device);

  let state: KeepScreenAwakeState;
  try {
    state = await manager.apply(keepScreenAwake);
  } catch (error) {
    logger.warn(`[ToolExecutionContext] Failed to apply keep-awake for ${device.deviceId}: ${error}`);
    state = { applied: false, skipReason: "failed" };
  }

  sessionManager.setKeepScreenAwake(session.sessionId, state);
}
