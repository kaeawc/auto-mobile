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
import type { DeviceDisplays } from "../../../models/DisplayPanel";
import { logger } from "../../../utils/logger";
import { errorMessage } from "../../../utils/describeUnknownError";
import {
  PROTOVIEWER_DEFAULT_TIMEOUT_MS,
  ProtoViewerEntryPointMissingError,
  ProtoViewerStorageError,
  type ProtoViewerDevice,
} from "./protoViewerDevice";
import { protoViewerDisplayFor, type ProtoViewerDisplay } from "./protoViewerDisplay";
import {
  PROTOVIEWER_CAPABILITY_PATH,
  PROTOVIEWER_LIBRARY_ID,
  protoViewerDefaultLabel,
  protoViewerLabelProblem,
  type ProtoViewerResult,
} from "./protoViewerContract";

export const PROTOVIEWER_IMPORTED_WARNING =
  "ProtoViewer treats this prototype as imported: its requests stay off until someone turns on network for imported prototypes in ProtoViewer's settings, and it is not attached to this host (no awaitEvent, patch or inspect).";

export interface ProtoViewerEntry {
  app: "protoviewer";
  libraryId: string;
  label: string;
  /** The panel it landed on, on a multi-screen device (iPhone Duo) when the app reported it. */
  display?: ProtoViewerDisplay;
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
  /** Panel key, role or `active` the caller asked for; ProtoViewer cannot choose one, only report it. */
  display?: string;
}

export interface ProtoViewerRouteDependencies {
  device: ProtoViewerDevice;
  assetFileReader: PrototypeAssetFileReader;
  observationScreenshotReader: PrototypeObservationScreenshotReader;
  /** The device's display inventory, to name the panel a result landed on. */
  displays?: DeviceDisplays;
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
 * is not installed falls back to the existing platform save path.
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
  const installed = await probeInstalled(deps, signal);
  if (!installed) {
    // The normal case for Android without ProtoViewer and for physical iOS devices.
    logger.debug(
      "[protoviewer] ProtoViewer is unavailable for this target. Keeping the platform save path.",
    );
    return undefined;
  }
  return await saveInProtoViewer(args, args.spec, deps, signal);
}

/** A probe that cannot answer keeps the platform save path: it must never fail a save by itself. */
async function probeInstalled(
  deps: ProtoViewerRouteDependencies,
  signal?: AbortSignal,
): Promise<boolean> {
  try {
    return await deps.device.installed(signal);
  } catch (error) {
    if (signal?.aborted) {
      throw error;
    }
    logger.warn(
      `[protoviewer] could not check for ProtoViewer, keeping the platform save path: ${errorMessage(error)}`,
      error,
    );
    return false;
  }
}

async function saveInProtoViewer(
  args: ProtoViewerInput,
  spec: PrototypeSpec,
  deps: ProtoViewerRouteDependencies,
  signal?: AbortSignal,
): Promise<ProtoViewerOutput | undefined> {
  if (hasElementAnchors(spec)) {
    return failure(
      "invalid_spec",
      'Element anchors are resolved against the live screen and are not supported in a saved prototype; use {type:"bounds",bounds:{x,y,width,height}} anchors (dp) instead. Nothing was saved.',
    );
  }
  const label = libraryLabel(args.label, spec.id);
  if ("failure" in label) {
    return label.failure;
  }
  const bundle = await canonicalBundle(args, spec, deps);
  if ("failure" in bundle) {
    return bundle.failure;
  }
  return await deviceCall(
    () =>
      deps.device.importBundle(
        bundle.bytes,
        label.label,
        args.timeoutMs ?? PROTOVIEWER_DEFAULT_TIMEOUT_MS,
        signal,
      ),
    (error) => {
      // An absent entry point or unusable app storage means nothing was imported; retain the
      // platform save path (including Android shell-owned storage, #15174).
      logger.warn(`[protoviewer] ${error.message} Keeping the platform save path.`);
      return undefined;
    },
    deps.displays,
    args.display,
  );
}

