// Matches StorageInspectionPolicy.swift and SdkPreferenceRouteHandler.swift.
export const IOS_SDK_REDACTED_VALUE = "[REDACTED]";

export type IosPreferenceType =
  | "string"
  | "bool"
  | "int"
  | "float"
  | "date"
  | "data"
  | "array"
  | "dictionary"
  | "unknown";

const IOS_TYPES = new Map<string, IosPreferenceType>([
  ["int", "int"],
  ["integer", "int"],
  ["boolean", "bool"],
  ["bool", "bool"],
  ["true", "bool"],
  ["false", "bool"],
  ["real", "float"],
  ["double", "float"],
  ["float", "float"],
  ["string", "string"],
  ["date", "date"],
  ["data", "data"],
  ["array", "array"],
  ["dictionary", "dictionary"],
  ["dict", "dictionary"],
]);

/** Shared vocabulary for SDK enums, XML tags, and defaults read-type output. */
export function iosPreferenceType(type: string): IosPreferenceType {
  const name = type
    .trim()
    .toLowerCase()
    .replace(/^type is\s+/, "");
  return IOS_TYPES.get(name) ?? "unknown";
}
