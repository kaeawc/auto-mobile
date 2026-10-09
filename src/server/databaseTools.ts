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

/**
 * Strip leading SQL comments and whitespace so keyword detection sees the first
 * significant token.
 *
 * Handles line comments (`-- ...` to end of line) and block comments
 * (`/* ... *\/`), including several stacked in sequence, e.g.
 * `-- note\n/* x *\/  DELETE FROM t`. Without this, a mutation whose text does
 * not literally start with the keyword is misclassified as a non-mutation.
 */
export function stripLeadingSqlNoise(query: string): string {
  let text = query.trimStart();

  for (;;) {
    if (text.startsWith("--")) {
      const newline = text.indexOf("\n");
      text = newline === -1 ? "" : text.slice(newline + 1);
    } else if (text.startsWith("/*")) {
      const end = text.indexOf("*/");
      text = end === -1 ? "" : text.slice(end + 2);
    } else {
      break;
    }
    text = text.trimStart();
  }

  return text;
}

/**
 * Approximate whether a query may mutate data before execution.
 *
 * This is not authoritative: SQLite's statement-readonly result determines
 * execution policy, and the SQLResult returned by the device determines cache
 * invalidation. Treat statements that are not clearly read-only as mutations,
 * consistent with the iOS SDK's sqlite3_stmt_readonly classification.
 */
export function isMutationQuery(query: string): boolean {
  const upperQuery = stripLeadingSqlNoise(query).toUpperCase();

  // Clearly read-only statements. PRAGMA can both read and write; assignment,
  // call-style arguments, and unknown forms are conservatively mutations.
  if (startsWithKeyword(upperQuery, "SELECT") || startsWithKeyword(upperQuery, "VALUES")) {
    return false;
  }
  if (startsWithKeyword(upperQuery, "PRAGMA")) {
    const pragmaBody = upperQuery.slice("PRAGMA".length).trim().replace(/;+$/, "").trim();
    const readOnlyPragmas = new Set([
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
    const pragmaName = /^(?:\w+\s*\.\s*)?(\w+)$/.exec(pragmaBody)?.[1];
    return pragmaName === undefined || !readOnlyPragmas.has(pragmaName);
  }

  // Direct mutations (including SQLite's REPLACE alias for INSERT OR REPLACE).
  if (
    ["INSERT", "REPLACE", "UPDATE", "DELETE", "ALTER", "DROP", "CREATE", "TRUNCATE"].some(
      (keyword) => startsWithKeyword(upperQuery, keyword),
    )
  ) {
    return true;
  }

  // CTE queries: recognize the terminal read; any other or unrecognized
  // statement is conservatively treated as a possible mutation.
  if (upperQuery.startsWith("WITH")) {
    const statementType = findStatementAfterCTE(upperQuery);
    return statementType !== "SELECT" && statementType !== "VALUES";
  }

  return true;
}

/**
 * Whether the query is one statement that cannot change data, so a request for it that got no answer
 * is safe to retry. Stricter than `!isMutationQuery`: any `;` before more text (a second statement, or
 * one hidden in a literal) counts as not read-only.
 */
export function isReadOnlySqlQuery(query: string): boolean {
  if (isMutationQuery(query)) {
    return false;
  }
  const withoutTrailingSemicolons = query.replace(/[\s;]+$/, "");
  return !withoutTrailingSemicolons.includes(";");
}

/**
 * Check if text starts with a keyword followed by a word boundary.
 * Prevents matching CTE names like "select_cte" as statement keywords.
 */
function startsWithKeyword(text: string, keyword: string): boolean {
  if (!text.startsWith(keyword)) {
    return false;
  }
  const nextChar = text[keyword.length];
  // Word boundary: next char is undefined (end of string) or not a word character
  return nextChar === undefined || !/\w/.test(nextChar);
}

/**
 * Find the actual statement type after CTE definitions.
 *
 * Parses past WITH ... AS (...) clauses to find SELECT/INSERT/UPDATE/DELETE.
 * Uses word boundary checks to avoid matching CTE names like "update_cte".
 */
function findStatementAfterCTE(upperQuery: string): string | null {
  let depth = 0;
  let i = 4; // Skip "WITH"

  while (i < upperQuery.length) {
    const char = upperQuery[i];

    if (char === "(") {
      depth++;
    } else if (char === ")") {
      depth--;
    } else if (depth === 0) {
      // Check for statement keywords at this position (with word boundary)
      const remaining = upperQuery.slice(i).trimStart();
      if (startsWithKeyword(remaining, "SELECT")) {
        return "SELECT";
      }
      if (startsWithKeyword(remaining, "INSERT")) {
        return "INSERT";
      }
      if (startsWithKeyword(remaining, "UPDATE")) {
        return "UPDATE";
      }
      if (startsWithKeyword(remaining, "DELETE")) {
        return "DELETE";
      }
    }
    i++;
  }

  return null;
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
