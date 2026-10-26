import { type Located, type PrototypeValidationError } from "./prototypeBindingValidation";
import { PrototypeRepeatData } from "./prototypeData";
import { record } from "./prototypeTemplate";
import { walkPrototypeNodes } from "./prototypeNodeChildren";
import { PROTOTYPE_TOOLTIP_CAPABILITY } from "../observe/android/ctrlProxyProtocol";

/** Authored node paths, including repeat templates and reusable components. */
export function prototypeTooltipFields(spec: unknown): string[] {
  const fields: string[] = [];
  walkPrototypeNodes(spec, (node, path) => {
    if (node.type === "tooltip") {
      fields.push(path);
    }
  });
  return fields;
}

export function prototypeTooltipUnsupportedMessage(
  fields: readonly string[],
  platform: "android" | "ios",
): string {
  const more = fields.length > 1 ? ` (and ${fields.length - 1} more)` : "";
  const device = platform === "android" ? "connected CtrlProxy" : "connected iOS prototype agent";
  const update =
    platform === "android"
      ? "Update the connected CtrlProxy"
      : "Relaunch the app with launchApp prototype: true to load the agent built for this AutoMobile version";
  return `The ${device} does not advertise ${PROTOTYPE_TOOLTIP_CAPABILITY}, so it cannot draw the tooltip node at ${fields[0]}${more}. Nothing was shown. ${update}, or remove tooltip nodes.`;
}

/**
 * Component instances have already expanded. IDs are literal (never repeat-bound); count each
 * template target once per projected repeat item. Zero rows have no target, multiple rows are
 * ambiguous even if the tooltip is in that same repeat. Unused component definitions are absent.
 */
function tooltipTargetCounts(
  nodes: readonly Located[],
  repeats: PrototypeRepeatData,
): ReadonlyMap<string, number> {
  const scopes = nodes.flatMap(({ value, path }) => {
    const repeat = record(value.repeat);
    if (!repeat) {
      return [];
    }
    const items = repeat.items;
    const pointer = record(items)?.path;
    const count = Array.isArray(items)
      ? items.length
      : typeof pointer === "string"
        ? repeats.items(pointer).length
        : 0;
    return [{ prefix: `${path}.children[`, count }];
  });
  const ids = new Map<string, number>();
  for (const { value, path } of nodes) {
    if (typeof value.id !== "string") {
      continue;
    }
    const count = scopes.find((scope) => path.startsWith(scope.prefix))?.count ?? 1;
    ids.set(value.id, (ids.get(value.id) ?? 0) + count);
  }
  return ids;
}

export function prototypeTooltipError(
  nodes: readonly Located[],
  repeats: PrototypeRepeatData,
): PrototypeValidationError | undefined {
  const tooltips = nodes.filter(
    ({ value }) => value.type === "tooltip" && typeof value.anchorTo === "string",
  );
  if (tooltips.length === 0) {
    return undefined;
  }
  const ids = tooltipTargetCounts(nodes, repeats);
  for (const { value, path } of tooltips) {
    if (typeof value.anchorTo !== "string") {
      continue;
    }
    const count = ids.get(value.anchorTo) ?? 0;
    if (count !== 1 || value.anchorTo === value.id) {
      return {
        path: `${path}.anchorTo`,
        message: `${count > 1 ? "Duplicate" : "Unknown"} anchorTo id ${JSON.stringify(value.anchorTo)}`,
      };
    }
  }
  return undefined;
}
