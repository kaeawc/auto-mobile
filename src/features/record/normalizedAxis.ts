/** Four decimals keep a point within a quarter pixel on a 2400 px axis without float noise. */
export function normalizedAxis(value: number, size: number): number {
  return Math.round(Math.min(1, Math.max(0, value / size)) * 10_000) / 10_000;
}
