import { PROTOTYPE_LOADING_STATES_CAPABILITY } from "../observe/android/ctrlProxyProtocol";
import { walkPrototypeNodes } from "./prototypeNodeChildren";
import { record } from "./prototypeTemplate";

/**
 * Loading and empty states (#14207): a `{data, empty}` condition that holds for a missing value,
 * `[]`, `{}` or `""` (`empty: false` is its inverse), and style `shimmer`, an animated highlight
 * over a placeholder's background. Both are gated by `prototype_loading_states_v1`.
 */

/** Keys whose values are child nodes (walked as their own nodes) or opaque data. */
const SKIPPED_KEYS = new Set(["child", "children", "screens", "payload", "repeat", "data"]);

function scan(value: unknown, path: string, fields: string[]): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => scan(entry, `${path}[${index}]`, fields));
    return;
  }
  const object = record(value);
  if (!object) {
    return;
  }
  for (const [key, child] of Object.entries(object)) {
    if (key === "empty" || key === "shimmer") {
      fields.push(`${path}.${key}`);
    } else if (!SKIPPED_KEYS.has(key)) {
      scan(child, `${path}.${key}`, fields);
    }
  }
}

export interface PrototypeLoadingStatesError {
  path: string;
  message: string;
}

const SHIMMER_TYPES = new Set(["box", "row", "column", "card"]);

/** `shimmer` sweeps a container's background, so only box, row, column and card take it. */
export function prototypeLoadingStatesError(
  nodes: readonly { value: Record<string, unknown>; path: string }[],
): PrototypeLoadingStatesError | undefined {
  for (const { value, path } of nodes) {
    if (SHIMMER_TYPES.has(String(value.type))) {
      continue;
    }
    const styleWhen = Array.isArray(value.styleWhen) ? value.styleWhen : [];
    const styles = [
      { style: value.style, at: `${path}.style` },
      ...styleWhen.map((entry, index) => ({
        style: record(entry)?.style,
        at: `${path}.styleWhen[${index}].style`,
      })),
    ];
    const shimmer = styles.find(({ style }) => record(style)?.shimmer !== undefined);
    if (shimmer) {
      return {
        path: `${shimmer.at}.shimmer`,
        message: "shimmer applies only to box, row, column and card",
      };
    }
  }
  return undefined;
}

/** Authored paths of every `empty` condition and `shimmer` style, in tree order. */
export function prototypeLoadingStatesFields(spec: unknown): string[] {
  const fields: string[] = [];
  walkPrototypeNodes(spec, (node, path) => {
    for (const [key, value] of Object.entries(node)) {
      if (!SKIPPED_KEYS.has(key)) {
        scan(value, `${path}.${key}`, fields);
      }
    }
  });
  return fields;
}

export function prototypeLoadingStatesUnsupportedMessage(
  fields: readonly string[],
  platform: "android" | "ios",
): string {
  const device = platform === "ios" ? "connected iOS prototype agent" : "connected CtrlProxy";
  const update =
    platform === "ios"
      ? "Relaunch the app with launchApp prototype: true to load the agent built for this AutoMobile version"
      : "Update the connected CtrlProxy";
  const more = fields.length > 1 ? ` (and ${fields.length - 1} more)` : "";
  return `The ${device} does not advertise ${PROTOTYPE_LOADING_STATES_CAPABILITY}, so it cannot evaluate ${fields[0]}${more}. Nothing was shown. ${update}, or use a statusKey condition and a plain placeholder.`;
}
