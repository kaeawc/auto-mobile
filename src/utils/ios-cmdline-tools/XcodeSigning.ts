import { errorMessage } from "../describeUnknownError";
import { promises as fs } from "fs";
import { homedir } from "os";
import { join } from "path";
import { createHash, X509Certificate } from "crypto";
import { logger } from "../logger";
import { Xcodebuild, XcodebuildClient } from "./XcodebuildClient";
import { escapeXml, parsePlist, PlistReal, type PlistValue } from "./XctestrunPlist";
import { resolvePathFromDaemonLaunchWorkingDirectory } from "../workingDirectory";
import { SecurityClient, type SecurityClientApi } from "./SecurityClient";
import { defaultTimer, Timer } from "../SystemTimer";
import { raceWithDeadline } from "../raceWithDeadline";
import { getAbortSignal } from "../AbortContext";
import { getSharedAutoMobileDir } from "../tempDir";

type SigningStyle = "automatic" | "manual";

// Bound on the xcodebuild availability probe inside detectTeamIdsFromXcode
// (issue #6585): a stalled `xcodebuild -version` must never block callers
// (e.g. physical-device CtrlProxy startup) indefinitely, regardless of
// whether the underlying Xcodebuild dependency enforces its own timeout.
const XCODEBUILD_AVAILABILITY_PROBE_TIMEOUT_MS = 10_000;

interface SigningIdentity {
  name: string;
  fingerprint: string;
  validTo?: Date;
  subject?: string;
  issuer?: string;
}

interface CertificateInfo {
  fingerprint: string;
  validTo?: Date;
  subject?: string;
  issuer?: string;
}

interface ProvisioningProfile {
  uuid: string;
  name: string;
  teamIds: string[];
  teamName?: string;
  expirationDate: Date;
  creationDate?: Date;
  provisionsAllDevices: boolean;
  provisionedDevices: string[] | null;
  entitlements: Record<string, unknown>;
  developerCertificates: CertificateInfo[];
  profileType: "development" | "distribution" | "ad-hoc" | "enterprise" | "unknown";
  path: string;
}

interface SigningResolution {
  style: SigningStyle;
  teamId?: string;
  identity?: SigningIdentity;
  profile?: ProvisioningProfile;
  entitlementsPath?: string;
  buildSettings: string[];
  allowProvisioningUpdates: boolean;
  warnings: string[];
}

