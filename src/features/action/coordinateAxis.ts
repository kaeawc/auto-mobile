/** Inclusive normalized endpoint resolves just inside the half-open extent. */
export function normalizedAxis(value: number, size: number): number {
  return value === 1 ? size * (1 - Number.EPSILON) : value * size;
}

/** Addition at a nonzero origin can round an inset endpoint back onto the edge. */
export function translatedNormalizedAxis(value: number, start: number, end: number): number {
  const result = start + normalizedAxis(value, end - start);
  return result >= end
    ? Math.max(start, end - Math.max(Math.abs(end), end - start) * Number.EPSILON)
    : result;
}
