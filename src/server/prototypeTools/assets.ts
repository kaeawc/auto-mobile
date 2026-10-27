import {
  cachedPrototypeShaderAssetProblem,
  prototypeShaderAssetProblem,
  prototypeShaderOptInProblem,
} from "../../features/prototype/prototypeShaders";
import { z } from "zod/v4";
import type {
  PrototypeDismiss,
  PrototypeResult,
} from "../../features/observe/android/ctrlProxyProtocol";
import { prototypeAssetPutClient } from "../../features/prototype/PrototypeTransport";
import { prototypeAppearanceOverride } from "../../features/prototype/prototypeAppearance";
import {
  preparePrototypeAssets,
  uploadPrototypeAssets,
} from "../../features/prototype/prototypeAssetUploader";
import {
  missingAssetsWarning,
  type MissingAssetRepair,
} from "../../features/prototype/prototypeMissingAssets";
import { type PrototypeSpec } from "../../features/prototype/prototypeSpec";
import { toActionableError } from "../../models/ActionableError";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import { markIndeterminate } from "../prototypeShownOutcome";
import { prototypeSchema } from "./schemas";
import type { AssetReaders, AssetStage, PrototypeTarget } from "./types";

// Validation has already succeeded. Forward authored specs unchanged; omitted
// defaults (including opacity=100) remain the wire contract's defaults.
async function mutate(
  target: PrototypeTarget,
  args: z.infer<typeof prototypeSchema>,
  displayId?: number,
): Promise<PrototypeResult> {
  if (args.action === "show") {
    return target.transport.show(args.spec as PrototypeSpec, {
      timeoutMs: args.timeoutMs,
      displayId,
      reset: args.reset,
      ...((args.spec as PrototypeSpec | undefined)?.strings && args.locale !== undefined
        ? { locale: args.locale }
        : {}),
      replaceOthers: args.replaceOthers,
      // [appearanceRefusal] already ended the call when the device would ignore it.
      appearance: prototypeAppearanceOverride(args.appearance),
    });
  }
  const dismissal: PrototypeDismiss = args.all ? { all: true } : { id: args.id! };
  return target.transport.dismiss(dismissal, args.timeoutMs);
}

/** Upload every `assets` entry before the prototype is sent; a failure ends the call. */
export async function stageAssets(
  target: PrototypeTarget,
  args: z.infer<typeof prototypeSchema>,
  readers: AssetReaders,
  signal: AbortSignal | undefined,
  cached?: {
    serial: string;
    cache: Pick<import("../../features/prototype/prototypeAssetCache").PrototypeAssetCache, "get">;
  },
): Promise<AssetStage> {
  const optIn = prototypeShaderOptInProblem(args.spec, readers.env);
  if (optIn) {
    return { uploaded: [], prepared: [], failure: { success: false, error: optIn } };
  }
  if (args.assets === undefined) {
    const problem = cached
      ? await cachedPrototypeShaderAssetProblem(args.spec, cached.serial, cached.cache)
      : undefined;
    return {
      uploaded: [],
      prepared: [],
      ...(problem ? { failure: { success: false, error: problem } } : {}),
    };
  }
  const prepared = await preparePrototypeAssets(
    args.assets,
    readers.assetFileReader,
    readers.observationScreenshotReader,
    readers.env,
  );
  if ("error" in prepared) {
    return { uploaded: [], prepared: [], failure: { success: false, error: prepared.error } };
  }
  const shaderProblem = cached
    ? await cachedPrototypeShaderAssetProblem(
        args.spec,
        cached.serial,
        cached.cache,
        prepared.assets,
      )
    : prototypeShaderAssetProblem(args.spec, prepared.assets);
  if (shaderProblem) {
    return { uploaded: [], prepared: [], failure: { success: false, error: shaderProblem } };
  }
  const outcome = await uploadPrototypeAssets(
    prototypeAssetPutClient(target.transport),
    prepared.assets,
    { signal, action: args.action === "save" ? "save" : "show", env: readers.env },
  );
  return {
    uploaded: outcome.uploaded,
    prepared: prepared.assets,
    ...(outcome.success
      ? {}
      : {
          failure: {
            success: false,
            error: outcome.error,
          },
        }),
  };
}

async function runMutation(
  target: PrototypeTarget,
  args: z.infer<typeof prototypeSchema>,
  displayId: number | undefined,
): Promise<PrototypeResult> {
  try {
    return await mutate(target, args, displayId);
  } catch (error) {
    logger.warn("[prototype] Request failed", error);
    return markIndeterminate({
      success: false,
      error: toActionableError(error, "Prototype request failed").message,
    });
  }
}

