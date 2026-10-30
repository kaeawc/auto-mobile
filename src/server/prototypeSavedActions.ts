import { prototypeIosShaderProblem } from "../features/prototype/prototypeShaders";
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
import type { AdbExecutor } from "../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { AndroidUserTargetResolver } from "../utils/android-cmdline-tools/AndroidUserTargetResolver";
import { CTRL_PROXY_PACKAGE } from "../ctrlProxy/constants";
import { ActionableError, toActionableError } from "../models/ActionableError";
import { outputLooksLikeShellFailure } from "../utils/android-cmdline-tools/shellOutputHeuristics";
import { logger } from "../utils/logger";
import { errorMessage } from "../utils/describeUnknownError";
import type { ProtoViewerDevice } from "../features/prototype/protoViewer/protoViewerDevice";
import {
  protoViewerHandles,
  routeToProtoViewer,
  type ProtoViewerEntry,
} from "../features/prototype/protoViewer/protoViewerSaved";
import {
  confirmPinDialog,
  type PinConfirmationDriver,
  type PinConfirmationOutcome,
} from "../features/prototype/pinConfirmation";

import {
  refreshLauncherForShortcut,
  type LauncherRefreshDriver,
} from "../features/prototype/launcherRefresh";

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
  pinned?: "pinned" | "pending" | "unsupported";
  /** Whether the default launcher was restarted so a new or updated shortcut shows (#14887). */
  launcherRestarted?: boolean;
  /** Whether the shortcut was seen on the home screen after pin/update; absent when not checked. */
  shortcutVisible?: boolean;
  warning?: string;
  uploadedAssets?: UploadedPrototypeAsset[];
  viewer?: ProtoViewerEntry;
}
export interface PrototypeSavedInput {
  action: PrototypeSavedAction;
  spec?: PrototypeSpec;
  label?: string;
  icon?: string;
  pin?: true;
  autoConfirm?: true;
  /** false opts out of the automatic launcher restart after a pin or shortcut update. */
  restartLauncher?: false;
  id?: string;
  removeIcon?: true;
  timeoutMs?: number;
  assets?: readonly PrototypeAssetSource[];
}
export interface PrototypeSavedDependencies {
  client: Pick<
    AndroidPrototypeTransport,
    "save" | "listSaved" | "deleteSaved" | "pinSaved" | "supportsCommand"
  >;
  /** Host-side adb for `removeIcon`; absent means the icon cannot be cleared from the host. */
  adb?: AdbExecutor;
  /** Accepts the launcher's pin dialog for `autoConfirm`; absent means it cannot be driven. */
  pinConfirmation?: PinConfirmationDriver;
  /** Looks for the shortcut and restarts the launcher when it is missing; absent skips it. */
  launcherRefresh?: LauncherRefreshDriver;
  stageAssets: () => Promise<{ uploaded: UploadedPrototypeAsset[]; failure?: PrototypeResult }>;
  signal?: AbortSignal;
}
export const savedPrototypeErrorMessages: Record<SavedPrototypeErrorCode, string> = {
  render_failed:
    "The prototype did not complete its first render. Check the prototype content and CtrlProxy logs, then retry.",
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
  args: PrototypeSavedInput,
  result: PrototypeResult,
): PrototypeSavedOutput {
  if (args.action === "listSaved") {
    return { success: true, savedPrototypes: result.savedPrototypes ?? [] };
  }
  if (args.action === "deleteSaved") {
    return { success: true, warning: DISABLED_ICON_WARNING };
  }
  return {
    success: true,
    ...(result.saved ? { saved: result.saved } : {}),
  };
}
const DISABLED_ICON_WARNING = "A deleted prototype's disabled home-screen icon may remain.";
/** Clearing is only safe when no saved prototype is left: it clears every CtrlProxy shortcut. */
const clearShortcutsCommand = (userId: number) =>
  `shell cmd shortcut clear-shortcuts --user ${userId} ${CTRL_PROXY_PACKAGE}`;
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
  args: PrototypeSavedInput,
  result: PrototypeResult,
): PrototypeSavedOutput {
  return result.success ? savedPrototypeSuccess(args, result) : savedPrototypeFailure(result);
}
export async function performPrototypeSavedAction(
  deps: PrototypeSavedDependencies,
  args: PrototypeSavedInput,
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
      if (result.success && args.removeIcon) {
        return { success: true, warning: await removeIconWarning(deps, args.timeoutMs) };
      }
      return savedPrototypeResult(args, result);
    }
    return await saveAndroidPrototype(deps, args);
  } catch (error) {
    return savedPrototypeRequestFailure(error, args.action, deps.signal);
  }
}

