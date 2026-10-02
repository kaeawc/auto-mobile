import type { BootedDevice, ObserveResult } from "../../models";
import { ActionableError } from "../../models/ActionableError";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { defaultTimer } from "../../utils/SystemTimer";
import { DaemonState } from "../../daemon/daemonState";
import { staleDisplayError } from "../../models/StaleDisplayError";
import { displayTransitions, type DisplayTransitionReader } from "../observe/DisplayTransition";
import { resolveTargetDisplay } from "../observe/DisplaySelection";
import { ObservedAndroidDisplayCache } from "../observe/ObservationDisplay";
import type { ObserveScreen } from "../observe/interfaces/ObserveScreen";

export type RenderedObservationReader = (deviceId: string) =>
  | {
      display: { key: string; generation?: number; posture?: ObserveResult["display"]["posture"] };
      displayRevision?: number;
    }
  | undefined;

export function sessionRenderedObservation(
  deviceId: string,
): ReturnType<RenderedObservationReader> {
  const daemon = DaemonState.getInstance();
  if (!daemon.isInitialized()) {
    return undefined;
  }
  const sessions = daemon.getSessionManager();
  const sessionId = sessions.getSessionForDevice(deviceId);
  if (!sessionId) {
    return undefined;
  }
  const key = sessions.getLastRenderedDisplayKey(sessionId);
  return key === undefined
    ? undefined
    : {
        display: { key, generation: sessions.getLastRenderedDisplayGeneration(sessionId) },
        displayRevision: sessions.getLastRenderedDisplayRevision(sessionId),
      };
}

function renderedRevision(
  deviceId: string,
  previous: NonNullable<ReturnType<RenderedObservationReader>>,
): number | undefined {
  const daemon = DaemonState.getInstance();
  if (!daemon.isInitialized()) {
    return previous.displayRevision;
  }
  const sessions = daemon.getSessionManager();
  const sessionId = sessions.getSessionForDevice(deviceId);
  return sessionId ? sessions.getLastRenderedDisplayRevision(sessionId) : previous.displayRevision;
}

/** Keep resolving and dispatch checks bound to the same action-start stamp. */
function targetRevisionFence(
  deviceId: string,
  revision: number,
  previous: ReturnType<RenderedObservationReader>,
  transitions: DisplayTransitionReader,
) {
  // Missing caller stamp: only in-flight fences use the action-start identity generation.
  const observedGeneration = previous?.display.generation ?? transitions.identityRevision(deviceId);
  const stale = () =>
    staleDisplayError(
      observedGeneration,
      transitions.identityRevision(deviceId),
      transitions.currentObservedPanel(deviceId)?.key,
    );
  const assertCurrent = () => {
    if (transitions.revision(deviceId) !== revision) {
      throw stale();
    }
  };
  const assertCallerCurrent = (callerRevision: number | undefined) => {
    if (callerRevision !== undefined && callerRevision !== revision) {
      throw stale();
    }
  };
  return { stale, assertCurrent, assertCallerCurrent };
}

async function inputDisplayId(
  device: BootedDevice,
  adb: Pick<AdbExecutor, "executeCommand">,
  key: string,
  signal?: AbortSignal,
): Promise<number | undefined> {
  if (device.platform === "ios") {
    return undefined;
  }
  if (device.platform !== "android") {
    throw new ActionableError(`Unsupported platform: ${device.platform}`);
  }
  return new ObservedAndroidDisplayCache(defaultTimer).logicalIdForPanel(device, adb, key, signal);
}

/** Resolve explicit action targeting against the caller's last visible panel. */
// oxlint-disable-next-line max-params -- Append the injectable tracker without breaking existing positional reader/signal callers.
export async function prepareTargetDisplayAction(
  device: BootedDevice,
  display: string,
  observe: Pick<ObserveScreen, "execute">,
  adb: Pick<AdbExecutor, "executeCommand">,
  lastRenderedObservation: RenderedObservationReader = sessionRenderedObservation,
  signal?: AbortSignal,
  transitions: DisplayTransitionReader = displayTransitions,
): Promise<{ observation: ObserveResult; displayId?: number; assertCurrent: () => void }> {
  const previous = lastRenderedObservation(device.deviceId);
  const revision = transitions.revision(device.deviceId);
  const { stale, assertCurrent, assertCallerCurrent } = targetRevisionFence(
    device.deviceId,
    revision,
    previous,
    transitions,
  );
  const panel = resolveTargetDisplay(device.displays, display, {
    focusedPanelKey: previous?.display.key,
    activePanelKey: previous?.display.key,
    posture: previous?.display.posture,
  });
  // Observe owns the live-panel check on iOS; surface that error before a
  // re-observe instruction for a panel the simulator cannot accept input on.
  const iosObservation =
    device.platform === "ios"
      ? await observe.execute({ display, freshness: "cached-ok", signal })
      : undefined;
  if (previous?.display.key !== panel.key) {
    throw new ActionableError(
      `Coordinates for display "${panel.key}" require a prior observation of that panel. Re-observe display "${panel.key}" and retry.`,
    );
  }
  const callerRevision = renderedRevision(device.deviceId, previous);
  assertCallerCurrent(callerRevision);
  const observation =
    iosObservation ?? (await observe.execute({ display, freshness: "cached-ok", signal }));
  assertCurrent();
  if (observation.display.key !== panel.key) {
    throw stale();
  }
  const displayId = await inputDisplayId(device, adb, panel.key, signal);
  assertCurrent();
  return {
    observation,
    displayId,
    assertCurrent,
  };
}
