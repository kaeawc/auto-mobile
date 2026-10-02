/** Append up to the character limit, keeping the head and dropping any excess tail. */
export function appendBounded(
  current: string,
  next: string,
  maximum: number,
): { value: string; truncated: boolean } {
  const available = maximum - current.length;
  if (available <= 0) {
    return { value: current, truncated: next.length > 0 };
  }
  if (next.length <= available) {
    return { value: current + next, truncated: false };
  }
  return { value: current + next.slice(0, available), truncated: true };
}
