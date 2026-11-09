import type {
  BootedDevice,
  VideoRecordingDisplayTransition,
  VideoRecordingPanel,
} from "../../models";
import { isPhysicalPanel } from "../../models/DisplayPanel";
import type { AndroidRecordingDisplay } from "./AndroidRecordingDisplay";

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
