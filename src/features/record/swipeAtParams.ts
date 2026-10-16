export interface ScreenSize {
  width: number;
  height: number;
}

interface NativePoint {
  x: number;
  y: number;
}

/** Four decimals keep a point within a quarter pixel on a 2400 px axis without float noise. */
function fractionOf(value: number, size: number): number {
  return Math.round(Math.min(1, Math.max(0, value / size)) * 10_000) / 10_000;
}

function hasPositiveSize(screen: ScreenSize | undefined): screen is ScreenSize {
  return !!screen && screen.width > 0 && screen.height > 0;
}

/**
 * `swipeAt` params for a recorded swipe: fractions of the screen it was made on, so replay adapts to
 * another screen size and a digitizer-edge touch that maps to exactly the display size stays
 * replayable (1 resolves to the last pixel). Native pixels are kept only when the screen is unknown.
 */
export function recordedSwipeAtParams(
  endpoints: { from: NativePoint; to: NativePoint },
  screen: ScreenSize | undefined,
): Record<string, unknown> {
  if (!hasPositiveSize(screen)) {
    return { from: endpoints.from, to: endpoints.to };
  }
  const normalize = (point: NativePoint): NativePoint => ({
    x: fractionOf(point.x, screen.width),
    y: fractionOf(point.y, screen.height),
  });
  return {
    from: normalize(endpoints.from),
    to: normalize(endpoints.to),
    coordinateSpace: "normalized",
  };
}
