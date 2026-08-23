import { ActionableError, BootedDevice } from "../../models";
import { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { logger } from "../../utils/logger";
import { shellQuote } from "../../utils/shellQuote";

/**
 * Database descriptor returned from listDatabases
 */
export interface DatabaseInfo {
  /** Display name of the database */
  name: string;
  /** Absolute path to the database file */
  path: string;
}

/**
 * Column metadata for table structure
 */
export interface ColumnInfo {
  /** Column name */
  name: string;
  /** Column type (TEXT, INTEGER, REAL, BLOB) */
  type: string;
  /** Whether column allows NULL */
  nullable: boolean;
  /** Whether column is primary key */
  primaryKey: boolean;
  /** Default value if any */
  defaultValue: string | null;
}

/**
 * Table structure result
 */
export interface TableStructureResult {
  columns: ColumnInfo[];
  diagnostic?: SQLResult["diagnostic"];
}

/**
 * Table data result with pagination
 */
export interface TableDataResult {
  /** Column names */
  columns: string[];
  /** Row data as array of column values */
  rows: any[][];
  /** Total number of rows in table */
  total: number;
  diagnostic?: SQLResult["diagnostic"];
}

/**
 * SQL execution result
 */
export interface SQLResult {
  type: "query" | "mutation";
  /** Column names (query only) */
  columns?: string[];
  /** Row data (query only) */
  rows?: any[][];
  /** Number of rows affected (mutation only) */
  rowsAffected?: number;
  diagnostic?: {
    code: string;
    message: string;
  };
  truncated?: boolean;
}

/**
 * Database inspection action for Android apps.
 *
 * Communicates with the AutoMobile SDK's DatabaseInspectorProvider via
 * `adb shell content call` commands.
 */
export class DatabaseInspector {
  /**
   * Keys the DatabaseInspectorProvider puts into the Bundle it returns from `call`
   * (android/auto-mobile-sdk/src/debug/kotlin/.../database/DatabaseInspectorProvider.kt).
   * Used to find entry boundaries when splitting the printed Bundle.
   */
  private static readonly BUNDLE_KEYS = ["success", "errorType", "error", "result"];

  constructor(
    private device: BootedDevice,
    private adb: AdbExecutor,
  ) {}

  /**
   * List all databases in an app
   */
  async listDatabases(appId: string): Promise<DatabaseInfo[]> {
    const response = await this.contentCall<{ databases: DatabaseInfo[] }>(appId, "listDatabases");
    return response.databases;
  }

  /**
   * List tables in a database
   */
  async listTables(appId: string, databasePath: string): Promise<string[]> {
    const response = await this.contentCall<{ tables: string[] }>(appId, "listTables", {
      databasePath,
    });
    return response.tables;
  }

  /**
   * Get table data with pagination
   */
  async getTableData(
    appId: string,
    databasePath: string,
    table: string,
    limit: number = 50,
    offset: number = 0,
  ): Promise<TableDataResult> {
    return this.contentCall<TableDataResult>(appId, "getTableData", {
      databasePath,
      table,
      limit: limit.toString(),
      offset: offset.toString(),
    });
  }

  /**
   * Get table structure (column definitions)
   */
  async getTableStructure(
    appId: string,
    databasePath: string,
    table: string,
  ): Promise<TableStructureResult> {
    return this.contentCall<TableStructureResult>(appId, "getTableStructure", {
      databasePath,
      table,
    });
  }

  /**
   * Execute a SQL query
   */
  async executeSQL(appId: string, databasePath: string, query: string): Promise<SQLResult> {
    return this.contentCall<SQLResult>(appId, "executeSQL", {
      databasePath,
      query,
    });
  }

  /**
   * Execute a content call to the DatabaseInspectorProvider
   */
  private async contentCall<T>(
    appId: string,
    method: string,
    extras?: Record<string, string>,
  ): Promise<T> {
    const uri = `content://${appId}.automobile.database`;
    let cmd = `shell content call --uri ${uri} --method ${method}`;

    if (extras) {
      for (const [key, value] of Object.entries(extras)) {
        cmd += ` --extra ${key}:s:${shellQuote(value)}`;
      }
    }

    const result = await this.adb.executeCommand(cmd);
    const output = [result.stdout, result.stderr]
      .filter((part) => part.trim().length > 0)
      .join("\n");
    return this.parseContentCallResult<T>(output);
  }

  /**
   * Parse the Bundle output from content call
   *
   * Format: Bundle[{success=true, result={"databases":[...]}}]
   */
  private parseContentCallResult<T>(output: string): T {
    // Check for success
    const success = this.extractBundleValue(output, "success") === "true";

    if (!success) {
      const { errorType, error } = this.extractError(output);
      throw new ActionableError(`Database error (${errorType}): ${error}`);
    }

    // Extract the JSON result by finding balanced braces/brackets
    const json = this.extractJsonFromBundle(output);
    if (!json) {
      throw new ActionableError("Failed to parse ContentProvider response: no result found");
    }

    try {
      return JSON.parse(json) as T;
    } catch {
      throw new ActionableError(`Failed to parse ContentProvider response: invalid JSON`);
    }
  }

  /**
   * Resolve the `errorType` / `error` of a failure reply.
   *
   * Newer SDK builds put the failure payload in a single JSON envelope under `result=`, exactly
   * as the success path does (see DatabaseInspectorProvider.kt). Because the values live inside a
   * JSON string they are escaped, so they can no longer collide with Bundle.toString()'s
   * delimiters (", ", "=", "}]") — the balanced-brace `extractJsonFromBundle` reads them back
   * intact even when a caller-controlled fragment such as `near "x, error=y": syntax` is echoed.
   *
   * Older SDK builds emit the flat form (`errorType=...`, `error=...` as raw Bundle entries).
   * Version skew is the normal state between releases, so when there is no parseable envelope we
   * fall back to reading the flat entries with {@link extractBundleValue}. If neither form is
   * present, the raw command output is retained so shell/provider failures remain actionable.
   */
  private extractError(output: string): { errorType: string; error: string } {
    const json = this.extractJsonFromBundle(output);
    if (json) {
      try {
        const parsed = JSON.parse(json) as { errorType?: unknown; error?: unknown };
        // Only accept it as the envelope if it actually carries a field. Otherwise this is an old
        // flat reply whose error text merely contains a parseable `result={...}` span: `indexOf`
        // latched onto that substring, JSON.parse succeeded, but the real flat values are elsewhere
        // — fall through so the flat reader below still finds them.
        if (typeof parsed.errorType === "string" || typeof parsed.error === "string") {
          return {
            errorType: typeof parsed.errorType === "string" ? parsed.errorType : "UNKNOWN",
            error: typeof parsed.error === "string" ? parsed.error : "Unknown error",
          };
        }
      } catch (error) {
        // Not a structured envelope (e.g. an old flat reply whose error text merely contains
        // a "result=" substring) — expected under version skew, so fall through to the flat form.
        logger.debug(`database error envelope was not valid JSON, using flat form: ${error}`);
      }
    }

    return {
      errorType: this.extractBundleValue(output, "errorType") || "UNKNOWN",
      error: this.extractBundleValue(output, "error") || output.trim() || "Unknown error",
    };
  }

  /**
   * Extract a single Bundle entry value from `content call` output.
   *
   * `adb shell content call` prints the returned Bundle with Bundle.toString(), i.e.
   * `Bundle[{key=value, key=value}]`: entries are joined by ", " and the map is closed by a
   * single trailing "}]". Values are raw, unescaped strings — a SQLite message routinely
   * contains spaces, commas and braces — so a value can only be terminated by the next
   * `, <knownKey>=` boundary or by the bundle's trailing "}]". Matching a value with a
   * character class such as `[^,}]+` silently truncates it at the first comma or brace.
   *
   * Bundle.toString() does not escape its values, so a value that itself contains a literal
   * `, <knownKey>=` sequence is indistinguishable from a real entry boundary and would still be
   * cut short. That ambiguity is in the wire format, not in this parser. Newer SDK builds remove
   * it at the producer by nesting the failure payload in a JSON envelope (see {@link extractError}
   * and DatabaseInspectorProvider.kt); this flat reader remains only as the version-skew fallback
   * for older SDK builds that still emit raw `errorType=` / `error=` entries.
   */
  private extractBundleValue(output: string, key: string): string | null {
    // A key always starts the bundle ("Bundle[{key=") or follows an entry separator.
    const keyPattern = new RegExp(`(?:^|[[{,]\\s*)${key}=`);
    const keyMatch = keyPattern.exec(output);
    if (!keyMatch) {
      return null;
    }

    const valueStart = keyMatch.index + keyMatch[0].length;
    const rest = output.slice(valueStart);

    // The value ends at the next known key boundary...
    const nextKeyPattern = new RegExp(`,\\s*(?:${DatabaseInspector.BUNDLE_KEYS.join("|")})=`);
    const nextKeyMatch = nextKeyPattern.exec(rest);
    let end = nextKeyMatch ? nextKeyMatch.index : rest.length;

    // ...or, when it is the last entry, at the bundle's trailing "}]".
    if (!nextKeyMatch) {
      const terminator = rest.lastIndexOf("}]");
      if (terminator !== -1) {
        end = terminator;
      }
    }

    const value = rest.slice(0, end).trim();
    return value.length > 0 ? value : null;
  }

  /**
   * Extract JSON value from Bundle output by finding balanced braces/brackets
   */
  private extractJsonFromBundle(output: string): string | null {
    const resultIndex = output.indexOf("result=");
    if (resultIndex === -1) {
      return null;
    }

    const startIndex = resultIndex + "result=".length;
    const startChar = output[startIndex];

    if (startChar !== "{" && startChar !== "[") {
      return null;
    }

    const endChar = startChar === "{" ? "}" : "]";
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = startIndex; i < output.length; i++) {
      const char = output[i];

      if (escaped) {
        escaped = false;
        continue;
      }

      if (char === "\\") {
        escaped = true;
        continue;
      }

      if (char === '"') {
        inString = !inString;
        continue;
      }

      if (inString) {
        continue;
      }

      if (char === startChar) {
        depth++;
      } else if (char === endChar) {
        depth--;
        if (depth === 0) {
          return output.slice(startIndex, i + 1);
        }
      }
    }

    return null;
  }
}
