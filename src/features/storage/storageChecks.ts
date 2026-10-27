import { ActionableError } from "../../models/ActionableError";
import type { KeyValueType } from "./storageTypes";

// Types only valid on Android
const ANDROID_ONLY_TYPES = new Set<string>(["LONG", "STRING_SET"]);

// Types only valid on iOS
const IOS_ONLY_TYPES = new Set<string>(["DOUBLE", "DATA", "DATE", "ARRAY", "DICTIONARY"]);

// Guidance messages for cross-platform type errors
const TYPE_GUIDANCE: Record<string, string> = {
  // Android-only types on iOS
  "ios:LONG": "LONG is Android-only. On iOS, use INT for integer values.",
  "ios:STRING_SET": "STRING_SET is Android-only. On iOS, use ARRAY for collections of strings.",
  // iOS-only types on Android
  "android:DOUBLE": "DOUBLE is iOS-only. On Android, use FLOAT for decimal values.",
  "android:DATA":
    "DATA is iOS-only and stores raw binary data (base64 encoded). Not available on Android.",
  "android:DATE":
    "DATE is iOS-only and stores ISO 8601 date strings. On Android, store dates as STRING or LONG (epoch millis).",
  "android:ARRAY":
    "ARRAY is iOS-only. On Android, use STRING_SET for string collections, or store JSON as STRING.",
  "android:DICTIONARY": "DICTIONARY is iOS-only. On Android, store JSON objects as STRING.",
};

/**
 * Validate that the type is supported on the given platform. Throws ActionableError with guidance if not.
 *
 * Exported so the daemon `ide/*` socket key-value handlers can enforce the same
 * cross-platform type guidance as the MCP-tool path, without duplicating the
 * platform-specific type sets (issue #5022).
 */
export function validateTypeForPlatform(platform: string, type: KeyValueType): void {
  if (type === "UNKNOWN") {
    throw new ActionableError(
      "UNKNOWN type is read-only and cannot be used for write operations. " +
        "Specify an explicit type (STRING, INT, BOOLEAN, etc.).",
    );
  }

  if (platform === "ios" && ANDROID_ONLY_TYPES.has(type)) {
    const guidance = TYPE_GUIDANCE[`ios:${type}`] || `${type} is not supported on iOS.`;
    throw new ActionableError(guidance);
  }

  if (platform === "android" && IOS_ONLY_TYPES.has(type)) {
    const guidance = TYPE_GUIDANCE[`android:${type}`] || `${type} is not supported on Android.`;
    throw new ActionableError(guidance);
  }
}

/** @internal Preserve any existing warning before adding the set-only override guidance. */
export function preferenceSetWarning(
  existingWarning: string | undefined,
  effectiveValueDiffers?: boolean,
): string | undefined {
  return (
    [
      existingWarning,
      effectiveValueDiffers === true
        ? "The value was written to the app's persistent store but the effective value read by the app differs (for example a launch argument, managed configuration or other override). The write persisted."
        : undefined,
    ]
      .filter(Boolean)
      .join(" ") || undefined
  );
}
