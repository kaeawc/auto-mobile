import type { BootedDevice, ObserveResult } from "../../models";
import { ActionableError } from "../../models/ActionableError";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { defaultTimer } from "../../utils/SystemTimer";
import { DaemonState } from "../../daemon/daemonState";
import { logger } from "../../utils/logger";
import { errorMessage } from "../../utils/describeUnknownError";
import { throwIfAborted } from "../../utils/toolUtils";
import { serverConfig } from "../../utils/ServerConfig";
import type { HierarchyCapture } from "../observe/HierarchyCapture";
import { StaleDisplayError, staleDisplayError } from "../../models/StaleDisplayError";
import { displayTransitions, type DisplayTransitionReader } from "../observe/DisplayTransition";
import { resolveTargetDisplay } from "../observe/DisplaySelection";
import { ObservedAndroidDisplayCache } from "../observe/ObservationDisplay";
import type { ObserveScreen } from "../observe/interfaces/ObserveScreen";
import { buildDisconnectedPanelMessage, type DisplayPanel } from "../../models/DisplayPanel";
import {
  logicalDisplayIdForPanel,
  parseAndroidDisplayInfos,
  type AndroidDisplayInfo,
} from "../../utils/android-cmdline-tools/AndroidDisplayParsers";
import { selectedDisplayPin } from "../observe/SessionDisplayContext";

export { buildDisconnectedPanelMessage } from "../../models/DisplayPanel";

async function readActionDisplayInfos(
  adb: Pick<AdbExecutor, "executeCommand">,
  signal?: AbortSignal,
): Promise<AndroidDisplayInfo[]> {
  throwIfAborted(signal);
  try {
    const output = await adb.executeCommand(
      "shell cmd display get-displays",
      2000,
      undefined,
      true,
      signal,
    );
    throwIfAborted(signal);
    const infos = parseAndroidDisplayInfos(output.stdout);
    if (!infos.length) {
      // Older Android may not support this optional list; absence cannot prove disconnection.
      logger.debug("Android action display list is empty; retaining prior-observation guidance.");
    }
    return infos;
  } catch (error) {
    throwIfAborted(signal);
    if (error instanceof Error && error.name === "AbortError") {
      throw error;
    }
    logger.warn(`Unable to read Android action displays: ${errorMessage(error)}`, error);
    return [];
  }
}

function connectedActionPanels(infos: readonly AndroidDisplayInfo[], device: BootedDevice) {
  return infos.map((info) => {
    // Match logicalDisplayIdForPanel's physical-key extraction; that helper is not exported separately.
    const key = info.uniqueId?.split(":").slice(1).join(":") || info.logicalId;
    const role = device.displays?.panels.find((panel) => panel.key === key)?.role;
    return { key, role };
  });
}

async function assertActionPanelConnected(
  device: BootedDevice,
  panel: DisplayPanel,
  adb: Pick<AdbExecutor, "executeCommand">,
  signal?: AbortSignal,
): Promise<void> {
  if (device.platform !== "android" || !device.displays?.panels.length) {
    return;
  }
  const infos = await readActionDisplayInfos(adb, signal);
  if (!infos.length || logicalDisplayIdForPanel(infos, panel.key) !== undefined) {
    return;
  }
  throw new ActionableError(
    buildDisconnectedPanelMessage(
      panel.key,
      panel.role,
      connectedActionPanels(infos, device),
      device.displays.postures.length > 0,
      selectedDisplayPin() !== undefined,
    ),
  );
}

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
    await assertActionPanelConnected(device, panel, adb, signal);
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

/** Search and retry captures must stay on the prepared Android panel. */
export async function refreshTargetDisplayHierarchy(
  target: Awaited<ReturnType<typeof prepareTargetDisplayAction>>,
  capture: HierarchyCapture,
  timeoutMs: number,
  stale: () => StaleDisplayError,
  signal?: AbortSignal,
) {
  throwIfAborted(signal);
  target.assertCurrent();
  try {
    const { hierarchy } = await capture.capture({
      freshness: "fresh",
      searchRaw: serverConfig.isRawElementSearchEnabled(),
      timeoutMs,
      signal,
      displayId: target.displayId ?? 0,
    });
    target.assertCurrent();
    if (hierarchy.displayId !== (target.displayId ?? 0)) {
      throw stale();
    }
    return hierarchy;
  } catch (error) {
    target.assertCurrent();
    if (error instanceof StaleDisplayError) {
      throw error;
    }
    throwIfAborted(signal);
    logger.warn(`Fresh display capture failed: ${errorMessage(error)}`, error);
    return null;
  }
}
