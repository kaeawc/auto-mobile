/**
 * A small SQLite lexer for classifying statements before they are sent to a device (#10966).
 *
 * It recognizes exactly the token classes that change what a `(`, `)` or `;` means: string
 * literals (`'…'` with `''` escapes), quoted identifiers (`"…"`, `` `…` ``, `[…]`), line comments
 * (`-- …`) and block comments (`/* … *\/`). Everything else is a bare word, a punctuation
 * character, or other text. It does not parse SQL: callers walk the significant tokens.
 */

export type SqlTokenKind =
  /** An unquoted keyword or identifier; `text` is upper-cased. */
  | "word"
  /** A quoted identifier (`"x"`, `` `x` ``, `[x]`): never a keyword. */
  | "identifier"
  /** A string literal (`'x'`, including the quote of a blob literal `X'..'`). */
  | "string"
  /** `(`, `)`, `;`, `,` or `.`. */
  | "punctuation"
  /** Any other run of significant characters (numbers, operators). */
  | "other";

export interface SqlToken {
  kind: SqlTokenKind;
  text: string;
}

export interface SqlLexResult {
  /** Significant tokens, with whitespace and comments dropped. */
  tokens: SqlToken[];
  /** A string literal, quoted identifier or block comment ran to the end of the text unclosed. */
  unterminated: boolean;
}

const PUNCTUATION = new Set(["(", ")", ";", ",", "."]);
const QUOTE_CLOSERS: Readonly<Record<string, SqlTokenKind>> = {
  "'": "string",
  '"': "identifier",
  "`": "identifier",
};

function isWordStart(char: string): boolean {
  return /[A-Za-z_]/.test(char) || char.charCodeAt(0) > 0x7f;
}

function isWordPart(char: string): boolean {
  return isWordStart(char) || /[0-9$]/.test(char);
}

function isSpace(char: string): boolean {
  return /\s/.test(char);
}

/**
 * Read a quoted run starting at `start` (the opening quote). A doubled closing quote is an escaped
 * quote inside the run. Returns the index after the closing quote, or `-1` when it never closes.
 */
function readQuoted(sql: string, start: number, close: string): number {
  let i = start + 1;
  while (i < sql.length) {
    if (sql[i] === close) {
      if (close !== "]" && sql[i + 1] === close) {
        i += 2;
        continue;
      }
      return i + 1;
    }
    i++;
  }
  return -1;
}

/** One scan step: the index after it, the token it produced (none for space and comments). */
interface ScanStep {
  next: number;
  token?: SqlToken;
}

function startsComment(sql: string, i: number): boolean {
  return (sql[i] === "-" && sql[i + 1] === "-") || (sql[i] === "/" && sql[i + 1] === "*");
}

/** Skip a comment starting at `i`; undefined when a block comment never closes. */
function skipComment(sql: string, i: number): ScanStep | undefined {
  if (sql[i] === "-") {
    const newline = sql.indexOf("\n", i + 2);
    return { next: newline === -1 ? sql.length : newline + 1 };
  }
  const end = sql.indexOf("*/", i + 2);
  return end === -1 ? undefined : { next: end + 2 };
}

function isQuoteStart(char: string): boolean {
  return char in QUOTE_CLOSERS || char === "[";
}

/** Scan a literal or quoted identifier at `i`; undefined when it never closes. */
function scanQuoted(sql: string, i: number): ScanStep | undefined {
  const open = sql[i];
  const end = readQuoted(sql, i, open === "[" ? "]" : open);
  if (end === -1) {
    return undefined;
  }
  return {
    next: end,
    token: { kind: QUOTE_CLOSERS[open] ?? "identifier", text: sql.slice(i, end) },
  };
}

function scanWord(sql: string, i: number): ScanStep {
  let end = i + 1;
  while (end < sql.length && isWordPart(sql[end])) {
    end++;
  }
  return { next: end, token: { kind: "word", text: sql.slice(i, end).toUpperCase() } };
}

/** Whether `sql[i]` starts a token other than an `other` run (or a separator). */
function endsOtherRun(sql: string, i: number): boolean {
  const char = sql[i];
  return (
    isSpace(char) ||
    PUNCTUATION.has(char) ||
    isQuoteStart(char) ||
    isWordStart(char) ||
    startsComment(sql, i)
  );
}

function scanOther(sql: string, i: number): ScanStep {
  let end = i + 1;
  while (end < sql.length && !endsOtherRun(sql, end)) {
    end++;
  }
  return { next: end, token: { kind: "other", text: sql.slice(i, end) } };
}

/** Scan one step at `i`; undefined when an unterminated literal, identifier or comment starts. */
function scanAt(sql: string, i: number): ScanStep | undefined {
  const char = sql[i];
  if (isSpace(char)) {
    return { next: i + 1 };
  }
  if (startsComment(sql, i)) {
    return skipComment(sql, i);
  }
  if (isQuoteStart(char)) {
    return scanQuoted(sql, i);
  }
  if (PUNCTUATION.has(char)) {
    return { next: i + 1, token: { kind: "punctuation", text: char } };
  }
  return isWordStart(char) ? scanWord(sql, i) : scanOther(sql, i);
}

/** Lex `sql` into significant tokens. Never throws; malformed input sets `unterminated`. */
export function lexSql(sql: string): SqlLexResult {
  const tokens: SqlToken[] = [];
  let i = 0;
  while (i < sql.length) {
    const step = scanAt(sql, i);
    if (!step) {
      return { tokens, unterminated: true };
    }
    if (step.token) {
      tokens.push(step.token);
    }
    i = step.next;
  }
  return { tokens, unterminated: false };
}

/**
 * Split significant tokens into statements on `;`. Empty statements (`;;`, a trailing `;`) are
 * dropped. A `;` can only end a statement: SQLite has no nested statement inside parentheses
 * except a trigger body, which only `CREATE TRIGGER` (a write) can contain.
 */
export function splitSqlStatements(tokens: readonly SqlToken[]): SqlToken[][] {
  const statements: SqlToken[][] = [[]];
  for (const token of tokens) {
    if (token.kind === "punctuation" && token.text === ";") {
      statements.push([]);
    } else {
      statements[statements.length - 1].push(token);
    }
  }
  return statements.filter((statement) => statement.length > 0);
}