async function saveAndroidPrototype(
  deps: PrototypeSavedDependencies,
  args: PrototypeSavedInput,
): Promise<PrototypeSavedOutput> {
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
  const output = savedPrototypeResult(args, result);
  if (!output.success) {
    return { ...output, ...uploaded };
  }
  return { ...output, ...(await pinAndRefresh(deps, args, result)), ...uploaded };
}

/** The pin step (when asked for) and the launcher refresh that follows a shortcut change. */
async function pinAndRefresh(
  deps: PrototypeSavedDependencies,
  args: PrototypeSavedInput,
  result: PrototypeResult,
): Promise<Partial<PrototypeSavedOutput>> {
  if (!args.pin) {
    // An updated shortcut (new label or icon) can show stale in the launcher without a pin call.
    return await refreshLauncher(deps, args, result.saved?.shortcut === "updated");
  }
  // The pin transport takes no signal, so a cancellation that landed during the save must stop
  // the second mutation here; the completed save is still reported.
  if (deps.signal?.aborted) {
    return {
      warning: "The request was cancelled after the save, so the prototype was not pinned.",
    };
  }
  const pinned = await pinSavedPrototype(deps, args, result.saved?.id ?? args.spec!.id);
  return { ...pinned, ...(await refreshLauncher(deps, args, pinned.pinned === "pinned")) };
}

/**
 * Restarts the default launcher when a pinned or updated shortcut is not showing (#14887). Runs
 * once per call, only when the shortcut exists, and never fails the save.
 */
async function refreshLauncher(
  deps: PrototypeSavedDependencies,
  args: PrototypeSavedInput,
  shortcutExists: boolean,
): Promise<Partial<PrototypeSavedOutput>> {
  if (!deps.launcherRefresh || args.restartLauncher === false || !shortcutExists) {
    return {};
  }
  try {
    const outcome = await refreshLauncherForShortcut(deps.launcherRefresh, {
      label: args.label ?? args.spec!.id,
      signal: deps.signal,
    });
    return {
      launcherRestarted: outcome.launcherRestarted,
      shortcutVisible: outcome.shortcutVisible,
      ...(outcome.message ? { warning: outcome.message } : {}),
    };
  } catch (error) {
    if (deps.signal?.aborted) {
      throw error;
    }
    // The pin already succeeded; a failed launcher check only leaves visibility unreported.
    logger.warn(`[prototype] launcher refresh failed: ${errorMessage(error)}`, error);
    return {};
  }
}

const PIN_PENDING_WARNING =
  "The launcher's confirmation dialog is open and the icon is pinned only once it is accepted; declining sends no signal.";
const PIN_VERIFY_ATTEMPTS = 5;
const PIN_VERIFY_POLL_MS = 400;

function autoConfirmReason(outcome: PinConfirmationOutcome | undefined): string {
  switch (outcome?.status) {
    case "unrecognized":
      return `confirmation_unrecognized: no known accept button in the launcher dialog (buttons seen: ${outcome.visibleButtons.join(", ") || "none"}); accept it on the device.`;
    case "timeout":
      return "The launcher's confirmation dialog did not appear in time; accept it on the device if it is open.";
    case "tap_failed":
      return `Tapping the accept button failed (${outcome.error}); accept it on the device.`;
    case "tapped":
      return `Tapped "${outcome.label}" but the shortcut was not reported pinned yet.`;
    default:
      return "autoConfirm needs a driveable device; accept the launcher dialog on the device.";
  }
}

/** Taps the launcher's accept button, then reports pinned only once listSaved says so. */
async function autoConfirmPin(
  deps: PrototypeSavedDependencies,
  args: PrototypeSavedInput,
  id: string,
): Promise<Partial<PrototypeSavedOutput>> {
  const driver = deps.pinConfirmation;
  const pending = (outcome?: PinConfirmationOutcome) => ({
    pinned: "pending" as const,
    warning: `${PIN_PENDING_WARNING} autoConfirm: ${autoConfirmReason(outcome)}`,
  });
  if (!driver) {
    return pending();
  }
  const outcome = await confirmPinDialog(driver, { signal: deps.signal });
  if (outcome.status !== "tapped") {
    return pending(outcome);
  }
  for (let attempt = 0; attempt < PIN_VERIFY_ATTEMPTS; attempt++) {
    deps.signal?.throwIfAborted();
    if (await isPinnedOnDevice(deps, id, args.timeoutMs)) {
      return { pinned: "pinned" };
    }
    await driver.timer.sleep(PIN_VERIFY_POLL_MS);
  }
  return pending(outcome);
}

