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
import type { PrototypeSpec } from "../features/prototype/prototypeSpec";
import type { UploadedPrototypeAsset } from "../features/prototype/prototypeAssetUploader";
import { ActionableError, toActionableError } from "../models/ActionableError";
import { logger } from "../utils/logger";

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
  savedPrototypes?: SavedPrototypeEntry[];
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
}
export interface PrototypeSavedDependencies {
  client: Pick<AndroidPrototypeTransport, "save" | "listSaved" | "deleteSaved" | "supportsCommand">;
  stageAssets: () => Promise<{ uploaded: UploadedPrototypeAsset[]; failure?: PrototypeResult }>;
  signal?: AbortSignal;
}
export const savedPrototypeErrorMessages: Record<SavedPrototypeErrorCode, string> = {
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
export function savedPrototypePlatformRefusal(): PrototypeSavedOutput {
  return {
    success: false,
    errorCode: "unsupported_platform",
    error: "Saved prototypes are Android only for now; iOS support is not available yet.",
  };
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
  return {
    success: false,
    error: toActionableError(
      action === "save" && signal?.aborted
        ? new ActionableError("the request was cancelled", { cause: error })
        : error,
      "Saved prototype request failed",
    ).message,
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
export function prototypeSavedPlatformError(
  platform: string,
  action: string,
): (ActionableError & { errorCode: PrototypeSavedErrorCode }) | undefined {
  if (platform !== "ios" || !isPrototypeSavedAction(action)) {
    return undefined;
  }
  const refusal = savedPrototypePlatformRefusal();
  return Object.assign(new ActionableError(refusal.error!), {
    errorCode: "unsupported_platform" as const,
  });
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
