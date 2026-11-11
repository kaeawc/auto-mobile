import type { BootedDevice, ObserveResult } from "../../models";
import { displayInventoryOutcome } from "../../models/DeviceInfo";
import { ActionableError } from "../../models/ActionableError";
import type { AdbCommandRunner } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { defaultTimer } from "../../utils/SystemTimer";
import { defaultDaemonContext, type DaemonContext } from "../../daemon/daemonContext";
import { logger } from "../../utils/logger";
import { errorMessage } from "../../utils/describeUnknownError";
import { throwIfAborted } from "../../utils/toolUtils";
import { serverConfig } from "../../utils/ServerConfig";
import type { HierarchyCapture } from "../observe/HierarchyCapture";
import { StaleDisplayError, staleDisplayError } from "../observe/StaleDisplayError";
import { displayTransitions, type DisplayTransitionReader } from "../observe/DisplayTransition";
import { DisplaySelectionError, resolveDeviceTargetDisplay } from "../observe/DisplaySelection";
import { ObservedAndroidDisplayCache } from "../observe/ObservationDisplay";
import type {
  ObserveScreen,
  ObserveScreenExecuteOptions,
} from "../observe/interfaces/ObserveScreen";
import { buildDisconnectedPanelMessage, type DisplayPanel } from "../../models/DisplayPanel";
import {
  logicalDisplayIdForPanel,
  panelKeyForUniqueId,
  type AndroidDisplayInfo,
} from "../../utils/android-cmdline-tools/AndroidDisplayParsers";
import { readAndroidLogicalDisplays } from "../../utils/android-cmdline-tools/AndroidLogicalDisplays";
import { selectedDisplayPin } from "../observe/SessionDisplayContext";
import { INTERMEDIATE_OBSERVATION_OPTIONS } from "./BaseVisualChange";
import type { ActionCall } from "./ActionCall";

export { buildDisconnectedPanelMessage } from "../../models/DisplayPanel";

async function readActionDisplayInfos(
  adb: AdbCommandRunner,
  panels: readonly DisplayPanel[],
  signal?: AbortSignal,
): Promise<AndroidDisplayInfo[]> {
  throwIfAborted(signal);
  try {
    const infos = await readAndroidLogicalDisplays(adb, panels, signal);
    throwIfAborted(signal);
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
    const key = (info.uniqueId && panelKeyForUniqueId(info.uniqueId)) || info.logicalId;
    const role = device.displays?.panels.find((panel) => panel.key === key)?.role;
    return { key, role };
  });
}

