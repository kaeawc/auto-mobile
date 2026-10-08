#!/usr/bin/env bun
/**
 * Generate the committed MDM configuration profile that pre-approves the
 * network-filter system extension and its content filter (#10595).
 *
 * The profile is release-independent: it pins the Team ID and bundle
 * identifiers only, never a version or cdhash, so one upload to an MDM keeps
 * working across every AutoMobile release and Developer ID certificate renewal.
 * The release guard (`scripts/ci/verify-network-filter-requirement.sh`) reads
 * its requirements back out of the committed profile, so a release is checked
 * against exactly what the profile approves.
 *
 * Usage:
 *   bun scripts/network-filter/generate-mdm-profile.ts          # write the profile
 *   bun scripts/network-filter/generate-mdm-profile.ts --check  # exit 1 when stale
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { AUTOMOBILE_APPLE_TEAM_ID } from "../../src/constants/appleTeam";

export interface NetworkFilterIdentity {
  teamId: string;
  containingAppBundleId: string;
  extensionBundleId: string;
}

// Bundle identifiers from ios/network-filter/Packaging/*-Info.plist (a test
// keeps them in sync).
export const NETWORK_FILTER_IDENTITY: NetworkFilterIdentity = {
  teamId: AUTOMOBILE_APPLE_TEAM_ID,
  containingAppBundleId: "dev.jasonpearson.automobile.networkfilter",
  extensionBundleId: "dev.jasonpearson.automobile.networkfilter.provider",
};

export const PROFILE_PATH = fileURLToPath(
  new URL("../../docs/assets/mdm/automobile-network-filter.mobileconfig", import.meta.url),
);

// Generated once and fixed forever: an MDM replaces an installed profile in
// place only when the identifier and UUID stay the same.
const PROFILE_IDENTIFIER = "dev.jasonpearson.automobile.mdm.network-filter";
const PROFILE_UUID = "D681C242-3D68-40E7-8057-4B23FC963CB4";
const SYSTEM_EXTENSION_POLICY_UUID = "9FBEE3E7-90FF-43FA-94C0-570AFBCB1A08";
const WEB_CONTENT_FILTER_UUID = "BD5FE8D4-4B12-49ED-B255-998F34F39EA3";

const TEAM_ID_PATTERN = /^[A-Z0-9]{10}$/;
const BUNDLE_ID_PATTERN = /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;

export type PlistValue = string | boolean | number | PlistValue[] | PlistDict;
export interface PlistDict {
  [key: string]: PlistValue;
}

/**
 * Stable designated requirement: Apple-anchored, bundle identifier, and the
 * signing team. It deliberately omits cdhash and version so it survives
 * releases and certificate renewals. Matches `ProbeSigning.peerRequirement`.
 */
export function designatedRequirement(bundleId: string, teamId: string): string {
  return `anchor apple generic and identifier "${bundleId}" and certificate leaf[subject.OU] = "${teamId}"`;
}

function validateIdentity(identity: NetworkFilterIdentity): void {
  if (!TEAM_ID_PATTERN.test(identity.teamId)) {
    throw new Error(`teamId must be a ten-character Apple Team ID, got "${identity.teamId}"`);
  }
  for (const bundleId of [identity.containingAppBundleId, identity.extensionBundleId]) {
    if (!BUNDLE_ID_PATTERN.test(bundleId)) {
      throw new Error(`"${bundleId}" is not a reverse-DNS bundle identifier`);
    }
  }
}

