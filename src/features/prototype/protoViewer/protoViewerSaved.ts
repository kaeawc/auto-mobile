import type { SavedPrototypeErrorCode } from "../../observe/android/ctrlProxyProtocol";
import { hasElementAnchors } from "../prototypeAnchors";
import {
  preparePrototypeAssets,
  type PrototypeAssetFileReader,
  type PrototypeAssetSource,
  type PrototypeObservationScreenshotReader,
} from "../prototypeAssetUploader";
import { exportPrototypeBundle, type BundleExportAsset } from "../prototypeBundle";
import type { PrototypeSpec } from "../prototypeSpec";
import { logger } from "../../../utils/logger";
import { errorMessage } from "../../../utils/describeUnknownError";
import { PROTOVIEWER_DEFAULT_TIMEOUT_MS, type ProtoViewerDevice } from "./AndroidProtoViewer";
import { PROTOVIEWER_LIBRARY_ID, type ProtoViewerResult } from "./protoViewerContract";

export const PROTOVIEWER_IMPORTED_WARNING =
  "ProtoViewer treats this prototype as imported: its requests stay off until someone turns on network for imported prototypes in ProtoViewer's settings, and it is not attached to this host (no awaitEvent, patch or inspect).";

export interface ProtoViewerEntry {
  app: "protoviewer";
  libraryId: string;
  label: string;
}

export type ProtoViewerErrorCode = SavedPrototypeErrorCode | "unsupported_capability";

export interface ProtoViewerOutput {
  success: boolean;
  error?: string;
  errorCode?: ProtoViewerErrorCode;
  viewer?: ProtoViewerEntry;
  warning?: string;
}

export interface ProtoViewerInput {
  action: string;
  spec?: PrototypeSpec;
  label?: string;
  icon?: string;
  pin?: true;
  id?: string;
  timeoutMs?: number;
  assets?: readonly PrototypeAssetSource[];
}

export interface ProtoViewerRouteDependencies {
  device: ProtoViewerDevice;
  assetFileReader: PrototypeAssetFileReader;
  observationScreenshotReader: PrototypeObservationScreenshotReader;
}

/**
 * Whether ProtoViewer may take this call. `pin` and `icon` describe CtrlProxy launcher shortcuts,
 * which ProtoViewer does not have, so those saves keep today's path; so do show and the other
 * saved actions (`listSaved` and `deleteSaved` merging is later work).
 */
export function protoViewerHandles(args: Pick<ProtoViewerInput, "action" | "pin" | "icon">) {
  if (args.action === "open") {
    return true;
  }
  return args.action === "save" && args.pin === undefined && args.icon === undefined;
}

/**
 * Runs `save` or `open` against ProtoViewer. Undefined means "not routed": a save when ProtoViewer
 * is not installed falls back to the CtrlProxy saved path unchanged.
 */
export async function routeToProtoViewer(
  args: ProtoViewerInput,
  deps: ProtoViewerRouteDependencies,
  signal?: AbortSignal,
): Promise<ProtoViewerOutput | undefined> {
  if (args.action === "open") {
    return await openInProtoViewer(args, deps, signal);
  }
  if (args.spec === undefined) {
    return undefined;
  }
  if (hasElementAnchors(args.spec)) {
    return failure(
      "invalid_spec",
      'Element anchors are resolved against the live screen and are not supported in a saved prototype; use {type:"bounds",bounds:{x,y,width,height}} anchors (dp) instead. Nothing was saved.',
    );
  }
  const userId = await deps.device.installedUser(signal);
  if (userId === undefined) {
    return undefined;
  }
  const bundle = await canonicalBundle(args, args.spec, deps);
  if ("failure" in bundle) {
    return bundle.failure;
  }
  return await deviceCall(() =>
    deps.device.importBundle(
      userId,
      bundle.bytes,
      args.label,
      args.timeoutMs ?? PROTOVIEWER_DEFAULT_TIMEOUT_MS,
      signal,
    ),
  );
}

async function openInProtoViewer(
  args: ProtoViewerInput,
  deps: ProtoViewerRouteDependencies,
  signal?: AbortSignal,
): Promise<ProtoViewerOutput> {
  if (args.id === undefined || !PROTOVIEWER_LIBRARY_ID.test(args.id)) {
    return failure(
      "invalid_id",
      "open takes a ProtoViewer library id (the viewer.libraryId a save returned).",
    );
  }
  const userId = await deps.device.installedUser(signal);
  if (userId === undefined) {
    return failure(
      "unsupported_capability",
      "open needs ProtoViewer installed on the device; install it and save the prototype again.",
    );
  }
  const libraryId = args.id;
  return await deviceCall(() =>
    deps.device.open(userId, libraryId, args.timeoutMs ?? PROTOVIEWER_DEFAULT_TIMEOUT_MS, signal),
  );
}

async function canonicalBundle(
  args: ProtoViewerInput,
  spec: PrototypeSpec,
  deps: ProtoViewerRouteDependencies,
): Promise<{ bytes: Uint8Array } | { failure: ProtoViewerOutput }> {
  const prepared = await preparePrototypeAssets(
    args.assets ?? [],
    deps.assetFileReader,
    deps.observationScreenshotReader,
  );
  if ("error" in prepared) {
    return { failure: failure("invalid_asset_id", `${prepared.error} Nothing was saved.`) };
  }
  const uploaded = new Map<string, BundleExportAsset>(
    prepared.assets.map((asset) => [asset.id, { mediaType: asset.mimeType, bytes: asset.bytes }]),
  );
  const exported = exportPrototypeBundle({
    specBytes: Buffer.from(JSON.stringify(spec)),
    assets: (id) => uploaded.get(id),
    fonts: (id) => uploaded.get(id),
  });
  if (!exported.ok) {
    const where = exported.path ? ` (${exported.path})` : "";
    return exported.code === "asset_missing"
      ? {
          failure: failure(
            "missing_asset",
            `Upload every asset the spec references in the same save call${where}. Nothing was saved.`,
          ),
        }
      : {
          failure: failure(
            "invalid_spec",
            `The prototype does not fit a ProtoViewer bundle: ${exported.code}${where}. Nothing was saved.`,
          ),
        };
  }
  return { bytes: exported.bytes };
}

async function deviceCall(call: () => Promise<ProtoViewerResult>): Promise<ProtoViewerOutput> {
  let result: ProtoViewerResult;
  try {
    result = await call();
  } catch (error) {
    logger.warn(`[protoviewer] request failed: ${errorMessage(error)}`, error);
    return { success: false, error: `ProtoViewer request failed: ${errorMessage(error)}` };
  }
  switch (result.status) {
    case "imported":
    case "opened":
      return {
        success: true,
        viewer: { app: "protoviewer", libraryId: result.libraryId, label: result.label },
        warning: PROTOVIEWER_IMPORTED_WARNING,
      };
    case "rejected":
      return failure(
        "invalid_spec",
        `ProtoViewer refused the prototype at ${result.path}: ${result.reason}`,
      );
    case "not_found":
      return failure(
        "not_found",
        "ProtoViewer has no library entry with that id; save the prototype again.",
      );
  }
}

function failure(errorCode: ProtoViewerErrorCode, error: string): ProtoViewerOutput {
  return { success: false, errorCode, error };
}
