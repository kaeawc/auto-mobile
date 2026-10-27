import { z } from "zod";
import contract from "../../../schemas/prototype-spec-contract.json";
import { walkPrototypeNodes } from "./prototypeNodeChildren";
import { record, type Raw } from "./prototypeTemplate";
import { isPrototypeDataPointer, resolvePrototypeDataPointer } from "./prototypeData";
import { prototypeContractPatterns } from "./prototypeContractPatterns";

export const MAX_PROTOTYPE_KEYFRAME_NODES = contract.limits.MAX_PROTOTYPE_KEYFRAME_NODES;

export const PROTOTYPE_KEYFRAME_REST = {
  scale: 1,
  scaleX: 1,
  scaleY: 1,
  rotation: 0,
  offsetX: 0,
  offsetY: 0,
  alpha: 1,
} as const;
const points = z
  .array(z.tuple([z.number().finite(), z.number().finite()]))
  .min(2)
  .max(8);
const track = z.union([
  points,
  z.object({ points, curve: z.enum(["linear", "standard", "spring"]).optional() }).strict(),
]);
export const prototypeKeyframesSchema = z
  .object({
    trigger: z
      .object({
        key: z.string().regex(prototypeContractPatterns.stateKey).optional(),
        data: z.string().refine(isPrototypeDataPointer).optional(),
      })
      .strict()
      .refine((v) => (v.key !== undefined) !== (v.data !== undefined)),
    durationMs: z.number().finite().int().min(100).max(3000),
    tracks: z
      .object({
        scale: track.optional(),
        scaleX: track.optional(),
        scaleY: track.optional(),
        rotation: track.optional(),
        offsetX: track.optional(),
        offsetY: track.optional(),
        alpha: track.optional(),
      })
      .strict()
      .refine((v) => Object.keys(v).length > 0),
  })
  .strict()
  .superRefine((v, context) => {
    const error = prototypeKeyframeTracksError(v.tracks, "tracks");
    if (error)
      context.addIssue({ code: "custom", path: error.path.split("."), message: error.message });
  });

/** Cross-point invariants shared with the native contract validators. Structure is checked first. */
export function prototypeKeyframeTracksError(
  tracks: unknown,
  path: string,
): { path: string; message: string } | undefined {
  for (const [name, value] of Object.entries(record(tracks) ?? {})) {
    const rest = PROTOTYPE_KEYFRAME_REST[name as keyof typeof PROTOTYPE_KEYFRAME_REST];
    const raw = Array.isArray(value) ? value : record(value)?.points;
    if (!Array.isArray(raw)) continue;
    const points = raw as number[][];
    if (
      points.length < 2 ||
      points.some(
        (p) =>
          !Array.isArray(p) ||
          p.length !== 2 ||
          p.some((n) => typeof n !== "number" || !Number.isFinite(n)),
      )
    )
      continue;
    if (
      points[0][0] !== 0 ||
      points.at(-1)![0] !== 1 ||
      points.some((p, i) => p[0] < 0 || p[0] > 1 || (i > 0 && p[0] <= points[i - 1][0]))
    ) {
      return { path: `${path}.${name}`, message: "Fractions must increase strictly from 0 to 1" };
    }
    if (points[0][1] !== rest || points.at(-1)![1] !== rest) {
      return {
        path: `${path}.${name}`,
        message: `First and last values must equal rest value ${rest}`,
      };
    }
    if (
      points.some((p) =>
        name === "alpha" ? p[1] < 0 || p[1] > 1 : name.startsWith("scale") && p[1] <= 0,
      )
    ) {
      return {
        path: `${path}.${name}`,
        message: "alpha must be in 0..1 and scale values must be positive",
      };
    }
  }
  return undefined;
}

export function prototypeKeyframesError(
  nodes: readonly { value: Raw; path: string }[],
  spec: Raw,
): { path: string; message: string } | undefined {
  for (const { value, path } of nodes) {
    const trigger = record(record(value.keyframes)?.trigger);
    if (typeof trigger?.key === "string" && !Object.hasOwn(record(spec.state) ?? {}, trigger.key)) {
      return { path: `${path}.keyframes.trigger.key`, message: "Unknown state key" };
    }
    if (
      typeof trigger?.data === "string" &&
      resolvePrototypeDataPointer(spec.data, trigger.data) === undefined
    ) {
      return { path: `${path}.keyframes.trigger.data`, message: "Data pointer does not resolve" };
    }
  }
  return undefined;
}

export function prototypeKeyframesFields(spec: unknown): string[] {
  const fields: string[] = [];
  walkPrototypeNodes(spec, (node, path) => {
    if (node.keyframes !== undefined) fields.push(`${path}.keyframes`);
  });
  return fields;
}
export function prototypeKeyframesUnsupportedMessage(
  fields: readonly string[],
  platform: "android" | "ios",
): string {
  return `The connected ${platform === "ios" ? "iOS prototype agent (iOS 17+ required)" : "CtrlProxy"} does not advertise prototype_keyframes_v1, so it cannot play ${fields[0]}. Nothing was shown. Update the agent or remove keyframes.`;
}
