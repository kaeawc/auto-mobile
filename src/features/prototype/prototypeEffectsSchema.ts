import { z } from "zod";

/**
 * `style.effects` (#15128): a closed list of named, paint-only looks with typed, bounded
 * parameters, so the spec stays data-only (no shader source). The structural contract is
 * `definitions.effect` in `schemas/prototype-spec-contract.json`; this is its Zod twin.
 */
export const PROTOTYPE_EFFECT_TYPES = [
  "noise",
  "gradientMesh",
  "shimmer",
  "glow",
  "vignette",
  "blur",
  "pixelate",
  "chromaticAberration",
  "wave",
  "ripple",
] as const;

const unit = z.number().finite().min(0).max(1);
const angle = z.number().finite().min(-360).max(360);
const range = (min: number, max: number) => z.number().finite().min(min).max(max);

/** `animate: {periodMs}` loops an effect's phase; separate from a node's motion-v2 `animate`. */
const effectAnimateSchema = z
  .object({ periodMs: z.number().finite().int().min(400).max(20000) })
  .strict();
const effectCenterSchema = z.object({ x: unit, y: unit }).strict();

/** The effect union over a colour-value schema (injected so this file has no import cycle). */
export function createEffectSchema(color: z.ZodTypeAny) {
  const common = { animate: effectAnimateSchema.optional(), phase: unit.optional() };
  const effect = <T extends string, S extends z.ZodRawShape>(type: T, shape: S) =>
    z.object({ type: z.literal(type), ...shape, ...common }).strict();
  return z.discriminatedUnion("type", [
    effect("noise", {
      amount: unit.optional(),
      grain: range(0.5, 8).optional(),
      seed: z.number().finite().int().min(0).max(65535).optional(),
      monochrome: z.boolean().optional(),
    }),
    effect("gradientMesh", { colors: z.array(color).length(4), softness: unit.optional() }),
    effect("shimmer", {
      color: color.optional(),
      angle: angle.optional(),
      width: range(0.05, 1).optional(),
    }),
    effect("glow", { color, radius: range(0, 48).optional(), intensity: unit.optional() }),
    effect("vignette", {
      color: color.optional(),
      intensity: unit.optional(),
      radius: unit.optional(),
    }),
    effect("blur", { radius: range(0, 25) }),
    effect("pixelate", { cell: range(1, 64) }),
    effect("chromaticAberration", { offset: range(0, 8).optional(), angle: angle.optional() }),
    effect("wave", {
      amplitude: range(0, 16).optional(),
      wavelength: range(8, 400).optional(),
      angle: angle.optional(),
    }),
    effect("ripple", {
      amplitude: range(0, 16).optional(),
      wavelength: range(8, 400).optional(),
      center: effectCenterSchema.optional(),
    }),
  ]);
}
