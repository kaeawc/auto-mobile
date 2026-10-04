import { promises as fs } from "node:fs";
import { errorMessage } from "../../../utils/describeUnknownError";
import * as os from "os";
import * as path from "path";
import { resolveIosDeviceKind } from "../../../utils/ios-cmdline-tools/IosDeviceKind";
import { logger } from "../../../utils/logger";
import { PlistClient } from "../../../utils/ios-cmdline-tools/PlistClient";
import { parsePlist, type PlistValue } from "../../../utils/ios-cmdline-tools/XctestrunPlist";
import {
  defaultDeviceSetRoot,
  type SimulatorDeviceSetEnvironment,
} from "../../../utils/ios-cmdline-tools/SimulatorTccSqliteClient";
import type { NotificationPolicyAccessState } from "../NotificationPolicy";

/**
 * `UNAuthorizationStatus` ordering — the on-disk `authorizationStatus` integer
 * maps directly onto this enum.
 */
const UN_AUTH = ["notDetermined", "denied", "authorized", "provisional", "ephemeral"] as const;

/** Settings keys decoded from the per-bundle BulletinBoard NSKeyedArchiver blob. */
export interface BulletinBoardSettings {
  authorizationStatus?: number;
  pushSettings?: number;
  alertType?: number;
  lockScreenSetting?: number;
  notificationCenterSetting?: number;
}

export interface IosNotificationAuthorizationReader {
  read(deviceId: string, bundleId: string): Promise<NotificationPolicyAccessState>;
}

/**
 * Dependencies injected so the reader is fully fakeable (<100ms, no real device,
 * no real `plutil`).
 *
 * `plutilToXml` is the ONLY thing that shells out. We convert to **xml1** rather
 * than json because BulletinBoard blobs are NSKeyedArchiver archives containing
 * `CFKeyedArchiverUID` refs, which `plutil -convert json` rejects ("invalid
 * object in plist for destination format"). xml1 round-trips them losslessly,
 * and the resulting XML is parsed with the repo's structured plist parser
 * ({@link parsePlist}) to extract the scalar settings we need
 * (`authorizationStatus`, etc.).
 */
export interface BulletinBoardReaderDeps {
  /** Run `plutil -convert xml1 -o - -- <path>` and return the XML string. */
  plutilToXml(path: string): Promise<string>;
  /** Persist a decoded nested blob to a temp file; returns its path. */
  writeTemp(buf: Buffer): Promise<string>;
  /** Remove a temp file written by {@link writeTemp}. */
  rmTemp(path: string): Promise<void>;
  /** Absolute path of a simulator device root (…/CoreSimulator/Devices/<udid>). */
  deviceDataRoot(udid: string): string;
}

/** An ordered plist `<dict>`, as produced by {@link parsePlist}. */
type PlistDict = Map<string, PlistValue>;

/**
 * Extract the base64 `<data>` blob registered under `sectionInfo[bundleId]` in
 * the outer `VersionedSectionInfo.plist` XML by parsing it with the repo's
 * structured plist parser ({@link parsePlist}, built on `xml2js`) and walking
 * the `sectionInfo` dict directly, rather than regex-matching `bundleId`
 * anywhere in the document. Returns null if the bundle has no section
 * registered.
 */
export async function extractSectionDataBase64(
  outerXml: string,
  bundleId: string,
): Promise<string | null> {
  const root = await parsePlist(outerXml);
  if (!(root instanceof Map)) {
    return null;
  }
  const sectionInfo = root.get("sectionInfo");
  if (!(sectionInfo instanceof Map)) {
    return null;
  }
  const data = sectionInfo.get(bundleId);
  // `<data>` decodes to a Buffer; re-encode it rather than re-deriving base64
  // from the raw XML text (plutil wraps the payload across indented lines).
  if (Buffer.isBuffer(data)) {
    return data.toString("base64");
  }
  if (typeof data !== "string") {
    return null;
  }
  // Strip all whitespace from the base64 payload (plutil wraps it across lines).
  return data.replace(/\s+/g, "");
}

/** The scalar keys that identify a BulletinBoard settings dict. */
const SETTINGS_KEYS = [
  "authorizationStatus",
  "pushSettings",
  "alertType",
  "lockScreenSetting",
  "notificationCenterSetting",
] as const;

