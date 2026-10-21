import { lexSql, splitSqlStatements, type SqlToken } from "./sqlLexer";

const READ_ONLY_PRAGMAS: ReadonlySet<string> = new Set([
  "APPLICATION_ID",
  "COMPILE_OPTIONS",
  "DATA_VERSION",
  "DATABASE_LIST",
  "ENCODING",
  "FREELIST_COUNT",
  "PAGE_COUNT",
  "SCHEMA_VERSION",
  "USER_VERSION",
]);

/** The statement keywords a CTE can lead into. */
const CTE_MAIN_STATEMENTS: ReadonlySet<string> = new Set([
  "SELECT",
  "VALUES",
  "INSERT",
  "REPLACE",
  "UPDATE",
  "DELETE",
]);

/**
 * A bare PRAGMA query (`PRAGMA name` or `PRAGMA schema.name`) of a read-only pragma. PRAGMA can
 * both read and write; an assignment, call-style argument or unknown form is a write.
 */
function isReadOnlyPragma(body: readonly SqlToken[]): boolean {
  const name =
    body.length === 1
      ? body[0]
      : body.length === 3 && body[1].kind === "punctuation" && body[1].text === "."
        ? body[2]
        : undefined;
  return name?.kind === "word" && READ_ONLY_PRAGMAS.has(name.text);
}

/**
 * The statement keyword after a `WITH` clause's CTE definitions: the first statement keyword at
 * parenthesis depth zero. Parentheses inside string literals, quoted identifiers and comments are
 * not tokens, so they cannot shift the depth (#10966); a CTE named `update_cte` or `"select"` is
 * one identifier token, never a keyword. Unbalanced parentheses give undefined.
 */
function findStatementAfterCTE(statement: readonly SqlToken[]): string | undefined {
  let depth = 0;
  for (const token of statement.slice(1)) {
    if (token.kind === "punctuation" && token.text === "(") {
      depth++;
    } else if (token.kind === "punctuation" && token.text === ")") {
      depth--;
      if (depth < 0) {
        return undefined;
      }
    } else if (depth === 0 && token.kind === "word" && CTE_MAIN_STATEMENTS.has(token.text)) {
      return token.text;
    }
  }
  return undefined;
}

/** Whether one statement's significant tokens are clearly a read; anything else may write. */
function isReadStatement(statement: readonly SqlToken[]): boolean {
  const first = statement[0];
  if (first?.kind !== "word") {
    return false;
  }
  switch (first.text) {
    case "SELECT":
    case "VALUES":
      return true;
    case "PRAGMA":
      return isReadOnlyPragma(statement.slice(1));
    case "WITH": {
      const main = findStatementAfterCTE(statement);
      return main === "SELECT" || main === "VALUES";
    }
    default:
      return false;
  }
}

/**
 * Approximate whether a query may mutate data before execution.
 *
 * This is not authoritative: SQLite's statement-readonly result determines
 * execution policy, and the SQLResult returned by the device determines cache
 * invalidation. Statements that are not clearly read-only count as mutations,
 * consistent with the iOS SDK's sqlite3_stmt_readonly classification. The text is
 * lexed first (#10966), so comments, string literals and quoted identifiers can
 * neither hide a write nor fake a statement boundary. Any write among several
 * statements makes the query a mutation; unterminated text or no statement at
 * all is conservatively a mutation.
 */
export function isMutationQuery(query: string): boolean {
  const { tokens, unterminated } = lexSql(query);
  const statements = splitSqlStatements(tokens);
  return unterminated || statements.length === 0 || !statements.every((s) => isReadStatement(s));
}

/**
 * Whether the query is exactly one statement that cannot change data: safe to run for a caller
 * that does not hold the device (#10830) and safe to retry when it got no answer. Stricter than
 * `!isMutationQuery`: a second statement, even a read, is not read-only. A `;` inside a string
 * literal, quoted identifier or comment is not a statement boundary.
 */
export function isReadOnlySqlQuery(query: string): boolean {
  const { tokens, unterminated } = lexSql(query);
  if (unterminated) {
    return false;
  }
  const statements = splitSqlStatements(tokens);
  return statements.length === 1 && isReadStatement(statements[0]);
}
