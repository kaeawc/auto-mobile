import { z } from "zod/v4";

/** Device result metadata, independent of the authored spec contract. */
export const prototypeDegradedEffectSchema = z.object({
  path: z.string().min(1),
  type: z.string().min(1),
  reason: z.enum(["api", "budget"]),
});

export type DegradedEffect = z.infer<typeof prototypeDegradedEffectSchema>;

export function parsePrototypeDegradedEffects(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry) => {
    const parsed = prototypeDegradedEffectSchema.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  });
}

/** Invalid entries are ignored individually so valid diagnostics survive a mixed reply. */
export function prototypeDegradedEffectsField(value: unknown): {
  degradedEffects?: DegradedEffect[];
} {
  const degradedEffects = parsePrototypeDegradedEffects(value);
  return degradedEffects.length > 0 ? { degradedEffects } : {};
}

export function prototypeDegradedEffectsOutput(value: unknown): {
  degradedEffects?: DegradedEffect[];
  warning?: string;
} {
  const fields = prototypeDegradedEffectsField(value);
  if (!fields.degradedEffects) {
    return {};
  }
  const effects = fields.degradedEffects.map(
    ({ path, type, reason }) =>
      `${type} at ${path} (${reason}: ${reason === "api" ? "unsupported on this device" : "frame budget exceeded"})`,
  );
  return { ...fields, warning: `Prototype effects degraded: ${effects.join(", ")}.` };
}