/** The first send already reached the device, so a cancelled repair reports the partial result. */
async function reuploadAfterSend(
  target: PrototypeTarget,
  assets: Parameters<typeof uploadPrototypeAssets>[1],
  signal: AbortSignal | undefined,
  env: NodeJS.ProcessEnv | undefined,
): Promise<Awaited<ReturnType<typeof uploadPrototypeAssets>>> {
  try {
    return await uploadPrototypeAssets(prototypeAssetPutClient(target.transport), assets, {
      signal,
      action: "resend",
      env,
    });
  } catch (error) {
    logger.warn("[prototype] Asset re-upload failed after the show was sent", error);
    return {
      success: false,
      uploaded: [],
      error: signal?.aborted ? "the request was cancelled" : errorMessage(error),
    };
  }
}

interface MissingAssetRetry {
  result: PrototypeResult;
  repair: MissingAssetRepair;
}

/**
 * The upload-then-cleared race: the device finished the show but lists assets this same
 * call uploaded as missing. Re-uploads those once and re-sends once. Bounded: never loops, honours
 * the abort signal, and keeps the first (successful) result when the repair cannot complete.
 */
async function retryMissingAssets(
  target: PrototypeTarget,
  args: z.infer<typeof prototypeSchema>,
  stage: AssetStage,
  first: PrototypeResult,
  signal: AbortSignal | undefined,
  { displayId, env }: { displayId: number | undefined; env?: NodeJS.ProcessEnv },
): Promise<MissingAssetRetry | undefined> {
  const missing = new Set(first.missingAssets);
  const again = stage.prepared.filter((asset) => missing.has(asset.id));
  if (again.length === 0) {
    return undefined;
  }
  const fail = (reason: string): MissingAssetRetry => ({
    result: first,
    repair: { kind: "retry-failed", reason },
  });
  if (signal?.aborted) {
    return fail("the request was cancelled");
  }
  const upload = await reuploadAfterSend(target, again, signal, env);
  if (!upload.success) {
    return fail(upload.error ?? "upload failed");
  }
  if (signal?.aborted) {
    return fail("the request was cancelled before the prototype was re-sent");
  }
  // The re-send targets the display the first send resolved, never a re-resolved one.
  const second = await runMutation(target, args, displayId);
  return second.success
    ? { result: second, repair: { kind: "still-missing" } }
    : fail(second.error ?? "re-sending the prototype failed");
}

interface MutationOutcome {
  result: PrototypeResult;
  warning?: string;
}

/**
 * A newer show of the same id on this device started while this one resolved its display or
 * staged assets (#10641). Sending now would put this older spec on screen, possibly on another
 * display, while host status records the newer one, so the older show is never sent.
 */
function supersededBeforeSend(args: { spec?: unknown }): PrototypeResult {
  const id = (args.spec as PrototypeSpec | undefined)?.id;
  return {
    success: false,
    error: `Prototype ${id ?? ""} was not sent: a newer show of the same id on this device started first and is the one on screen.`,
  };
}

/** A re-send after a newer same-id show landed would replace it with this older spec. */
function needsAssetResend(first: PrototypeResult, superseded: () => boolean): boolean {
  return first.success && (first.missingAssets?.length ?? 0) > 0 && !superseded();
}

export async function sendPrototype(
  target: PrototypeTarget,
  args: z.infer<typeof prototypeSchema>,
  stage: AssetStage,
  signal: AbortSignal | undefined,
  displayId: number | undefined,
  hooks: {
    superseded?: () => boolean;
    beforeSend?: () => Promise<void>;
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<MutationOutcome> {
  const superseded = hooks.superseded ?? (() => false);
  const { beforeSend } = hooks;
  if (stage.failure) {
    return { result: stage.failure };
  }
  if (superseded()) {
    return { result: supersededBeforeSend(args) };
  }
  await beforeSend?.();
  const first = await runMutation(target, args, displayId);
  if (!needsAssetResend(first, superseded)) {
    return { result: first };
  }
  const retry = await retryMissingAssets(target, args, stage, first, signal, {
    displayId,
    env: hooks.env,
  });
  const result = retry?.result ?? first;
  if (!result.missingAssets?.length) {
    return { result };
  }
  return {
    result,
    warning: missingAssetsWarning({
      missing: result.missingAssets,
      supplied: new Set(stage.prepared.map((asset) => asset.id)),
      repair: retry?.repair,
    }),
  };
}
