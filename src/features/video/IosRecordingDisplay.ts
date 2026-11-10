import type {
  BootedDevice,
  VideoRecordingDisplayTransition,
  VideoRecordingPanel,
} from "../../models";
import { isPhysicalPanel } from "../../models/DisplayPanel";
import type { AndroidRecordingDisplay } from "./AndroidRecordingDisplay";
import { androidPanelTransitionWarnings } from "./AndroidPanelTransitionWarnings";

const UNKNOWN_PANEL: VideoRecordingPanel = { key: "unknown", role: "unknown" };

/**
 * The starting panel of an iOS multi-panel recording. simctl's `--display` is chosen once at
 * start and a running capture cannot switch panels, so the session only tracks transitions to
 * report them; single-panel devices are not tracked at all.
 */
export function resolveIosRecordingDisplay(
  device: BootedDevice,
  observedPanel: Pick<VideoRecordingPanel, "key" | "role"> | undefined,
): AndroidRecordingDisplay | undefined {
  const panels = (device.displays?.panels ?? []).filter(isPhysicalPanel);
  if (panels.length < 2) {
    return undefined;
  }
  const known = panels.find((panel) => panel.key === observedPanel?.key);
  const panel = known ? { key: known.key, role: known.role } : UNKNOWN_PANEL;
  return { panel, activePanel: panel };
}

/**
 * The panel an iOS capture actually records: the `--display` simctl was started with, never the
 * last observe, which can be stale (#17593). Undefined when the recording tracks no panel; the
 * unknown panel when simctl ran without `--display` and records its own default.
 */
export function iosRecordedPanel(
  device: BootedDevice | undefined,
  requested: VideoRecordingPanel | undefined,
  displayArg: string | undefined,
): VideoRecordingPanel | undefined {
  if (!requested) {
    return undefined;
  }
  if (!displayArg) {
    return UNKNOWN_PANEL;
  }
  const panel = device?.displays?.panels.find((candidate) => candidate.key === displayArg);
  return { key: displayArg, role: panel?.role ?? "unknown" };
}

/**
 * The display session a started recording tracks. On iOS a `--display` chosen by the live start
 * probe was the active panel at start, so it is both the recorded and the active panel; without
 * one, neither is known until the first observe. Other platforms keep the requested display.
 */
export function startedRecordingDisplay(
  device: Pick<BootedDevice, "platform">,
  requested: AndroidRecordingDisplay,
  recordedPanel: VideoRecordingPanel | undefined,
): AndroidRecordingDisplay {
  if (device.platform !== "ios") {
    return requested;
  }
  const panel = recordedPanel ?? requested.panel;
  return { ...requested, panel, activePanel: panel };
}

/**
 * The first known reading of an iOS recording that started with no known active panel: it learns
 * the panel and is not a transition (#17593).
 */
export function isFirstIosPanelReading(
  device: Pick<BootedDevice, "platform">,
  currentPanel: VideoRecordingPanel,
  transitions: readonly VideoRecordingDisplayTransition[],
  next: Pick<VideoRecordingPanel, "key"> | undefined,
): boolean {
  return (
    device.platform === "ios" &&
    next !== undefined &&
    next.key !== "unknown" &&
    currentPanel.key === "unknown" &&
    transitions.length === 0
  );
}

function describePanel(panel: VideoRecordingPanel): string {
  return panel.key === "unknown" ? "the starting panel" : `panel "${panel.key}" (${panel.role})`;
}

/**
 * One warning per transition: the iOS capture keeps its starting `--display`, so every frame
 * after the first transition shows a panel that may be dark.
 */
export function iosPanelTransitionWarnings(
  recordedPanel: VideoRecordingPanel,
  transitions: readonly VideoRecordingDisplayTransition[],
): string[] {
  return transitions.map(
    (transition) =>
      `iOS recording kept capturing ${describePanel(recordedPanel)} after the active display ` +
      `changed to ${describePanel(transition.to)} at ${transition.atMs}ms; frames after that ` +
      `point may show an inactive panel.`,
  );
}

function panelTransitionWarnings(session: {
  device: Pick<BootedDevice, "platform" | "displays">;
  recordedPanel: VideoRecordingPanel;
  transitions: readonly VideoRecordingDisplayTransition[];
  seededTransition?: VideoRecordingDisplayTransition;
}): string[] {
  if (session.device.platform === "ios") {
    return iosPanelTransitionWarnings(session.recordedPanel, session.transitions);
  }
  if (session.device.platform === "android") {
    return androidPanelTransitionWarnings(
      session.device.displays,
      session.recordedPanel,
      session.transitions,
      session.seededTransition,
    );
  }
  return [];
}

/** The start-time display warning, then one per panel transition the capture missed. */
export function recordingDisplayWarnings(session: {
  device: Pick<BootedDevice, "platform" | "displays">;
  warning?: string;
  recordedPanel: VideoRecordingPanel;
  transitions: readonly VideoRecordingDisplayTransition[];
  seededTransition?: VideoRecordingDisplayTransition;
}): string[] {
  return [...(session.warning ? [session.warning] : []), ...panelTransitionWarnings(session)];
}
