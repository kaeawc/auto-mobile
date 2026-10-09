import { toActionableError } from "../models/ActionableError";
import { z } from "zod/v4";
import { ToolRegistry } from "./toolRegistry";
import { ActionableError, BootedDevice } from "../models";
import { addDeviceTargetingToSchema, withAppIdAliases } from "./toolSchemaHelpers";
import { createJSONToolResponse } from "../utils/toolUtils";
import { iosSqlErrorMessage } from "./storageSdkErrors";
import { DatabaseInspector } from "../features/database/DatabaseInspector";
import { defaultAdbClientFactory } from "../utils/android-cmdline-tools/AdbClientFactory";
import { notifyDatabaseChanged } from "./databaseResources";
import { IOSCtrlProxyClient } from "../features/observe/ios";
import type { SQLResult } from "../features/database/DatabaseInspector";
import { lexSql, splitSqlStatements, type SqlToken } from "../features/database/sqlLexer";

// Schema for sqlQuery tool
const sqlQuerySchema = withAppIdAliases(
  addDeviceTargetingToSchema(
    z
      .object({
        appId: z.string(),
        databasePath: z.string().describe("Database path"),
        query: z.string().describe("SQL query"),
      })
      .strict(),
  ),
);

// Type interface for tool arguments
interface SqlQueryArgs {
  appId: string;
  databasePath: string;
  query: string;
}

/**
 * Extract table names from SQL query for notification purposes.
 *
 * Handles SQLite replacement statements, conflict clauses, and quoted or
 * schema-qualified table identifiers. This is best-effort: callers must also
 * invalidate database-level resources when no table can be extracted.
 */
function extractAffectedTables(query: string): string[] {
  const tables: string[] = [];

  // SQLite conflict clause: OR (ABORT|FAIL|IGNORE|REPLACE|ROLLBACK)
  const conflictClause = "(?:OR\\s+(?:ABORT|FAIL|IGNORE|REPLACE|ROLLBACK)\\s+)?";
  // Capture the final component of an optionally schema-qualified SQLite
  // identifier. SQLite allows double quotes, backticks, and square brackets.
  const identifier = '(?:"(?:""|[^"])*"|`(?:``|[^`])*`|\\[(?:\\]\\]|[^\\]])*\\]|[\\w$]+)';
  const qualifiedTable = `(?:${identifier}\\s*\\.\\s*)?(${identifier})`;

  // Match INSERT/REPLACE [OR conflict] INTO table, UPDATE [OR conflict]
  // table, and the other common table-changing statements.
  const patterns = [
    new RegExp(`(?:INSERT\\s+${conflictClause}|REPLACE\\s+)INTO\\s+${qualifiedTable}`, "gi"),
    new RegExp(`UPDATE\\s+${conflictClause}${qualifiedTable}`, "gi"),
    new RegExp(`DELETE\\s+FROM\\s+${qualifiedTable}`, "gi"),
    new RegExp(`ALTER\\s+TABLE\\s+${qualifiedTable}`, "gi"),
    new RegExp(`DROP\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?${qualifiedTable}`, "gi"),
    new RegExp(`CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${qualifiedTable}`, "gi"),
    new RegExp(`TRUNCATE\\s+(?:TABLE\\s+)?${qualifiedTable}`, "gi"),
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(query)) !== null) {
      if (!match[1]) {
        continue;
      }
      const table = match[1]
        .replace(/^"|"$/g, "")
        .replace(/""/g, '"')
        .replace(/^`|`$/g, "")
        .replace(/``/g, "`")
        .replace(/^\[|\]$/g, "")
        .replace(/\]\]/g, "]");
      if (!tables.includes(table)) {
        tables.push(table);
      }
    }
  }

  return tables;
}

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

/**
 * Register database tools.
 *
 * Only the sqlQuery tool is registered here. Read-only operations
 * (listDatabases, listTables, getTableData, getTableStructure) are
 * exposed as MCP resources instead.
 */
export function registerDatabaseTools() {
  // SQL Query handler
  const sqlQueryHandler = async (device: BootedDevice, args: SqlQueryArgs) => {
    try {
      const result = await executeSqlForDevice(device, args);

      // The executed result type is authoritative; SQL text classification is
      // only an approximation for decisions that must happen before execution.
      if (result.type === "mutation") {
        const affectedTables = extractAffectedTables(args.query);
        await notifyDatabaseChanged(
          device.deviceId,
          args.appId,
          args.databasePath,
          affectedTables.length > 0 ? affectedTables : undefined,
        );
      }

      const message =
        result.type === "query"
          ? `Query returned ${result.rows?.length ?? 0} row(s)`
          : `Mutation affected ${result.rowsAffected ?? 0} row(s)`;

      return createJSONToolResponse({
        message,
        ...result,
      });
    } catch (error) {
      if (error instanceof ActionableError) {
        throw error;
      }
      throw toActionableError(error, `Failed to execute SQL`);
    }
  };

  // Register the sqlQuery tool
  ToolRegistry.registerDeviceAware(
    "sqlQuery",
    "Execute SQL on app SQLite database.",
    sqlQuerySchema,
    sqlQueryHandler,
    {
      defaultEnabled: false,
      embeddedSdkOnly: true,
      // Only a single read-only statement watches (#10830); anything the classifier cannot prove
      // read-only needs the device's holder and is refused with device_owned_by_other_session.
      deviceReadOnly: (args: SqlQueryArgs) =>
        typeof args.query === "string" && isReadOnlySqlQuery(args.query),
    },
  );
}

/**
 * Execute SQL using the platform-specific database bridge.
 */
async function executeSqlForDevice(device: BootedDevice, args: SqlQueryArgs): Promise<SQLResult> {
  if (device.platform === "android") {
    const adb = defaultAdbClientFactory.create(device);
    const inspector = new DatabaseInspector(device, adb);
    return inspector.executeSQL(args.appId, args.databasePath, args.query);
  }

  if (device.platform === "ios") {
    try {
      return await IOSCtrlProxyClient.getInstance(device).executeSQLForIos(
        args.appId,
        args.databasePath,
        args.query,
      );
    } catch (error) {
      throw new ActionableError(
        iosSqlErrorMessage(error, args.databasePath, {
          readOnlyQuery: isReadOnlySqlQuery(args.query),
        }),
        { cause: error },
      );
    }
  }

  throw new ActionableError(`Database inspection is not supported on ${device.platform} devices.`);
}
