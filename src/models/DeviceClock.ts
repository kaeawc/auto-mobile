/** Inclusive UTC window shared by clock execution and test-plan validation. */
export const MIN_DEVICE_CLOCK_INSTANT_MS = Date.parse("2000-01-01T00:00:00Z");
export const MAX_DEVICE_CLOCK_INSTANT_MS = Date.parse("2100-01-01T00:00:00Z");

export function clockInstantInWindow(value: number): boolean {
  return value >= MIN_DEVICE_CLOCK_INSTANT_MS && value <= MAX_DEVICE_CLOCK_INSTANT_MS;
}

/** Date.parse truncates fractions to milliseconds; do not admit a fraction above the inclusive end. */
export function clockInstantTextInWindow(instant: string): boolean {
  const milliseconds = Date.parse(instant);
  if (!clockInstantInWindow(milliseconds)) {
    return false;
  }
  const fraction = /\.(\d+)/.exec(instant)?.[1] ?? "";
  return milliseconds !== MAX_DEVICE_CLOCK_INSTANT_MS || !/[1-9]/.test(fraction);
}
