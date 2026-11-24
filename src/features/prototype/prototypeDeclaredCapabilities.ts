import { record } from "./prototypeTemplate";

/** Explicit capabilities share the same meaning in both root requires forms. */
export function prototypeDeclaredCapabilities(requires: unknown): string[] {
  const values = Array.isArray(requires) ? requires : record(requires)?.capabilities;
  return Array.isArray(values)
    ? values.filter((value): value is string => typeof value === "string")
    : [];
}
