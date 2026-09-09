import * as os from "os";
import * as path from "path";
import { isIosSimulatorUdid } from "../../../utils/ios-cmdline-tools/iosDeviceType";
import { logger } from "../../../utils/logger";
import { PlistClient } from "../../../utils/ios-cmdline-tools/PlistClient";
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

/** A parsed plist scalar (`<integer>`, `<string>`, `<data>`, `<real>`, `<date>`, …). */
interface PlistScalarNode {
  kind: "scalar";
  tag: string;
  text: string;
}

/** A parsed plist `<dict>`: an ordered list of key/value entries. */
interface PlistDictNode {
  kind: "dict";
  entries: Array<{ key: string; value: PlistNode }>;
}

/** A parsed plist `<array>`: an ordered list of unkeyed values. */
interface PlistArrayNode {
  kind: "array";
  items: PlistNode[];
}

type PlistNode = PlistScalarNode | PlistDictNode | PlistArrayNode;

/** Matches an opening/closing plist tag, e.g. `<dict>`, `</dict>`, `<key>`, `<true/>`. */
const PLIST_TAG_RE = /<(\/)?([a-zA-Z$][\w:$-]*)((?:\s[^>]*)?)>/g;

/**
 * A dict frame tracks its own `pendingKey` (the most recently opened `<key>`
 * awaiting a value) so that a nested dict's `<key>` cannot clobber an
 * ancestor dict's still-unpaired key — each nesting level's "next value goes
 * under this key" state is independent.
 */
type DictFrame = { entries: Array<{ key: string; value: PlistNode }>; pendingKey: string | null };
type ArrayFrame = { items: PlistNode[] };
type ParseFrame = DictFrame | ArrayFrame;

function isDictFrame(frame: ParseFrame): frame is DictFrame {
  return "entries" in frame;
}

function frameToNode(frame: ParseFrame): PlistNode {
  return isDictFrame(frame)
    ? { kind: "dict", entries: frame.entries }
    : { kind: "array", items: frame.items };
}

/** Attach a completed value to the current top-of-stack frame (or as the document root). */
function attachToFrame(
  stack: ParseFrame[],
  root: PlistNode | null,
  node: PlistNode,
): PlistNode | null {
  const top = stack[stack.length - 1];
  if (!top) {
    return node;
  }
  if (isDictFrame(top)) {
    if (top.pendingKey !== null) {
      top.entries.push({ key: top.pendingKey, value: node });
      top.pendingKey = null;
    }
  } else {
    top.items.push(node);
  }
  return root;
}

/**
 * Read a `<key>…</key>` element starting right after the opening `<key>` tag
 * and record it as the enclosing dict frame's pending key. Returns the index
 * to resume tag scanning from, or -1 if the element is unterminated.
 */
function consumeKeyElement(xml: string, stack: ParseFrame[], contentStart: number): number {
  const closeIdx = xml.indexOf("</key>", contentStart);
  if (closeIdx === -1) {
    return -1;
  }
  const top = stack[stack.length - 1];
  if (top && isDictFrame(top)) {
    top.pendingKey = xml.slice(contentStart, closeIdx);
  }
  return closeIdx + "</key>".length;
}

/**
 * Read a leaf scalar element (`<integer>…</integer>`, `<data>…</data>`, etc.)
 * starting right after its opening tag. Returns the parsed node and the index
 * to resume tag scanning from.
 */
function consumeScalarElement(
  xml: string,
  tag: string,
  contentStart: number,
): { node: PlistScalarNode; nextIndex: number } {
  const closeTag = `</${tag}>`;
  const closeIdx = xml.indexOf(closeTag, contentStart);
  const text = closeIdx === -1 ? "" : xml.slice(contentStart, closeIdx);
  const nextIndex = closeIdx === -1 ? contentStart : closeIdx + closeTag.length;
  return { node: { kind: "scalar", tag, text }, nextIndex };
}

/**
 * Parse `plutil -convert xml1` output into a lightweight plist DOM.
 *
 * This is intentionally minimal (not a general XML parser): it understands
 * exactly the plist grammar (`dict`/`array`/`key` plus leaf scalar tags) and
 * skips the `<?xml …?>` prolog and the outer `<plist …>` wrapper. That is
 * enough to walk `<dict>` elements coherently instead of regex-matching a
 * key anywhere in the document (issue #6583).
 */
