import { parsePlist, PlistReal, type PlistValue } from "./XctestrunPlist";

/** Convert a parsed plist value to plain JSON-like data (dates stay `Date`, data becomes base64). */
export const plistValueToSigningValue = (value: PlistValue): unknown => {
  if (value instanceof Map) {
    return Object.fromEntries(
      [...value.entries()].map(([key, child]) => [key, plistValueToSigningValue(child)]),
    );
  }
  if (Array.isArray(value)) {
    return value.map(plistValueToSigningValue);
  }
  if (value instanceof PlistReal) {
    return value.value;
  }
  if (Buffer.isBuffer(value)) {
    return value.toString("base64");
  }
  return value;
};

/** The fields of a decoded provisioning profile (`security cms -D` output) that callers read. */
export interface ProvisioningProfileFields {
  uuid: string;
  name: string;
  teamIds: string[];
  teamName?: string;
  /** Invalid when the profile carries no parseable ExpirationDate; check with `getTime()`. */
  expirationDate: Date;
  creationDate?: Date;
  provisionsAllDevices: boolean;
  provisionedDevices: string[] | null;
  entitlements: Record<string, unknown>;
  /** The whole profile as plain data, for fields not lifted above. */
  data: Record<string, unknown>;
}

const toDate = (value: unknown): Date | undefined => {
  if (value instanceof Date) {
    return value;
  }
  return value ? new Date(String(value)) : undefined;
};

/**
 * Parse decoded provisioning-profile XML. Returns null when the payload is not a plist
 * dictionary; throws when the XML itself is malformed (the plist parser's error).
 */
export async function parseProvisioningProfileXml(
  xml: string,
): Promise<ProvisioningProfileFields | null> {
  const plist = await parsePlist(xml);
  if (!plist || typeof plist !== "object") {
    return null;
  }
  const data = plistValueToSigningValue(plist as PlistValue) as Record<string, unknown>;
  return {
    uuid: String(data.UUID ?? ""),
    name: String(data.Name ?? ""),
    teamIds: Array.isArray(data.TeamIdentifier) ? data.TeamIdentifier.map(String) : [],
    teamName: typeof data.TeamName === "string" ? data.TeamName : undefined,
    expirationDate: toDate(data.ExpirationDate) ?? new Date(Number.NaN),
    creationDate: toDate(data.CreationDate),
    provisionsAllDevices: data.ProvisionsAllDevices === true,
    provisionedDevices: Array.isArray(data.ProvisionedDevices)
      ? data.ProvisionedDevices.map(String)
      : null,
    entitlements:
      typeof data.Entitlements === "object" && data.Entitlements
        ? (data.Entitlements as Record<string, unknown>)
        : {},
    data,
  };
}
