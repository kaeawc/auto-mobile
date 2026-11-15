/**
 * Lays the ejected Compose scaffold out the way `ktfmt --google-style` would (#16499), so an app
 * that formats with ktfmt does not rewrite the file on its first commit. The dialect writes every
 * nesting level with the shared four-space indent; this pass maps it to ktfmt's two-space block and
 * continuation indent, collapses empty lambdas, wraps long `//` comments and puts each argument of
 * an over-long call on its own line with a trailing comma (which ktfmt then keeps broken).
 */

const MAX_WIDTH = 100;
const EMITTER_INDENT = 4;
const KTFMT_INDENT = 2;

function leading(line: string): number {
  return line.length - line.trimStart().length;
}

function reindent(line: string): string {
  const depth = Math.floor(leading(line) / EMITTER_INDENT);
  return `${" ".repeat(depth * KTFMT_INDENT)}${line.trimStart()}`;
}

/** `onClick = {` directly followed by its `},` becomes `onClick = {},`. */
function collapseEmptyLambdas(lines: readonly string[]): string[] {
  const out: string[] = [];
  for (const line of lines) {
    const previous = out[out.length - 1];
    if (
      previous !== undefined &&
      previous.endsWith("= {") &&
      line.trim() === "}," &&
      leading(line) === leading(previous)
    ) {
      out[out.length - 1] = `${previous}},`;
    } else {
      out.push(line);
    }
  }
  return out;
}

/** A `//` comment wider than ktfmt's limit, refilled word by word at the same indent. */
function wrapComment(line: string): string[] {
  const pad = " ".repeat(leading(line));
  const words = line.trim().slice(2).trim().split(/\s+/);
  const out: string[] = [];
  let current = `${pad}//`;
  for (const word of words) {
    const candidate = `${current} ${word}`;
    if (candidate.length > MAX_WIDTH && current.length > pad.length + 2) {
      out.push(current);
      current = `${pad}// ${word}`;
    } else {
      current = candidate;
    }
  }
  out.push(current);
  return out;
}

/** Splits `a, b(c, d), "e, f"` at its top-level commas. */
function topLevelArgs(args: string): string[] | undefined {
  const parts: string[] = [];
  let depth = 0;
  let inString = false;
  let start = 0;
  for (let i = 0; i < args.length; i += 1) {
    const ch = args[i];
    if (inString) {
      if (ch === "\\") {
        i += 1;
      } else if (ch === '"') {
        inString = false;
      }
    } else if (ch === '"') {
      inString = true;
    } else if ("([{".includes(ch)) {
      depth += 1;
    } else if (")]}".includes(ch)) {
      depth -= 1;
    } else if (ch === "," && depth === 0) {
      parts.push(args.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(args.slice(start).trim());
  return depth === 0 && !inString ? parts.filter((part) => part.length > 0) : undefined;
}

const CALL = /^(\s*)((?:private )?(?:fun )?[A-Za-z_][\w.]*)\((.*)\)( \{)?$/;

/** A one-line `Name(args)`, `Name(args) {` or `fun Name(params) {` wider than the limit, one argument per line. */
function breakCall(line: string): string[] {
  const match = CALL.exec(line);
  const args = match ? topLevelArgs(match[3]) : undefined;
  if (!match || !args || args.length === 0) {
    return [line];
  }
  const [, pad, name, , trailing = ""] = match;
  const inner = " ".repeat(pad.length + KTFMT_INDENT);
  return [`${pad}${name}(`, ...args.map((arg) => `${inner}${arg},`), `${pad})${trailing}`];
}

function fitLine(line: string): string[] {
  if (line.length <= MAX_WIDTH) {
    return [line];
  }
  return line.trimStart().startsWith("//") ? wrapComment(line) : breakCall(line);
}

/** The four-space emitter lines of a Compose file, laid out as ktfmt --google-style writes them. */
export function ktfmtLayout(lines: readonly string[]): string[] {
  return collapseEmptyLambdas(lines.map(reindent)).flatMap(fitLine);
}
