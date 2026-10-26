import { prototypeTimerWarnings } from "../features/prototype/prototypeTimers";
import { ActionableError, toActionableError } from "../models/ActionableError";
import { logger } from "../utils/logger";
import {
  applyPrototypePatch,
  prototypePatchDataPaths,
  prototypePatchTouchesState,
  type PrototypePatchOp,
} from "../features/prototype/prototypePatch";
import {
  prototypePatchReplyFields,
  prototypePatchUnsupportedMessage,
  type PrototypePatchConflict,
  type PrototypePatchReply,
} from "../features/prototype/prototypePatchWire";
import type { PrototypeStatusStore } from "../features/prototype/PrototypeStatusStore";
import type { PrototypeTransport } from "../features/prototype/PrototypeTransport";
import type { PrototypeResult } from "../features/observe/android/ctrlProxyProtocol";
import { MAX_PROTOTYPE_SPEC_BYTES, type PrototypeSpec } from "../features/prototype/prototypeSpec";
import { validatePrototypeSpec } from "../features/prototype/prototypeValidation";
import {
  prototypeAccessibilityOutput,
  type PrototypeAccessibilityFinding,
} from "../features/prototype/prototypeAccessibilityLint";
import type { ShownSpecJson } from "../features/prototype/PrototypeShownSpecs";

export interface PrototypePatchQueue {
  run<T>(deviceId: string, task: () => Promise<T>): Promise<T>;
}
/** Host-owned FIFO. Unlike the readiness/package locks, it retains no idle device entries. */
export function createPrototypePatchQueue(): PrototypePatchQueue {
  const tails = new Map<string, Promise<void>>();
  return {
    run<T>(deviceId: string, task: () => Promise<T>): Promise<T> {
      const result = (tails.get(deviceId) ?? Promise.resolve()).then(task);
      const tail = result.then(
        () => {},
        () => {},
      );
      tails.set(deviceId, tail);
      void tail.then(() => {
        if (tails.get(deviceId) === tail) {
          tails.delete(deviceId);
        }
      });
      return result;
    },
  };
}
export interface PrototypePatchDependencies {
  store: Pick<PrototypeStatusStore, "shownSpecs" | "recordPatchedData">;
  transport: Pick<PrototypeTransport, "patch">;
  supportsPatch: () => Promise<boolean>;
  /** Checks spec-level capabilities on the complete validated patch result. */
  specRefusal?: (spec: unknown) => Promise<string | undefined>;
  /** Settles what `specRefusal` staged: true once the patch landed (or may have), else false. */
  settleSpec?: (landed: boolean) => Promise<void>;
  platform: "android" | "ios";
  queue: PrototypePatchQueue;
  /** Retires the device's cached observation after an applied patch. */
  retire: (result: PrototypeResult) => void;
}
export interface PrototypePatchInput {
  id: string;
  ops: unknown;
  baseRevision?: number;
  timeoutMs?: number;
}
export interface PrototypePatchOutput {
  success: boolean;
  error?: string;
  revision?: number;
  conflict?: PrototypePatchConflict;
  warning?: string;
  accessibilityFindings?: PrototypeAccessibilityFinding[];
  accessibilityFindingsTotal?: number;
}
const failure = (error: string): PrototypePatchOutput => ({ success: false, error });

function patchSpec(
  spec: ShownSpecJson,
  ops: unknown,
): { spec: Record<string, unknown>; validated: PrototypeSpec } | PrototypePatchOutput {
  try {
    const applied = applyPrototypePatch(spec, ops, { stateTests: "skip" });
    if (!applied.success) {
      return failure(`Invalid patch at ${applied.error.path}: ${applied.error.message}`);
    }
    const validated = validatePrototypeSpec(applied.spec);
    return validated.success
      ? { spec: applied.spec, validated: validated.data }
      : failure(`Invalid patch result at spec.${validated.error.path}: ${validated.error.message}`);
  } catch (error) {
    logger.warn("[prototype] Patch application failed", error);
    if (!(error instanceof RangeError)) {
      throw error;
    }
    return failure("Invalid patch at ops: Patch is nested too deeply");
  }
}

async function sendPatch(
  deps: PrototypePatchDependencies,
  args: PrototypePatchInput,
): Promise<PrototypePatchReply> {
  try {
    return await deps.transport.patch(
      {
        id: args.id,
        ...(args.baseRevision === undefined ? {} : { baseRevision: args.baseRevision }),
        ops: args.ops as readonly PrototypePatchOp[],
      },
      args.timeoutMs,
    );
  } catch (error) {
    logger.warn("[prototype] Patch request failed", error);
    const message = toActionableError(error, "Prototype patch failed").message;
    return { success: false, delivery: "indeterminate", error: message };
  }
}

