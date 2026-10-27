import { PROTOTYPE_STRING_CONDITIONS_CAPABILITY } from "../observe/android/ctrlProxyProtocol";
import { walkPrototypeNodes } from "./prototypeNodeChildren";
import { record } from "./prototypeTemplate";

const COMPARISONS = ["contains", "startsWith", "lengthGt", "lengthLt"];

/** Only condition slots can introduce string comparisons; data and style names are opaque. */
export function prototypeStringConditionsFields(spec: unknown): string[] {
  const fields: string[] = [];
  function condition(value: unknown, path: string): void {
    const object = record(value);
    if (!object) {
      return;
    }
    for (const key of COMPARISONS) {
      if (Object.hasOwn(object, key)) {
        fields.push(`${path}.${key}`);
      }
    }
    if (object.not) {
      condition(object.not, `${path}.not`);
    }
    for (const form of ["all", "any"]) {
      const children = object[form];
      if (Array.isArray(children)) {
        children.forEach((child, index) => condition(child, `${path}.${form}[${index}]`));
      }
    }
  }
  walkPrototypeNodes(spec, (node, path) => {
    condition(node.visibleWhen, `${path}.visibleWhen`);
    condition(node.enabledWhen, `${path}.enabledWhen`);
    if (Array.isArray(node.styleWhen)) {
      node.styleWhen.forEach((entry, index) =>
        condition(record(entry)?.when, `${path}.styleWhen[${index}].when`),
      );
    }
    if (node.type === "textField") {
      if (Object.hasOwn(node, "errorWhen")) {
        fields.push(`${path}.errorWhen`);
        condition(node.errorWhen, `${path}.errorWhen`);
      }
      if (Object.hasOwn(node, "errorText")) {
        fields.push(`${path}.errorText`);
      }
    }
  });
  return fields;
}

export function prototypeStringConditionsUnsupportedMessage(
  fields: readonly string[],
  platform: "android" | "ios",
): string {
  const device = platform === "ios" ? "connected iOS prototype agent" : "connected CtrlProxy";
  const update =
    platform === "ios"
      ? "Relaunch the app with launchApp prototype: true to load the agent built for this AutoMobile version"
      : "Update the connected CtrlProxy";
  return `The ${device} does not advertise ${PROTOTYPE_STRING_CONDITIONS_CAPABILITY}, so it cannot evaluate ${fields[0]}${fields.length > 1 ? ` (and ${fields.length - 1} more)` : ""}. Nothing was shown. ${update}, or remove string conditions and textField errorWhen/errorText.`;
}
