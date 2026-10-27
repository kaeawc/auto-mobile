import type { IosInstalledAppRecord } from "./iosInstalledApp";

function isRecord(value: unknown): value is IosInstalledAppRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parses `xcrun simctl listapps` output (JSON, or plist already converted to JSON); the one
 * place its payload is parsed. simctl answers with a dictionary keyed by bundle id, so each
 * entry is returned with that key as `bundleId`; an array answer passes through, keeping only
 * record entries. Throws on malformed JSON so callers can retry or report the failure.
 */
export function parseSimctlListApps(payload: string): IosInstalledAppRecord[] {
  const data: unknown = JSON.parse(payload);
  if (Array.isArray(data)) {
    return data.filter(isRecord);
  }
  if (!isRecord(data)) {
    return [];
  }
  return Object.entries(data).map(([bundleId, appInfo]) => ({
    ...(isRecord(appInfo) ? appInfo : {}),
    bundleId,
  }));
}
