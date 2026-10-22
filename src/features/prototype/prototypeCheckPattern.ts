/**
 * prototype_checks_v1 portable regex grammar (also the Kotlin/Swift fixture contract).
 * Reject every group repeated more than once whose transitive body contains alternation or
 * any variable quantifier (max > min). At most two variable quantifiers are allowed
 * in the entire pattern. This rejects polynomial/exponential backtracking blowups;
 * optional groups and repetitions of fixed sequences remain legal.
 * Bounds are <=100 (open upper bounds, * and + are unbounded). Length is UTF-16 code units.
 * Matching is whole-value, Unicode scalar aware, with ASCII d/w/s classes. s is exactly
 * space, tab, CR, LF, FF and VT. Dot excludes CR, LF, U+2028 and U+2029.
 * Standard RegExp cannot enforce this grammar, and no installed parser implements this subset.
 */
import contract from "../../../schemas/prototype-spec-contract.json";

const maxLength = contract.definitions.check.fields.pattern.rule.max;
const maxBound = contract.limits.MAX_PROTOTYPE_CHECK_QUANTIFIER_BOUND;
const maxVariable = contract.limits.MAX_PROTOTYPE_CHECK_VARIABLE_QUANTIFIERS;

export type CheckPatternResult = { ok: true } | { ok: false; message: string };
interface Body {
  variable: boolean;
  alternation: boolean;
}
const escaped = "^$\\.*+?()[]{}|/-";

class PatternParser {
  private cursor = 0;
  private error?: string;
  private variableQuantifiers = 0;
  private variable = false;
  constructor(private readonly source: string) {}

