export type SimctlVersionTuple = [major: number, minor: number, patch: number];

/** Parse a dotted CoreSimulator version into a fixed three-component tuple. */
export function parseSimctlVersion(version: string | undefined): SimctlVersionTuple | undefined {
  if (!version?.trim()) {
    return undefined;
  }
  const parts = version.trim().split(".");
  if (parts.length > 3 || parts.some((part) => !/^\d+$/.test(part))) {
    return undefined;
  }
  const numbers = parts.map((part) => Number(part));
  return numbers.every(Number.isSafeInteger)
    ? [numbers[0] ?? 0, numbers[1] ?? 0, numbers[2] ?? 0]
    : undefined;
}

/** Decode the packed version integer emitted by `simctl list devicetypes -j`. */
export function decodeSimctlVersion(value: number | undefined): SimctlVersionTuple | undefined {
  if (value === undefined || !Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) {
    return undefined;
  }
  if (value === 0xffffffff) {
    return [Number.POSITIVE_INFINITY, 0, 0];
  }
  return [Math.floor(value / 0x10000), Math.floor(value / 0x100) % 0x100, value % 0x100];
}

/** Compare two normalized CoreSimulator version tuples component by component. */
export function compareSimctlVersions(left: SimctlVersionTuple, right: SimctlVersionTuple): number {
  for (let index = 0; index < 3; index++) {
    const difference = left[index] - right[index];
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
}
