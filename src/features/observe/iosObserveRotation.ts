/**
 * Prefer the runner's interface rotation, except landscape on a fixed portrait display.
 * Without cardinal runner evidence, size distinguishes only portrait (0) and landscape (1).
 * Square screens use landscape; invalid dimensions cannot establish a fallback.
 * This is observation metadata only: never synthesize hierarchy rotation used by screenshot crops.
 */
export function resolveIosObserveRotation(
  runnerRotation: number | undefined,
  screenSize: { width: number; height: number },
): number | undefined {
  const validRotation =
    Number.isInteger(runnerRotation) && runnerRotation! >= 0 && runnerRotation! <= 3;
  const validSize = [screenSize.width, screenSize.height].every(
    (value) => Number.isFinite(value) && value > 0,
  );
  const portrait = screenSize.width < screenSize.height;
  const fixedPortraitDisplay =
    validSize && portrait && (runnerRotation === 1 || runnerRotation === 3);
  if (validRotation && !fixedPortraitDisplay) {
    return runnerRotation;
  }
  return validSize ? (portrait ? 0 : 1) : undefined;
}
