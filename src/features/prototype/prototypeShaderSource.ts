import { isUtf8 } from "node:buffer";
import contract from "../../../schemas/prototype-asset-contract.json";

export const PROTOTYPE_SHADER_MIME_TYPE = "application/vnd.automobile.agsl";
export type PrototypeShaderSourceResult =
  | { success: true; uniforms: ReadonlySet<string> }
  | { success: false; error: string };

/** A lexical preflight, not an AGSL compiler. Comments become separators, never joined tokens. */
function stripComments(source: string): string | undefined {
  let result = "";
  for (let index = 0; index < source.length; index++) {
    const next = source[index + 1];
    if (source[index] === "/" && next === "/") {
      index += 2;
      while (index < source.length && !/[\n\r\v\f\u0085\u2028\u2029]/.test(source[index])) {
        index++;
      }
      result += " ";
    } else if (source[index] === "/" && next === "*") {
      const end = source.indexOf("*/", index + 2);
      if (end === -1) {
        return undefined;
      }
      index = end + 1;
      result += " ";
    } else {
      result += source[index];
    }
  }
  return result;
}

/**
 * Only scalar `uniform float name;` and optional `uniform shader content;` declarations.
 * No qualifiers, arrays, initializers, comma lists, directives, strings, escapes or non-ASCII
 * code tokens. The device must still compile on put before storing or advertising support.
 */
export function validatePrototypeShaderSource(bytes: Uint8Array): PrototypeShaderSourceResult {
  const fail = (error: string): PrototypeShaderSourceResult => ({ success: false, error });
  if (bytes.length === 0 || bytes.length > contract.limits.MAX_PROTOTYPE_SHADER_ASSET_BYTES) {
    return fail("AGSL source must contain 1 to 16384 bytes.");
  }
  if (!isUtf8(bytes)) {
    return fail("AGSL source must be valid UTF-8 text.");
  }
  const source = stripComments(new TextDecoder().decode(bytes));
  if (source === undefined) {
    return fail("AGSL source has an unterminated block comment.");
  }
  if (/[^\x20-\x7e\t\r\n]|[#\\"']/.test(source)) {
    return fail(
      "AGSL code must be ASCII text with no preprocessor directives, strings or escapes.",
    );
  }
  const tokens = source.match(/[A-Za-z_][A-Za-z0-9_]*|[^\s]/g) ?? [];
  return scanUniforms(tokens);
}

function scanUniforms(tokens: readonly string[]): PrototypeShaderSourceResult {
  const fail = (error: string): PrototypeShaderSourceResult => ({ success: false, error });
  const uniforms = new Set<string>();
  let content = false;
  let depth = 0;
  for (let index = 0; index < tokens.length; index++) {
    if (tokens[index] === "{") {
      depth++;
    }
    if (tokens[index] === "}") {
      depth--;
    }
    if (tokens[index] !== "uniform") {
      continue;
    }
    if (depth !== 0 || (index > 0 && ![";", "}"].includes(tokens[index - 1]))) {
      return fail("AGSL uniforms must be unqualified top-level declarations.");
    }
    const problem = addUniform(tokens.slice(index + 1, index + 4), uniforms, content);
    if (problem) {
      return fail(problem);
    }
    if (tokens[index + 1] === "shader") {
      content = true;
    }
    index += 3;
  }
  return { success: true, uniforms };
}

function addUniform(
  tokens: readonly string[],
  uniforms: Set<string>,
  content: boolean,
): string | undefined {
  const [type, name, end] = tokens;
  if (end !== ";" || !name || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    return "AGSL uniforms must use a single unqualified scalar declaration ending in ';'.";
  }
  if (type === "shader" && name === "content" && !content) {
    return undefined;
  }
  if (type !== "float" || name === "content" || uniforms.has(name)) {
    return "AGSL permits unique uniform float names and at most one uniform shader content; no other uniform types or sampled inputs.";
  }
  uniforms.add(name);
  return uniforms.size > 16
    ? "AGSL source permits at most 16 uniform float declarations."
    : undefined;
}
