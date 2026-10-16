import {
  PROTOTYPE_STORAGE_CAPABILITY,
  type PrototypeResult,
} from "../features/observe/android/ctrlProxyProtocol";
import type { AndroidPrototypeTransport } from "../features/prototype/androidPrototypeTransport";
import type { IosPrototypeTransport } from "../features/prototype/ios/iosPrototypeTransport";
import { prototypeClearStorageUnsupportedMessage } from "../features/prototype/prototypeStorage";
import type { z } from "zod/v4";
import type { PrototypeStatusStore } from "../features/prototype/PrototypeStatusStore";
import { toActionableError } from "../models/ActionableError";
import { logger } from "../utils/logger";

/** The transports `clearStorage` can reach: CtrlProxy on Android, the injected agent on iOS. */
export interface PrototypeClearStorageTarget {
  android?: Pick<AndroidPrototypeTransport, "supportsCommand" | "clearStorage">;
  ios?: Pick<IosPrototypeTransport, "supportsCapability" | "clearStorage">;
}

export interface PrototypeClearStorageOutput {
  success: boolean;
  error?: string;
  /** How many stored keys the device removed; absent when the device did not say. */
  cleared?: number;
}

/**
 * `prototype {action:"clearStorage", id}` (#12522): asks the device to wipe every value it stored
 * for the prototype's `storage` block. The next show of the id starts from the spec's values. It
 * is refused, before anything is sent, on a device that does not advertise `prototype_storage_v1`,
 * since an older device would answer an unknown request with a protocol error (or not at all).
 */
export async function performPrototypeClearStorage(
  target: PrototypeClearStorageTarget,
  args: { id?: string; timeoutMs?: number },
  store: Pick<PrototypeStatusStore, "forgetStorage">,
  deviceId: string,
): Promise<PrototypeClearStorageOutput> {
  const id = args.id!; // validatePrototypeStorageInput requires it
  const platform = target.android ? "android" : "ios";
  try {
    const supported = target.android
      ? await target.android.supportsCommand(PROTOTYPE_STORAGE_CAPABILITY)
      : (target.ios?.supportsCapability(PROTOTYPE_STORAGE_CAPABILITY) ?? false);
    if (!supported) {
      return { success: false, error: prototypeClearStorageUnsupportedMessage(platform) };
    }
    const reply: PrototypeResult = target.android
      ? await target.android.clearStorage(id, args.timeoutMs)
      : await target.ios!.clearStorage(id);
    if (!reply.success) {
      return { success: false, error: reply.error ?? "clearStorage failed" };
    }
    store.forgetStorage(deviceId, id);
    return { success: true, ...(reply.cleared === undefined ? {} : { cleared: reply.cleared }) };
  } catch (error) {
    logger.warn("[prototype] clearStorage request failed", error);
    return { success: false, error: toActionableError(error, "clearStorage failed").message };
  }
}

/** `clearStorage` names the prototype whose stored values to wipe. */
export function validatePrototypeStorageInput(
  value: { action: string; id?: string },
  ctx: z.RefinementCtx,
): void {
  if (value.action === "clearStorage" && value.id === undefined) {
    ctx.addIssue({ code: "custom", path: ["id"], message: "clearStorage requires id" });
  }
}
