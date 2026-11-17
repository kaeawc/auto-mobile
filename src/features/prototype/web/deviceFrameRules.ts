import type { DeviceFrame, DeviceFramePanel } from "./deviceFrameSchema";

/**
 * The cross-field rules of a device frame that a schema cannot state: a cutout or hinge inside its
 * panel, insets that leave a screen, one panel per role and one entry per posture. Zod-free, so
 * the registry test and the web library's frame-object check (#16453) share them.
 */
type Insets = DeviceFramePanel["safeArea"]["portrait"];

function cutoutOutsideScreen(panel: DeviceFramePanel): boolean {
  const { cutout, screen } = panel;
  if (cutout.type === "none") {
    return false;
  }
  const [halfWidth, halfHeight] =
    cutout.type === "punchHole"
      ? [cutout.radiusDp, cutout.radiusDp]
      : [cutout.widthDp / 2, cutout.heightDp / 2];
  return (
    cutout.centerXDp - halfWidth < 0 ||
    cutout.centerXDp + halfWidth > screen.widthDp ||
    cutout.centerYDp - halfHeight < 0 ||
    cutout.centerYDp + halfHeight > screen.heightDp
  );
}

function leavesNoScreen(inset: Insets, width: number, height: number): boolean {
  return inset.left + inset.right >= width || inset.top + inset.bottom >= height;
}

function panelProblems(panel: DeviceFramePanel, path: string): string[] {
  const { widthDp, heightDp } = panel.screen;
  return [
    cutoutOutsideScreen(panel) ? `${path}.cutout: lies outside the portrait screen` : undefined,
    leavesNoScreen(panel.safeArea.portrait, widthDp, heightDp)
      ? `${path}.safeArea.portrait: insets leave no screen`
      : undefined,
    leavesNoScreen(panel.safeArea.landscape, heightDp, widthDp)
      ? `${path}.safeArea.landscape: insets leave no screen`
      : undefined,
  ].filter((problem): problem is string => problem !== undefined);
}

/** Panel 0 is the top-level fields; the rest are `panels[i - 1]` in the JSON entry. */
function panelPath(path: string, index: number): string {
  return index === 0 ? path : `${path}.panels[${index - 1}]`;
}

function hingeProblems(frame: DeviceFrame, path: string): string[] {
  const { hinge } = frame;
  if (!hinge) {
    return [];
  }
  const panel = frame.panels.find((candidate) => candidate.role === hinge.panel);
  if (!panel) {
    return [`${path}.hinge.panel: the frame has no "${hinge.panel}" panel`];
  }
  const extent = hinge.axis === "vertical" ? panel.screen.widthDp : panel.screen.heightDp;
  const within = hinge.positionDp > 0 && hinge.positionDp + hinge.widthDp < extent;
  return within ? [] : [`${path}.hinge: lies outside its "${hinge.panel}" panel`];
}

function postureProblems(frame: DeviceFrame, path: string): string[] {
  const roles = new Set(frame.panels.map((panel) => panel.role));
  const seen = new Set<string>();
  return frame.postures.flatMap((entry, index) => {
    const entryPath = `${path}.postures[${index}]`;
    const duplicate = seen.has(entry.posture)
      ? [`${entryPath}.posture: duplicate posture "${entry.posture}"`]
      : [];
    seen.add(entry.posture);
    const missing = roles.has(entry.panel)
      ? []
      : [`${entryPath}.panel: the frame has no "${entry.panel}" panel`];
    return [...duplicate, ...missing];
  });
}

function duplicatePanelProblems(frame: DeviceFrame, path: string): string[] {
  const seen = new Set<string>();
  return frame.panels.flatMap((panel, index) => {
    const duplicate = seen.has(panel.role)
      ? [`${panelPath(path, index)}.role: duplicate panel role "${panel.role}"`]
      : [];
    seen.add(panel.role);
    return duplicate;
  });
}

/** Every geometry rule `frame` breaks, each prefixed with `path`; empty when it is drawable. */
export function deviceFrameGeometryProblems(frame: DeviceFrame, path: string): string[] {
  return [
    ...duplicatePanelProblems(frame, path),
    ...frame.panels.flatMap((panel, index) => panelProblems(panel, panelPath(path, index))),
    ...hingeProblems(frame, path),
    ...postureProblems(frame, path),
  ];
}
