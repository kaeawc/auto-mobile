import contract from "../../../schemas/prototype-spec-contract.json";
import { PROTOTYPE_TEXT_FIELD_OPTIONS_CAPABILITY } from "../observe/android/ctrlProxyProtocol";
import { record } from "./prototypeTemplate";

const optionFields = new Set(
  Object.keys(contract.definitions.node.variants.textField.fields).filter(
    (field) =>
      !Object.hasOwn(contract.definitions.node.variants.spacer.fields, field) &&
      field !== "stateKey" &&
      field !== "placeholder",
  ),
);

/** Authored field order, depth-first through child/children and repeat templates. */
function nodeFields(value: unknown, path: string): string[] {
  const node = record(value);
  if (!node) {
    return [];
  }
  return Object.entries(node).flatMap(([key, child]) => {
    if (node.type === "textField" && optionFields.has(key)) {
      return [`${path}.${key}`];
    }
    if (key === "child") {
      return nodeFields(child, `${path}.child`);
    }
    if (key === "children" && Array.isArray(child)) {
      return child.flatMap((entry, index) => nodeFields(entry, `${path}.children[${index}]`));
    }
    return [];
  });
}

/** Components are expanded by the host before this scan, just as for data-model capability checks. */
export function prototypeTextFieldOptionFields(spec: unknown): string[] {
  return nodeFields(record(spec)?.root, "root");
}

export function prototypeTextFieldOptionsUnsupportedMessage(
  fields: readonly string[],
  platform: "android" | "ios",
): string {
  const more = fields.length > 1 ? ` (and ${fields.length - 1} more)` : "";
  const device = platform === "ios" ? "connected iOS prototype agent" : "connected CtrlProxy";
  const update =
    platform === "ios"
      ? "Relaunch the app with launchApp prototype: true to load the agent built for this AutoMobile version"
      : "Update the connected CtrlProxy";
  return `The ${device} does not advertise ${PROTOTYPE_TEXT_FIELD_OPTIONS_CAPABILITY}, so it cannot render the textField options at ${fields[0]}${more}. Nothing was shown. ${update}, or drop the textField options.`;
}
