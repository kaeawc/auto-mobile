import { z } from "zod";
import contract from "../../../schemas/prototype-spec-contract.json";
import { keySchema, pointerSchema } from "./prototypeActionValues";
import { prototypeContractPatterns } from "./prototypeContractPatterns";

/**
 * The root `media` block (#14253): declared, long-lived players. The contract
 * (`definitions.media`, `mediaPlayer`, `mediaSource`) is the shared definition; this is its Zod
 * mirror. Cross-references the contract cannot express live in `prototypeMedia.ts`.
 */
export const PROTOTYPE_MEDIA_SAMPLES = ["tone440", "silence", "colorBars", "countdown"] as const;

/** Exactly one of an uploaded asset id, an http(s) URL, a `/data` pointer or a built-in sample. */
export const prototypeMediaSourceSchema = z.union([
  z.object({ asset: z.string().min(1).max(128) }).strict(),
  z.object({ url: z.string().max(2048).regex(prototypeContractPatterns.mediaUrl) }).strict(),
  z.object({ data: pointerSchema }).strict(),
  z.object({ sample: z.enum(PROTOTYPE_MEDIA_SAMPLES) }).strict(),
]);
export type PrototypeMediaSource = z.infer<typeof prototypeMediaSourceSchema>;

export const prototypeMediaSchema = z
  .object({
    players: z
      .record(
        keySchema,
        z
          .object({
            kind: z.enum(["video", "audio"]),
            source: prototypeMediaSourceSchema,
            loop: z.boolean().optional(),
          })
          .strict(),
      )
      .refine(
        (players) => Object.keys(players).length <= contract.limits.MAX_PROTOTYPE_MEDIA_PLAYERS,
      ),
  })
  .strict();
export type PrototypeMedia = z.infer<typeof prototypeMediaSchema>;
