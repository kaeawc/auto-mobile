/**
 * JSON.parse supplies the grammar. This bounded preflight preserves duplicate members and Unicode
 * validity, which it drops. No installed parser exposes duplicate-member diagnostics.
 */
class PrototypeJsonPreflight {
  private cursor = 0;
  private readonly stack: { keys?: Set<string> }[] = [];
  constructor(private readonly source: string) {}

  scan(): void {
    while (this.cursor < this.source.length) {
      const char = this.source[this.cursor++];
      switch (char) {
        case '"':
          this.string();
          break;
        case "{":
        case "[":
          this.open(char);
          break;
        case "}":
        case "]":
          this.stack.pop();
          break;
        default:
          if (char === "-" || (char >= "0" && char <= "9")) {
            this.number();
          }
      }
    }
  }

  private open(char: string): void {
    this.stack.push(char === "{" ? { keys: new Set() } : {});
    if (this.stack.length > 128) {
      throw new Error("JSON nesting limit exceeded");
    }
  }

  private string(): void {
    const start = this.cursor - 1;
    while (this.cursor < this.source.length) {
      const next = this.source[this.cursor++];
      if (next === "\\") {
        this.cursor++;
      } else if (next === '"') {
        break;
      }
    }
    const token: unknown = JSON.parse(this.source.slice(start, this.cursor));
    if (typeof token !== "string" || !token.isWellFormed()) {
      throw new Error("Invalid Unicode JSON string");
    }
    if (this.afterString() === ":") {
      this.key(token);
    }
  }

  private afterString(): string | undefined {
    let after = this.cursor;
    while (" \r\n\t".includes(this.source[after] ?? "\0")) {
      after++;
    }
    return this.source[after];
  }

  private key(token: string): void {
    const keys = this.stack.at(-1)?.keys;
    if (keys?.has(token)) {
      throw new Error("Duplicate JSON key");
    }
    keys?.add(token);
  }

  private number(): void {
    const start = this.cursor - 1;
    while (this.cursor < this.source.length && !" \r\n\t,]}:".includes(this.source[this.cursor]!)) {
      this.cursor++;
    }
    if (!Number.isFinite(Number(this.source.slice(start, this.cursor)))) {
      throw new Error("Nonfinite JSON number");
    }
  }
}

/** Containers are scanned iteratively before any recursive decoder runs. One leading BOM is allowed. */
export function prototypeStrictJson(input: string): unknown {
  const source = input.startsWith("\uFEFF") ? input.slice(1) : input;
  new PrototypeJsonPreflight(source).scan();
  return JSON.parse(source) as unknown;
}
