import contract from "../../../schemas/prototype-spec-contract.json";
import { fail, object, type PrototypeValidationError } from "./prototypeBindingValidation";
import { prototypeContractPatterns } from "./prototypeContractPatterns";
import { jsonCost } from "./prototypeJsonCost";

/** A data leaf: a string, a boolean or a finite number. */
export function isPrototypeDataScalar(value: unknown): boolean {
  return (
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}
export function keyPath(path: string, key: string): string {
  if (prototypeContractPatterns.pathKey.test(key)) {
    return path ? `${path}.${key}` : key;
  }
  return `${path || "$"}[${JSON.stringify(key)}]`;
}
/** Data uses the emit payload cost after its own stricter depth-first walk. */
export function prototypeDataError(
  value: unknown,
  maxBytes: number = contract.limits.MAX_PROTOTYPE_DATA_BYTES,
  maxArrayItems: number = contract.limits.MAX_PROTOTYPE_DATA_ARRAY_ITEMS,
): PrototypeValidationError | undefined {
  if (!object(value)) {
    return fail("data", "Expected object");
  }
  return (
    walkDataValue(value, "data", { depth: 1, maxArrayItems }) ??
    (jsonCost(value) > maxBytes ? fail("data", "Data byte limit exceeded") : undefined)
  );
}
function dataChildren(value: unknown, path: string): { value: unknown; path: string }[] {
  if (Array.isArray(value)) {
    return value.map((child, index) => ({ value: child, path: `${path}[${index}]` }));
  }
  const data = object(value) ?? {};
  return Object.keys(data)
    .sort()
    .map((key) => ({ value: data[key], path: keyPath(path, key) }));
}
function walkDataValue(
  value: unknown,
  path: string,
  { depth, maxArrayItems }: { depth: number; maxArrayItems: number },
): PrototypeValidationError | undefined {
  if (!Array.isArray(value) && !object(value)) {
    return isPrototypeDataScalar(value) ? undefined : fail(path, "Invalid data value");
  }
  if (depth > contract.limits.MAX_PROTOTYPE_DATA_DEPTH) {
    return fail(path, "Data depth limit exceeded");
  }
  if (Array.isArray(value) && value.length > maxArrayItems) {
    return fail(path, "Data array limit exceeded");
  }
  for (const child of dataChildren(value, path)) {
    const error = walkDataValue(child.value, child.path, { depth: depth + 1, maxArrayItems });
    if (error) {
      return error;
    }
  }
  return undefined;
}