  parse(): CheckPatternResult {
    if (this.source.length > maxLength) {
      return { ok: false, message: `Pattern exceeds ${maxLength} characters` };
    }
    this.body(false);
    return this.error ? { ok: false, message: this.error } : { ok: true };
  }
  private fail(message: string): void {
    this.error ??= message;
  }
  private body(group: boolean): Body {
    const body: Body = { variable: false, alternation: false };
    while (this.cursor < this.source.length && !this.error) {
      const char = this.source[this.cursor];
      if (char === ")") {
        if (!group) {
          this.fail("Unmatched closing group");
        } else {
          this.cursor++;
        }
        return body;
      }
      if (char === "|") {
        body.alternation = true;
        this.cursor++;
        continue;
      }
      this.bodyAtom(body, char);
    }
    if (group && !this.error) {
      this.fail("Unclosed group");
    }
    return body;
  }
  private bodyAtom(body: Body, char: string): void {
    const atom = this.atom();
    const maximum = this.quantifier();
    const repeated = maximum !== undefined && maximum > 1;
    if (maximum !== undefined && (char === "^" || char === "$")) {
      this.fail("Anchor cannot be quantified");
    }
    if (repeated && this.unsafeBody(atom)) {
      this.fail("Repeated group contains repetition or alternation");
    }
    this.mergeBody(body, atom, this.variable);
  }
  private mergeBody(body: Body, atom: Body | undefined, variable: boolean): void {
    body.variable ||= variable || atom?.variable === true;
    body.alternation ||= atom?.alternation === true;
  }
  private unsafeBody(body: Body | undefined): boolean {
    return body !== undefined && (body.variable || body.alternation);
  }
  private atom(): Body | undefined {
    const char = this.source[this.cursor++];
    if (char === "\\") {
      this.escape();
    } else if (char === "[") {
      this.characterClass();
    } else if (char === "(") {
      if (this.source[this.cursor] === "?") {
        if (this.source.startsWith("?:", this.cursor)) {
          this.cursor += 2;
        } else {
          this.fail(this.groupError());
          return undefined;
        }
      }
      return this.body(true);
    } else if ("*+?{}]".includes(char)) {
      this.fail("Unexpected metacharacter or quantifier");
    }
    return undefined;
  }
  private groupError(): string {
    const rest = this.source.slice(this.cursor);
    if (rest.startsWith("?=") || rest.startsWith("?!")) {
      return "Lookahead is not supported";
    }
    if (rest.startsWith("?<=") || rest.startsWith("?<!")) {
      return "Lookbehind is not supported";
    }
    if (rest.startsWith("?<")) {
      return "Named groups are not supported";
    }
    return "Inline flags or unsupported group syntax";
  }
  private escape(): string | undefined {
    const char = this.source[this.cursor++];
    if (!char) {
      this.fail("Trailing escape");
      return undefined;
    }
    if (/[0-9]/.test(char) || char === "k") {
      this.fail("Backreferences are not supported");
    } else if (char === "p" || char === "P") {
      this.fail("Unicode property classes are not supported");
    } else if (char === "b" || char === "B") {
      this.fail("Word boundaries are not supported");
    } else if (!"dwsDWS".includes(char) && !escaped.includes(char)) {
      this.fail(`Unsupported escape \\${char}`);
    }
    // Class ranges must have literal scalar endpoints, not shorthand classes.
    return "dwsDWS".includes(char) ? undefined : char;
  }
  private classAtom(): string | undefined {
    const char = this.source[this.cursor++];
    if (char === "\\") {
      return this.escape();
    }
    // Read one scalar, including astral literal range endpoints.
    const point = this.source.codePointAt(this.cursor - 1);
    if (point !== undefined && point > 0xffff) {
      this.cursor++;
      return String.fromCodePoint(point);
    }
    return char;
  }
  private characterClass(): void {
    if (this.source[this.cursor] === "^") {
      this.cursor++;
    }
    let count = 0;
    while (this.cursor < this.source.length && this.source[this.cursor] !== "]" && !this.error) {
      const start = this.classAtom();
      count++;
      if (this.source[this.cursor] === "-" && this.source[this.cursor + 1] !== "]") {
        this.cursor++;
        const end = this.classAtom();
        if (!start || !end) {
          this.fail("Character class range requires literal endpoints");
        } else if (start.codePointAt(0)! > end.codePointAt(0)!) {
          this.fail("Character class range is reversed");
        }
      }
    }
    if (this.source[this.cursor] !== "]") {
      this.fail("Unclosed character class");
    } else {
      this.cursor++;
    }
    if (!count) {
      this.fail("Empty character class is not supported");
    }
  }
  private quantifier(): number | undefined {
    const char = this.source[this.cursor];
    this.variable = false;
    let max: number | undefined;
    if (char === "?" || char === "*" || char === "+") {
      this.cursor++;
      max = char === "?" ? 1 : Infinity;
      this.variable = true;
    } else if (char === "{") {
      max = this.boundedQuantifier();
    }
    this.countVariableQuantifier();
    if (max !== undefined) {
      const next = this.source[this.cursor];
      if (next === "?") {
        this.fail("Lazy quantifiers are not supported");
      } else if (next === "+") {
        this.fail("Possessive quantifiers are not supported");
      } else if (next === "*" || next === "{") {
        this.fail("Repeated quantifier is not supported");
      }
    }
    return max;
  }
  private countVariableQuantifier(): void {
    if (this.variable && ++this.variableQuantifiers > maxVariable) {
      this.fail(`pattern has too many variable quantifiers (max ${maxVariable})`);
    }
  }
  private boundedQuantifier(): number | undefined {
    const match = /^\{([0-9]+)(?:,([0-9]*))?\}/.exec(this.source.slice(this.cursor));
    if (!match) {
      this.fail("Malformed bounded quantifier");
      return undefined;
    }
    const min = Number(match[1]);
    const max = match[2] === undefined ? min : match[2] === "" ? Infinity : Number(match[2]);
    if (min > maxBound || (max !== Infinity && max > maxBound)) {
      this.fail(`Quantifier bounds must be <=${maxBound}`);
    } else if (min > max) {
      this.fail("Quantifier minimum exceeds maximum");
    }
    this.variable = max > min;
    this.cursor += match[0].length;
    return max;
  }
}

export function parseCheckPattern(pattern: string): CheckPatternResult {
  return new PatternParser(pattern).parse();
}

/** Translate shorthand whitespace and escaped punctuation to portable ASCII semantics. */
function patternSource(pattern: string): string {
  let result = "";
  let inClass = false;
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char !== "\\") {
      if (char === "[") {
        inClass = true;
      }
      if (char === "]") {
        inClass = false;
      }
      result += char;
      continue;
    }
    const next = pattern[++i];
    if (next === "s") {
      result += inClass ? " \\t\\r\\n\\f\\v" : "[ \\t\\r\\n\\f\\v]";
    } else if (next === "S") {
      result += inClass ? "\\x00-\\x08\\x0e-\\x1f\\x21-\\u{10ffff}" : "[^ \\t\\r\\n\\f\\v]";
    } else if (next === "-") {
      result += inClass ? "\\-" : "-";
    } else {
      result += `\\${next}`;
    }
  }
  return result;
}

export function matchesCheckPattern(pattern: string, value: string): boolean {
  if (!parseCheckPattern(pattern).ok) {
    return false;
  }
  // The parser guarantees syntactically valid source. Absolute end avoids JS $ accepting a final LF.
  return new RegExp(`^(?:${patternSource(pattern)})$(?![\\s\\S])`, "u").test(value);
}
