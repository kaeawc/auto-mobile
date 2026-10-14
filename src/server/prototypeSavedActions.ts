import type { z } from "zod/v4";
import {
  PROTOTYPE_SAVED_CAPABILITY,
  isSavedPrototypeErrorCode,
  type PrototypeResult,
  type SavedPrototypeErrorCode,
  type SavedPrototypeInfo,
  type SavedPrototypeEntry,
} from "../features/observe/android/ctrlProxyProtocol";
import { prototypeSavedUnsupportedMessage } from "../features/observe/android/CtrlProxyPrototypes";
import type { AndroidPrototypeTransport } from "../features/prototype/androidPrototypeTransport";
import type { PrototypeSpec, PrototypeJson } from "../features/prototype/prototypeSpec";
import { hasElementAnchors } from "../features/prototype/prototypeAnchors";
import {
  preparePrototypeAssets,
  type PrototypeAssetSource,
  type PrototypeAssetFileReader,
  type PrototypeObservationScreenshotReader,
  type UploadedPrototypeAsset,
} from "../features/prototype/prototypeAssetUploader";
import type { IosPrototypeInstaller } from "../features/prototype/ios/iosPrototypeInstaller";
import { createDefaultIosPrototypeInstaller } from "../features/prototype/ios/iosPrototypeInstallerFactory";
import {
  PrototypeInstallPhysicalDeviceError,
  TemplateResolveError,
} from "../features/prototype/ios/iosPrototypeInstallerErrors";
import {
  PROTOTYPE_BUNDLE_ID_PREFIX,
  isPrototypeBundleId,
  prototypeBundleId,
} from "../features/prototype/ios/iosPrototypeBundleId";
import { resolveIosDeviceKind } from "../utils/ios-cmdline-tools/IosDeviceKind";
import type { BootedDevice } from "../models";
import { ActionableError, toActionableError } from "../models/ActionableError";
import { logger } from "../utils/logger";
import { errorMessage } from "../utils/describeUnknownError";

export type PrototypeSavedAction = "save" | "listSaved" | "deleteSaved";
export type PrototypeSavedErrorCode =
  | SavedPrototypeErrorCode
  | "unsupported_capability"
  | "unsupported_platform";
