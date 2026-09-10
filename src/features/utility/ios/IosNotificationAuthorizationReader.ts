import * as os from "os";
import * as path from "path";
import { isIosSimulatorUdid } from "../../../utils/ios-cmdline-tools/iosDeviceType";
import { logger } from "../../../utils/logger";
import { PlistClient } from "../../../utils/ios-cmdline-tools/PlistClient";
import { parsePlist, type PlistValue } from "../../../utils/ios-cmdline-tools/XctestrunPlist";
import { defaultDeviceSetRoot } from "../../../utils/ios-cmdline-tools/SimulatorTccSqliteClient";
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
 * graph. The `$objects` array is flat and order-dependent, so more than one
 * dict can carry an `authorizationStatus` key (issue #6583); among those
 * candidates, pick the one that also carries the most other known settings
 * keys as siblings, rather than trusting document order.
 */
function findSettingsDict(root: PlistValue): PlistDict | undefined {
  const dicts: PlistDict[] = [];
  collectDicts(root, dicts);
  const candidates = dicts.filter((dict) => dict.get("authorizationStatus") !== undefined);
  return candidates.reduce<PlistDict | undefined>((best, dict) => {
    if (!best) {
      return dict;
    }
    const score = (d: PlistDict) => SETTINGS_KEYS.filter((key) => d.get(key) !== undefined).length;
    return score(dict) > score(best) ? dict : best;
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
 * (via `CORESIMULATOR_DEVICE_SET_PATH`, falling back to the default
 * CoreSimulator device set layout) rather than hard-coding the default
 * device set (issue #6583).
 */
export function resolveDeviceDataRoot(udid: string, homeDirectory: string = os.homedir()): string {
  return path.join(defaultDeviceSetRoot(homeDirectory), udid);
}

export class BulletinBoardAuthorizationReader implements IosNotificationAuthorizationReader {
  constructor(private readonly deps: BulletinBoardReaderDeps) {}

  async read(deviceId: string, bundleId: string): Promise<NotificationPolicyAccessState> {
    if (!isIosSimulatorUdid(deviceId)) {
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

    const settings = await this.decodeNestedBlob(Buffer.from(base64Blob, "base64"));

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

/** Wire the real deps: host `plutil`, `fs` temp files, CoreSimulator device root. */
export function defaultBulletinBoardReader(): IosNotificationAuthorizationReader {
  const plist = new PlistClient();
  return new BulletinBoardAuthorizationReader({
    plutilToXml: (path) => plist.readXmlFile(path),
    writeTemp: async (buf) => {
      const { promises: fs } = await import("fs");
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "automobile-bb-"));
      const file = path.join(dir, "blob.bplist");
      await fs.writeFile(file, buf);
      return file;
    },
    rmTemp: async (file) => {
      const { promises: fs } = await import("fs");
      await fs.rm(path.dirname(file), { recursive: true, force: true });
    },
    deviceDataRoot: (udid) => resolveDeviceDataRoot(udid),
  });
}
