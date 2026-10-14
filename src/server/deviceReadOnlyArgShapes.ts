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

function isNonEmptyStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((entry: unknown) => typeof entry === "string")
  );
}

function isArgumentShape(value: object): boolean {
  return (
    "argument" in value &&
    !("absentArguments" in value) &&
    typeof value.argument === "string" &&
    value.argument.length > 0 &&
    "values" in value &&
    isNonEmptyStringArray(value.values)
  );
}

function isAbsentArgumentsShape(value: object): boolean {
  return (
    "absentArguments" in value &&
    !("values" in value) &&
    isNonEmptyStringArray(value.absentArguments)
  );
}

function isDeviceReadOnlyArgShape(value: unknown): value is DeviceReadOnlyArgShape {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  return isArgumentShape(value) || isAbsentArgumentsShape(value);
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