export interface PrototypeSavedOutput {
  success: boolean;
  error?: string;
  errorCode?: PrototypeSavedErrorCode;
  saved?: SavedPrototypeInfo;
  savedPrototypes?: (Omit<SavedPrototypeEntry, "savedAt"> & { savedAt?: number })[];
  pinned?: "unsupported";
  warning?: string;
  uploadedAssets?: UploadedPrototypeAsset[];
}
export interface PrototypeSavedArgs {
  action: PrototypeSavedAction;
  spec?: PrototypeSpec;
  label?: string;
  icon?: string;
  pin?: true;
  id?: string;
  removeIcon?: true;
  timeoutMs?: number;
  assets?: readonly PrototypeAssetSource[];
}
export interface PrototypeSavedDependencies {
  client: Pick<AndroidPrototypeTransport, "save" | "listSaved" | "deleteSaved" | "supportsCommand">;
  stageAssets: () => Promise<{ uploaded: UploadedPrototypeAsset[]; failure?: PrototypeResult }>;
  signal?: AbortSignal;
}
export const savedPrototypeErrorMessages: Record<SavedPrototypeErrorCode, string> = {
  pin_unsupported: "This launcher does not support pinned shortcuts; save without pin.",
  device_locked: "Unlock the device and retry saving with pin.",
  pin_failed:
    "The launcher refused the pinned shortcut; retry or accept the saved prototype without a shortcut.",
  invalid_id: "Use a valid saved prototype id.",
  invalid_label: "Use a non-empty label of at most 120 characters.",
  spec_too_large: "Reduce the saved prototype spec size and retry.",
  invalid_spec: "Correct the prototype spec before saving it.",
  invalid_asset_id: "Use a valid asset id for each uploaded asset and icon.",
  duplicate_asset_id: "Give each uploaded asset a unique id.",
  unsupported_mime_type: "Use a supported asset MIME type (PNG, JPEG, WebP, TTF or OTF).",
  empty_asset: "Replace the empty asset with a non-empty file.",
  asset_too_large: "Reduce the individual asset file size and retry.",
  count_limit: "Upload fewer assets in this saved prototype.",
  total_limit: "Reduce the combined size of the saved prototype assets.",
  missing_asset: "Upload every referenced asset in the same save call.",
  saved_count_limit: "Delete an unused saved prototype before saving another.",
  storage_failure: "Check available device storage and retry saving the prototype.",
  unsupported_existing:
    "Update CtrlProxy to read the existing saved prototype before replacing it.",
  not_found: "List saved prototypes and use an id that still exists.",
  unsupported_format: "Update CtrlProxy to support this saved prototype format.",
  internal_error: "Retry the saved prototype request; if it persists, inspect the CtrlProxy logs.",
};
export function savedPrototypeFailure(result: PrototypeResult): PrototypeSavedOutput {
  if (isSavedPrototypeErrorCode(result.errorCode)) {
    const message = savedPrototypeErrorMessages[result.errorCode];
    return {
      success: false,
      errorCode: result.errorCode,
      error: result.error ? `${message} ${result.error}` : message,
    };
  }
  return {
    success: false,
    error: result.error ?? "Saved prototype request failed; retry the request.",
  };
}
export function isPrototypeSavedAction(action: string): action is PrototypeSavedAction {
  return action === "save" || action === "listSaved" || action === "deleteSaved";
}
const requestTypes: Record<PrototypeSavedAction, string> = {
  save: "save_prototype",
  listSaved: "list_saved_prototypes",
  deleteSaved: "delete_saved_prototype",
};
export function savedPrototypeSuccess(
  args: PrototypeSavedArgs,
  result: PrototypeResult,
): PrototypeSavedOutput {
  if (args.action === "listSaved") {
    return { success: true, savedPrototypes: result.savedPrototypes ?? [] };
  }
  if (args.action === "deleteSaved") {
    return {
      success: true,
      warning: `${args.removeIcon ? "Icon removal is not available in this build; any icon pinned earlier remains and can be removed by hand. " : ""}A deleted prototype's disabled home-screen icon may remain.`,
    };
  }
  return {
    success: true,
    ...(result.saved ? { saved: result.saved } : {}),
    ...(args.pin
      ? {
          pinned: "unsupported",
          warning: "Pinning to the home screen is not available in this build.",
        }
      : {}),
  };
}
function savedPrototypeRequestFailure(
  error: unknown,
  action: PrototypeSavedAction,
  signal?: AbortSignal,
): PrototypeSavedOutput {
  logger.warn("[prototype] Saved prototype request failed", error);
  const actionable = toActionableError(
    action === "save" && signal?.aborted
      ? new ActionableError("the request was cancelled", { cause: error })
      : error,
    "Saved prototype request failed",
  );
  return {
    success: false,
    error:
      // TemplateResolveError already embeds an ActionableError cause in its message.
      actionable instanceof TemplateResolveError &&
      actionable.cause !== undefined &&
      !(actionable.cause instanceof ActionableError)
        ? `${actionable.message}: ${errorMessage(actionable.cause)}`
        : actionable.message,
  };
}
function savedPrototypeResult(
  args: PrototypeSavedArgs,
  result: PrototypeResult,
): PrototypeSavedOutput {
  return result.success ? savedPrototypeSuccess(args, result) : savedPrototypeFailure(result);
}
export async function performPrototypeSavedAction(
  deps: PrototypeSavedDependencies,
  args: PrototypeSavedArgs,
): Promise<PrototypeSavedOutput> {
  try {
    if (!(await deps.client.supportsCommand(PROTOTYPE_SAVED_CAPABILITY))) {
      return {
        success: false,
        errorCode: "unsupported_capability",
        error: prototypeSavedUnsupportedMessage(requestTypes[args.action]),
      };
    }
    if (args.action === "save" && hasElementAnchors(args.spec!)) {
      return savedElementAnchorFailure();
    }
    if (args.action === "listSaved") {
      const result = await deps.client.listSaved(args.timeoutMs);
      return savedPrototypeResult(args, result);
    }
    if (args.action === "deleteSaved") {
      const result = await deps.client.deleteSaved(args.id!, args.timeoutMs);
      return savedPrototypeResult(args, result);
    }
    const staged = await deps.stageAssets();
    deps.signal?.throwIfAborted();
    const uploaded = staged.uploaded.length ? { uploadedAssets: staged.uploaded } : {};
    if (staged.failure) {
      return { ...savedPrototypeFailure(staged.failure), ...uploaded };
    }
    const result = await deps.client.save(
      {
        spec: args.spec!,
        label: args.label ?? args.spec!.id,
        ...(args.icon === undefined ? {} : { icon: args.icon }),
      },
      args.timeoutMs,
    );
    return {
      ...savedPrototypeResult(args, result),
      ...uploaded,
    };
  } catch (error) {
    return savedPrototypeRequestFailure(error, args.action, deps.signal);
  }
}

