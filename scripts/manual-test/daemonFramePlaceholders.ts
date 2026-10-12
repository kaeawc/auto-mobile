export interface ManagedFrameIdentity {
  sessionIds: string[];
  slots: Map<number, string>;
  token: string;
}
/** Walk parsed JSON values, never its serialized syntax; keys remain literal. */
export function substituteFramePlaceholders(
  value: unknown,
  identity?: ManagedFrameIdentity,
): unknown {
  if (typeof value === "string") {
    return value.replace(
      /\{\{(ownSessionId[^}]*|ownLivenessOwnerToken[^}]*)\}\}/g,
      (_match, name: string) => {
        if (!identity) {
          throw new Error("Own-session placeholders require --managed-binding.");
        }
        if (!/^(ownSessionId(?::(?:0|[1-9]\d*))?|ownLivenessOwnerToken)$/.test(name)) {
          throw new Error(`Cannot resolve {{${name}}} from this managed binding.`);
        }
        const sessionId =
          name === "ownSessionId"
            ? identity.sessionIds[0]
            : identity.slots.get(Number(name.slice("ownSessionId:".length)));
        const replacement = name === "ownLivenessOwnerToken" ? identity.token : sessionId;
        if (!replacement) {
          throw new Error(`Cannot resolve {{${name}}} from this managed binding.`);
        }
        return replacement;
      },
    );
  }
  if (Array.isArray(value)) {
    return value.map((item) => substituteFramePlaceholders(item, identity));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        substituteFramePlaceholders(item, identity),
      ]),
    );
  }
  return value;
}
