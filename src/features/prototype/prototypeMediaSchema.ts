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
      // Keep every authored id: Zod 3 record output alone drops an own __proto__ key.
      .and(z.unknown())
      .refine(
        (players) => Object.keys(players).length <= contract.limits.MAX_PROTOTYPE_MEDIA_PLAYERS,
      ),
  })
  .strict();
export type PrototypeMedia = z.infer<typeof prototypeMediaSchema>;

/** A `videoPlayer` caption track (#14259): an uploaded WebVTT asset or `/data` cues. */
const prototypeMediaCaptionSchema = z
  .object({
    id: z.string().trim().min(1).max(64),
    language: z.string().trim().min(1).max(35),
    label: z.string().trim().min(1).max(64),
    source: z.union([
      z.object({ asset: z.string().min(1).max(128) }).strict(),
      z.object({ data: pointerSchema }).strict(),
    ]),
  })
  .strict();

/**
 * The `videoPlayer` node's own fields (#14253): exactly one of a declared `player` or an inline
 * `source` (checked in `prototypeMedia.ts`), plus how it is drawn and started.
 */
const videoPlayerShape = {
  type: z.enum(["videoPlayer"]),
  player: keySchema.optional(),
  source: prototypeMediaSourceSchema.optional(),
  poster: z.string().min(1).max(128).optional(),
  controls: z.enum(["builtin", "none"]).optional(),
  contentScale: z.enum(["fit", "crop", "fill"]).optional(),
  autoplay: z.union([z.boolean(), z.literal("whenVisible")]).optional(),
  muted: z.boolean().optional(),
  loop: z.boolean().optional(),
  startMs: z.number().int().min(0).max(86_400_000).optional(),
  positionKey: keySchema.optional(),
  captions: z.array(prototypeMediaCaptionSchema).min(1).max(8).optional(),
};

/** The `videoPlayer` node schema: the shared node fields plus its own. */
export function prototypeVideoPlayerSchema<T extends z.ZodRawShape>(common: T) {
  return z.object({ ...common, ...videoPlayerShape }).strict();
}