/** Action-specific refinements keep the existing actions' validation unchanged. */
export function validatePrototypeSavedInput(
  value: {
    action: string;
    spec?: unknown;
    id?: string;
    autoConfirm?: true;
    pin?: true;
    icon?: string;
    assets?: readonly { id: string }[];
  },
  ctx: z.RefinementCtx,
): void {
  if (value.action === "save" && value.spec === undefined) {
    ctx.addIssue({ code: "custom", path: ["spec"], message: "save requires spec" });
  }
  if (value.action === "deleteSaved" && value.id === undefined) {
    ctx.addIssue({ code: "custom", path: ["id"], message: "deleteSaved requires id" });
  }
  if (value.autoConfirm && !value.pin) {
    ctx.addIssue({ code: "custom", path: ["autoConfirm"], message: "autoConfirm requires pin" });
  }
  if (
    value.action === "save" &&
    value.icon !== undefined &&
    !value.assets?.some((asset) => asset.id === value.icon)
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["icon"],
      message: "save icon must be an asset uploaded in assets in this call",
    });
  }
}
export type IosSavedPrototypeInstaller = Pick<IosPrototypeInstaller, "install" | "list" | "delete">;

interface IosSavedDependencies {
  installer?: IosSavedPrototypeInstaller;
  assetFileReader: PrototypeAssetFileReader;
  observationScreenshotReader: PrototypeObservationScreenshotReader;
}

/** Intercept saved iOS actions, otherwise retain the existing platform validation. */
export function createPrototypeSavedPlatformDispatch(dependencies: IosSavedDependencies) {
  let installer = dependencies.installer;
  const backend = () => (installer ??= createDefaultIosPrototypeInstaller());
  return (
    device: BootedDevice,
    args: Omit<PrototypeSavedArgs, "action"> & { action: string },
    signal: AbortSignal | undefined,
    platformError: () =>
      | (Pick<ActionableError, "message"> & { errorCode?: PrototypeSavedErrorCode })
      | undefined,
  ): Promise<PrototypeSavedOutput> | PrototypeSavedOutput | undefined => {
    const error = platformError();
    if (error) {
      return prototypePlatformFailure(error);
    }
    if (device.platform !== "ios" || !isPrototypeSavedAction(args.action)) {
      return undefined;
    }
    return performIosSavedAction(
      backend,
      device,
      { ...args, action: args.action },
      dependencies,
      signal,
    );
  };
}

/** Element anchors resolve against the live screen, so a saved prototype cannot carry them. */
function savedElementAnchorFailure(): PrototypeSavedOutput {
  return savedPrototypeFailure({
    success: false,
    errorCode: "invalid_spec",
    error:
      'Element anchors are resolved against the live screen and are not supported in a saved prototype; use {type:"bounds",bounds:{x,y,width,height}} anchors (dp) instead. Nothing was uploaded or saved.',
  });
}

