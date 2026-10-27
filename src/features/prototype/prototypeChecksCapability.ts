import { prototypeNodeChildren, prototypeSpecNodeRoots } from "./prototypeNodeChildren";
import { record } from "./prototypeTemplate";
import { PROTOTYPE_CHECKS_CAPABILITY } from "../observe/android/ctrlProxyProtocol";

/** Only traverse authored structure: opaque emit payloads and data cannot activate the gate. */
export function prototypeChecksFields(spec: unknown): string[] {
  const fields: string[] = [];
  const pending: ({ value: unknown; path: string } | { field: string })[] = prototypeSpecNodeRoots(
    spec,
  )
    .map(({ node, path }) => ({ value: node, path }))
    .reverse();
  while (pending.length) {
    const task = pending.pop()!;
    if ("field" in task) {
      fields.push(task.field);
      continue;
    }
    const { value, path } = task;
    if (Array.isArray(value)) {
      pending.push(
        ...value.map((value, index) => ({ value, path: `${path}[${index}]` })).reverse(),
      );
      continue;
    }
    const object = record(value);
    if (!object) {
      continue;
    }
    const children = prototypeNodeChildren(object);
    const next: typeof pending = [];
    for (const [key, child] of Object.entries(object)) {
      const form = key === "body" ? record(record(child)?.form) : undefined;
      if (form) {
        next.push(
          ...Object.entries(form).map(([name, value]) => ({
            value,
            path: `${path}.body.form.${name}`,
          })),
        );
        continue;
      }
      if (["payload", "data", "state", "repeat"].includes(key)) {
        continue;
      }
      if (["checks", "validateOn", "enabledWhen", "valid", "requireValid"].includes(key)) {
        next.push({ field: `${path}.${key}` });
      } else if (["child", "children", "screens"].includes(key)) {
        next.push(
          ...children
            .filter((entry) => entry.suffix === `.${key}` || entry.suffix.startsWith(`.${key}[`))
            .map((entry) => ({ value: entry.value, path: `${path}${entry.suffix}` })),
        );
      } else {
        next.push({ value: child, path: `${path}.${key}` });
      }
    }
    pending.push(...next.reverse());
  }

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
