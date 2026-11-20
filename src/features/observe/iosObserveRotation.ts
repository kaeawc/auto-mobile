type ScreenSize = { width: number; height: number };

const isCardinalRotation = (value: number | undefined): value is number =>
  Number.isInteger(value) && value! >= 0 && value! <= 3;

const isUsableSize = (size: ScreenSize): boolean =>
  [size.width, size.height].every((value) => Number.isFinite(value) && value > 0);

/**
 * The rotation the runner's own geometry (and so its tap conversion) uses: its interface
 * rotation, except landscape on a fixed portrait display, which resolves to 0. A runner portrait
 * on a landscape-shaped screen is kept, so a runner still lagging after an unfold stays visible
 * to callers that compare it with observe (#18245).
 */
export function resolveIosRunnerRotation(
  runnerRotation: number | undefined,
  screenSize: ScreenSize | undefined,
): number | undefined {
  if (!screenSize || !isUsableSize(screenSize)) {
    return isCardinalRotation(runnerRotation) ? runnerRotation : undefined;
  }
  const portrait = screenSize.width < screenSize.height;
  if (isCardinalRotation(runnerRotation) && !(portrait && runnerRotation % 2 === 1)) {
    return runnerRotation;
  }
  return portrait ? 0 : 1;
}

/**
 * Prefer the runner's interface rotation unless the observed screen shape contradicts it.
 * A runner landscape on a portrait-shaped screen (fixed portrait display) resolves to 0, and a
 * runner portrait on a landscape-shaped screen resolves to 1 only on a multi-panel device (a stale
 * rotation on a Duo inner panel right after an unfold, #18831); a single-panel device keeps it, since
 * an iPad floating window is legitimately landscape-shaped in a portrait display. Square screens keep the runner's rotation.
 * Without cardinal runner evidence, size distinguishes only portrait (0) and landscape (1).
 * Square screens use landscape; invalid dimensions cannot establish a fallback.
 * This is observation metadata only: never synthesize hierarchy rotation used by screenshot crops.
 */
export function resolveIosObserveRotation(
  runnerRotation: number | undefined,
  screenSize: ScreenSize | undefined,
  multiPanel = false,
): number | undefined {
  const rotation = resolveIosRunnerRotation(runnerRotation, screenSize);
  const staleRunnerPortrait =
    multiPanel &&
    screenSize !== undefined &&
    isUsableSize(screenSize) &&
    screenSize.width > screenSize.height &&
    rotation !== undefined &&
    rotation % 2 === 0;
  return staleRunnerPortrait ? 1 : rotation;
}

/** True when the device reports two or more panels (a Duo), the only case with stale-rotation correction. */
export const hasMultiplePanels = (device: { displays?: { panels: readonly unknown[] } }): boolean =>
  (device.displays?.panels.length ?? 0) > 1;
