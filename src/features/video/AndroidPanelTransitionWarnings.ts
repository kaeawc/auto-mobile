import type {
  DeviceDisplays,
  VideoRecordingDisplayTransition,
  VideoRecordingPanel,
} from "../../models";

type PanelSize = { width: number; height: number };

function panelSize(
  displays: DeviceDisplays | undefined,
  panel: VideoRecordingPanel,
): PanelSize | undefined {
  const size = displays?.panels.find((candidate) => candidate.key === panel.key)?.sizePx;
  return size && size.width > 0 && size.height > 0 ? size : undefined;
}

function describe(panel: VideoRecordingPanel, size: PanelSize | undefined): string {
  if (panel.key === "unknown") {
    return "an unresolved panel";
  }
  return `panel "${panel.key}" (${panel.role}${size ? `, ${size.width}x${size.height}` : ""})`;
}

function sameSize(a: PanelSize | undefined, b: PanelSize | undefined): boolean {
  return a !== undefined && b !== undefined && a.width === b.width && a.height === b.height;
}

/**
 * One warning per mid-recording move of the active display away from the recorded panel.
 * Android screenrecord fixes its output size at start, so frames after a fold to a panel of
 * another size are cropped or letterboxed (#17753). A transition seeded at start (the caller
 * chose a non-active panel) is deliberate and is not warned about.
 */
export function androidPanelTransitionWarnings(
  displays: DeviceDisplays | undefined,
  recordedPanel: VideoRecordingPanel,
  transitions: readonly VideoRecordingDisplayTransition[],
  seeded?: VideoRecordingDisplayTransition,
): string[] {
  const recordedSize = panelSize(displays, recordedPanel);
  return transitions.flatMap((transition, index) => {
    if (transition === seeded || transition.to.key === recordedPanel.key) {
      return [];
    }
    const toSize = panelSize(displays, transition.to);
    const next = transitions[index + 1];
    const span = next
      ? `from ${transition.atMs}ms to ${next.atMs}ms`
      : `after ${transition.atMs}ms`;
    const effect = sameSize(recordedSize, toSize)
      ? "may show an inactive panel"
      : `are cropped or letterboxed to the recorded ${recordedSize ? `${recordedSize.width}x${recordedSize.height} ` : ""}size`;
    return [
      `Android recording kept capturing ${describe(recordedPanel, recordedSize)} after the ` +
        `active display changed to ${describe(transition.to, toSize)} at ${transition.atMs}ms; ` +
        `frames ${span} ${effect}. Stop the recording before setPosture or a fold and start a ` +
        `new one after it to capture the new panel at its full size.`,
    ];
  });
}
