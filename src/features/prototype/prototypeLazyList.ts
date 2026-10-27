import contract from "../../../schemas/prototype-spec-contract.json";
import { PROTOTYPE_LAZY_LIST_CAPABILITY } from "../observe/android/ctrlProxyProtocol";
import { resolvePrototypeDataPointer } from "./prototypeData";
import { walkPrototypeNodes } from "./prototypeNodeChildren";
import {
  mapBindableFields,
  visitPrototypeHandlerFields,
  record,
  type FieldVisitor,
  type Raw,
} from "./prototypeTemplate";

interface ListError {
  path: string;
  message: string;
}
type Located = readonly { value: Raw; path: string }[];

type Entry = Located[number];

const axisOf = (value: Raw): unknown => value.axis ?? "vertical";

/** Nesting restrictions of a list: row templates, headers and footers at any depth count. */
function listNestingError(entry: Entry, ancestors: readonly Entry[]): ListError | undefined {
  const { value, path } = entry;
  if (ancestors.some((other) => other.value.type === "list")) {
    return { path, message: "A list cannot sit inside another list" };
  }
  if (
    ancestors.some(
      (other) => other.value.repeat !== undefined && path.startsWith(`${other.path}.children[`),
    )
  ) {
    return { path, message: "A list cannot sit inside a repeat template" };
  }
  if (
    ancestors.some(
      (other) => other.value.type === "scroll" && axisOf(other.value) === axisOf(value),
    )
  ) {
    return { path, message: "A list cannot sit inside a scroll on the same axis" };
  }
  return undefined;
}

/** Field rules of one list: the end trigger options. */
function listOptionsError({ value, path }: Entry): ListError | undefined {
  if (value.endThreshold !== undefined && value.onEndReached === undefined) {
    return { path: `${path}.endThreshold`, message: "endThreshold needs onEndReached" };
  }
  const threshold = typeof value.endThreshold === "number" ? value.endThreshold : 3;
  if (
    value.onEndReached !== undefined &&
    typeof value.maxItems === "number" &&
    value.maxItems <= threshold
  ) {
    return { path: `${path}.maxItems`, message: "maxItems must be greater than endThreshold" };
  }
  return undefined;
}

/** Ancestor restrictions include row templates, headers and footers at any depth. */
export function prototypeLazyListError(nodes: Located): ListError | undefined {
  const containers = nodes.filter(
    ({ value }) => value.type === "list" || value.type === "scroll" || value.repeat !== undefined,
  );
  for (const entry of nodes) {
    const { value, path } = entry;
    if (value.type !== "list" && value.type !== "scroll") {
      continue;
    }
    const ancestors = containers.filter((other) => path.startsWith(`${other.path}.`));
    const error =
      value.type === "list"
        ? (listNestingError(entry, ancestors) ?? listOptionsError(entry))
        : scrollInListError(entry, ancestors);
    if (error) {
      return error;
    }
  }
  return undefined;
}

function scrollInListError(entry: Entry, ancestors: readonly Entry[]): ListError | undefined {
  const inList = ancestors.some(
    (other) => other.value.type === "list" && axisOf(other.value) === axisOf(entry.value),
  );
  return inList
    ? { path: entry.path, message: "A scroll cannot sit inside a list on the same axis" }
    : undefined;
}

/** Prefer the list's source path over the generic data-array budget for oversized feeds. */
export function prototypeLazyListLimitError(spec: unknown): ListError | undefined {
  let error: ListError | undefined;
  walkPrototypeNodes(spec, (node, path) => {
    const pointer = record(record(node.repeat)?.items)?.path;
    if (node.type !== "list" || typeof pointer !== "string") {
      return;
    }
    const items = resolvePrototypeDataPointer(record(spec)?.data, pointer);
    if (Array.isArray(items) && items.length > contract.limits.MAX_PROTOTYPE_LIST_ITEMS) {
      error ??= {
        path: `${path}.repeat.items.path`,
        message: `Repeat path resolves to more than ${contract.limits.MAX_PROTOTYPE_LIST_ITEMS} items`,
      };
    }
  });
  return error;
}

/** List and append gates visit only authored nodes/actions, never opaque JSON payloads. */
export function prototypeLazyListFields(spec: unknown): string[] {
  const fields: string[] = [];
  const visit: FieldVisitor = (value, actionPath, kind) => {
    if (kind === "prependData") fields.push(actionPath);
    if (kind === "request" && Object.hasOwn(record(value) ?? {}, "append"))
      fields.push(`${actionPath}.append`);
    return value;
  };
  walkPrototypeNodes(spec, (node, path) => {
    if (node.type === "list") {
      fields.push(path);
    }
    mapBindableFields(node, path, visit);
  });
  visitPrototypeHandlerFields(spec, visit);

  return fields;
}

export function prototypeLazyListUnsupportedMessage(
  fields: readonly string[],
  platform: "android" | "ios",
): string {
  const device = platform === "ios" ? "connected iOS prototype agent" : "connected CtrlProxy";
  const update =
    platform === "ios"
      ? "Relaunch the app with launchApp prototype: true to load the agent built for this AutoMobile version"
      : "Update the connected CtrlProxy";
  const more = fields.length > 1 ? ` (and ${fields.length - 1} more)` : "";
  return `The ${device} does not advertise ${PROTOTYPE_LAZY_LIST_CAPABILITY}, so it cannot run the lazy list feature at ${fields[0]}${more}. Nothing was shown. ${update}, or use a plain scroll without request.append or prependData.`;
}
