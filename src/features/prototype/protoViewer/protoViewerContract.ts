import { z } from "zod/v4";

/**
 * Host side of the ProtoViewer MCP inbox (#13621). The Android twin is `McpActivity` in
 * `android/protoviewer`; keep the names, paths and result shape below in step with it.
 *
 * The host pushes a canonical `.automobile-proto` bundle into the app's own external files
 * directory, then starts an explicit, `android.permission.DUMP`-guarded activity that only the adb
 * shell can launch. The app validates and commits it exactly like a user import, sets the entry's
 * source itself, and writes one result file the host reads back.
 *
 * The app, not the host, creates `mcp/`, `mcp/inbox/` and `mcp/results/` (the PREPARE action):
 * on API 30+ scoped storage a directory the adb shell creates under another app's `Android/data`
 * is owned by the shell and the app can neither traverse nor create entries in it (#15174).
 */
export const PROTOVIEWER_PACKAGE = "dev.jasonpearson.automobile.protoviewer";
export const PROTOVIEWER_MCP_COMPONENT = `${PROTOVIEWER_PACKAGE}/.McpActivity`;
export const PROTOVIEWER_MCP_IMPORT_ACTION = `${PROTOVIEWER_PACKAGE}.mcp.IMPORT`;
export const PROTOVIEWER_MCP_OPEN_ACTION = `${PROTOVIEWER_PACKAGE}.mcp.OPEN`;
export const PROTOVIEWER_MCP_PREPARE_ACTION = `${PROTOVIEWER_PACKAGE}.mcp.PREPARE`;
export const PROTOVIEWER_EXTRA_REQUEST = "request";
export const PROTOVIEWER_EXTRA_LABEL = "label";
export const PROTOVIEWER_EXTRA_LIBRARY_ID = "libraryId";
const PROTOVIEWER_BUNDLE_SUFFIX = ".automobile-proto";
/** Matches the app's own check: request ids name files, so they stay plain. */
export const PROTOVIEWER_REQUEST_ID = /^[A-Za-z0-9_-]{1,64}$/;
/** The app's library ids are canonical lowercase UUIDs (`validLibraryId`). */
export const PROTOVIEWER_LIBRARY_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const PROTOVIEWER_MAX_LABEL_LENGTH = 120;
/**
 * Characters the app refuses in a label: controls, format (bidi) and line/paragraph separators.
 * The host also refuses lone surrogates (`\p{Cs}`): they cannot be percent-encoded into the iOS
 * launch URL, and a half emoji is never a usable label.
 */
const PROTOVIEWER_LABEL_FORBIDDEN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}]/u;
/** Result path the app uses when a pushed bundle is missing or unreadable from its side. */
export const PROTOVIEWER_INBOX_PATH = "inbox";
/** Result path the app uses when the spec needs a capability this ProtoViewer build lacks. */
export const PROTOVIEWER_CAPABILITY_PATH = "capability";

/** The same rule as the app's `validLabel`: one trimmed line of 1 to 120 characters. */
export function protoViewerLabelProblem(label: string): string | undefined {
  const trimmed = label.trim();
  if (trimmed.length === 0 || trimmed.length > PROTOVIEWER_MAX_LABEL_LENGTH) {
    return `Use a label of 1 to ${PROTOVIEWER_MAX_LABEL_LENGTH} characters.`;
  }
  return PROTOVIEWER_LABEL_FORBIDDEN.test(trimmed)
    ? "Use a single-line label without control or direction-override characters."
    : undefined;
}

/** A ProtoViewer label from a spec id: forbidden characters dropped, trimmed and capped. */
export function protoViewerDefaultLabel(specId: string): string | undefined {
  const cleaned = specId.replace(new RegExp(PROTOVIEWER_LABEL_FORBIDDEN.source, "gu"), "").trim();
  const capped = truncateWholeCharacters(cleaned, PROTOVIEWER_MAX_LABEL_LENGTH).trim();
  return capped.length > 0 ? capped : undefined;
}

