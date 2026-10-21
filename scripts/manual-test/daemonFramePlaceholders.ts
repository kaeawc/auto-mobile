export interface BrokerFrameIdentity {
  sessionId?: string;
  token: string;
  clients: Map<string, string>;
}
/** Walk parsed JSON values, never its serialized syntax; keys remain literal. */
export function substituteFramePlaceholders(
  value: unknown,
  identity?: BrokerFrameIdentity,
): unknown {
  if (typeof value === "string") {
    return value.replace(
      /\{\{(ownSessionId[^}]*|ownLivenessOwnerToken[^}]*|clientSessionId[^}]*)\}\}/g,
      (_match, name: string) => {
        if (name.startsWith("ownSessionId:")) {
          throw new Error(
            "Indexed ownSessionId placeholders were removed; use {{clientSessionId:<name>}}.",
          );
        }
        if (!identity) {
          throw new Error("Session placeholders require --broker-binding.");
        }
        const replacement =
          name === "ownSessionId"
            ? identity.sessionId
            : name === "ownLivenessOwnerToken"
              ? identity.token
              : /^clientSessionId:[a-z0-9-]{1,32}$/.test(name)
                ? identity.clients.get(name.slice("clientSessionId:".length))
                : undefined;
        if (!replacement) {
          throw new Error(`Cannot resolve {{${name}}} from this broker binding.`);
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
