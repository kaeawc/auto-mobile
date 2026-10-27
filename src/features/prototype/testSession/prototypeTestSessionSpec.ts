/** Walk the whole authored JSON, including components, repeated templates and every slot. */
export function prototypeSecureKeys(spec: unknown): ReadonlySet<string> {
  const keys = new Set<string>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (value === null || typeof value !== "object") {
      return;
    }
    const node = value as Record<string, unknown>;
    if (
      (node.type === "textField" || node.type === "searchBar") &&
      typeof node.stateKey === "string" &&
      node.secure !== false
    ) {
      // Missing/dynamic secure is conservatively private, as is an unresolved repeated key.
      keys.add(node.stateKey.includes("{") ? "*" : node.stateKey);
    }
    Object.values(node).forEach(visit);
  };
  visit(spec);
  return keys;
}