function parsePlistBody(xml: string): PlistNode | null {
  PLIST_TAG_RE.lastIndex = 0;
  const stack: ParseFrame[] = [];
  let root: PlistNode | null = null;

  let match: RegExpExecArray | null;
  while ((match = PLIST_TAG_RE.exec(xml))) {
    const [, closing, tag, attrs] = match;
    if (tag === "plist") {
      continue;
    }
    if (closing) {
      const top = stack.pop();
      root = top ? attachToFrame(stack, root, frameToNode(top)) : root;
      continue;
    }
    if (attrs.trimEnd().endsWith("/")) {
      root = attachToFrame(stack, root, { kind: "scalar", tag, text: "" });
      continue;
    }
    if (tag === "dict") {
      stack.push({ entries: [], pendingKey: null });
      continue;
    }
    if (tag === "array") {
      stack.push({ items: [] });
      continue;
    }
    if (tag === "key") {
      const nextIndex = consumeKeyElement(xml, stack, PLIST_TAG_RE.lastIndex);
      if (nextIndex === -1) {
        break;
      }
      PLIST_TAG_RE.lastIndex = nextIndex;
      continue;
    }
    // Leaf scalar: <integer>…</integer>, <string>…</string>, <data>…</data>, etc.
    const { node, nextIndex } = consumeScalarElement(xml, tag, PLIST_TAG_RE.lastIndex);
    PLIST_TAG_RE.lastIndex = nextIndex;
    root = attachToFrame(stack, root, node);
  }

  return root;
}

function dictEntry(dict: PlistDictNode, key: string): PlistNode | undefined {
  return dict.entries.find((entry) => entry.key === key)?.value;
}

/**
 * Extract the base64 `<data>` blob registered under `sectionInfo[bundleId]` in
 * the outer `VersionedSectionInfo.plist` XML by walking the `sectionInfo` dict
 * directly, rather than regex-matching `bundleId` anywhere in the document.
 * Returns null if the bundle has no section registered.
 */
export function extractSectionDataBase64(outerXml: string, bundleId: string): string | null {
  const root = parsePlistBody(outerXml);
  if (!root || root.kind !== "dict") {
    return null;
  }
  const sectionInfo = dictEntry(root, "sectionInfo");
  if (!sectionInfo || sectionInfo.kind !== "dict") {
    return null;
  }
  const data = dictEntry(sectionInfo, bundleId);
  if (!data || data.kind !== "scalar" || data.tag !== "data") {
    return null;
  }
  // Strip all whitespace from the base64 payload (plutil wraps it across lines).
  return data.text.replace(/\s+/g, "");
}

/** The scalar keys that identify a BulletinBoard settings dict. */
const SETTINGS_KEYS = [
  "authorizationStatus",
  "pushSettings",
  "alertType",
  "lockScreenSetting",
  "notificationCenterSetting",
] as const;

function collectDicts(node: PlistNode | null | undefined, out: PlistDictNode[]): void {
  if (!node) {
    return;
  }
  if (node.kind === "dict") {
    out.push(node);
    for (const entry of node.entries) {
      collectDicts(entry.value, out);
    }
  } else if (node.kind === "array") {
    for (const item of node.items) {
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
function findSettingsDict(root: PlistNode | null): PlistDictNode | undefined {
  const dicts: PlistDictNode[] = [];
  collectDicts(root, dicts);
  const candidates = dicts.filter((dict) => dictEntry(dict, "authorizationStatus") !== undefined);
  return candidates.reduce<PlistDictNode | undefined>((best, dict) => {
    if (!best) {
      return dict;
    }
    const score = (d: PlistDictNode) =>
      SETTINGS_KEYS.filter((key) => dictEntry(d, key) !== undefined).length;
    return score(dict) > score(best) ? dict : best;
  }, undefined);
}

/**
 * Extract the BulletinBoard settings scalars from the decoded nested-blob XML.
 * All scalars are read from the *same* coherent settings `<dict>` (see
 * {@link findSettingsDict}) rather than independently regex-matched anywhere
 * in the document.
 */
export function parseSettingsFromNestedXml(nestedXml: string): BulletinBoardSettings {
  const root = parsePlistBody(nestedXml);
  const dict = findSettingsDict(root);
  if (!dict) {
    return {};
  }
  const intKey = (key: string): number | undefined => {
    const value = dictEntry(dict, key);
    return value && value.kind === "scalar" && value.tag === "integer"
      ? Number(value.text)
      : undefined;
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
    deviceDataRoot: (udid) => resolveDeviceDataRoot(udid),
  });
}
