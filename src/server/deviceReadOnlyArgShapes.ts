/** Conservative, declarative subsets of a tool's authoritative per-call read classifier. */
export type DeviceReadOnlyArgShape =
  | { argument: string; values: readonly string[] }
  | { absentArguments: readonly string[] };

export function matchesDeviceReadOnlyArgShape(
  shape: DeviceReadOnlyArgShape,
  args: Record<string, unknown>,
): boolean {
  if ("argument" in shape) {
    const value = args[shape.argument];
    return typeof value === "string" && shape.values.includes(value);
  }
  return shape.absentArguments.every((argument) => args[argument] === undefined);
}

function isDeviceReadOnlyArgShape(value: unknown): value is DeviceReadOnlyArgShape {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  if ("argument" in value) {
    return (
      !("absentArguments" in value) &&
      typeof value.argument === "string" &&
      "values" in value &&
      Array.isArray(value.values) &&
      value.values.every((entry: unknown) => typeof entry === "string")
    );
  }
  return (
    !("values" in value) &&
    "absentArguments" in value &&
    Array.isArray(value.absentArguments) &&
    value.absentArguments.every((entry: unknown) => typeof entry === "string")
  );
}

/** Invalid wire metadata never grants read access; valid entries can still match. */
export function anyDeviceReadOnlyArgShapeMatches(
  shapes: unknown,
  args: Record<string, unknown>,
): boolean {
  return (
    Array.isArray(shapes) &&
    shapes.some(
      (shape: unknown) =>
        isDeviceReadOnlyArgShape(shape) && matchesDeviceReadOnlyArgShape(shape, args),
    )
  );
}