async function isPinnedOnDevice(
  deps: PrototypeSavedDependencies,
  id: string,
  timeoutMs: number | undefined,
): Promise<boolean> {
  try {
    const listed = await deps.client.listSaved(timeoutMs);
    return listed.savedPrototypes?.some((entry) => entry.id === id && entry.pinned) === true;
  } catch (error) {
    if (deps.signal?.aborted) {
      throw error;
    }
    // A failed verification read only leaves the pin pending, which is reported to the caller.
    logger.warn(`[prototype] pin verification failed: ${errorMessage(error)}`, error);
    return false;
  }
}

/**
 * The save already succeeded, so a pin problem never drops `saved`: the pin outcome rides beside
 * it. Declining the launcher dialog sends no callback, so a requested pin stays `pending`.
 */
async function pinSavedPrototype(
  deps: PrototypeSavedDependencies,
  args: PrototypeSavedInput,
  id: string,
): Promise<Partial<PrototypeSavedOutput>> {
  let reply: PrototypeResult;
  try {
    reply = await deps.client.pinSaved(id, args.icon, args.timeoutMs);
  } catch (error) {
    if (deps.signal?.aborted) {
      throw error;
    }
    // The save already succeeded; a pin transport failure must not hide it.
    logger.warn(`[prototype] pin request failed: ${errorMessage(error)}`, error);
    return { success: false, error: `Saved, but pinning failed. ${errorMessage(error)}` };
  }
  if (reply.success && reply.pin?.status === "already_pinned") {
    return { pinned: "pinned" };
  }
  if (reply.success && args.autoConfirm) {
    return await autoConfirmPin(deps, args, id);
  }
  if (reply.success) {
    return { pinned: "pending", warning: PIN_PENDING_WARNING };
  }
  const failure = savedPrototypeFailure(reply);
  if (reply.errorCode === "pin_unsupported") {
    return { pinned: "unsupported", warning: `Saved without a shortcut. ${failure.error}` };
  }
  return {
    success: false,
    errorCode: failure.errorCode,
    error: `Saved, but pinning failed. ${failure.error}`,
  };
}

/** The saved ids still present after a delete, or the warning that the list could not be confirmed. */
async function probeRemainingSaved(
  deps: PrototypeSavedDependencies,
  timeoutMs: number | undefined,
): Promise<readonly unknown[] | string> {
  const unconfirmed = (detail: string) =>
    `Could not confirm that no saved prototype remains${detail}, so no icon was cleared. ${DISABLED_ICON_WARNING}`;
  try {
    const remaining = await deps.client.listSaved(timeoutMs);
    // Only an explicit empty list proves nothing else would lose its shortcut.
    return remaining.success && remaining.savedPrototypes !== undefined
      ? remaining.savedPrototypes
      : unconfirmed("");
  } catch (error) {
    if (deps.signal?.aborted) {
      throw error;
    }
    // The delete already succeeded; an unconfirmed probe only means the icon is left alone.
    logger.warn(`[prototype] saved-list probe failed: ${errorMessage(error)}`, error);
    return unconfirmed(` (${errorMessage(error)})`);
  }
}

async function removeIconWarning(
  deps: PrototypeSavedDependencies,
  timeoutMs: number | undefined,
): Promise<string> {
  if (!deps.adb) {
    return `removeIcon is unavailable without host adb. ${DISABLED_ICON_WARNING}`;
  }
  const remaining = await probeRemainingSaved(deps, timeoutMs);
  if (typeof remaining === "string") {
    return remaining;
  }
  if (remaining.length > 0) {
    return `Other saved prototypes remain, and clearing shortcuts would remove their icons too, so the icon was left. ${DISABLED_ICON_WARNING}`;
  }
  try {
    // ShortcutService defaults to user 0, so a work or secondary profile needs the active user.
    const { userId } = await new AndroidUserTargetResolver(deps.adb).resolve({
      currentUser: true,
      signal: deps.signal,
    });
    const cleared = await deps.adb.executeCommand(clearShortcutsCommand(userId), {
      noRetry: true,
      signal: deps.signal,
    });
    const output = `${cleared.stdout}\n${cleared.stderr ?? ""}`.trim();
    if (outputLooksLikeShellFailure(cleared.stdout, cleared.stderr ?? "")) {
      return `Clearing the icon failed: ${output}. ${DISABLED_ICON_WARNING}`;
    }
    return "Cleared CtrlProxy's pinned shortcuts, the last saved prototype's icon included.";
  } catch (error) {
    if (deps.signal?.aborted) {
      throw error;
    }
    logger.warn(`[prototype] clear-shortcuts failed: ${errorMessage(error)}`, error);
    return `Clearing the icon failed: ${errorMessage(error)}. ${DISABLED_ICON_WARNING}`;
  }
}

