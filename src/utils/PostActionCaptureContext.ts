import { AsyncLocalStorage } from "node:async_hooks";
import type { ObserveResult } from "../models/ObserveResult";
import { logger } from "./logger";
import { errorMessage } from "./describeUnknownError";

/** Symbol metadata follows object spreads, but never JSON/text envelopes. */
export const terminalScreenshotUnavailable = Symbol("terminalScreenshotUnavailable");
export type TerminalCaptureObservation = ObserveResult & {
  [terminalScreenshotUnavailable]?: boolean;
};

type Capture = (observation: ObserveResult, signal?: AbortSignal) => Promise<void>;
interface PendingCapture {
  observation: ObserveResult;
  capture: Capture;
}
interface UnavailableCapture {
  observation: ObserveResult;
  error?: unknown;
}
interface CaptureScope {
  pending: PendingCapture[];
  unavailable: UnavailableCapture[];
  multiAction: boolean;
  signal?: AbortSignal;
  closed: boolean;
}
const scopes = new AsyncLocalStorage<CaptureScope | undefined>();

/** Only the pipeline that awaits the finalizer may enable deferral. */
export async function runWithPostActionCaptureScope<T>(
  signal: AbortSignal | undefined,
  fn: () => Promise<T>,
  enabled = true,
): Promise<T> {
  if (!enabled) {
    return scopes.run(undefined, fn);
  }
  const scope: CaptureScope = {
    pending: [],
    unavailable: [],
    signal,
    closed: false,
    multiAction: false,
  };
  return scopes.run(scope, async () => {
    let completed = false;
    try {
      const result = await fn();
      completed = true;
      return result;
    } finally {
      try {
        if (completed) {
          // Successful discarded/malformed results still own terminal evidence.
          await finalizePendingPostActionCaptures();
        } else {
          scope.pending = [];
        }
      } finally {
        scope.closed = true;
      }
    }
  });
}

/** Decorate the pipeline callback without adding another nested action body. */
export function postActionCaptures(
  signal: AbortSignal | undefined,
  internal: boolean,
  name: string,
) {
  return <T>(fn: () => Promise<T>): (() => Promise<T>) =>
    () =>
      runWithPostActionCaptureScope(signal, fn, !internal && name !== "observe");
}

function sameObservation(left: ObserveResult, right: ObserveResult): boolean {
  return (
    left === right ||
    (!!left.observationId &&
      left.observationId === right.observationId &&
      left.deviceId === right.deviceId)
  );
}

/** Flush earlier evidence while its screen is current, before another gesture. */
export async function beginPostActionCaptureAction(): Promise<void> {
  const scope = scopes.getStore();
  if (!scope || scope.closed || scope.pending.length === 0) {
    return;
  }
  // Disable before awaiting: concurrent descendants cannot queue more old frames.
  scope.multiAction = true;
  await finalizePendingPostActionCaptures();
}

/** Records that action-time policy wanted a capture, without changing the result. */
export function deferTerminalScreenshot(observation: ObserveResult, capture: Capture): boolean {
  const scope = scopes.getStore();
  if (!scope) {
    return false;
  }
  if (scope.closed) {
    // Async descendants must not start evidence work after their response left.
    return true;
  }
  if (scope.multiAction) {
    return false;
  }
  // Text-only envelope parsing must still identify the pending observation.
  // RealObserveScreen supplies both ids; unidentified direct/fake results stay immediate.
  if (!observation.observationId || !observation.deviceId) {
    return false;
  }
  if (!scope.pending.some((pending) => sameObservation(pending.observation, observation))) {
    scope.pending.push({ observation, capture });
  }
  return true;
}

export function hasPendingTerminalScreenshot(observation: ObserveResult): boolean {
  return (
    scopes
      .getStore()
      ?.pending.some((pending) => sameObservation(pending.observation, observation)) ?? false
  );
}

/** Capture the chosen hierarchy, retrying a thrown capture once, never after cancellation. */
export async function captureChosenTerminalScreenshot(
  observation: TerminalCaptureObservation,
  capture: Capture,
  signal?: AbortSignal,
): Promise<void> {
  observation[terminalScreenshotUnavailable] = true;
  const scope = scopes.getStore();
  const unavailable: UnavailableCapture = { observation };
  scope?.unavailable.push(unavailable);
  for (let attempt = 0; attempt < 2; attempt++) {
    if (scope?.closed || signal?.aborted) {
      return;
    }
    observation.screenshotCaptureAttempted = true;
    try {
      await capture(observation, signal);
      delete observation[terminalScreenshotUnavailable];
      if (scope) {
        scope.unavailable = scope.unavailable.filter(
          (frame) => !sameObservation(frame.observation, observation),
        );
      }
      if (observation.accessibilityAudit !== undefined) {
        delete observation.accessibilityAuditSkipped;
      }
      return;
    } catch (error) {
      unavailable.error = error;
      // A partially written capture/audit must not advertise nonexistent evidence.
      delete observation.screenshotPath;
      delete observation.screenshotSource;
      delete observation.screenshotCapturedAt;
      delete observation.screenshotImageSize;
      delete observation.screenshotExpiresAt;
      delete observation.screenshotSettled;
      delete observation.screenshotOrientation;
      delete observation.screenshotPixelsPerNativeUnit;
      delete observation.screenshotScaleProvenance;
      delete observation.screenshotAgeMs;
      delete observation.screenshotFormat;
      delete observation.screenshotMimeType;
      delete observation.screenshotImage;
      delete observation.screenshotCaptureSource;
      delete observation.observationScreenshotResourceUri;
      delete observation.accessibilityAudit;
      logger.warn(`[PostActionCapture] terminal screenshot failed: ${errorMessage(error)}`, error);
    }
  }
}

/** Consume before awaiting so no bypass/finally branch can capture it twice. */
export async function finalizePendingTerminalScreenshot(
  original: ObserveResult,
  chosen = original,
  capture?: Capture,
  signal?: AbortSignal,
): Promise<boolean> {
  const scope = scopes.getStore();
  const index =
    scope?.pending.findIndex((pending) => sameObservation(pending.observation, original)) ?? -1;
  if (!scope || index < 0) {
    return false;
  }
  const [pending] = scope.pending.splice(index, 1);
  await captureChosenTerminalScreenshot(chosen, capture ?? pending.capture, scope.signal ?? signal);
  return true;
}

export async function finalizePendingPostActionCaptures(): Promise<void> {
  const scope = scopes.getStore();
  while (scope && scope.pending.length > 0) {
    await finalizePendingTerminalScreenshot(scope.pending[0].observation);
  }
}

/** Text-only envelopes lose symbol identity; request-owned capture status does not. */
export function isTerminalScreenshotUnavailable(observation: TerminalCaptureObservation): boolean {
  return (
    observation[terminalScreenshotUnavailable] === true ||
    (scopes
      .getStore()
      ?.unavailable.some((frame) => sameObservation(frame.observation, observation)) ??
      false)
  );
}

/** Retain the thrown failure even when a text envelope reconstructs the frame. */
export function terminalScreenshotCaptureError(observation: ObserveResult): unknown {
  return scopes
    .getStore()
    ?.unavailable.find((frame) => sameObservation(frame.observation, observation))?.error;
}
