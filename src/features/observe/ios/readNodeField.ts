import type { ConvertibleNode } from "./types";

/** Reads a node field by its in-memory (camel-case) key, falling back to the runner's dashed key. */
export function readNodeField<T>(
  node: ConvertibleNode,
  camelKey: keyof ConvertibleNode,
  dashedKey?: string,
): T | undefined {
  const record = node as Record<string, unknown>;
  if (record[camelKey as string] !== undefined) {
    return record[camelKey as string] as T;
  }
  if (dashedKey && record[dashedKey] !== undefined) {
    return record[dashedKey] as T;
  }
  return undefined;
}
