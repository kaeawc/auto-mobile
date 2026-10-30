import { defaultDaemonContext, type DaemonContext } from "../../daemon/daemonContext";
import { ObserveResult } from "../../models";
import type { AdbClientFactory } from "../../utils/android-cmdline-tools/AdbClientFactory";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import type { Timer } from "../../utils/SystemTimer";
import { displayTransitions, type DisplayTransitionReader } from "../observe/DisplayTransition";
import type { AwaitIdle } from "../observe/interfaces/AwaitIdle";
import type {
  ObserveScreen,
  ObserveScreenExecuteOptions,
} from "../observe/interfaces/ObserveScreen";
import type { Window } from "../observe/interfaces/Window";
import { PredictionAnalyzer } from "../observe/PredictionAnalyzer";
import { type StaleDisplayDetails } from "../observe/StaleDisplayError";
import type { ActionClockSkewProvider } from "./ActionClockSkewCache";

export interface ProgressCallback {
  (progress: number, total?: number, message?: string): Promise<void>;
}

/**
 * Backoff delays (ms) between `takeObservation`'s post-action retries below.
 * Exported so callers that must budget the WORST CASE of this retry loop
 * (e.g. the daemon's `TAP_ANY_LONG_PRESS_NON_PRESS_OVERHEAD_MS` in
 * `src/daemon/mcpRequestTimeout.ts`) derive it from the real constant instead
 * of guessing at a duplicated magic number (issue #6248 review, P2).
 */
export const FINAL_OBSERVATION_RETRY_BACKOFF_MS: readonly number[] = [50, 100, 200, 400];

export const COORDINATE_ACTIONS = new Set([
  "tapAt",
  "swipeAt",
  "tapOn",
  "tapAny",
  "swipeOn",
  "dragAndDrop",
  "pinchOn",
  "multiTouch",
]);

export type RenderedDisplayRevisionReader = (deviceId: string) => number | undefined;

export interface DisplayFence {
  assertCurrent(): void;
}

/** Internal dispatch options; never part of a tool's input schema. */
export interface DisplayFenceOption {
  readonly displayFence?: DisplayFence;
}

export const NO_OP_DISPLAY_FENCE: DisplayFence = Object.freeze({ assertCurrent: () => {} });

/** Intermediate action reads resolve targets and effects; terminal evidence is captured once. */
export const INTERMEDIATE_OBSERVATION_OPTIONS = {
  skipScreenshot: true,
  skipAccessibilityAudit: true,
} satisfies ObserveScreenExecuteOptions;

export function resolveDisplayFence(options?: DisplayFenceOption): DisplayFence {
  return options?.displayFence ?? NO_OP_DISPLAY_FENCE;
}

export interface DisplayFenceDependencies {
  actionClockSkewCache?: ActionClockSkewProvider;
  /** Collaborator overrides; default to the real device-backed implementations. */
  observeScreen?: ObserveScreen;
  awaitIdle?: AwaitIdle;
  window?: Window;
  predictionAnalyzer?: Pick<PredictionAnalyzer, "recordOutcomeForAction">;
  displayTransitions?: DisplayTransitionReader;
  renderedDisplayRevision?: RenderedDisplayRevisionReader;
  renderedDisplayGeneration?: RenderedDisplayRevisionReader;
}

/** Optional collaborators for `BaseVisualChange`; each falls back to its production default. */
export interface BaseVisualChangeOptions {
  /** AdbClientFactory instance, AdbExecutor instance, or null (uses the default factory). */
  adb?: AdbClientFactory | AdbExecutor | null;
  /** Clock for this instance and its default collaborators; a seam for FakeTimer tests. */
  timer?: Timer;
  /** Fallback rendered-display revision reader when `displayFence` does not supply one. */
  renderedDisplayRevision?: RenderedDisplayRevisionReader;
  displayFence?: DisplayFenceDependencies;
}

export function resolveDisplayReaders(
  displayFence: DisplayFenceDependencies,
  renderedDisplayRevision: RenderedDisplayRevisionReader,
): {
  renderedDisplayRevision: RenderedDisplayRevisionReader;
  displayTransitionReader: DisplayTransitionReader;
  renderedDisplayGeneration: RenderedDisplayRevisionReader;
} {
  return {
    renderedDisplayRevision: displayFence.renderedDisplayRevision ?? renderedDisplayRevision,
    displayTransitionReader: displayFence.displayTransitions ?? displayTransitions,
    renderedDisplayGeneration:
      displayFence.renderedDisplayGeneration ?? sessionRenderedDisplayGeneration,
  };
}

export function sessionRenderedDisplayGeneration(
  deviceId: string,
  daemon: DaemonContext = defaultDaemonContext,
): number | undefined {
  const sessions = daemon.renderedDisplaySessions();
  if (!sessions) {
    return undefined;
  }
  const sessionId = sessions.getSessionForDevice(deviceId);
  return sessionId ? sessions.getLastRenderedDisplayGeneration(sessionId) : undefined;
}

export function sessionRenderedDisplayRevision(
  deviceId: string,
  daemon: DaemonContext = defaultDaemonContext,
): number | undefined {
  const sessions = daemon.renderedDisplaySessions();
  if (!sessions) {
    return undefined;
  }
  const sessionId = sessions.getSessionForDevice(deviceId);
  return sessionId ? sessions.getLastRenderedDisplayRevision(sessionId) : undefined;
}

/**
 * Max retry attempts `takeObservation` performs after its initial observation
 * (5 observation attempts total). Exported for the same reason as
 * `FINAL_OBSERVATION_RETRY_BACKOFF_MS` above.
 */
export const FINAL_OBSERVATION_MAX_RETRY_ATTEMPTS = 4;

/** Mutable display-fence state shared by the fence, pre-read and run stages. */
export interface CallerFenceState {
  displayRevision: number;
  fence: DisplayFence;
  observedGeneration: number;
  reresolvesTarget: boolean;
  refreshForDisplayChange: boolean;
}

export interface PostActionCapture {
  observation: ObserveResult;
  readFailed: boolean;
  staleDisplay?: StaleDisplayDetails;
}