async function queuedPatch(
  deps: PrototypePatchDependencies,
  deviceId: string,
  args: PrototypePatchInput,
  signal?: AbortSignal,
): Promise<PrototypePatchOutput> {
  const read = deps.store.shownSpecs.read(deviceId, args.id);
  if (read.kind === "busy") {
    return failure(
      `Prototype ${args.id} was not patched: a show is in flight on this device. Patch after it returns.`,
    );
  }
  if (read.kind === "unknown") {
    return failure(
      `Prototype ${args.id} was not patched: this host is not tracking its spec on this device (it was not shown by this host, or a dismiss, a failed show or an overlapping show ended the tracking). Show it, then patch.`,
    );
  }
  const applied = plannedPatch(deps, deviceId, args, read.spec);
  if (!("spec" in applied)) {
    return applied;
  }
  let landed = false;
  try {
    const refused = await deps.specRefusal?.(applied.spec);
    if (refused !== undefined) {
      return failure(refused);
    }
    signal?.throwIfAborted();
    const result = await sendPatch(deps, args);
    landed = result.success || result.delivery === "indeterminate";
    return await finishPatch(deps, deviceId, args, { read, applied, result });
  } finally {
    await deps.settleSpec?.(landed);
  }
}

async function finishPatch(
  deps: PrototypePatchDependencies,
  deviceId: string,
  args: PrototypePatchInput,
  sent: {
    read: { version: number };
    applied: Extract<ReturnType<typeof patchSpec>, { spec: unknown }>;
    result: PrototypePatchReply;
  },
): Promise<PrototypePatchOutput> {
  const { read, applied, result } = sent;
  if (result.delivery === "indeterminate") {
    deps.store.shownSpecs.abandon(deviceId);
    return failure(
      `${result.error ?? "Prototype patch failed"} The device may or may not have applied the patch: show the prototype again before the next patch.`,
    );
  }
  const fields = prototypePatchReplyFields(result);
  if (!result.success) {
    return { success: false, error: result.error ?? "The device refused the patch.", ...fields };
  }
  const committed = deps.store.shownSpecs.commitPatch(
    deviceId,
    args.id,
    read.version,
    applied.spec,
  );
  if (committed) {
    deps.store.recordPatchedData(deviceId, args.id, applied.validated.data);
  }
  deps.retire(result);
  const output = successfulPatchOutput(fields.revision, committed, args.id);
  const warning = [output.warning, ...prototypeTimerWarnings(applied.spec)]
    .filter(Boolean)
    .join(" ");
  return {
    ...output,
    ...(warning ? { warning } : {}),
    ...prototypeAccessibilityOutput(applied.spec),
  };
}

/** The patched spec, unless the patch is invalid or would overwrite device `/data` writes. */
function plannedPatch(
  deps: PrototypePatchDependencies,
  deviceId: string,
  args: PrototypePatchInput,
  spec: ShownSpecJson,
): ReturnType<typeof patchSpec> {
  const applied = patchSpec(spec, args.ops);
  return "spec" in applied ? (dataWriteGuard(deps, deviceId, args) ?? applied) : applied;
}

/** A patch must not overwrite device `/data` writes it was not built on (see dataPatchGuard). */
function dataWriteGuard(
  deps: PrototypePatchDependencies,
  deviceId: string,
  args: PrototypePatchInput,
): PrototypePatchOutput | undefined {
  const guard = deps.store.shownSpecs.dataPatchGuard(
    deviceId,
    args.id,
    prototypePatchDataPaths(args.ops),
    args.baseRevision,
  );
  if (guard.kind === "baseRevisionRequired") {
    return failure(
      "Invalid patch at baseRevision: required for /data ops once the device has written this prototype's data (setData, appendData, prependData, removeData); use the revision from the latest change event or patch result",
    );
  }
  return guard.kind === "conflict"
    ? {
        success: false,
        error: `The patch was refused: the device wrote ${guard.paths.join(", ")} after revision ${args.baseRevision}. Re-read the prototype's data and patch again from revision ${guard.revision}.`,
        conflict: { revision: guard.revision, state: {}, data: guard.paths },
      }
    : undefined;
}

function successfulPatchOutput(
  revision: number | undefined,
  committed: boolean,
  id: string,
): PrototypePatchOutput {
  return {
    success: true,
    ...(revision === undefined ? {} : { revision }),
    ...(committed
      ? {}
      : {
          warning: `A show on this device overlapped this patch, so the host no longer tracks prototype ${id}'s spec: show it again before the next patch.`,
        }),
  };
}

export async function performPrototypePatch(
  deps: PrototypePatchDependencies,
  deviceId: string,
  args: PrototypePatchInput,
  signal?: AbortSignal,
): Promise<PrototypePatchOutput> {
  const supported = await deps.supportsPatch();
  signal?.throwIfAborted();
  if (!supported) {
    return failure(new ActionableError(prototypePatchUnsupportedMessage(deps.platform)).message);
  }
  if (args.baseRevision === undefined && prototypePatchTouchesState(args.ops)) {
    return failure("Invalid patch at baseRevision: required when a patch has /state ops");
  }
  try {
    if (
      Buffer.byteLength(
        JSON.stringify({ id: args.id, baseRevision: args.baseRevision, ops: args.ops }),
        "utf8",
      ) > MAX_PROTOTYPE_SPEC_BYTES
    ) {
      return failure("Invalid patch at ops: Patch byte limit exceeded");
    }
  } catch (error) {
    logger.warn("[prototype] Patch serialization failed", error);
    if (!(error instanceof RangeError)) {
      throw error;
    }
    return failure("Invalid patch at ops: Patch is nested too deeply");
  }
  return deps.queue.run(deviceId, () => queuedPatch(deps, deviceId, args, signal));
}
