import { parseDeviceLock } from "./parseDeviceLock";
import { DUMPSYS_MAX_BUFFER } from "./dumpsysLimits";
import { rethrowDeviceTransportUnavailable } from "./AdbDeviceTransportUnavailableError";

import { parseDumpsysUsers, parsePmListUsers } from "./parseAndroidUsers";

import { errorMessage } from "../describeUnknownError";
import { logger } from "../logger";

import { ExecResult, AndroidUser, DeviceLockState } from "../../models";

import { parseResumedActivityForDisplay } from "./parseResumedActivity";
import {
  type ForegroundAppReadResult,
  type AdbExecuteOptions,
  type DeviceTimestampResult,
} from "./interfaces/AdbExecutor";

import { Timer } from "../SystemTimer";

export interface AdbDeviceReadingsContext {
  executeCommand(command: string, options?: AdbExecuteOptions): Promise<ExecResult>;
  timer: Timer;
}
export class AdbDeviceReadings {
  constructor(private readonly context: AdbDeviceReadingsContext) {}

  /**
   * Get device time in milliseconds since epoch and identify its clock source.
   * Falls back to host time if the device timestamp cannot be retrieved.
   */
  async getDeviceTimestampMsWithSource(
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<DeviceTimestampResult> {
    try {
      const result = await this.context.executeCommand("shell date +%s%3N", {
        timeoutMs,
        noRetry: true,
        signal,
      });
      const trimmed = result.stdout.trim();
      if (/^\d+$/.test(trimmed)) {
        const parsed = Number(trimmed);
        if (Number.isSafeInteger(parsed) && parsed > 0) {
          return { timestampMs: parsed, source: "device-ms" };
        }
      }
    } catch (error) {
      signal?.throwIfAborted();
      logger.debug(`[ADB] Failed to read device time with ms precision: ${error}`);
    }

    try {
      const result = await this.context.executeCommand("shell date +%s", {
        timeoutMs,
        noRetry: true,
        signal,
      });
      const trimmed = result.stdout.trim();
      if (/^\d+$/.test(trimmed)) {
        const parsed = Number(trimmed);
        const timestampMs = parsed * 1000;
        if (Number.isSafeInteger(parsed) && parsed > 0 && Number.isSafeInteger(timestampMs)) {
          return { timestampMs, source: "device-seconds" };
        }
      }
    } catch (error) {
      signal?.throwIfAborted();
      logger.debug(`[ADB] Failed to read device time in seconds: ${error}`);
    }

    logger.debug("[ADB] Falling back to host time for device timestamp");
    return { timestampMs: this.context.timer.now(), source: "host" };
  }

  /**
   * Get the device wakefulness state
   * Uses dumpsys power to check mWakefulness state
   * @returns Promise with wakefulness state: "Awake", "Asleep", "Dozing", or null if unknown
   */
  async getWakefulness(signal?: AbortSignal): Promise<"Awake" | "Asleep" | "Dozing" | null> {
    try {
      const result = await this.context.executeCommand("shell dumpsys power | grep mWakefulness=", {
        maxBuffer: DUMPSYS_MAX_BUFFER,
        noRetry: true,
        signal,
      });
      const match = result.stdout.match(/mWakefulness=(\w+)/);
      if (match) {
        const state = match[1];
        if (state === "Awake" || state === "Asleep" || state === "Dozing") {
          return state;
        }
      }
      return null;
    } catch {
      logger.debug("[ADB] Failed to get wakefulness state");
      return null;
    }
  }

  /**
   * Get the device lock state (Android only).
   *
   * All three signals come from a single `dumpsys window policy` read — its
   * `KeyguardServiceDelegate` block carries `showing`, `occluded`, and `secure`
   * (the last mirrors `KeyguardManager.isKeyguardSecure()`, i.e. a credential is
   * set). `secure` is deliberately NOT derived from `locksettings get-disabled`:
   * that only reports whether the lock is set to *None*, so it returns `false`
   * for both a swipe lock and a PIN and cannot tell them apart (#4235 review).
   *
   * `locked` is `showing && !occluded` — an occluded keyguard (a
   * FLAG_SHOW_WHEN_LOCKED activity like the camera) is not obscuring the app.
   *
   * Degrades gracefully: an unreadable policy dump, or one missing the keyguard
   * `showing` field, yields `null` (lock state unknown → observe omits the
   * field); a missing `secure` field yields `secure: undefined` rather than a
   * guessed boolean, so a swipe lock is never mistaken for a secure one.
   *
   * The field names are the API 30+ `KeyguardServiceDelegate` dump; on a release
   * that does not emit them the read simply returns `null` — a missing signal,
   * never a wrong one.
   *
   * Keyguard interaction has a hard ~7s budget (`config_lockScreenDisplayTimeout`,
   * a baked framework resource, not a settable key) and a documented key-event
   * unlock recipe; see docs/design-docs/plat/android/keyguard.md before building
   * anything that drives a locked device.
   */
  async getDeviceLock(signal?: AbortSignal): Promise<DeviceLockState | null> {
    let policy: string;
    try {
      const result = await this.context.executeCommand("shell dumpsys window policy", {
        maxBuffer: DUMPSYS_MAX_BUFFER,
        noRetry: true,
        signal,
      });
      policy = result.stdout;
    } catch {
      logger.debug("[ADB] Failed to read window policy for device lock state");
      return null;
    }

    return parseDeviceLock(policy);
  }

  /**
   * List all Android users on the device (personal, work profiles, etc.)
   * Uses dumpsys user for structured output parsing
   * Falls back to pm list users if dumpsys fails
   * @returns Promise with array of Android users
   */
  async listUsers(signal?: AbortSignal): Promise<AndroidUser[]> {
    try {
      // Try dumpsys user first - provides more structured output
      const result = await this.context.executeCommand("shell dumpsys user", {
        maxBuffer: DUMPSYS_MAX_BUFFER,
        noRetry: true,
        signal,
      });
      const users = parseDumpsysUsers(result.stdout);

      if (users.length > 0) {
        logger.info(
          `[ADB] Found ${users.length} user(s) via dumpsys: ${users.map((u) => `${u.userId}:${u.name}`).join(", ")}`,
        );
        return users;
      }

      // If dumpsys parsing failed, fall back to pm list users
      logger.debug("[ADB] dumpsys user parsing returned no users, falling back to pm list users");
      return await this.listUsersLegacy(signal);
    } catch (error) {
      signal?.throwIfAborted();
      rethrowDeviceTransportUnavailable(error);
      // Older Android versions may lack dumpsys user; pm can still enumerate users.
      logger.debug(
        `[ADB] dumpsys user failed: ${(error as Error).message}, falling back to pm list users`,
      );
      return await this.listUsersLegacy(signal);
    }
  }

  /**
   * Legacy method to list users using pm list users command
   * Used as fallback when dumpsys user is not available or fails
   * Example output:
   *   Users:
   *     UserInfo{0:Owner:4c13} running
   *     UserInfo{10:Work profile:30} running
   * @returns Promise with array of Android users
   */
  async listUsersLegacy(signal?: AbortSignal): Promise<AndroidUser[]> {
    try {
      const result = await this.context.executeCommand("shell pm list users", {
        noRetry: true,
        signal,
      });
      const users = parsePmListUsers(result.stdout);

      if (users.length > 0) {
        logger.info(
          `[ADB] Found ${users.length} user(s) via pm: ${users.map((u) => `${u.userId}:${u.name}`).join(", ")}`,
        );
        return users;
      }

      // If still no users found, log the raw output for debugging
      logger.warn(
        `[ADB] Failed to parse users from pm list users. Raw output: ${result.stdout.substring(0, 200)}`,
      );

      // An unparseable response is not evidence that user 0 is active.
      return [];
    } catch (error) {
      signal?.throwIfAborted();
      rethrowDeviceTransportUnavailable(error);
      logger.warn(`[ADB] Failed to list users via pm: ${(error as Error).message}`);
      // An unavailable user service is not evidence that user 0 is active.
      return [];
    }
  }

  /**
   * Read the resumed app for the requested display, reporting unparseable output as unreadable.
   * Known with app: null requires positive evidence of no foreground app; this dumpsys
   * reader currently has no such evidence and reports unreadable when no activity parses.
   */
  async getForegroundAppChecked(
    signal?: AbortSignal,
    timeout?: number | { timeoutMs?: number; displayId?: number },
  ): Promise<ForegroundAppReadResult> {
    const { timeoutMs, displayId = 0 } =
      typeof timeout === "number" ? { timeoutMs: timeout } : (timeout ?? {});
    try {
      const result = await this.context.executeCommand(
        "shell dumpsys activity activities | grep -E '^[^[:space:]]|^[[:space:]]*(topResumedActivity|mResumedActivity|ResumedActivity|Resumed|mFocusedActivity)[[:space:]]*[:=]'",
        { timeoutMs, maxBuffer: DUMPSYS_MAX_BUFFER, noRetry: true, signal },
      );

      const parsed = parseResumedActivityForDisplay(result.stdout, displayId);
      const foreground = parsed.activity;
      if (foreground) {
        const { userId, packageName } = foreground;
        logger.info(`[ADB] Foreground app: ${packageName} (user ${userId})`);
        return {
          state: "known",
          app: {
            packageName,
            userId,
            activityName: foreground.activityName,
            displayCount: parsed.displayCount,
          },
        };
      }

      const error = `No resumed activity could be parsed from the dumpsys activity activities output for display ${displayId} (display sections: ${parsed.displayCount}, stdout length: ${result.stdout.length})`;
      logger.warn(`[ADB] ${error}`);
      return { state: "unreadable", error };
    } catch (error) {
      signal?.throwIfAborted();
      logger.warn("[ADB] Failed to get foreground app", error);
      return { state: "unreadable", error: errorMessage(error) };
    }
  }
}