async function assertActionPanelConnected(
  device: BootedDevice,
  panel: DisplayPanel,
  adb: AdbCommandRunner,
  signal?: AbortSignal,
): Promise<void> {
  if (device.platform !== "android" || !device.displays?.panels.length) {
    return;
  }
  const infos = await readActionDisplayInfos(adb, device.displays.panels, signal);
  if (!infos.length || logicalDisplayIdForPanel(infos, panel.key) !== undefined) {
    return;
  }
  const connectedPanels = connectedActionPanels(infos, device);
  const hasPostures = device.displays.postures.length > 0;
  // DisplaySelectionError lets a session pin's displayPinFailure attach `pinnedDisplay`; an explicit
  // display has no pin in scope, so it keeps the plain message with no pin details.
  throw new DisplaySelectionError(
    buildDisconnectedPanelMessage(panel.key, panel.role, connectedPanels, {
      hasPostures,
      pinned: selectedDisplayPin() !== undefined,
    }),
    {
      disconnectedPanel: {
        panel,
        connectedPanels: connectedPanels.map(({ key, role }) => ({
          key,
          role: role ?? "unknown",
        })),
        hasPostures,
      },
    },
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
  daemon: DaemonContext = defaultDaemonContext,
): ReturnType<RenderedObservationReader> {
  const sessions = daemon.renderedDisplaySessions();
  if (!sessions) {
    return undefined;
  }
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

/**
 * The caller's latest rendered revision, read again through the same reader that supplied
 * `previous` so an injected reader and its session store stay the one source (#13315).
 */
function renderedRevision(
  deviceId: string,
  previous: NonNullable<ReturnType<RenderedObservationReader>>,
  lastRenderedObservation: RenderedObservationReader,
): number | undefined {
  return lastRenderedObservation(deviceId)?.displayRevision ?? previous.displayRevision;
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

/** Collaborators for {@link resolveActionDisplayId}. */
export interface ActionDisplayDependencies {
  adb: AdbCommandRunner;
  lastRenderedObservation?: RenderedObservationReader;
  signal?: AbortSignal;
}

/**
 * Resolve a tool's `display` argument to an Android logical display id, with the same selection
 * helper the tap tools use. `display` is already the product of the shared precedence (an explicit
 * argument, else the session display pin injected by the registry); undefined means the default
 * display and returns undefined so the wire stays unchanged.
 *
 * Throws DisplaySelectionError for an unknown panel, and (via the observed-display cache) the
 * disconnected-panel guidance when the panel exists but is not connected in this posture.
 */
export async function resolveActionDisplayId(
  device: BootedDevice,
  display: string | undefined,
  dependencies: ActionDisplayDependencies,
): Promise<number | undefined> {
  return display === undefined
    ? undefined
    : (await resolveActionDisplay(device, display, dependencies)).displayId;
}

/**
 * Resolve a `display` selector once to its concrete panel key and Android logical display id, so
 * an action can dispatch to and observe the same panel (`active` is not re-resolved later).
 */
export async function resolveActionDisplay(
  device: BootedDevice,
  display: string,
  dependencies: ActionDisplayDependencies,
): Promise<{ key: string; displayId: number }> {
  const previous = (dependencies.lastRenderedObservation ?? sessionRenderedObservation)(
    device.deviceId,
  );
  const panel = resolveDeviceTargetDisplay(device, display, {
    focusedPanelKey: previous?.display.key,
    activePanelKey: previous?.display.key,
    posture: previous?.display.posture,
  });
  const displayId = await new ObservedAndroidDisplayCache(defaultTimer).logicalIdForPanel(
    device,
    dependencies.adb,
    panel.key,
    dependencies.signal,
  );
  return { key: panel.key, displayId };
}

async function inputDisplayId(
  device: BootedDevice,
  adb: AdbCommandRunner,
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

/**
 * The pre-dispatch read only resolves the panel, its hierarchy and the stale-display fence. Every
 * consumer of the returned observation reads hierarchy, screen size, display identity or geometry;
 * none reads a screenshot or audit, and the action's own post-dispatch capture is the single one.
 */
function targetDisplayRead(display: string, signal?: AbortSignal) {
  return {
    ...INTERMEDIATE_OBSERVATION_OPTIONS,
    display,
    freshness: "cached-ok",
    signal,
  } satisfies ObserveScreenExecuteOptions;
}

/** Optional collaborators and cancellation for {@link prepareTargetDisplayAction}. */
export interface TargetDisplayCall extends ActionCall {
  /** Reader for the caller's last rendered observation (defaults to the session reader). */
  lastRenderedObservation?: RenderedObservationReader;
  /** Display-transition revision source (defaults to the shared tracker). */
  transitions?: DisplayTransitionReader;
}

/** A display-targeted action's prepared panel, read and fence. */
export interface PreparedTargetDisplay {
  observation: ObserveResult;
  displayId?: number;
  /** Selector for the action's follow-up observe reads; see {@link followUpDisplaySelector}. */
  followUpDisplay: string;
  assertCurrent: () => void;
}

/** Resolve explicit action targeting against the caller's last visible panel. */
export async function prepareTargetDisplayAction(
  device: BootedDevice,
  display: string,
  observe: Pick<ObserveScreen, "execute">,
  { adb, ...call }: TargetDisplayCall & { adb: AdbCommandRunner },
): Promise<PreparedTargetDisplay> {
  const {
    lastRenderedObservation = sessionRenderedObservation,
    signal,
    transitions = displayTransitions,
  } = call;
  const previous = lastRenderedObservation(device.deviceId);
  const revision = transitions.revision(device.deviceId);
  const { stale, assertCurrent, assertCallerCurrent } = targetRevisionFence(
    device.deviceId,
    revision,
    previous,
    transitions,
  );
  const panel = resolveDeviceTargetDisplay(device, display, {
    focusedPanelKey: previous?.display.key,
    activePanelKey: previous?.display.key,
    posture: previous?.display.posture,
  });
  // Observe owns the live-panel check on iOS; surface that error before a
  // re-observe instruction for a panel the simulator cannot accept input on.
  const iosObservation =
    device.platform === "ios"
      ? await observe.execute(targetDisplayRead(display, signal))
      : undefined;
  if (previous?.display.key !== panel.key) {
    await assertActionPanelConnected(device, panel, adb, signal);
    throw new ActionableError(
      `Coordinates for display "${panel.key}" require a prior observation of that panel. Re-observe display "${panel.key}" and retry.`,
    );
  }
  const callerRevision = renderedRevision(device.deviceId, previous, lastRenderedObservation);
  assertCallerCurrent(callerRevision);
  const observation = iosObservation ?? (await observe.execute(targetDisplayRead(display, signal)));
  assertCurrent();
  if (observation.display.key !== panel.key) {
    throw stale();
  }
  const displayId = await inputDisplayId(device, adb, panel.key, signal);
  assertCurrent();
  return {
    observation,
    displayId,
    followUpDisplay: followUpDisplaySelector(device, display, panel.key),
    assertCurrent,
  };
}

/**
 * The selector an action's follow-up reads pass to observe. They pin the prepared panel's key so
 * `active` is not re-resolved, except when `active` fell back on an unreadable inventory: that
 * fallback key is not a selector the caller chose, so re-checking it as explicit would reject the
 * read (#16741). `active` re-resolves to the same sole fallback panel.
 */
export function followUpDisplaySelector(
  device: Pick<BootedDevice, typeof displayInventoryOutcome>,
  display: string,
  panelKey: string,
): string {
  return display === "active" && device[displayInventoryOutcome]?.kind === "unreadable"
    ? "active"
    : panelKey;
}

/** Search and retry captures must stay on the prepared Android panel. */
export async function refreshTargetDisplayHierarchy(
  target: Awaited<ReturnType<typeof prepareTargetDisplayAction>>,
  capture: HierarchyCapture,
  timeoutMs: number,
  { stale, signal }: { stale: () => StaleDisplayError; signal?: AbortSignal },
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
