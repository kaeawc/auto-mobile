import { record } from "./prototypeTemplate";
import { PROTOTYPE_CHECKS_CAPABILITY } from "../observe/android/ctrlProxyProtocol";

/** Only traverse authored structure: opaque emit payloads and data cannot activate the gate. */
export function prototypeChecksFields(spec: unknown): string[] {
  const fields: string[] = [];
  function visit(value: unknown, path: string): void {
    if (Array.isArray(value)) {
      value.forEach((child, index) => visit(child, `${path}[${index}]`));
      return;
    }
    const object = record(value);
    if (!object) {
      return;
    }
    for (const [key, child] of Object.entries(object)) {
      if (["payload", "data", "state", "repeat", "checks"].includes(key)) {
        if (key === "checks") {
          fields.push(`${path}.${key}`);
        }
        continue;
      }
      if (["validateOn", "enabledWhen", "valid", "requireValid"].includes(key)) {
        fields.push(`${path}.${key}`);
      } else {
        visit(child, `${path}.${key}`);
      }
    }
  }
  visit(record(spec)?.root, "root");
  return fields;
}
export function prototypeChecksUnsupportedMessage(
  fields: readonly string[],
  platform: "android" | "ios",
): string {
  const device = platform === "ios" ? "connected iOS prototype agent" : "connected CtrlProxy";
  const update =
    platform === "ios"
      ? "Relaunch the app with launchApp prototype: true"
      : "Update the connected CtrlProxy";
  return `The ${device} does not advertise ${PROTOTYPE_CHECKS_CAPABILITY}, so it cannot evaluate input checks at ${fields[0]}${fields.length > 1 ? ` (and ${fields.length - 1} more)` : ""}. Nothing was shown or patched. ${update}, or remove checks, validateOn, enabledWhen, valid conditions and requireValid guards.`;
}
