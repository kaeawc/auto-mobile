/** Validate the portable JSON subset after the native parser checks JSON grammar.
 * Tokenize, rather than inspecting parsed objects: JSON.parse loses duplicate keys.
 * An iterative object/array stack also avoids adding a recursive traversal limit.
 */
export function validateBundleJsonTokens(text: string): void {
  const tokens =
    /"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null|[{}\[\]:,]/g;
  const stack: (Set<string> | undefined)[] = [];
  for (const match of text.matchAll(tokens)) {
    const token = match[0];
    if (token === "{" || token === "[") {
      stack.push(token === "{" ? new Set() : undefined);
    } else if (token === "}" || token === "]") {
      stack.pop();
    } else if (token.startsWith('"')) {
      checkStringToken(text, match.index + token.length, token, stack.at(-1));
    } else if (/^-?\d/.test(token) && !Number.isFinite(Number(token))) {
      throw new SyntaxError("JSON number is not finite");
    }
  }
}

function checkStringToken(
  text: string,
  end: number,
  token: string,
  keys: Set<string> | undefined,
): void {
  const value: string = JSON.parse(token);
  if (!value.isWellFormed()) {
    throw new SyntaxError("JSON string contains a lone surrogate");
  }
  if (keys && /^\s*:/.test(text.slice(end))) {
    if (keys.has(value)) {
      throw new SyntaxError("Duplicate JSON object key");
    }
    keys.add(value);
  }
}
