import { resolveJsonSchemaReference } from "../jsonSchemaReferences";

/** A default supplies an omitted key; retain the pre-ref advertisement contract. */
export function dropDefaultedKeysFromRequired(
  schema: Record<string, unknown>,
  root?: Record<string, unknown>,
): void {
  const required = schema.required;
  const properties = schema.properties as Record<string, unknown> | undefined;
  if (!Array.isArray(required) || !properties) {
    return;
  }
  const pruned = required.filter((key) => {
    const property = properties[String(key)];
    if (!property || typeof property !== "object" || Array.isArray(property)) {
      return true;
    }
    const node = property as Record<string, unknown>;
    return !("default" in (root ? resolveJsonSchemaReference(root, node) : node));
  });
  if (pruned.length === required.length) {
    return;
  }
  if (pruned.length > 0) {
    schema.required = pruned;
  } else {
    delete schema.required;
  }
}

/** Defaults behind refs must remain optional, just like their inline counterparts. */
export function dropReferencedDefaultsFromRequired(root: Record<string, unknown>): void {
  const walk = (node: unknown): void => {
    if (!node || typeof node !== "object" || Array.isArray(node)) {
      return;
    }
    const schema = node as Record<string, unknown>;
    dropDefaultedKeysFromRequired(schema, root);
    // Traverse schema keywords, never default/const/example instance data.
    for (const key of [
      "properties",
      "$defs",
      "definitions",
      "patternProperties",
      "dependentSchemas",
    ]) {
      const children = schema[key];
      if (children && typeof children === "object") {
        Object.values(children).forEach(walk);
      }
    }
    for (const key of ["anyOf", "oneOf", "allOf", "prefixItems"]) {
      const children = schema[key];
      if (Array.isArray(children)) {
        children.forEach(walk);
      }
    }
    for (const key of [
      "items",
      "additionalProperties",
      "not",
      "if",
      "then",
      "else",
      "contains",
      "propertyNames",
      "unevaluatedProperties",
      "unevaluatedItems",
    ]) {
      walk(schema[key]);
    }
  };
  walk(root);
}
