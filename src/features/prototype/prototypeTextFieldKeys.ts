import type { PrototypeSpec } from "./prototypeSpec";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function collectTextFieldKeys(
  node: Record<string, unknown>,
  keys: Map<string, string>,
  conflicts: Set<string>,
): void {
  if (
    (node.type !== "textField" && node.type !== "searchBar") ||
    typeof node.stateKey !== "string" ||
    node.stateKey.includes("{")
  ) {
    return;
  }
  for (const identifier of [node.testTag, node.id]) {
    if (typeof identifier !== "string" || identifier.includes("{") || conflicts.has(identifier)) {
      continue;
    }
    if (keys.has(identifier) && keys.get(identifier) !== node.stateKey) {
      keys.delete(identifier);
      conflicts.add(identifier);
    } else {
      keys.set(identifier, node.stateKey);
    }
  }
}

/** Walk slots as well as containers; ambiguous and device-expanded identifiers cannot bind. */
export function prototypeTextFieldKeys(spec: PrototypeSpec): ReadonlyMap<string, string> {
  const keys = new Map<string, string>();
  const conflicts = new Set<string>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const child of value) {
        visit(child);
      }
    } else if (isRecord(value)) {
      collectTextFieldKeys(value, keys, conflicts);
      for (const child of Object.values(value)) {
        visit(child);
      }
    }
  };
  visit(spec.root);
  return keys;
}
