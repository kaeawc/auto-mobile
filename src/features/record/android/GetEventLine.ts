/**
 * With more than one device path, `getevent -lt` prefixes every event with the
 * path that produced it:
 *   "[   77.123456] /dev/input/event2: EV_ABS       ABS_X                00000123"
 * With a single path the prefix is absent. This splits the path off and returns
 * the line in the single-device shape that TouchFrameReconstructor parses.
 */
export function splitDeviceLine(line: string): { path: string | null; line: string } {
  const match = line.match(/^(\[\s*[\d.]+\])\s+(\/\S+?):\s+(.*)$/);
  if (!match) {
    return { path: null, line };
  }
  return { path: match[2], line: `${match[1]} ${match[3]}` };
}