function requireSavedId(value: { action: string; id?: string }, ctx: z.RefinementCtx): void {
  if ((value.action === "deleteSaved" || value.action === "open") && value.id === undefined) {
    ctx.addIssue({ code: "custom", path: ["id"], message: `${value.action} requires id` });
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
  requireSavedId(value, ctx);
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
  env?: NodeJS.ProcessEnv;
  installer?: IosSavedPrototypeInstaller;
  assetFileReader: PrototypeAssetFileReader;
  observationScreenshotReader: PrototypeObservationScreenshotReader;
  /** ProtoViewer on Android or an iOS simulator; absent means saves keep the platform path. */
  protoViewer?: (device: BootedDevice) => ProtoViewerDevice;
}

const OPEN_NEEDS_PROTOVIEWER =
  "open needs ProtoViewer installed on an Android device or iOS simulator.";

/**
 * Intercept saved iOS actions and ProtoViewer-routed Android ones, otherwise retain the existing
 * platform validation. A promise that settles undefined means "not routed": continue as before.
 */
export function createPrototypeSavedPlatformDispatch(dependencies: IosSavedDependencies) {
  let installer = dependencies.installer;
  const backend = () => (installer ??= createDefaultIosPrototypeInstaller());
  return (
    device: BootedDevice,
    args: Omit<PrototypeSavedInput, "action"> & { action: string },
    signal: AbortSignal | undefined,
    platformError: () =>
      | (Pick<ActionableError, "message"> & { errorCode?: PrototypeSavedErrorCode })
      | undefined,
  ): Promise<PrototypeSavedOutput | undefined> | PrototypeSavedOutput | undefined => {
    const error = platformError();
    if (error) {
      return prototypePlatformFailure(error);
    }
    if (
      device.platform === "ios" &&
      args.action === "open" &&
      resolveIosDeviceKind(device) !== "simulator"
    ) {
      return {
        success: false,
        errorCode: "unsupported_platform",
        error: "open needs an iOS simulator. Target one with deviceId or sessionUuid.",
      };
    }
    if (
      (device.platform === "android" || device.platform === "ios") &&
      dependencies.protoViewer &&
      protoViewerHandles(args)
    ) {
      return routeToProtoViewer(
        args,
        { ...dependencies, device: dependencies.protoViewer(device), displays: device.displays },
        signal,
      ).then((output) => {
        if (output || device.platform !== "ios" || !isPrototypeSavedAction(args.action)) {
          return output;
        }
        return performIosSavedAction(
          backend,
          device,
          { ...args, action: args.action },
          { readers: dependencies, signal },
        );
      });
    }
    if (args.action === "open") {
      return {
        success: false,
        errorCode: "unsupported_capability",
        error: OPEN_NEEDS_PROTOVIEWER,
      };
    }
    if (device.platform !== "ios" || !isPrototypeSavedAction(args.action)) {
      return undefined;
    }
    return performIosSavedAction(
      backend,
      device,
      { ...args, action: args.action },
      { readers: dependencies, signal },
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
  args: PrototypeSavedInput,
  { readers, signal }: { readers: IosSavedDependencies; signal?: AbortSignal },
): Promise<PrototypeSavedOutput> {
  const shaderProblem = prototypeIosShaderProblem(args.spec, args.assets);
  if (shaderProblem) {
    return {
      success: false,
      errorCode: "unsupported_platform",
      error: shaderProblem,
    };
  }
  if (hasElementAnchors(args.spec!)) {
    return savedElementAnchorFailure();
  }
  const prepared = await preparePrototypeAssets(
    args.assets ?? [],
    readers.assetFileReader,
    readers.observationScreenshotReader,
    readers.env,
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
          pinned: "unsupported" as const,
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
  args: PrototypeSavedInput,
  { readers, signal }: { readers: IosSavedDependencies; signal?: AbortSignal },
): Promise<PrototypeSavedOutput> {
  try {
    if (resolveIosDeviceKind(device) !== "simulator") {
      throw new PrototypeInstallPhysicalDeviceError();
    }
    signal?.throwIfAborted();
    if (args.action === "save") {
      return await saveIosPrototype(backend, device.deviceId, args, { readers, signal });
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
  args: Omit<PrototypeSavedInput, "action"> & {
    action: PrototypeSavedAction | "open" | "show" | "patch" | "dismiss";
  },
  dependencies: () => PrototypeSavedDependencies,
  fallback: (action: "show" | "patch" | "dismiss") => Promise<T>,
): Promise<PrototypeSavedOutput | T> {
  if (args.action === "open") {
    // The platform dispatch answers every open it can route; nothing reaches CtrlProxy.
    return Promise.resolve({
      success: false,
      errorCode: "unsupported_capability",
      error: OPEN_NEEDS_PROTOVIEWER,
    });
  }
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
