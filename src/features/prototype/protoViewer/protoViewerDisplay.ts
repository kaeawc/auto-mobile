import type { DeviceDisplays, PanelRole } from "../../../models/DisplayPanel";

/** The panel of a multi-screen device that a ProtoViewer save or open landed on. */
export interface ProtoViewerDisplay {
  key: string;
  role: PanelRole;
}

/**
 * Maps the app's reported screen (native pixels "WxH", orientation-agnostic) onto the host's display
 * inventory. Only a multi-panel device with exactly one matching panel yields an answer: a
 * single-screen device keeps its payload unchanged, and an ambiguous size is left unreported rather
 * than guessed.
 */
export function protoViewerDisplayFor(
  screen: string | undefined,
  displays: DeviceDisplays | undefined,
): ProtoViewerDisplay | undefined {
  const match = screen === undefined ? null : /^(\d+)x(\d+)$/.exec(screen);
  if (match === null || displays === undefined || displays.panels.length < 2) {
    return undefined;
  }
  const width = Number(match[1]);
  const height = Number(match[2]);
  const matches = displays.panels.filter(
    ({ sizePx }) =>
      (sizePx.width === width && sizePx.height === height) ||
      (sizePx.width === height && sizePx.height === width),
  );
  return matches.length === 1 ? { key: matches[0].key, role: matches[0].role } : undefined;
}
