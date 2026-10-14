import { prototypeNodeChildren, prototypeSpecNodeRoots } from "./prototypeNodeChildren";
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

/** Authored field order, including descendants and reusable component roots. */
export function prototypeTextFieldOptionFields(spec: unknown): string[] {
  const fields: string[] = [];
  const pending: ({ node: unknown; path: string } | { field: string })[] =
    prototypeSpecNodeRoots(spec).reverse();
  while (pending.length) {
    const task = pending.pop()!;
    if ("field" in task) {
      fields.push(task.field);
      continue;
    }
    const { path } = task;
    const node = record(task.node);
    if (!node) {
      continue;
    }
    const children = prototypeNodeChildren(node);
    const next: typeof pending = [];
    for (const key of Object.keys(node)) {
      if (node.type === "textField" && optionFields.has(key)) {
        next.push({ field: `${path}.${key}` });
      } else {
        next.push(
          ...children
            .filter((entry) => entry.suffix === `.${key}` || entry.suffix.startsWith(`.${key}[`))
            .map((entry) => ({ node: entry.value, path: `${path}${entry.suffix}` })),
        );
      }
    }
    pending.push(...next.reverse());
  }
  return fields;
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
