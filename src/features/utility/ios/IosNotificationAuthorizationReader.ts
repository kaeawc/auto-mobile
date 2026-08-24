import * as os from "os";
import * as path from "path";
import { isIosSimulatorUdid } from "../../../utils/ios-cmdline-tools/iosDeviceType";
import { logger } from "../../../utils/logger";
import { PlistClient } from "../../../utils/ios-cmdline-tools/PlistClient";
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
 * and the scalar settings we need (`authorizationStatus`, etc.) appear as plain
 * `<integer>` values we can extract without a full plist parser.
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

/**
 * Extract the base64 `<data>` blob registered under `sectionInfo[bundleId]` in
 * the outer `VersionedSectionInfo.plist` XML. Returns null if the bundle has no
 * section registered.
 */
export function extractSectionDataBase64(outerXml: string, bundleId: string): string | null {
  // Match `<key>bundleId</key>` followed (ignoring whitespace) by `<data>…</data>`.
  // Bundle IDs are dotted identifiers, so escape regex metacharacters.
  const escaped = bundleId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`<key>${escaped}</key>\\s*<data>([\\s\\S]*?)</data>`);
  const match = outerXml.match(re);
  if (!match) {
    return null;
  }
  // Strip all whitespace from the base64 payload (plutil wraps it across lines).
  return match[1].replace(/\s+/g, "");
}

/**
 * Extract the BulletinBoard settings scalars from the decoded nested-blob XML.
 * The settings dict is the `<dict>` carrying `<key>authorizationStatus</key>`;
 * we pull each integer key globally (the archive has exactly one settings dict).
 */
export function parseSettingsFromNestedXml(nestedXml: string): BulletinBoardSettings {
  const intKey = (key: string): number | undefined => {
    const re = new RegExp(`<key>${key}</key>\\s*<integer>(-?\\d+)</integer>`);
    const match = nestedXml.match(re);
    return match ? Number(match[1]) : undefined;
  };
  return {
    authorizationStatus: intKey("authorizationStatus"),
    pushSettings: intKey("pushSettings"),
    alertType: intKey("alertType"),
    lockScreenSetting: intKey("lockScreenSetting"),
    notificationCenterSetting: intKey("notificationCenterSetting"),
  };
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

    const base64Blob = extractSectionDataBase64(outerXml, bundleId);
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
    deviceDataRoot: (udid) =>
      path.join(os.homedir(), "Library/Developer/CoreSimulator/Devices", udid),
  });
}
