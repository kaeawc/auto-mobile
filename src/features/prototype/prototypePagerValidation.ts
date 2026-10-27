import { fail, type Located, type PrototypeValidationError } from "./prototypeBindingValidation";

/** The slice of the validation context the pager and nesting checks read. */
interface PagerContext {
  nodes: Located[];
}

/** Whether a `scroll` with the given axis rule encloses the node at `path`. */
function insideScroll(context: PagerContext, path: string, horizontal: boolean): boolean {
  return context.nodes.some(
    ({ value: ancestor, path: ancestorPath }) =>
      ancestor.type === "scroll" &&
      (ancestor.axis === "horizontal") === horizontal &&
      path.startsWith(`${ancestorPath}.`),
  );
}
/**
 * A horizontal `scroll` measures its child with an infinite width, which the lazy horizontal pager
 * and carousel layouts cannot take (#14165); the vertical rule is the same for vertical pagers.
 */
export function horizontalLazyError(
  node: Record<string, unknown>,
  path: string,
  context: PagerContext,
): PrototypeValidationError | undefined {
  if (node.type === "carousel" && insideScroll(context, path, true)) {
    return fail(path, "A carousel cannot appear inside a horizontal scroll");
  }
  if (node.type === "pager" && node.axis !== "vertical" && insideScroll(context, path, true)) {
    return fail(path, "A horizontal pager cannot appear inside a horizontal scroll");
  }
  return undefined;
}
/** One pager's own checks; records its id in `pagers`. */
export function pagerNodeError(
  value: Record<string, unknown>,
  path: string,
  context: PagerContext,
  pagers: Set<string>,
): PrototypeValidationError | undefined {
  if (value.type !== "pager" || typeof value.id !== "string") {
    return undefined;
  }
  if (pagers.has(value.id)) {
    return fail(`${path}.id`, "Duplicate pager id");
  }
  pagers.add(value.id);
  return value.axis === "vertical" && insideScroll(context, path, false)
    ? fail(`${path}.axis`, "A vertical pager cannot appear inside a vertical scroll")
    : undefined;
}
export function pagerStateKeyErrors(context: PagerContext): PrototypeValidationError | undefined {
  const keys = new Set<string>();
  for (const { value, path } of context.nodes) {
    if (value.type !== "pager" || typeof value.stateKey !== "string") {
      continue;
    }
    if (
      context.nodes.some(
        (ancestor) => ancestor.value.repeat !== undefined && path.startsWith(`${ancestor.path}.`),
      )
    ) {
      return fail(`${path}.stateKey`, "Pager stateKey cannot appear inside repeat");
    }
    if (keys.has(value.stateKey)) {
      return fail(`${path}.stateKey`, "Two pagers cannot bind the same state key");
    }
    keys.add(value.stateKey);
  }
  return undefined;
}
