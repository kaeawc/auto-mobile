import { ActionableError } from "../../models/ActionableError";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import type { WatchRunnerClient } from "./WatchRunnerClient";
import { WatchRunnerError } from "./WatchRunnerError";
import { watchRunners, type WatchRunnerRegistry } from "./WatchRunnerRegistry";

/** `XCUIApplication.State` by case name, as the watch runner's `appStates` reply carries it. */
export type WatchAppState =
  | "unknown"
  | "notRunning"
  | "runningBackgroundSuspended"
  | "runningBackground"
  | "runningForeground";

const WATCH_APP_STATES: ReadonlySet<string> = new Set<WatchAppState>([
  "unknown",
  "notRunning",
  "runningBackgroundSuspended",
  "runningBackground",
  "runningForeground",
]);

/** The runner answers at most this many bundle IDs per request. */
export const MAX_WATCH_APP_STATE_BUNDLES = 128;

/** Asks the watch runner for each bundle's `XCUIApplication.State` (#19359). */
export async function readWatchAppStates(
  client: Pick<WatchRunnerClient, "request">,
  bundleIds: readonly string[],
  signal?: AbortSignal,
): Promise<Map<string, WatchAppState>> {
  const states = new Map<string, WatchAppState>();
  const unique = [...new Set(bundleIds)];
  for (let start = 0; start < unique.length; start += MAX_WATCH_APP_STATE_BUNDLES) {
    const chunk = unique.slice(start, start + MAX_WATCH_APP_STATE_BUNDLES);
    const reply = await client.request({ type: "appStates", bundleIds: chunk }, signal);
    if (!reply || typeof reply !== "object") {
      throw new ActionableError("Invalid watch appStates reply; reconnect the runner.");
    }
    // Only the bundles asked about: a reply naming others is not evidence about the listing.
    const answers = reply as Record<string, unknown>;
    for (const bundleId of chunk) {
      const state = answers[bundleId];
      if (typeof state === "string" && WATCH_APP_STATES.has(state)) {
        states.set(bundleId, state as WatchAppState);
      }
    }
  }
  return states;
}

/**
 * System processes the runner reports as `runningForeground` whatever app is in front: every
 * captured reply (test/fixtures/watchos-xcuitest/app-states-*) has both, with the runner or
 * Settings in front as well.
 */
const ALWAYS_FOREGROUND_SYSTEM_BUNDLES: ReadonlySet<string> = new Set([
  "com.apple.Carousel",
  "com.apple.clockface",
]);

/**
 * At most one app is in front. A foreground app outside the always-foreground system set wins;
 * with none, a lone system bundle is the front one. Two or more candidates on either tier cannot
 * be told apart, so none is marked.
 */
function frontApp(foreground: readonly string[]): ReadonlySet<string> {
  const apps = foreground.filter((id) => !ALWAYS_FOREGROUND_SYSTEM_BUNDLES.has(id));
  const candidates = apps.length > 0 ? apps : foreground;
  return new Set(candidates.length === 1 ? candidates : []);
}

/** Which of the given watch apps are in front, read from a runner that is already connected. */
export interface WatchForegroundProbe {
  foregroundBundleIds(
    deviceId: string,
    bundleIds: readonly string[],
    signal?: AbortSignal,
  ): Promise<ReadonlySet<string>>;
}

/**
 * simctl has no foreground signal, so the watch runner reports it. Listing never starts a runner:
 * with none connected, or one too old for `appStates`, no app is marked foreground.
 */
export class RunnerWatchForegroundProbe implements WatchForegroundProbe {
  constructor(private readonly registry: Pick<WatchRunnerRegistry, "get"> = watchRunners) {}

  async foregroundBundleIds(
    deviceId: string,
    bundleIds: readonly string[],
    signal?: AbortSignal,
  ): Promise<ReadonlySet<string>> {
    const client = this.registry.get(deviceId);
    if (!client?.isUsable() || bundleIds.length === 0) {
      return new Set();
    }
    try {
      const states = await readWatchAppStates(client, bundleIds, signal);
      return frontApp(
        [...states].filter(([, state]) => state === "runningForeground").map(([id]) => id),
      );
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof WatchRunnerError && error.errorCode === "unsupported_on_watchos") {
        // A runner built before appStates cannot say which app is in front; listing still works.
        logger.debug(`[WatchForeground] runner on ${deviceId} has no appStates: ${error.message}`);
      } else {
        logger.warn(
          `[WatchForeground] could not read app states on ${deviceId}: ${errorMessage(error)}`,
          error,
        );
      }
      return new Set();
    }
  }
}

const defaultWatchForegroundProbe = new RunnerWatchForegroundProbe();

/**
 * Marks the listed watch apps the runner reports in front, read fresh on every call and never
 * cached. Other platforms, and an empty listing, come back unchanged (#19359).
 */
export async function markWatchForeground<T extends { packageName: string; foreground: boolean }>(
  device: { deviceId: string; platform?: string },
  apps: T[],
  probe: WatchForegroundProbe = defaultWatchForegroundProbe,
  signal?: AbortSignal,
): Promise<T[]> {
  if (device.platform !== "watchos" || apps.length === 0) {
    return apps;
  }
  const foreground = await probe.foregroundBundleIds(
    device.deviceId,
    apps.map((app) => app.packageName),
    signal,
  );
  return apps.map((app) => (foreground.has(app.packageName) ? { ...app, foreground: true } : app));
}
