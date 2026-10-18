/**
 * Typed path reader for untyped JSON-ish values in tests (MCP `structuredContent`,
 * parsed wire payloads). Replaces `(value as any).a.b.c` casts: each step narrows
 * through a runtime object check, and a missing step yields `undefined` instead of
 * throwing, so `expect(valueAt(x, "a", "b")).toBeUndefined()` reads naturally.
 */
export function valueAt(value: unknown, ...path: Array<string | number>): unknown {
  let current: unknown = value;
  for (const key of path) {
    if (typeof current !== "object" || current === null) {
      return undefined;
    }
    current = Reflect.get(current, key);
  }
  return current;
}

/** Like {@link valueAt} but requires an object at the path (for toMatchObject / spreads). */
export function recordAt(value: unknown, ...path: Array<string | number>): Record<string, unknown> {
  const found = valueAt(value, ...path);
  if (typeof found !== "object" || found === null) {
    throw new Error(`expected an object at ${path.join(".")}, got ${JSON.stringify(found)}`);
  }
  return Object.fromEntries(Object.entries(found));
}

/** Like {@link valueAt} but requires an array at the path. */
export function arrayAt(value: unknown, ...path: Array<string | number>): unknown[] {
  const found = valueAt(value, ...path);
  if (!Array.isArray(found)) {
    throw new Error(`expected an array at ${path.join(".")}, got ${JSON.stringify(found)}`);
  }
  return found;
}
