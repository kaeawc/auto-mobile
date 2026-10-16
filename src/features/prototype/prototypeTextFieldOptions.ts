import { prototypeNodeChildren, prototypeSpecNodeRoots } from "./prototypeNodeChildren";
import {
  PROTOTYPE_TEXT_FIELD_ACTIONS_CAPABILITY,
  PROTOTYPE_TEXT_FIELD_OPTIONS_CAPABILITY,
} from "../observe/android/ctrlProxyProtocol";
import { record } from "./prototypeTemplate";

/**
 * Fields gated by `prototype_text_field_options_v1`. Listed explicitly: deriving them from the
 * contract's textField fields would also sweep in fields owned by other capabilities, such as the
 * `prototype_checks_v1` fields `enabledWhen`, `checks` and `validateOn`.
 */
const optionFields: ReadonlySet<string> = new Set([
  "label",
  "variant",
  "supportingText",
  "keyboardType",
  "secure",
  "multiline",
  "minLines",
  "maxLines",
  "maxLength",
]);

/** Fields gated by `prototype_text_field_actions_v1`: a tappable icon and an IME action. */
const actionFields: ReadonlySet<string> = new Set(["trailingIcon", "imeAction", "onSubmit"]);

/** Authored field order, including descendants and reusable component roots. */
export function prototypeTextFieldOptionFields(spec: unknown): string[] {
  return textFieldFields(spec, optionFields);
}

/** Authored field order of `trailingIcon`, `imeAction` and `onSubmit` on text fields. */
export function prototypeTextFieldActionFields(spec: unknown): string[] {
  return textFieldFields(spec, actionFields);
}

function textFieldFields(spec: unknown, gated: ReadonlySet<string>): string[] {
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
      if (node.type === "textField" && gated.has(key)) {
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

export function prototypeTextFieldActionsUnsupportedMessage(
  fields: readonly string[],
  platform: "android" | "ios",
): string {
  const more = fields.length > 1 ? ` (and ${fields.length - 1} more)` : "";
  const device = platform === "ios" ? "connected iOS prototype agent" : "connected CtrlProxy";
  const update =
    platform === "ios"
      ? "Relaunch the app with launchApp prototype: true to load the agent built for this AutoMobile version"
      : "Update the connected CtrlProxy";
  return `The ${device} does not advertise ${PROTOTYPE_TEXT_FIELD_ACTIONS_CAPABILITY}, so it cannot draw or run the textField action at ${fields[0]}${more}. Nothing was shown. ${update}, or drop trailingIcon, imeAction and onSubmit.`;
}