/** Cuts at a UTF-16 length without splitting a surrogate pair. */
function truncateWholeCharacters(text: string, maxLength: number): string {
  let length = 0;
  let kept = "";
  for (const character of text) {
    length += character.length;
    if (length > maxLength) {
      break;
    }
    kept += character;
  }
  return kept;
}

/** `getExternalFilesDir(null)/mcp` for the given Android user, as adb shell sees it. */
export function protoViewerMcpRoot(userId: number): string {
  // Same user-0 spelling as the externalFiles app-file container (appFileSupport.ts).
  const storage = userId === 0 ? "/sdcard" : `/storage/emulated/${userId}`;
  return `${storage}/Android/data/${PROTOVIEWER_PACKAGE}/files/mcp`;
}

export function protoViewerInboxDir(userId: number): string {
  return `${protoViewerMcpRoot(userId)}/inbox`;
}

export function protoViewerResultsDir(userId: number): string {
  return `${protoViewerMcpRoot(userId)}/results`;
}

export function protoViewerInboxPath(userId: number, request: string): string {
  return `${protoViewerInboxDir(userId)}/${request}${PROTOVIEWER_BUNDLE_SUFFIX}`;
}

export function protoViewerResultPath(userId: number, request: string): string {
  return `${protoViewerResultsDir(userId)}/${request}.json`;
}

const entry = {
  request: z.string(),
  libraryId: z.string().regex(PROTOVIEWER_LIBRARY_ID),
  label: z.string(),
  /** iOS: the screen the app was on, as native pixels "WxH". Absent from Android and older apps. */
  screen: z
    .string()
    .regex(/^\d{1,5}x\d{1,5}$/)
    .optional(),
};

const workResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("imported"), ...entry }),
  z.object({ status: z.literal("opened"), ...entry }),
  z.object({
    status: z.literal("rejected"),
    request: z.string(),
    path: z.string(),
    reason: z.string(),
  }),
  z.object({ status: z.literal("not_found"), request: z.string() }),
]);
const preparedResultSchema = z.object({ status: z.literal("prepared"), request: z.string() });

// Unknown keys are stripped, not refused, so a newer app may add fields without breaking this host.
export const protoViewerWireResultSchema = z.union([workResultSchema, preparedResultSchema]);
export type ProtoViewerWireResult = z.infer<typeof protoViewerWireResultSchema>;
/** What an import or open answers with; the storage-preparing answer never leaves the transport. */
export type ProtoViewerResult = z.infer<typeof workResultSchema>;

/** Twin: ios/prototype-agent/Sources/AutoMobilePrototypeAgentCore/PrototypeMcp*.swift. */
export const PROTOVIEWER_IOS_SCHEME = "automobile-proto";
export const PROTOVIEWER_IOS_MCP_FOLDER = "Library/Application Support/ProtoViewer/mcp";
export const PROTOVIEWER_INBOX_FOLDER = "inbox";
export const PROTOVIEWER_RESULTS_FOLDER = "results";
/** Published by the iOS app at mcp/delivery; URL-only builds never publish this capability. */
export const PROTOVIEWER_IOS_DELIVERY = "file-inbox-v1";
/** Atomic inbox/<request>.request JSON; its filename supplies the request id. Twin: PrototypeMcpRequest.parseFile. */
export type ProtoViewerIosRequest =
  | { action: "import"; label?: string }
  | { action: "open"; libraryId: string };
/** Query values use percent encoding (including apostrophes), never shell interpolation. */
function queryValue(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}
export function protoViewerIosImportUrl(request: string, label?: string): string {
  return `${PROTOVIEWER_IOS_SCHEME}://import?request=${queryValue(request)}${label === undefined ? "" : `&label=${queryValue(label)}`}`;
}
export function protoViewerIosOpenUrl(request: string, libraryId: string): string {
  return `${PROTOVIEWER_IOS_SCHEME}://open?request=${queryValue(request)}&id=${queryValue(libraryId)}`;
}