const plistValueToSigningValue = (value: PlistValue): unknown => {
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

interface XcodeSigningDependencies {
  platform: () => NodeJS.Platform;
  securityClient: SecurityClientApi;
  xcodebuild: Xcodebuild;
  readDir: (path: string) => Promise<string[]>;
  readFile: (path: string) => Promise<string>;
  stat: (path: string) => Promise<{ isFile: () => boolean }>;
  writeFile: (path: string, data: string) => Promise<void>;
  mkdir: (path: string) => Promise<void>;
  homedir: () => string;
  now: () => number;
  timer?: Timer;
}

const createDefaultDependencies = (): XcodeSigningDependencies => ({
  platform: () => process.platform,
  securityClient: new SecurityClient(),
  xcodebuild: new XcodebuildClient(),
  readDir: async (path) => fs.readdir(path),
  readFile: async (path) => fs.readFile(path, "utf-8"),
  stat: async (path) => fs.stat(path),
  writeFile: async (path, data) => fs.writeFile(path, data, "utf-8"),
  mkdir: async (path) => {
    await fs.mkdir(path, { recursive: true });
  },
  homedir,
  now: () => Date.now(),
  timer: defaultTimer,
});

const fingerprintFromCertificate = (base64Der: string): CertificateInfo | null => {
  try {
    const raw = Buffer.from(base64Der, "base64");
    const cert = new X509Certificate(raw);
    const fingerprint = createHash("sha256").update(cert.raw).digest("hex").toUpperCase();
    return {
      fingerprint,
      validTo: new Date(cert.validTo),
      subject: cert.subject,
      issuer: cert.issuer,
    };
  } catch (error) {
    logger.warn(`[XcodeSigning] Failed to parse certificate: ${errorMessage(error)}`);
    return null;
  }
};

const resolveProfileType = (
  entitlements: Record<string, unknown>,
  provisionsAllDevices: boolean,
  provisionedDevices: string[] | null,
): ProvisioningProfile["profileType"] => {
  if (provisionsAllDevices) {
    return "enterprise";
  }
  if (provisionedDevices && provisionedDevices.length > 0) {
    return entitlements["get-task-allow"] === true ? "development" : "ad-hoc";
  }
  return "distribution";
};

const isCertificateExpired = (certificate: CertificateInfo, now: number): boolean => {
  if (!certificate.validTo) {
    return false;
  }
  return certificate.validTo.getTime() <= now;
};

const isAppleIssuer = (certificate: CertificateInfo): boolean => {
  return Boolean(certificate.issuer?.toLowerCase().includes("apple"));
};

const formatBuildSettingValue = (value: string): string => {
  if (value.includes('"') || value.includes("\\")) {
    const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    return `"${escaped}"`;
  }
  if (value.includes(" ") || value.includes("\t")) {
    return `"${value}"`;
  }
  return value;
};

const buildSetting = (key: string, value: string): string =>
  `${key}=${formatBuildSettingValue(value)}`;

const buildSettingsForManual = (
  teamId: string | undefined,
  identity: SigningIdentity | undefined,
  profile: ProvisioningProfile,
  entitlementsPath?: string,
): string[] => {
  const settings: string[] = ["CODE_SIGN_STYLE=Manual"];
  if (teamId) {
    settings.push(buildSetting("DEVELOPMENT_TEAM", teamId));
  }
  if (identity) {
    settings.push(buildSetting("CODE_SIGN_IDENTITY", identity.name));
  }
  settings.push(buildSetting("PROVISIONING_PROFILE_SPECIFIER", profile.name));
  if (entitlementsPath) {
    settings.push(buildSetting("CODE_SIGN_ENTITLEMENTS", entitlementsPath));
  }
  return settings;
};

const buildSettingsForAutomatic = (teamId: string | undefined): string[] => {
  const settings: string[] = ["CODE_SIGN_STYLE=Automatic"];
  if (teamId) {
    settings.push(buildSetting("DEVELOPMENT_TEAM", teamId));
  }
  return settings;
};

const serializePlist = (value: unknown, indent: string = ""): string => {
  const nextIndent = `${indent}  `;
  if (value === null || value === undefined) {
    return `${indent}<string></string>`;
  }
  if (typeof value === "string") {
    return `${indent}<string>${escapeXml(value)}</string>`;
  }
  if (typeof value === "number") {
    return Number.isInteger(value)
      ? `${indent}<integer>${value}</integer>`
      : `${indent}<real>${value}</real>`;
  }
  if (typeof value === "boolean") {
    return `${indent}<${value ? "true" : "false"}/>`;
  }
  if (value instanceof Date) {
    return `${indent}<date>${value.toISOString()}</date>`;
  }
  if (Array.isArray(value)) {
    const items = value.map((item) => serializePlist(item, nextIndent)).join("\n");
    return `${indent}<array>\n${items}\n${indent}</array>`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    const lines = entries.map(([key, val]) => {
      const keyLine = `${nextIndent}<key>${escapeXml(key)}</key>`;
      const valueLine = serializePlist(val, nextIndent);
      return `${keyLine}\n${valueLine}`;
    });
    return `${indent}<dict>\n${lines.join("\n")}\n${indent}</dict>`;
  }
  return `${indent}<string>${escapeXml(String(value))}</string>`;
};

const entitlementsPlist = (entitlements: Record<string, unknown>): string => {
  const body = serializePlist(entitlements, "  ");
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    body,
    "</plist>",
  ].join("\n");
};

export class XcodeSigningManager {
  private readonly dependencies: XcodeSigningDependencies;

  constructor(dependencies: XcodeSigningDependencies = createDefaultDependencies()) {
    this.dependencies = dependencies;
  }

  public async listProvisioningProfiles(): Promise<ProvisioningProfile[]> {
    if (this.dependencies.platform() !== "darwin") {
      return [];
    }

    let entries: string[];
    try {
      entries = await this.dependencies.readDir(this.profileDirectory());
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
        // Automatic signing can work without a local provisioning-profile directory.
        logger.debug(
          `[XcodeSigning] No local provisioning-profile directory: ${errorMessage(error)}`,
        );
      } else {
        logger.warn(
          `[XcodeSigning] Failed to read provisioning-profile directory: ${errorMessage(error)}`,
        );
      }
      return [];
    }