async function saveIosPrototype(
  backend: () => IosSavedPrototypeInstaller,
  udid: string,
  args: PrototypeSavedArgs,
  readers: IosSavedDependencies,
  signal?: AbortSignal,
): Promise<PrototypeSavedOutput> {
  if (hasElementAnchors(args.spec!)) {
    return savedElementAnchorFailure();
  }
  const prepared = await preparePrototypeAssets(
    args.assets ?? [],
    readers.assetFileReader,
    readers.observationScreenshotReader,
  );
  signal?.throwIfAborted();
  if ("error" in prepared) {
    return savedPrototypeFailure({
      success: false,
      error: `${prepared.error} The prototype was not saved.`,
    });
  }
  const spec = args.spec!; // Shared schema validation and component expansion ran before dispatch.
  const bundleId = prototypeBundleId(spec.id);
  const icon = prepared.assets.find((asset) => asset.id === args.icon);
  const installer = backend();
  const installed = await installer.list(udid);
  const replaced = installed.some((app) => app.bundleId === bundleId);
  signal?.throwIfAborted();
  await installer.install({
    udid,
    prototypeId: spec.id,
    label: args.label ?? spec.id,
    spec: spec as PrototypeJson,
    assets: prepared.assets,
    ...(icon ? { icon: { image: Buffer.from(icon.bytes) } } : {}),
  });
  return {
    ...savedPrototypeSuccess(args, {
      success: true,
      saved: {
        id: spec.id,
        slug: bundleId.slice(PROTOTYPE_BUNDLE_ID_PREFIX.length),
        replaced,
      },
    }),
    ...(args.pin
      ? {
          warning:
            "Pinning is not available on iOS simulators; the app icon is on the home screen.",
        }
      : {}),
    ...(prepared.assets.length
      ? {
          uploadedAssets: prepared.assets.map((asset) => ({
            id: asset.id,
            mimeType: asset.mimeType,
            bytes: asset.bytes.length,
          })),
        }
      : {}),
  };
}

async function performIosSavedAction(
  backend: () => IosSavedPrototypeInstaller,
  device: BootedDevice,
  args: PrototypeSavedArgs,
  readers: IosSavedDependencies,
  signal?: AbortSignal,
): Promise<PrototypeSavedOutput> {
  try {
    if (resolveIosDeviceKind(device) !== "simulator") {
      throw new PrototypeInstallPhysicalDeviceError();
    }
    signal?.throwIfAborted();
    if (args.action === "save") {
      return await saveIosPrototype(backend, device.deviceId, args, readers, signal);
    }
    const installer = backend();
    if (args.action === "listSaved") {
      const installed = await installer.list(device.deviceId);
      return {
        success: true,
        savedPrototypes: installed.map((app) => {
          const slug = app.bundleId.slice(PROTOTYPE_BUNDLE_ID_PREFIX.length);
          return { id: app.bundleId, label: app.displayName ?? slug, slug, pinned: false };
        }),
      };
    }
    const bundleId = isPrototypeBundleId(args.id!) ? args.id! : prototypeBundleId(args.id!);
    const installed = await installer.list(device.deviceId);
    signal?.throwIfAborted();
    if (!installed.some((app) => app.bundleId === bundleId)) {
      return savedPrototypeFailure({ success: false, errorCode: "not_found" });
    }
    await installer.delete(
      device.deviceId,
      isPrototypeBundleId(args.id!) ? args.id! : { prototypeId: args.id! },
    );
    return {
      success: true,
      ...(args.removeIcon
        ? {
            warning:
              "Icon removal does not apply on iOS simulators; deleting the prototype removes its app icon.",
          }
        : {}),
    };
  } catch (error) {
    if (error instanceof PrototypeInstallPhysicalDeviceError) {
      logger.warn("[prototype] Saved prototype requires an iOS simulator", error);
      return {
        success: false,
        errorCode: "unsupported_platform",
        error: "Saved prototypes need an iOS simulator. Target one with deviceId or sessionUuid.",
      };
    }
    return savedPrototypeRequestFailure(error, args.action, signal);
  }
}

/** Dispatches saved actions without adding decisions to the shared tool handler. */
export function dispatchPrototypeSavedAction<T>(
  args: Omit<PrototypeSavedArgs, "action"> & {
    action: PrototypeSavedAction | "show" | "patch" | "dismiss";
  },
  dependencies: () => PrototypeSavedDependencies,
  fallback: (action: "show" | "patch" | "dismiss") => Promise<T>,
): Promise<PrototypeSavedOutput | T> {
  if (isPrototypeSavedAction(args.action)) {
    return performPrototypeSavedAction(dependencies(), { ...args, action: args.action });
  }
  return fallback(args.action);
}

/** Preserve the existing platform error shape unless a saved-action code applies. */
export function prototypePlatformFailure(
  error: Pick<ActionableError, "message"> & { errorCode?: PrototypeSavedErrorCode },
): PrototypeSavedOutput {
  return {
    success: false,
    error: error.message,
    ...(error.errorCode ? { errorCode: error.errorCode } : {}),
  };
}