function collectDicts(node: PlistValue | undefined, out: PlistDict[]): void {
  if (node === undefined) {
    return;
  }
  if (node instanceof Map) {
    out.push(node);
    for (const value of node.values()) {
      collectDicts(value, out);
    }
  } else if (Array.isArray(node)) {
    for (const item of node) {
      collectDicts(item, out);
    }
  }
}

/**
 * Find the settings dict among every `<dict>` in the archive's `$objects`
 * graph. More than one dict can carry an `authorizationStatus` key (issue
 * #6583). Rank candidates by known settings key count, then total key count,
 * then lexicographically greatest canonical content. Recursively sorted dict
 * keys and type-tagged values make ties independent of document order; equal
 * content is interchangeable. Array element order remains meaningful.
 */
function findSettingsDict(root: PlistValue): PlistDict | undefined {
  const dicts: PlistDict[] = [];
  collectDicts(root, dicts);
  const candidates = dicts.filter((dict) => dict.get("authorizationStatus") !== undefined);
  const score = (dict: PlistDict) =>
    SETTINGS_KEYS.filter((key) => dict.get(key) !== undefined).length;
  const canonical = (value: PlistValue): string => {
    if (value instanceof Map) {
      const entries = [...value.entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, child]) => [key, canonical(child)]);
      return JSON.stringify(["dict", entries]);
    }
    if (Array.isArray(value)) {
      return JSON.stringify(["array", value.map(canonical)]);
    }
    if (Buffer.isBuffer(value)) {
      return JSON.stringify(["data", value.toString("base64")]);
    }
    if (value instanceof Date) {
      return JSON.stringify(["date", String(value.getTime())]);
    }
    if (typeof value === "object") {
      // The remaining plist type is PlistReal; keep it distinct from integers.
      return JSON.stringify(["real", Object.is(value.value, -0) ? "-0" : String(value.value)]);
    }
    return JSON.stringify([typeof value, Object.is(value, -0) ? "-0" : String(value)]);
  };
  return candidates.reduce<PlistDict | undefined>((best, dict) => {
    if (!best) {
      return dict;
    }
    const rankDifference = score(dict) - score(best) || dict.size - best.size;
    if (rankDifference !== 0) {
      return rankDifference > 0 ? dict : best;
    }
    return canonical(dict) > canonical(best) ? dict : best;
  }, undefined);
}

/**
 * Extract the BulletinBoard settings scalars from the decoded nested-blob XML.
 * All scalars are read from the *same* coherent settings `<dict>` (see
 * {@link findSettingsDict}) rather than independently regex-matched anywhere
 * in the document.
 */
export async function parseSettingsFromNestedXml(
  nestedXml: string,
): Promise<BulletinBoardSettings> {
  const root = await parsePlist(nestedXml);
  const dict = findSettingsDict(root);
  if (!dict) {
    return {};
  }
  const intKey = (key: string): number | undefined => {
    const value = dict.get(key);
    return typeof value === "number" ? value : undefined;
  };
  return {
    authorizationStatus: intKey("authorizationStatus"),
    pushSettings: intKey("pushSettings"),
    alertType: intKey("alertType"),
    lockScreenSetting: intKey("lockScreenSetting"),
    notificationCenterSetting: intKey("notificationCenterSetting"),
  };
}

/**
 * Resolve a simulator's per-device data root the same way the TCC client does
 * ({@link defaultDeviceSetRoot} reads `CORESIMULATOR_DEVICE_SET_PATH`, falling
 * back to the default CoreSimulator device set layout) rather than hard-coding the default
 * device set (issue #6583).
 */
export function resolveDeviceDataRoot(
  udid: string,
  homeDirectory: string = os.homedir(),
  environment: SimulatorDeviceSetEnvironment = process.env,
): string {
  return path.join(defaultDeviceSetRoot(homeDirectory, environment), udid);
}

export class BulletinBoardAuthorizationReader implements IosNotificationAuthorizationReader {
  constructor(private readonly deps: BulletinBoardReaderDeps) {}