    const profiles: ProvisioningProfile[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(".mobileprovision")) {
        continue;
      }
      const path = join(this.profileDirectory(), entry);
      const profile = await this.parseProvisioningProfile(path);
      if (profile) {
        profiles.push(profile);
      }
    }
    return profiles;
  }

  public async listSigningIdentities(): Promise<SigningIdentity[]> {
    if (this.dependencies.platform() !== "darwin") {
      return [];
    }
    return this.dependencies.securityClient.listCodeSigningIdentities();
  }

  public async detectTeamIdsFromXcode(): Promise<string[]> {
    const projectPath = resolvePathFromDaemonLaunchWorkingDirectory(
      join("ios", "control-proxy", "CtrlProxy.xcodeproj"),
    );
    try {
      const projectExists = await this.dependencies
        .stat(projectPath)
        .then(() => true)
        .catch((statError: unknown) => {
          // ENOENT (and ENOTDIR, when a path segment isn't a directory) mean
          // "no project here" -- the expected shape for an installed
          // (non-checkout) AutoMobile. Anything else (permissions, IO) is
          // unexpected and worth a trace rather than a silent [] (#6585 P2).
          const code = (statError as NodeJS.ErrnoException | undefined)?.code;
          if (code !== "ENOENT" && code !== "ENOTDIR") {
            logger.warn(
              `[XcodeSigning] Unexpected error checking for Xcode project at ${projectPath}: ${errorMessage(statError)}`,
            );
          }
          return false;
        });
      if (!projectExists) {
        return [];
      }

      const available = await this.probeXcodebuildAvailability();
      if (!available) {
        return [];
      }

      const result = await this.dependencies.xcodebuild.executeCommand(
        ["-showBuildSettings", "-project", projectPath, "-scheme", "AutoMobileTest"],
        { timeoutMs: 30000, maxBuffer: 10 * 1024 * 1024 },
      );
      const teams = new Set<string>();
      for (const line of result.stdout.split("\n")) {
        const match = line.match(/DEVELOPMENT_TEAM\s*=\s*([A-Z0-9]+)/);
        if (match) {
          teams.add(match[1]);
        }
      }
      return [...teams];
    } catch (error) {
      logger.warn(`[XcodeSigning] Failed to detect team IDs: ${errorMessage(error)}`);
      return [];
    }
  }

  /**
   * Bound `xcodebuild.isAvailable()` with our own timer/abort race, on top of
   * whatever timeout the injected dependency enforces internally. Callers
   * (fakes in tests, or a future dependency implementation) cannot be relied
   * on to bound themselves, and a stalled `xcodebuild -version` must never
   * block `detectTeamIdsFromXcode` -- and by extension physical-device
   * CtrlProxy startup -- indefinitely (issue #6585).
   */
  private async probeXcodebuildAvailability(): Promise<boolean> {
    const timer = this.dependencies.timer ?? defaultTimer;
    const controller = new AbortController();
    const parent = getAbortSignal();
    if (parent?.aborted) {
      return false;
    }
    const signal = parent ? AbortSignal.any([parent, controller.signal]) : controller.signal;
    try {
      return await raceWithDeadline(
        this.dependencies.xcodebuild
          .isAvailable({
            timeoutMs: XCODEBUILD_AVAILABILITY_PROBE_TIMEOUT_MS,
            signal,
          })
          .then(
            (available) => available,
            () => false,
          ),
        {
          timer,
          timeoutMs: XCODEBUILD_AVAILABILITY_PROBE_TIMEOUT_MS,
          signal: parent,
          label: "xcodebuild availability probe",
          onTimeout: () => controller.abort(),
        },
      );
    } catch (error) {
      logger.warn(
        `[XcodeSigning] xcodebuild availability probe did not complete: ${errorMessage(error)}`,
      );
      return false;
    }
  }

  public async resolveSigningForDevice(deviceUdid: string): Promise<SigningResolution> {
    const warnings: string[] = [];
    const preferredTeamIds = this.readTeamIdPreferences();
    const preferredProfile = this.readProfilePreference();
    const preferredIdentity = this.readIdentityPreference();

    const [profiles, identities, detectedTeams] = await Promise.all([
      this.listProvisioningProfiles(),
      this.listSigningIdentities(),
      this.detectTeamIdsFromXcode(),
    ]);

    const teamIds = preferredTeamIds.length > 0 ? preferredTeamIds : detectedTeams;

    let selectedProfile: ProvisioningProfile | undefined;
    if (preferredProfile) {
      selectedProfile = profiles.find(
        (profile) => profile.uuid === preferredProfile || profile.name === preferredProfile,
      );
      if (!selectedProfile) {
        warnings.push(`Requested provisioning profile '${preferredProfile}' not found`);
      }
    }

    const now = this.dependencies.now();
    if (selectedProfile && selectedProfile.expirationDate.getTime() <= now) {
      warnings.push(`Provisioning profile '${selectedProfile.name}' is expired`);
    }
    if (selectedProfile && !selectedProfile.provisionsAllDevices) {
      const matchesDevice = selectedProfile.provisionedDevices?.includes(deviceUdid) ?? false;
      if (!matchesDevice) {
        warnings.push(
          `Provisioning profile '${selectedProfile.name}' does not include device ${deviceUdid}`,
        );
      }
    }
    const eligibleProfiles = profiles.filter((profile) => {
      if (profile.expirationDate.getTime() <= now) {
        return false;
      }
      if (teamIds.length > 0 && !profile.teamIds.some((teamId) => teamIds.includes(teamId))) {
        return false;
      }
      if (profile.provisionsAllDevices) {
        return true;
      }
      return profile.provisionedDevices?.includes(deviceUdid) ?? false;
    });

    if (!selectedProfile) {
      const profileOrder: ProvisioningProfile["profileType"][] = [
        "development",
        "ad-hoc",
        "enterprise",
        "distribution",
        "unknown",
      ];
      const sorted = eligibleProfiles.sort(
        (a, b) => profileOrder.indexOf(a.profileType) - profileOrder.indexOf(b.profileType),
      );
      selectedProfile = sorted[0];
    }

    let selectedIdentity: SigningIdentity | undefined;
    if (preferredIdentity) {
      selectedIdentity = identities.find(
        (identity) =>
          identity.fingerprint === preferredIdentity.toUpperCase() ||
          identity.name.includes(preferredIdentity),
      );
      if (!selectedIdentity) {
        warnings.push(`Requested signing identity '${preferredIdentity}' not found`);
      }
    }

    if (!selectedIdentity && selectedProfile) {
      const fingerprints = new Set(
        selectedProfile.developerCertificates.map((cert) => cert.fingerprint),
      );
      selectedIdentity = identities.find((identity) => fingerprints.has(identity.fingerprint));
    }

    const resolvedTeamId = teamIds[0] ?? selectedProfile?.teamIds[0];

    if (selectedProfile && selectedIdentity) {
      const matchingCert = selectedProfile.developerCertificates.find(
        (cert) => cert.fingerprint === selectedIdentity?.fingerprint,
      );
      if (matchingCert && isCertificateExpired(matchingCert, now)) {
        warnings.push(`Signing certificate for '${selectedProfile.name}' is expired`);
      }
      if (matchingCert && !isAppleIssuer(matchingCert)) {
        warnings.push(
          `Signing certificate issuer for '${selectedProfile.name}' is not an Apple CA`,
        );
      }
      const allowTask = selectedProfile.entitlements["get-task-allow"] === true;
      if (selectedProfile.profileType === "development" && !allowTask) {
        warnings.push(
          `Development profile '${selectedProfile.name}' missing get-task-allow entitlement`,
        );
      }
      if (selectedProfile.profileType === "distribution" && allowTask) {
        warnings.push(`Distribution profile '${selectedProfile.name}' enables get-task-allow`);
      }
      const entitlementsPath = await this.writeEntitlementsIfNeeded(selectedProfile);
      return {
        style: "manual",
        teamId: resolvedTeamId,
        identity: selectedIdentity,
        profile: selectedProfile,
        entitlementsPath,
        buildSettings: buildSettingsForManual(
          resolvedTeamId,
          selectedIdentity,
          selectedProfile,
          entitlementsPath,
        ),
        allowProvisioningUpdates: false,
        warnings,
      };
    }

    if (selectedProfile && !selectedIdentity) {
      warnings.push(`No matching signing identity for profile '${selectedProfile.name}'`);
    }

    if (!selectedProfile) {
      warnings.push("No matching provisioning profile found for device");
    }
    const buildSettings = buildSettingsForAutomatic(resolvedTeamId);
    return {
      style: "automatic",
      teamId: resolvedTeamId,
      buildSettings,
      allowProvisioningUpdates: true,
      warnings,
    };
  }

  private readTeamIdPreferences(): string[] {
    const raw = process.env.AUTOMOBILE_IOS_TEAM_IDS ?? process.env.AUTOMOBILE_IOS_TEAM_ID ?? "";
    if (!raw) {
      return [];
    }
    return raw
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
  }

  private readProfilePreference(): string | null {
    const value =
      process.env.AUTOMOBILE_IOS_PROFILE_UUID ??
      process.env.AUTOMOBILE_IOS_PROFILE_NAME ??
      process.env.AUTOMOBILE_IOS_PROFILE_SPECIFIER;
    return value?.trim() || null;
  }

  private readIdentityPreference(): string | null {
    const value = process.env.AUTOMOBILE_IOS_CODE_SIGN_IDENTITY ?? "";
    return value.trim().length > 0 ? value.trim() : null;
  }

  private async parseProvisioningProfile(path: string): Promise<ProvisioningProfile | null> {
    try {
      const decoded = await this.dependencies.securityClient.decodeCms(path);
      const plist = await parsePlist(decoded);
      if (!plist || typeof plist !== "object") {
        return null;
      }
      const data = plistValueToSigningValue(plist as PlistValue) as Record<string, unknown>;
      const uuid = String(data.UUID ?? "");
      const name = String(data.Name ?? "");
      const teamIds = Array.isArray(data.TeamIdentifier) ? data.TeamIdentifier.map(String) : [];
      const teamName = typeof data.TeamName === "string" ? data.TeamName : undefined;
      const expirationDate =
        data.ExpirationDate instanceof Date
          ? data.ExpirationDate
          : new Date(String(data.ExpirationDate ?? ""));
      const creationDate =
        data.CreationDate instanceof Date
          ? data.CreationDate
          : data.CreationDate
            ? new Date(String(data.CreationDate))
            : undefined;
      const provisionsAllDevices = data.ProvisionsAllDevices === true;
      const provisionedDevices = Array.isArray(data.ProvisionedDevices)
        ? data.ProvisionedDevices.map(String)
        : null;
      const entitlements =
        typeof data.Entitlements === "object" && data.Entitlements
          ? (data.Entitlements as Record<string, unknown>)
          : {};
      const developerCertificates = Array.isArray(data.DeveloperCertificates)
        ? data.DeveloperCertificates.map(String)
        : [];
      const certificates = developerCertificates
        .map((cert) => fingerprintFromCertificate(cert))
        .filter(Boolean)
        .map((cert) => cert as CertificateInfo);

      if (!uuid || !name || !expirationDate || Number.isNaN(expirationDate.getTime())) {
        return null;
      }

      const profileType = resolveProfileType(
        entitlements,
        provisionsAllDevices,
        provisionedDevices,
      );

      return {
        uuid,
        name,
        teamIds,
        teamName,
        expirationDate,
        creationDate,
        provisionsAllDevices,
        provisionedDevices,
        entitlements,
        developerCertificates: certificates,
        profileType,
        path,
      };
    } catch (error) {
      logger.warn(`[XcodeSigning] Failed to parse provisioning profile: ${errorMessage(error)}`);
      return null;
    }
  }

  private async writeEntitlementsIfNeeded(
    profile: ProvisioningProfile,
  ): Promise<string | undefined> {
    const hasEntitlements = Object.keys(profile.entitlements ?? {}).length > 0;
    if (!hasEntitlements) {
      return undefined;
    }
    if (process.env.AUTOMOBILE_IOS_CODE_SIGN_ENTITLEMENTS_PATH) {
      return process.env.AUTOMOBILE_IOS_CODE_SIGN_ENTITLEMENTS_PATH;
    }
    const filename = `${profile.uuid}.plist`;
    const entitlementsDir = this.entitlementsDirectory();
    await this.dependencies.mkdir(entitlementsDir);
    const target = join(entitlementsDir, filename);
    await this.dependencies.writeFile(target, entitlementsPlist(profile.entitlements));
    return target;
  }

  private profileDirectory(): string {
    return join(this.dependencies.homedir(), "Library", "MobileDevice", "Provisioning Profiles");
  }

  private entitlementsDirectory(): string {
    return getSharedAutoMobileDir("ctrl-proxy/entitlements", this.dependencies.homedir());
  }
}