/** The caller's label, checked with the app's rule, or one derived from the spec id. */
function libraryLabel(
  label: string | undefined,
  specId: string,
): { label: string | undefined } | { failure: ProtoViewerOutput } {
  if (label === undefined) {
    return { label: protoViewerDefaultLabel(specId) };
  }
  const problem = protoViewerLabelProblem(label);
  return problem === undefined
    ? { label: label.trim() }
    : { failure: failure("invalid_label", `${problem} Nothing was saved.`) };
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
  const installed = await deps.device.installed(signal).catch((error: unknown) => {
    if (signal?.aborted) {
      throw error;
    }
    logger.warn(`[protoviewer] could not check for ProtoViewer: ${errorMessage(error)}`, error);
    return undefined;
  });
  if (!installed) {
    return failure(
      "unsupported_capability",
      "open needs ProtoViewer installed on the device; install it and save the prototype again.",
    );
  }
  const libraryId = args.id;
  const opened = await deviceCall(
    () => deps.device.open(libraryId, args.timeoutMs ?? PROTOVIEWER_DEFAULT_TIMEOUT_MS, signal),
    (error) => failure("unsupported_capability", error.message),
    deps.displays,
    args.display,
  );
  return opened ?? failure("unsupported_capability", "ProtoViewer could not open the entry.");
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

async function deviceCall(
  call: () => Promise<ProtoViewerResult>,
  onUnreachable: (
    error: ProtoViewerEntryPointMissingError | ProtoViewerStorageError,
  ) => ProtoViewerOutput | undefined,
  displays: DeviceDisplays | undefined,
  requestedDisplay?: string,
): Promise<ProtoViewerOutput | undefined> {
  let result: ProtoViewerResult;
  try {
    result = await call();
  } catch (error) {
    if (
      error instanceof ProtoViewerEntryPointMissingError ||
      error instanceof ProtoViewerStorageError
    ) {
      return onUnreachable(error);
    }
    logger.warn(`[protoviewer] request failed: ${errorMessage(error)}`, error);
    return { success: false, error: `ProtoViewer request failed: ${errorMessage(error)}` };
  }
  return outputFor(result, displays, requestedDisplay);
}

function outputFor(
  result: ProtoViewerResult,
  displays: DeviceDisplays | undefined,
  requestedDisplay?: string,
): ProtoViewerOutput {
  switch (result.status) {
    case "imported":
    case "opened": {
      const display = protoViewerDisplayFor(result.screen, displays);
      return {
        success: true,
        viewer: {
          app: "protoviewer",
          libraryId: result.libraryId,
          label: result.label,
          ...(display ? { display } : {}),
        },
        warning: [PROTOVIEWER_IMPORTED_WARNING, displayMismatchWarning(requestedDisplay, display)]
          .filter((part) => part !== undefined)
          .join(" "),
      };
    }
    case "rejected":
      return rejectionOutput(result.path, result.reason);
    case "not_found":
      return failure(
        "not_found",
        "ProtoViewer has no library entry with that id; save the prototype again.",
      );
  }
}

function rejectionOutput(path: string, reason: string): ProtoViewerOutput {
  if (path === PROTOVIEWER_CAPABILITY_PATH) {
    return failure(
      "unsupported_capability",
      `The installed ProtoViewer cannot show this prototype (${reason}). Install a newer ProtoViewer.`,
    );
  }
  return failure(
    path === "label" ? "invalid_label" : "invalid_spec",
    `ProtoViewer refused the prototype at ${path}: ${reason}`,
  );
}

function failure(errorCode: ProtoViewerErrorCode, error: string): ProtoViewerOutput {
  return { success: false, errorCode, error };
}

/**
 * ProtoViewer opens on whichever panel is in front when the URL is handled, so a requested `display`
 * is honoured only by coincidence. Say so when the reported panel is not the requested one, or
 * cannot be told, instead of silently ignoring the argument.
 */
export function displayMismatchWarning(
  requested: string | undefined,
  landed: ProtoViewerDisplay | undefined,
): string | undefined {
  if (requested === undefined || requested === "active") {
    return undefined;
  }
  if (landed === undefined) {
    return `display "${requested}" was not applied: ProtoViewer opens on the panel in front and this device did not report which one that was.`;
  }
  if (requested === landed.key || requested === landed.role) {
    return undefined;
  }
  return `display "${requested}" was not applied: ProtoViewer cannot choose a panel and opened on the ${landed.role} panel (${landed.key}). Fold or unfold the device to the panel you want and open again.`;
}
