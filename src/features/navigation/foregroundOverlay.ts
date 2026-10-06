import type { ObserveResult } from "../../models/ObserveResult";

/** The parts of an observation that say what is in front of the app. */
export type ForegroundObservation = Pick<
  ObserveResult,
  "activeWindow" | "screenIdentity" | "intentChooserDetected" | "notificationPermissionDetected"
>;

/** Narrow observe seam (RealObserveScreen satisfies it) so navigation tests need no device. */
export interface ForegroundObserver {
  execute(options?: { signal?: AbortSignal }): Promise<ForegroundObservation>;
}

function describeDetectedDialog(observation: ForegroundObservation): string | undefined {
  if (observation.notificationPermissionDetected) {
    return "a notification permission dialog";
  }
  if (observation.intentChooserDetected) {
    return "an intent chooser";
  }
  const modal = observation.screenIdentity?.components;
  const modalName = modal?.modalTitle ?? modal?.modalClass ?? modal?.presentation;
  return modalName ? `a modal presentation (${modalName})` : undefined;
}

function describeForegroundWindow(
  window: ForegroundObservation["activeWindow"],
  appId: string | null,
): string | undefined {
  if (!window) {
    return undefined;
  }
  if (window.systemOverlay) {
    return `a system surface (${window.appId})`;
  }
  if (window.type) {
    return `a ${window.type.replace(/_/g, " ")}`;
  }
  return appId && window.appId && window.appId !== appId
    ? `another app window (${window.appId})`
    : undefined;
}

/**
 * Describe a surface in front of the app that navigation does not model as a screen
 * (a system dialog, share sheet, permission prompt, another app, a modal the SDK did
 * not report), or `undefined` when the observation shows only the app's own content.
 * Used before dispatching a fallback edge so a Back press or tap is never replayed
 * onto an overlay the failed replay opened (#10133).
 */
export function describeForegroundOverlay(
  observation: ForegroundObservation,
  appId: string | null,
): string | undefined {
  return (
    describeDetectedDialog(observation) ?? describeForegroundWindow(observation.activeWindow, appId)
  );
}
