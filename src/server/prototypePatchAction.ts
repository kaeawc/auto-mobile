import { ActionableError, toActionableError } from "../models/ActionableError";
import { logger } from "../utils/logger";
import {
  applyPrototypePatch,
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
  richTextRefusal: () => Promise<string | undefined>;
  platform: "android" | "ios";
  queue: PrototypePatchQueue;
  /** Retires the device's cached observation after an applied patch. */
  retire: (result: PrototypeResult) => void;
}
export interface PrototypePatchArgs {
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
  args: PrototypePatchArgs,
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
  args: PrototypePatchArgs,
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
  const applied = patchSpec(read.spec, args.ops);
  if (!("spec" in applied)) {
    return applied;
  }
  signal?.throwIfAborted();
  const result = await sendPatch(deps, args);
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
  return {
    success: true,
    ...(fields.revision === undefined ? {} : { revision: fields.revision }),
    ...(committed
      ? {}
      : {
          warning: `A show on this device overlapped this patch, so the host no longer tracks prototype ${args.id}'s spec: show it again before the next patch.`,
        }),
  };
}

export async function performPrototypePatch(
  deps: PrototypePatchDependencies,
  deviceId: string,
  args: PrototypePatchArgs,
  signal?: AbortSignal,
): Promise<PrototypePatchOutput> {
  const supported = await deps.supportsPatch();
  signal?.throwIfAborted();
  if (!supported) {
    return failure(new ActionableError(prototypePatchUnsupportedMessage(deps.platform)).message);
  }
  const richTextRefusal = await deps.richTextRefusal();
  if (richTextRefusal) {
    return failure(richTextRefusal);
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
