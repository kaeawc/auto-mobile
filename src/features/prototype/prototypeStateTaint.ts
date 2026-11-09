/**
 * State-key matching for the R2 sensitive-sink copy taint (#17607). A state key may hold a repeat
 * placeholder (`sel_{index}`, `pick_{row.id}`) that binds per row, including rows added from live
 * data after validation, so a templated key is matched by its literal prefix: it may name any key
 * that starts with that prefix. This over-approximates, which keeps the analysis fail-closed.
 */

/** The literal text before a key's first placeholder, or undefined for a literal key. */
function templatePrefix(key: string): string | undefined {
  const at = key.indexOf("{");
  return at < 0 ? undefined : key.slice(0, at);
}

/** Whether two authored state keys may name the same runtime key. */
export function stateKeysOverlap(left: string, right: string): boolean {
  const leftPrefix = templatePrefix(left);
  const rightPrefix = templatePrefix(right);
  if (leftPrefix === undefined && rightPrefix === undefined) {
    return left === right;
  }
  if (leftPrefix === undefined) {
    return left.startsWith(rightPrefix!);
  }
  if (rightPrefix === undefined) {
    return right.startsWith(leftPrefix);
  }
  return leftPrefix.startsWith(rightPrefix) || rightPrefix.startsWith(leftPrefix);
}

export interface StateKeyTaintIndex {
  /** Whether a (bound) state key read may name a tainted key. */
  key(key: string): boolean;
  /** Whether text may interpolate a tainted key through a `{key}` placeholder. */
  text(text: string): boolean;
}

/**
 * Lookups over tainted state keys. Literal keys are a set lookup; templated keys are compared one
 * by one. `visit` is charged per comparison and returns false once the shared check cap is spent,
 * so the caller reports the cap instead of a partial result.
 */
export function stateKeyTaintIndex(
  taints: readonly string[],
  visit: () => boolean,
): StateKeyTaintIndex {
  const literal = new Set(taints.filter((taint) => templatePrefix(taint) === undefined));
  const templated = taints.filter((taint) => templatePrefix(taint) !== undefined);
  return {
    key: (key) => {
      if (!visit()) {
        return false;
      }
      if (templatePrefix(key) === undefined && literal.has(key)) {
        return true;
      }
      const candidates = templatePrefix(key) === undefined ? templated : taints;
      return candidates.some((taint) => visit() && stateKeysOverlap(taint, key));
    },
    text: (text) =>
      text.includes("{") &&
      taints.some((taint) => visit() && text.includes(`{${templatePrefix(taint) ?? `${taint}}`}`)),
  };
}
