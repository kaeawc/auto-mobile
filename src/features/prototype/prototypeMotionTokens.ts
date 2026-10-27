import contract from "../../../schemas/prototype-spec-contract.json";
import { walkPrototypeNodes } from "./prototypeNodeChildren";
import { record } from "./prototypeTemplate";
import { prototypeKeyframeTracksError } from "./prototypeKeyframes";
import type { Rule, PrototypeValidationError } from "./prototypeBindingValidation";

/** Runtime contract data, without a second copy of the physics constants. */
export const prototypeMotionTokens = contract.motionTokens;
export const PROTOTYPE_TEMPO_CONFLICT = "tempo cannot be combined with durationMs or easing";
export function prototypeAnimateError(
  value: Record<string, unknown>,
  path: string,
): PrototypeValidationError | undefined {
  return Object.hasOwn(value, "tempo") &&
    ["durationMs", "easing"].some((key) => Object.hasOwn(value, key))
    ? { path: `${path}.tempo`, message: PROTOTYPE_TEMPO_CONFLICT }
    : undefined;
}
export function prototypeMotionObjectError(
  rule: Rule,
  data: Record<string, unknown>,
  path: string,
): PrototypeValidationError | undefined {
  if (rule === contract.definitions.animate) {
    return prototypeAnimateError(data, path);
  }
  return rule === contract.definitions.keyframes
    ? prototypeKeyframeTracksError(data.tracks, `${path}.tracks`)
    : undefined;
}
export function prototypeMotionTokenFields(spec: unknown): string[] {
  const fields: string[] = [];
  walkPrototypeNodes(spec, (node, path) => {
    if (record(node.animate)?.tempo !== undefined) {
      fields.push(`${path}.animate.tempo`);
    }
  });
  return fields;
}
export function prototypeMotionTokensUnsupportedMessage(
  fields: readonly string[],
  platform: "android" | "ios",
): string {
  return `The connected ${platform} renderer does not advertise prototype_motion_tokens_v1 required by ${fields[0]}. Nothing was shown. Update the renderer or remove animate.tempo.`;
}
