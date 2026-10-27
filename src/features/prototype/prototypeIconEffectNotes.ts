import { walkPrototypeNodes } from "./prototypeNodeChildren";
import type { PrototypePlatformNote } from "./prototypePlatformNotes";
import { record } from "./prototypeTemplate";

const approximations: Readonly<Record<string, string>> = {
  bounce: "scale 1 → 1.2 → 1",
  pulse: "alpha 1 → 0.4 → 1",
  scale: "scale to 1.15 while the trigger is truthy",
  variableColor: "an alpha sweep",
  wiggle: "rotation ±10°",
  rotate: "rotation 0 → 360°",
  breathe: "scale 1 → 1.06 with alpha",
  replace: "crossfade with scale on name changes",
  drawOn: "crossfade",
};
const fallbacks: Readonly<Record<string, { minimum: number; fallback: string }>> = {
  wiggle: { minimum: 18, fallback: "bounce" },
  rotate: { minimum: 18, fallback: "none" },
  breathe: { minimum: 18, fallback: "pulse" },
  drawOn: { minimum: 26, fallback: "replace" },
};

/** Notes stay path-specific even when the same effect is used at many sites. */
export function prototypeIconEffectNotes(
  spec: unknown,
  platform: "android" | "ios",
  osMajor?: number,
): PrototypePlatformNote[] {
  const notes: PrototypePlatformNote[] = [];
  walkPrototypeNodes(spec, (node, path) => {
    const type = record(node.effect)?.type;
    if (node.type !== "icon" || typeof type !== "string") return;
    const fallback = fallbacks[type];
    if (platform === "ios" && (!fallback || (osMajor !== undefined && osMajor >= fallback.minimum)))
      return;
    const detail =
      platform === "android"
        ? `Android approximates ${type} with ${approximations[type]}.`
        : osMajor === undefined
          ? `On iOS below ${fallback.minimum}, ${type} falls back to ${fallback.fallback}; the connected OS version is unknown.`
          : `On iOS ${osMajor}, ${type} falls back to ${fallback.fallback} (native ${type} needs iOS ${fallback.minimum}).`;
    notes.push({
      platform,
      construct: "icon.effect",
      effect: "substituted",
      paths: [`${path}.effect`],
      detail,
    });
  });
  return notes;
}