export function buildProfile(identity: NetworkFilterIdentity = NETWORK_FILTER_IDENTITY): PlistDict {
  validateIdentity(identity);
  const { teamId, containingAppBundleId, extensionBundleId } = identity;
  const systemExtensionPolicy: PlistDict = {
    AllowedSystemExtensions: { [teamId]: [extensionBundleId] },
    AllowedSystemExtensionTypes: { [teamId]: ["NetworkExtension"] },
    PayloadDisplayName: "AutoMobile Network Filter System Extension",
    PayloadIdentifier: `${PROFILE_IDENTIFIER}.system-extension-policy`,
    PayloadType: "com.apple.system-extension-policy",
    PayloadUUID: SYSTEM_EXTENSION_POLICY_UUID,
    PayloadVersion: 1,
  };
  const webContentFilter: PlistDict = {
    FilterDataProviderBundleIdentifier: extensionBundleId,
    FilterDataProviderDesignatedRequirement: designatedRequirement(extensionBundleId, teamId),
    FilterPackets: false,
    FilterSockets: true,
    FilterType: "Plugin",
    PayloadDisplayName: "AutoMobile Network Filter Content Filter",
    PayloadIdentifier: `${PROFILE_IDENTIFIER}.webcontent-filter`,
    PayloadType: "com.apple.webcontent-filter",
    PayloadUUID: WEB_CONTENT_FILTER_UUID,
    PayloadVersion: 1,
    PluginBundleID: containingAppBundleId,
    UserDefinedName: "AutoMobile Network Filter",
  };
  return {
    PayloadContent: [systemExtensionPolicy, webContentFilter],
    PayloadDescription:
      "Pre-approves the AutoMobile network-filter system extension and its content filter. " +
      "Deliver through MDM: a user-installed profile does not pre-approve system extensions.",
    PayloadDisplayName: "AutoMobile Network Filter",
    PayloadIdentifier: PROFILE_IDENTIFIER,
    PayloadOrganization: "AutoMobile",
    PayloadScope: "System",
    PayloadType: "Configuration",
    PayloadUUID: PROFILE_UUID,
    PayloadVersion: 1,
  };
}

// XML 1.0 rejects these code points outright; escaping cannot represent them.
// oxlint-disable-next-line no-control-regex -- matching control characters is the point.
const INVALID_XML_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/;

export function escapeXmlText(text: string): string {
  if (INVALID_XML_CHARS.test(text)) {
    throw new Error(
      `Plist string contains a character XML 1.0 cannot represent: ${JSON.stringify(text)}`,
    );
  }
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function serializeValue(value: PlistValue, depth: number): string[] {
  const indent = "\t".repeat(depth);
  if (typeof value === "string") {
    return [`${indent}<string>${escapeXmlText(value)}</string>`];
  }
  if (typeof value === "boolean") {
    return [`${indent}<${value ? "true" : "false"}/>`];
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new Error(`Only safe integers are supported in plists, got ${value}`);
    }
    return [`${indent}<integer>${value}</integer>`];
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return [`${indent}<array/>`];
    }
    return [
      `${indent}<array>`,
      ...value.flatMap((item) => serializeValue(item, depth + 1)),
      `${indent}</array>`,
    ];
  }
  // Sort keys like `plutil -convert xml1` so output does not depend on
  // construction order.
  const keys = Object.keys(value).sort();
  if (keys.length === 0) {
    return [`${indent}<dict/>`];
  }
  return [
    `${indent}<dict>`,
    ...keys.flatMap((key) => [
      `${indent}\t<key>${escapeXmlText(key)}</key>`,
      ...serializeValue(value[key], depth + 1),
    ]),
    `${indent}</dict>`,
  ];
}

/** Serialize to an Apple XML property list, tab-indented like `plutil -convert xml1`. */
export function serializePlist(root: PlistValue): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    ...serializeValue(root, 0),
    "</plist>",
    "",
  ].join("\n");
}

export function renderProfile(identity: NetworkFilterIdentity = NETWORK_FILTER_IDENTITY): string {
  return serializePlist(buildProfile(identity));
}

if (import.meta.main) {
  const rendered = renderProfile();
  if (process.argv.includes("--check")) {
    if (readFileSync(PROFILE_PATH, "utf8") !== rendered) {
      console.error(
        `${PROFILE_PATH} is stale; run bun scripts/network-filter/generate-mdm-profile.ts`,
      );
      process.exit(1);
    }
  } else {
    writeFileSync(PROFILE_PATH, rendered);
    console.log(`Wrote ${PROFILE_PATH}`);
  }
}
