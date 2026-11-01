import { SdkCapabilityQueryError } from "../features/observe/ios/SdkCapabilityQueryError";
import { toActionableError } from "../models/ActionableError";
import { z } from "zod/v4";
import { ToolRegistry } from "./toolRegistry";
import { ActionableError, BootedDevice } from "../models";
import { addDeviceTargetingToSchema, withAppIdAliases } from "../utils/schemaHelpers";
import { createStructuredToolResponse } from "../utils/toolUtils";
import { sqlQueryResultSchema } from "./databaseToolOutputSchemas";
import { iosSqlErrorMessage } from "../utils/storageSdkErrors";
import { isNonOwnerReaderOfHeldDevice } from "./sdkProviderReadAccess";
import { DatabaseInspector } from "../features/database/DatabaseInspector";
import { defaultAdbClientFactory } from "../utils/android-cmdline-tools/AdbClientFactory";
import { notifyDatabaseChanged } from "./databaseResources";
import {
  defaultIosDatabaseClientResolver,
  type IosDatabaseClientResolver,
} from "./iosDatabaseClient";
import type { SQLResult } from "../features/database/DatabaseInspector";
import { resolveAndroidDatabasePath } from "../features/database/androidDatabasePath";
import { isReadOnlySqlQuery } from "../features/database/sqlQueryClassification";

// Schema for sqlQuery tool
const sqlQuerySchema = withAppIdAliases(
  addDeviceTargetingToSchema(
    z
      .object({
        appId: z.string(),
        databasePath: z
          .string()
          .describe(
            "Absolute path under the app data directory, or on Android a bare file name in the app databases directory",
          ),
        query: z.string().describe("SQL query"),
      })
      .strict(),
  ),
);

// Type interface for tool arguments
type SqlQueryArgs = z.output<typeof sqlQuerySchema>;

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
 * Register database tools.
 *
 * Only the sqlQuery tool is registered here. Read-only operations
 * (listDatabases, listTables, getTableData, getTableStructure) are
 * exposed as MCP resources instead.
 */
export function registerDatabaseTools(
  iosClient: IosDatabaseClientResolver = defaultIosDatabaseClientResolver,
) {
  // SQL Query handler
  const sqlQueryHandler = async (device: BootedDevice, args: SqlQueryArgs) => {
    try {
      const databasePath =
        device.platform === "android"
          ? resolveAndroidDatabasePath(args.appId, args.databasePath)
          : args.databasePath;
      const result = await executeSqlForDevice(device, { ...args, databasePath }, iosClient);

      // The executed result type is authoritative; SQL text classification is
      // only an approximation for decisions that must happen before execution.
      if (result.type === "mutation") {
        const affectedTables = extractAffectedTables(args.query);
        await notifyDatabaseChanged(
          device.deviceId,
          args.appId,
          databasePath,
          affectedTables.length > 0 ? affectedTables : undefined,
        );
      }

      const message =
        result.type === "query"
          ? `Query returned ${result.rows?.length ?? 0} row(s)`
          : `Mutation affected ${result.rowsAffected ?? 0} row(s)`;

      return createStructuredToolResponse({
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
    {
      handler: sqlQueryHandler,
      defaultEnabled: false,
      embeddedSdkOnly: true,
      outputSchema: sqlQueryResultSchema,
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
async function executeSqlForDevice(
  device: BootedDevice,
  args: SqlQueryArgs,
  iosClient: IosDatabaseClientResolver,
): Promise<SQLResult> {
  if (device.platform === "android") {
    const adb = defaultAdbClientFactory.create(device);
    const inspector = new DatabaseInspector(device, adb, undefined, () =>
      isNonOwnerReaderOfHeldDevice(device.deviceId),
    );
    // Defence in depth: when the host classifier calls the query a read, tell the SDK to enforce it
    // so a classifier gap can never become a write on the device (#10966).
    return inspector.executeSQL(
      args.appId,
      args.databasePath,
      args.query,
      isReadOnlySqlQuery(args.query),
    );
  }

  if (device.platform === "ios") {
    try {
      return await iosClient(device).executeSQLForIos(args.appId, args.databasePath, args.query, {
        readOnly: isReadOnlySqlQuery(args.query),
      });
    } catch (error) {
      if (error instanceof SdkCapabilityQueryError) {
        throw error;
      }
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
