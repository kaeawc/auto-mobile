import { RELEASE_CHECKSUM_REGISTRY, type ReleaseChecksumEntry } from "../../../constants/release";

/**
 * The ProtoViewer support window (#14156): the MCP server supports the last three ProtoViewer
 * releases. Older builds still get the capability handshake or the app's own import gate, without a
 * guarantee, so a save to one succeeds with a warning instead of a refusal.
 */
export const PROTOVIEWER_SUPPORTED_RELEASES = 3;

/** versionCode of local, never-published builds (debug and unversioned release builds). */
export const PROTOVIEWER_LOCAL_VERSION_CODE = 1;

const RELEASE_VERSION = /^(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,3})$/;
const MAX_MAJOR = 2099;
const MAX_MINOR_OR_PATCH = 999;

/**
 * The Play versionCode a release version maps to, or undefined when the version is not a plain
 * bounded MAJOR.MINOR.PATCH. Twin of `ProtoViewerVersioning.versionCode` in android/build-logic; the
 * shared vectors in test/fixtures/protoviewer-version-codes.txt keep the two in step.
 */
export function protoViewerVersionCode(version: string): number | undefined {
  const match = RELEASE_VERSION.exec(version);
  if (match === null) {
    return undefined;
  }
  const [major, minor, patch] = match.slice(1).map(Number);
  if (major > MAX_MAJOR || minor > MAX_MINOR_OR_PATCH || patch > MAX_MINOR_OR_PATCH) {
    return undefined;
  }
  return major * 1_000_000 + minor * 1_000 + patch;
}

export interface ProtoViewerOldestSupported {
  version: string;
  versionCode: number;
}

/**
 * The oldest release inside the support window: the third newest registry entry that ships the
 * standalone ProtoViewer APK, or the oldest such entry while fewer have shipped. Undefined when no
 * release has shipped one yet.
 */
export function oldestSupportedProtoViewerRelease(
  registry: readonly Pick<ReleaseChecksumEntry, "version" | "protoViewerApkSha256">[],
): ProtoViewerOldestSupported | undefined {
  const shipped = registry
    .filter((entry) => Boolean(entry.protoViewerApkSha256))
    .map((entry) => ({
      version: entry.version,
      versionCode: protoViewerVersionCode(entry.version),
    }))
    .filter((entry): entry is ProtoViewerOldestSupported => entry.versionCode !== undefined)
    .sort((a, b) => b.versionCode - a.versionCode)
    .slice(0, PROTOVIEWER_SUPPORTED_RELEASES);
  return shipped.at(-1);
}

export const PROTOVIEWER_OLDEST_SUPPORTED =
  oldestSupportedProtoViewerRelease(RELEASE_CHECKSUM_REGISTRY);

/**
 * A warning when the installed build is older than the support window, else undefined. Local builds
 * (versionCode 1), an unknown versionCode and an unknown window are never flagged.
 */
export function protoViewerSupportWindowWarning(
  installed: { versionCode?: number; version?: string; updateUrl?: string },
  oldest: ProtoViewerOldestSupported | undefined,
): string | undefined {
  const code = installed.versionCode;
  if (
    oldest === undefined ||
    code === undefined ||
    code === PROTOVIEWER_LOCAL_VERSION_CODE ||
    code >= oldest.versionCode
  ) {
    return undefined;
  }
  const name = installed.version === undefined ? `versionCode ${code}` : installed.version;
  const where = installed.updateUrl === undefined ? "" : ` from ${installed.updateUrl}`;
  return `The installed ProtoViewer (${name}) is older than the oldest supported release (${oldest.version}); this host supports the last ${PROTOVIEWER_SUPPORTED_RELEASES} releases. Update ProtoViewer${where}.`;
}