  async read(deviceId: string, bundleId: string): Promise<NotificationPolicyAccessState> {
    if (resolveIosDeviceKind({ deviceId: deviceId }) === "physical") {
      return {
        supported: false,
        method: "unsupported",
        error:
          "iOS notification authorization can only be read on simulators (no host-side API on physical devices)",
      };
    }

    const path = `${this.deps.deviceDataRoot(deviceId)}/data/Library/BulletinBoard/VersionedSectionInfo.plist`;

    let outerXml: string;
    try {
      outerXml = await this.deps.plutilToXml(path);
    } catch (error) {
      logger.debug(`[iOS] No BulletinBoard section info (${path}): ${error}`);
      return {
        supported: true,
        allowed: null,
        method: "ios_bulletinboard_plist",
        warning: `No BulletinBoard section info for device (${path} not found or unreadable)`,
      };
    }

    const base64Blob = await extractSectionDataBase64(outerXml, bundleId);
    if (!base64Blob) {
      return {
        supported: true,
        allowed: null,
        method: "ios_bulletinboard_plist",
        warning: `No notification section registered for ${bundleId} (app may never have requested authorization)`,
      };
    }

    let settings: BulletinBoardSettings;
    try {
      settings = await this.decodeNestedBlob(Buffer.from(base64Blob, "base64"));
    } catch (error) {
      logger.warn(
        `[iOS] Could not read notification authorization state for ${bundleId}: ${errorMessage(error)}`,
        error,
      );
      return {
        supported: true,
        allowed: null,
        method: "ios_bulletinboard_plist",
        warning: `Could not read notification authorization state for ${bundleId} (notification section unreadable)`,
      };
    }

    if (settings.authorizationStatus === undefined) {
      return {
        supported: true,
        allowed: null,
        method: "ios_bulletinboard_plist",
        warning: `Notification section for ${bundleId} had no authorization status`,
      };
    }

    const status =
      settings.authorizationStatus !== undefined && settings.authorizationStatus < UN_AUTH.length
        ? UN_AUTH[settings.authorizationStatus]
        : undefined;

    // iOS still delivers notifications for authorized (2), provisional (3, quiet
    // delivery) and ephemeral (4, App Clips), so all three count as "allowed".
    // Callers needing strict full authorization can check
    // `authorizationStatus === "authorized"`.
    const allowed =
      settings.authorizationStatus !== undefined &&
      settings.authorizationStatus >= 2 &&
      settings.authorizationStatus <= 4;

    return {
      supported: true,
      method: "ios_bulletinboard_plist",
      allowed,
      authorizationStatus: status,
      lockScreen: settings.lockScreenSetting === 2,
      notificationCenter: settings.notificationCenterSetting === 2,
      alerts: settings.alertType !== undefined && settings.alertType !== 0,
      rawValue:
        `authorizationStatus=${settings.authorizationStatus} ` +
        `pushSettings=${settings.pushSettings} alertType=${settings.alertType}`,
    };
  }

  private async decodeNestedBlob(blob: Buffer): Promise<BulletinBoardSettings> {
    const tmp = await this.deps.writeTemp(blob);
    try {
      const nestedXml = await this.deps.plutilToXml(tmp);
      return parseSettingsFromNestedXml(nestedXml);
    } finally {
      try {
        await this.deps.rmTemp(tmp);
      } catch {
        // best-effort temp cleanup
      }
    }
  }
}

/** Prepare a blob for plutil; ownership transfers to rmTemp only on success. */
export async function writeBulletinBoardTemp(
  buf: Buffer,
  files: {
    mkdtemp(prefix: string): Promise<string>;
    writeFile(file: string, data: Buffer): Promise<void>;
    rm(directory: string, options: { recursive: true; force: true }): Promise<void>;
  } = fs,
): Promise<string> {
  const dir = await files.mkdtemp(path.join(os.tmpdir(), "automobile-bb-"));
  try {
    const file = path.join(dir, "blob.bplist");
    await files.writeFile(file, buf);
    return file;
  } catch (error) {
    try {
      await files.rm(dir, { recursive: true, force: true });
    } catch (cleanupError) {
      // Cleanup failure must not mask the original preparation error.
      logger.warn(
        `Failed to remove BulletinBoard blob directory: ${errorMessage(cleanupError)}`,
        cleanupError,
      );
    }
    throw error;
  }
}

/** Wire the real deps: host `plutil`, `fs` temp files, CoreSimulator device root. */
export function defaultBulletinBoardReader(): IosNotificationAuthorizationReader {
  const plist = new PlistClient();
  return new BulletinBoardAuthorizationReader({
    plutilToXml: (path) => plist.readXmlFile(path),
    writeTemp: (buf) => writeBulletinBoardTemp(buf),
    rmTemp: async (file) => {
      const { promises: fs } = await import("fs");
      await fs.rm(path.dirname(file), { recursive: true, force: true });
    },
    deviceDataRoot: (udid) => resolveDeviceDataRoot(udid),
  });
}
