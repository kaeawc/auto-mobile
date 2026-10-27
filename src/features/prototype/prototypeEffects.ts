import contract from "../../../schemas/prototype-spec-contract.json";
import { PROTOTYPE_EFFECTS_CAPABILITY } from "../observe/android/ctrlProxyProtocol";
import { walkPrototypeNodes } from "./prototypeNodeChildren";
import { record, type Raw } from "./prototypeTemplate";

/** What one node's styles cost against `MAX_PROTOTYPE_EFFECTS` and `MAX_PROTOTYPE_ANIMATED_EFFECTS`. */
export interface PrototypeEffectUses {
  total: number;
  animated: number;
}

function stylesOf(node: Raw): unknown[] {
  const styleWhen = Array.isArray(node.styleWhen) ? node.styleWhen : [];
  return [node.style, ...styleWhen.map((entry) => record(entry)?.style)];
}

/** The per-list maximum in the contract; a longer list is a structural error reported by the walk. */
const MAX_EFFECTS_PER_LIST = contract.definitions.style.fields.effects.rule.max;

/**
 * The effects a node declares: its own `style.effects` plus every `styleWhen` style's. A `styleWhen`
 * style replaces `effects` as a whole when it matches, but each declared list still has to be
 * drawable, so every one counts.
 */
export function effectUses(node: Raw): PrototypeEffectUses {
  const repeatedIcon = node.type === "icon" && record(node.effect)?.repeat !== undefined;
  const uses = { total: 0, animated: repeatedIcon ? 1 : 0 };
  for (const style of stylesOf(node)) {
    const effects = record(style)?.effects;
    // Capped at the list maximum so an over-long list is reported as that, not as a count overflow.
    for (const effect of (Array.isArray(effects) ? effects : []).slice(0, MAX_EFFECTS_PER_LIST)) {
      uses.total++;
      if (record(effect)?.animate !== undefined) {
        uses.animated++;
      }
    }
  }
  return uses;
}

/** Authored paths of every `effects` list, in tree order (the capability gate's fields). */
export function prototypeEffectFields(spec: unknown): string[] {
  const fields: string[] = [];
  walkPrototypeNodes(spec, (node, path) => {
    const styleWhen = Array.isArray(node.styleWhen) ? node.styleWhen : [];
    const paths = [
      `${path}.style`,
      ...styleWhen.map((_, index) => `${path}.styleWhen[${index}].style`),
    ];
    stylesOf(node).forEach((style, index) => {
      if (record(style)?.effects !== undefined) {
        fields.push(`${paths[index]}.effects`);
      }
    });
  });
  return fields;
}

export function prototypeEffectsUnsupportedMessage(
  fields: readonly string[],
  platform: "android" | "ios",
): string {
  const device = platform === "ios" ? "connected iOS prototype agent" : "connected CtrlProxy";
  const update =
    platform === "ios"
      ? "Relaunch the app with launchApp prototype: true to load the agent built for this AutoMobile version"
      : "Update the connected CtrlProxy";
  const more = fields.length > 1 ? ` (and ${fields.length - 1} more)` : "";
  return `The ${device} does not advertise ${PROTOTYPE_EFFECTS_CAPABILITY}, so it cannot draw the effects at ${fields[0]}${more}. Nothing was shown. ${update}, or remove style.effects.`;
}
