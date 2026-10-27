import { z } from "zod";
import { PROTOTYPE_ICON_EFFECTS_CAPABILITY } from "../observe/android/ctrlProxyProtocol";
import { keySchema, pointerSchema } from "./prototypeActionValues";
import { walkPrototypeNodes } from "./prototypeNodeChildren";
import { iconNameSchema, iconVariantSchema } from "./prototypePresentationSchemas";

export const PROTOTYPE_ICON_EFFECT_TYPES = [
  "bounce",
  "pulse",
  "scale",
  "variableColor",
  "wiggle",
  "rotate",
  "breathe",
  "replace",
  "drawOn",
] as const;

export const prototypeIconEffectSchema = z
  .object({
    type: z.enum(PROTOTYPE_ICON_EFFECT_TYPES),
    trigger: z
      .union([z.object({ key: keySchema }).strict(), z.object({ data: pointerSchema }).strict()])
      .optional(),
    repeat: z.union([z.literal("infinite"), z.number().finite().int().min(1).max(20)]).optional(),
  })
  .strict()
  .refine((effect) => effect.trigger === undefined || effect.repeat === undefined, {
    message: "At most one of trigger, repeat is allowed",
    path: ["trigger"],
  })
  .describe(
    "Icon animation. trigger {key} or {data} replays on value changes; repeat is infinite or 1-20. trigger and repeat are mutually exclusive; omit both for one play on appearance. replace follows name changes.",
  );

export function prototypeIconEffectFields(spec: unknown): string[] {
  const paths: string[] = [];
  walkPrototypeNodes(spec, (node, path) => {
    if (node.type === "icon" && node.effect !== undefined) {
      paths.push(`${path}.effect`);
    }
  });
  return paths;
}

export function prototypeIconEffectsUnsupportedMessage(
  paths: readonly string[],
  platform: "android" | "ios",
): string {
  const device = platform === "ios" ? "connected iOS prototype agent" : "connected CtrlProxy";
  return `The ${device} does not advertise ${PROTOTYPE_ICON_EFFECTS_CAPABILITY}, so it cannot run the icon effect at ${paths[0]}. Nothing was shown. Update the agent or remove icon.effect.`;
}

/** The icon node's own fields, with the optional `effect` (#15251). */
export const prototypeIconShape = {
  type: z.enum(["icon"]),
  name: iconNameSchema,
  variant: iconVariantSchema.optional(),
  effect: prototypeIconEffectSchema.optional(),
};
