export function unresolvedLocalRefs(schema: unknown): string[] {
  const unresolved = new Set<string>();
  const stack: unknown[] = [schema];

  while (stack.length) {
    const node = stack.pop();
    if (Array.isArray(node)) {
      stack.push(...node);
      continue;
    }
    if (!node || typeof node !== "object") {
      continue;
    }

    const obj = node as Record<string, unknown>;
    if (typeof obj.$ref === "string" && obj.$ref.startsWith("#/") && !jsonPointerExists(schema, obj.$ref)) {
      unresolved.add(obj.$ref);
    }
    stack.push(...Object.values(obj));
  }

  return [...unresolved].sort();
}

function jsonPointerExists(root: unknown, ref: string): boolean {
  let current = root;
  for (const segment of ref.slice(2).split("/").map(unescapeJsonPointerSegment)) {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return false;
    }
    const record = current as Record<string, unknown>;
    if (!Object.prototype.hasOwnProperty.call(record, segment)) {
      return false;
    }
    current = record[segment];
  }
  return true;
}

function unescapeJsonPointerSegment(segment: string): string {
  return segment.replace(/~1/g, "/").replace(/~0/g, "~");
}
