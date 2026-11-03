import { ZodError } from "zod/v4";

/**
 * Upper bound on the length of any array inside a tool call's arguments,
 * enforced before the tool schema parses them.
 *
 * zod (3.25.76, including its bundled `zod/v4`) validates every element of an
 * array even after a `.max()` check fails, recording one issue per bad element,
 * so a schema-level `.max()` does not cap the work or memory an oversized array
 * costs (#16102). Rejecting the arguments before the parse does. The largest
 * declared `maxItems` in any tool input schema is far below this value.
 */
export const MAX_TOOL_PARAM_ARRAY_LENGTH = 10_000;

interface Frame {
  readonly value: unknown;
  readonly parent: Frame | undefined;
  readonly key: PropertyKey | undefined;
}

function framePath(frame: Frame): PropertyKey[] {
  const path: PropertyKey[] = [];
  for (
    let current: Frame | undefined = frame;
    current?.key !== undefined;
    current = current.parent
  ) {
    path.unshift(current.key);
  }
  return path;
}

function childEntries(value: object): Iterable<[PropertyKey, unknown]> {
  return Array.isArray(value) ? value.entries() : Object.entries(value);
}

/** Path to the first array longer than `limit`, or undefined when every array fits. */
export function findOversizedArray(
  params: unknown,
  limit: number = MAX_TOOL_PARAM_ARRAY_LENGTH,
): { path: PropertyKey[]; length: number } | undefined {
  // Iterative so deep nesting cannot overflow the stack; `seen` keeps shared
  // references (YAML aliases in plan steps) from being walked more than once.
  const seen = new WeakSet<object>();
  const stack: Frame[] = [{ value: params, parent: undefined, key: undefined }];
  while (stack.length > 0) {
    const frame = stack.pop()!;
    const { value } = frame;
    if (value === null || typeof value !== "object" || seen.has(value)) {
      continue;
    }
    seen.add(value);
    if (Array.isArray(value) && value.length > limit) {
      return { path: framePath(frame), length: value.length };
    }
    for (const [key, child] of childEntries(value)) {
      if (child !== null && typeof child === "object") {
        stack.push({ value: child, parent: frame, key });
      }
    }
  }
  return undefined;
}

/**
 * Throw a `ZodError` (so both the MCP boundary and plan steps render it as
 * "Invalid parameters for tool …") when any array in `params` is longer than
 * {@link MAX_TOOL_PARAM_ARRAY_LENGTH}.
 */
export function assertToolParamArraysBounded(
  params: unknown,
  limit: number = MAX_TOOL_PARAM_ARRAY_LENGTH,
): void {
  const oversized = findOversizedArray(params, limit);
  if (!oversized) {
    return;
  }
  throw new ZodError([
    {
      code: "too_big",
      origin: "array",
      maximum: limit,
      inclusive: true,
      path: oversized.path,
      message: `Too big: expected array to have <=${limit} items (received ${oversized.length})`,
      input: undefined,
    },
  ]);
}
