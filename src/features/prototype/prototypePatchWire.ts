import { z } from "zod";
import { PROTOTYPE_PATCH_CAPABILITY } from "../observe/android/ctrlProxyProtocol";
import type { PrototypePatchOp } from "./prototypePatch";
import { STATE_KEY } from "./prototypeTemplate";

export interface PrototypePatchRequest {
  id: string;
  /** Sent only when defined. */
  baseRevision?: number;
  ops: readonly PrototypePatchOp[];
}
export type PrototypeState = Record<string, string | number | boolean>;
export interface PrototypePatchConflict {
  revision: number;
  state: PrototypeState;
}
const revisionSchema = z.number().finite().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const conflictSchema = z
  .object({
    revision: revisionSchema,
    state: z.record(
      z.string().regex(STATE_KEY),
      z.union([z.string(), z.number().finite(), z.boolean()]),
    ),
  })
  .strict();
/** Keeps only well-formed patch reply fields. */
export function prototypePatchReplyFields(reply: unknown): {
  revision?: number;
  conflict?: PrototypePatchConflict;
} {
  const envelope = z
    .object({ revision: z.unknown().optional(), conflict: z.unknown().optional() })
    .safeParse(reply);
  if (!envelope.success) {
    return {};
  }
  const revision = revisionSchema.safeParse(envelope.data.revision);
  const conflict = conflictSchema.safeParse(envelope.data.conflict);
  return {
    ...(revision.success ? { revision: revision.data } : {}),
    ...(conflict.success ? { conflict: conflict.data } : {}),
  };
}
/** Shared by transport guards and the tool-level refusal. */
export function prototypePatchUnsupportedMessage(platform: "android" | "ios"): string {
  return platform === "android"
    ? `The connected CtrlProxy does not advertise ${PROTOTYPE_PATCH_CAPABILITY}, so it cannot patch a shown prototype. Nothing was sent. Update the connected CtrlProxy, or send the whole spec again with show.`
    : `The connected iOS prototype agent does not advertise ${PROTOTYPE_PATCH_CAPABILITY}, so it cannot patch a shown prototype. Nothing was sent. Relaunch the app with launchApp prototype: true to load the agent built for this AutoMobile version, or send the whole spec again with show.`;
}
