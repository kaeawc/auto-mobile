import { PROTOTYPE_STACK_TRANSITIONS_CAPABILITY } from "../observe/android/ctrlProxyProtocol";
import { walkPrototypeNodes } from "./prototypeNodeChildren";
import { mapBindableFields } from "./prototypeTemplate";

export const PROTOTYPE_STACK_TRANSITIONS = ["platform", "slide", "fade", "none"] as const;

/** Authored stack and navigation-action transition fields, in tree order. */
export function prototypeStackTransitionFields(spec: unknown): string[] {
  const fields: string[] = [];
  walkPrototypeNodes(spec, (node, path) => {
    if (node.type === "stack" && node.transition !== undefined) {
      fields.push(`${path}.transition`);
    }
    mapBindableFields(node, path, (entry, at, kind) => {
      if (kind === "stackTransition") {
        fields.push(at);
      }
      return entry;
    });
  });
  return fields;
}

export function prototypeStackTransitionsUnsupportedMessage(
  fields: readonly string[],
  platform: "android" | "ios",
): string {
  const device = platform === "ios" ? "connected iOS prototype agent" : "connected CtrlProxy";
  const update =
    platform === "ios"
      ? "Relaunch the app with launchApp prototype: true to load the agent built for this AutoMobile version"
      : "Update the connected CtrlProxy";
  const more = fields.length > 1 ? ` (and ${fields.length - 1} more)` : "";
  return `The ${device} does not advertise ${PROTOTYPE_STACK_TRANSITIONS_CAPABILITY}, so it cannot run the stack transition at ${fields[0]}${more}. Nothing was shown. ${update}, or omit transition on stacks and push/replace actions.`;
}
