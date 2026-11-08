/**
 * Evaluates the CSS lengths the web still emits (`12px`, `50%`, `0`, `var(--safe-top)`,
 * `calc(a + b)` of those, and `min(...)`/`max(...)` of any of them) to px, for the still's layout
 * pass (#16667). Anything else is unknown.
 */

/** Custom properties in scope (`--safe-top` and the like), from the screen down. */
export type CssVars = Readonly<Record<string, string>>;

const MAX_VAR_DEPTH = 8;

/** Replaces each `var(--name)` with its value in `vars`, so nested references resolve too. */
function substituteVars(value: string, vars: CssVars): string | undefined {
  let current = value;
  for (let depth = 0; depth < MAX_VAR_DEPTH && current.includes("var("); depth++) {
    let missing = false;
    current = current.replace(/var\(\s*(--[\w-]+)\s*\)/g, (_match, name: string) => {
      const resolved = vars[name];
      missing ||= resolved === undefined;
      return resolved ?? "";
    });
    if (missing) {
      return undefined;
    }
  }
  return current.includes("var(") ? undefined : current;
}

/** One term: `12px`, `0` or `50%` (of `percentBase`, when known). */
function term(value: string, percentBase: number | undefined): number | undefined {
  const match = /^(-?\d+(?:\.\d+)?|-?\.\d+)(px|%)?$/.exec(value.trim());
  if (!match) {
    return undefined;
  }
  const amount = Number(match[1]);
  if (match[2] === "%") {
    return percentBase === undefined ? undefined : (amount * percentBase) / 100;
  }
  // A unitless length is valid only as zero.
  return match[2] === "px" || amount === 0 ? amount : undefined;
}

/** A sum or difference of terms, as `calc(a + b - c)` writes it. */
function sum(expression: string, percentBase: number | undefined): number | undefined {
  const parts = expression.trim().split(/\s+([+-])\s+/);
  let total = term(parts[0] ?? "", percentBase);
  for (let index = 1; index < parts.length && total !== undefined; index += 2) {
    const next = term(parts[index + 1] ?? "", percentBase);
    total = next === undefined ? undefined : total + (parts[index] === "-" ? -next : next);
  }
  return total;
}

/** The comma-separated arguments of a `min(...)`/`max(...)`, split at the top nesting level only. */
function topLevelArgs(inner: string): string[] {
  const args: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < inner.length; index++) {
    const char = inner[index];
    depth += char === "(" ? 1 : char === ")" ? -1 : 0;
    if (char === "," && depth === 0) {
      args.push(inner.slice(start, index));
      start = index + 1;
    }
  }
  args.push(inner.slice(start));
  return args;
}

/** `min(a, b)` or `max(a, b)`: known only when every argument is. */
function extremum(
  fn: string,
  inner: string,
  vars: CssVars,
  percentBase: number | undefined,
): number | undefined {
  const values = topLevelArgs(inner).map((arg) => cssLength(arg, vars, percentBase));
  const known = values.filter((value): value is number => value !== undefined);
  if (known.length !== values.length) {
    return undefined;
  }
  return fn === "min" ? Math.min(...known) : Math.max(...known);
}

/**
 * A length in px, or undefined when it is absent, not a length (`auto`, `fit-content`) or
 * depends on something unknown (a percentage of an unknown size, an unset variable).
 */
export function cssLength(
  value: string | undefined,
  vars: CssVars,
  percentBase?: number,
): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const substituted = substituteVars(value.trim(), vars);
  if (substituted === undefined) {
    return undefined;
  }
  const bounded = /^(min|max)\((.*)\)$/.exec(substituted);
  if (bounded) {
    return extremum(bounded[1]!, bounded[2]!, vars, percentBase);
  }
  // A difference of a group (`a - (b + c)`) would need real precedence; the still never emits one.
  if (/-\s*(?:calc)?\(/.test(substituted)) {
    return undefined;
  }
  const calc = /^calc\((.*)\)$/.exec(substituted.trim());
  // Inner parentheses (a substituted `calc(...)`) nest as plain grouping in a sum.
  const flat = (calc ? calc[1]! : substituted).replace(/calc\(|\(|\)/g, "");
  return sum(flat, percentBase);
}
