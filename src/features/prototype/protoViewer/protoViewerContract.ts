import { z } from "zod/v4";

/**
 * Host side of the ProtoViewer MCP inbox (#13621). The Android twin is `McpActivity` in
 * `android/protoviewer`; keep the names, paths and result shape below in step with it.
 *
 * The host pushes a canonical `.automobile-proto` bundle into the app's own external files
 * directory, then starts an explicit, `android.permission.DUMP`-guarded activity that only the adb
 * shell can launch. The app validates and commits it exactly like a user import, sets the entry's
 * source itself, and writes one result file the host reads back.
 */
export const PROTOVIEWER_PACKAGE = "dev.jasonpearson.automobile.protoviewer";
export const PROTOVIEWER_MCP_COMPONENT = `${PROTOVIEWER_PACKAGE}/.McpActivity`;
export const PROTOVIEWER_MCP_IMPORT_ACTION = `${PROTOVIEWER_PACKAGE}.mcp.IMPORT`;
export const PROTOVIEWER_MCP_OPEN_ACTION = `${PROTOVIEWER_PACKAGE}.mcp.OPEN`;
export const PROTOVIEWER_EXTRA_REQUEST = "request";
export const PROTOVIEWER_EXTRA_LABEL = "label";
export const PROTOVIEWER_EXTRA_LIBRARY_ID = "libraryId";
export const PROTOVIEWER_BUNDLE_SUFFIX = ".automobile-proto";
/** Matches the app's own check: request ids name files, so they stay plain. */
export const PROTOVIEWER_REQUEST_ID = /^[A-Za-z0-9_-]{1,64}$/;
/** The app's library ids are UUIDs (`validLibraryId`). */
export const PROTOVIEWER_LIBRARY_ID =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
export const PROTOVIEWER_MAX_LABEL_LENGTH = 120;

/** `getExternalFilesDir(null)/mcp` for the given Android user, as adb shell sees it. */
export function protoViewerMcpRoot(userId: number): string {
  // Same user-0 spelling as the externalFiles app-file container (appFileSupport.ts).
  const storage = userId === 0 ? "/sdcard" : `/storage/emulated/${userId}`;
  return `${storage}/Android/data/${PROTOVIEWER_PACKAGE}/files/mcp`;
}

export function protoViewerInboxPath(userId: number, request: string): string {
  return `${protoViewerMcpRoot(userId)}/inbox/${request}${PROTOVIEWER_BUNDLE_SUFFIX}`;
}

export function protoViewerResultPath(userId: number, request: string): string {
  return `${protoViewerMcpRoot(userId)}/results/${request}.json`;
}

const entry = {
  request: z.string(),
  libraryId: z.string().regex(PROTOVIEWER_LIBRARY_ID),
  label: z.string(),
};

export const protoViewerResultSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("imported"), ...entry }),
  z.strictObject({ status: z.literal("opened"), ...entry }),
  z.strictObject({
    status: z.literal("rejected"),
    request: z.string(),
    path: z.string(),
    reason: z.string(),
  }),
  z.strictObject({ status: z.literal("not_found"), request: z.string() }),
]);
export type ProtoViewerResult = z.infer<typeof protoViewerResultSchema>;
