import { walkPrototypeNodes } from "./prototypeNodeChildren";
import contract from "../../../schemas/prototype-spec-contract.json";
import { PROTOTYPE_GESTURES_CAPABILITY } from "../observe/android/ctrlProxyProtocol";

const gestureFields = ["onLongPress", "onDoubleTap"] as const;
const gestureTypes = new Set(
  Object.entries(contract.definitions.node.variants)
    .filter(([, variant]) => gestureFields.every((field) => Object.hasOwn(variant.fields, field)))
    .map(([type]) => type),
);

/** Authored node paths, including component definitions and repeat templates; never action payloads. */
export function prototypeGestureFields(spec: unknown): string[] {
  const fields: string[] = [];
  walkPrototypeNodes(spec, (node, path) => {
    if (gestureTypes.has(String(node.type))) {
      fields.push(
        ...gestureFields
          .filter((field) => Object.hasOwn(node, field))
          .map((field) => `${path}.${field}`),
      );
    }
  });
  return fields;
}

/** Refusal for a device that cannot execute authored prototype gesture actions. */
export function prototypeGesturesUnsupportedMessage(
  fields: readonly string[],
  platform: "android" | "ios",
): string {
  const device = platform === "android" ? "connected CtrlProxy" : "connected iOS prototype agent";
  const update =
    platform === "android"
      ? "Update the connected CtrlProxy"
      : "Relaunch the app with launchApp prototype: true to load the agent built for this AutoMobile version";
  return `The ${device} does not advertise ${PROTOTYPE_GESTURES_CAPABILITY}, so it cannot run gesture fields: ${fields.join(", ")}. Nothing was shown. ${update}, or remove onLongPress and onDoubleTap.`;
}
