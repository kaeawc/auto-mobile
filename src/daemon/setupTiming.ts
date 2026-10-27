import { defaultDaemonContext } from "./daemonContext";
import type { SessionManager } from "./sessionManager";
import type { TimingData } from "../utils/PerformanceTracker";

/** Fallback timings are tagged to prevent unresolved sessions crossing owners. */
const sessionlessSetupTimingsByDevice = new Map<
  string,
  { timing: TimingData; sessionId?: string }
>();
const SESSIONLESS_SETUP_TIMING_CAP = 256;

function setupTimingSessionManager(): SessionManager | undefined {
  return defaultDaemonContext.sessionManager();
}

/** Session-owned timing never falls back to another session's device timing. */
export function storeSetupTiming(
  deviceId: string,
  timing: TimingData,
  sessionId?: string,
  sessionManager = setupTimingSessionManager(),
): void {
  if (sessionId) {
    const session = sessionManager?.getSession(sessionId);
    if (session && session.assignedDevice === deviceId) {
      session.cacheData.pendingSetupTiming = timing;
      return;
    }
    if (sessionManager && !session) {
      return;
    }
  }
  sessionlessSetupTimingsByDevice.delete(deviceId);
  sessionlessSetupTimingsByDevice.set(deviceId, { timing, sessionId });
  if (sessionlessSetupTimingsByDevice.size > SESSIONLESS_SETUP_TIMING_CAP) {
    const oldestDeviceId = sessionlessSetupTimingsByDevice.keys().next().value;
    if (oldestDeviceId !== undefined) {
      sessionlessSetupTimingsByDevice.delete(oldestDeviceId);
    }
  }
}

function consumeFallbackSetupTiming(deviceId: string, sessionId?: string): TimingData | null {
  const fallback = sessionlessSetupTimingsByDevice.get(deviceId);
  if (!fallback || fallback.sessionId !== sessionId) {
    return null;
  }
  sessionlessSetupTimingsByDevice.delete(deviceId);
  return fallback.timing;
}

/** Consume once from the owning session, or the explicit session-less fallback. */
export function consumeSetupTiming(
  deviceId: string,
  sessionId?: string,
  sessionManager = setupTimingSessionManager(),
): TimingData | null {
  if (sessionId) {
    const session = sessionManager?.getSession(sessionId);
    if (!session || session.assignedDevice !== deviceId) {
      if (sessionManager && !session) {
        return null;
      }
      return consumeFallbackSetupTiming(deviceId, sessionId);
    }
    const timing = session.cacheData.pendingSetupTiming;
    delete session.cacheData.pendingSetupTiming;
    return timing ?? null;
  }
  return consumeFallbackSetupTiming(deviceId);
}
