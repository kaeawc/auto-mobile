import { PROTOTYPE_ZOOM_TRANSITION_CAPABILITY } from "../observe/android/ctrlProxyProtocol";
import { walkPrototypeNodes } from "./prototypeNodeChildren";
import { mapBindableFields } from "./prototypeTemplate";
import type { PrototypePlatformNote } from "./prototypePlatformNotes";

/** Rendering-only capability: patterns v1 remains the acceptance gate for existing zoom specs. */
export const PROTOTYPE_ZOOM_RENDERING_GATE = {
  capability: PROTOTYPE_ZOOM_TRANSITION_CAPABILITY,
  fields: prototypeZoomTransitionFields,
};

export function prototypeZoomTransitionFields(spec: unknown): string[] {
  const fields: string[] = [];
  walkPrototypeNodes(spec, (node, path) => {
    if (node.type === "stack" && node.transition === "zoom") {
      fields.push(`${path}.transition`);
    }
    mapBindableFields(node, path, (value, at, kind) => {
      if (kind === "stackTransition" && value === "zoom") {
        fields.push(at);
      }
      return value;
    });
  });
  return fields;
}

export function prototypeZoomTransitionNotes(
  spec: unknown,
  platform: "android" | "ios",
  supports: (capability: string) => boolean,
  osMajor?: number,
): PrototypePlatformNote[] {
  const paths = PROTOTYPE_ZOOM_RENDERING_GATE.fields(spec);
  if (paths.length === 0) {
    return [];
  }
  if (
    supports(PROTOTYPE_ZOOM_RENDERING_GATE.capability) &&
    (platform !== "ios" || osMajor === undefined || osMajor >= 18)
  ) {
    return [];
  }
  const version = osMajor === undefined ? "" : ` (device iOS ${osMajor})`;
  return [
    {
      platform,
      construct: "stack.zoom",
      effect: "substituted",
      paths: paths.slice(0, 20),
      ...(paths.length > 20 ? { total: paths.length } : {}),
      detail:
        platform === "ios"
          ? `Native zoom needs iOS 18 or later${version} and prototype_zoom_transition_v1; this agent uses platform push. Reduced motion crossfades; motion off is instant.`
          : "This CtrlProxy lacks prototype_zoom_transition_v1 and substitutes fadeThrough for zoom. Reduced motion crossfades; motion off is instant.",
    },
  ];
}
