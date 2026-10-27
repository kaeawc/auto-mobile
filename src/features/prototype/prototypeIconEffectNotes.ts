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

/** Aggregate each distinct fallback in tree order, using the shared path cap. */
export function prototypeIconEffectNotes(
  spec: unknown,
  platform: "android" | "ios",
  osMajor?: number,
): PrototypePlatformNote[] {
  const notes = new Map<string, PrototypePlatformNote>();
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
    const existing = notes.get(detail);
    if (existing) {
      const count = (existing.total ?? existing.paths.length) + 1;
      if (existing.paths.length < 20) existing.paths.push(`${path}.effect`);
      else existing.total = count;
      return;
    }
    notes.set(detail, {
      platform,
      construct: "icon.effect",
      effect: platform === "ios" && fallback.fallback === "none" ? "ignored" : "substituted",
      paths: [`${path}.effect`],
      detail,
    });
  });
  return [...notes.values()];
}
