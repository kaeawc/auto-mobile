/**
 * CtrlProxy iOS Database - Delegate for SQLite database inspection operations.
 *
 * Requests are relayed through CtrlProxy to the target app's in-app SDK server,
 * so SQLite access happens inside the app process.
 */

import { logger } from "../../../utils/logger";
import type {
  DatabaseInfo,
  SQLResult,
  TableDataResult,
  TableStructureResult,
} from "../../database/DatabaseInspector";
import type { DelegateContext } from "./types";

interface DatabaseResultBase {
  success: boolean;
  totalTimeMs: number;
  error?: string;
}

interface ExecuteSqlResult extends DatabaseResultBase {
  queryType?: "query" | "mutation";
  columns?: string[];
  rows?: unknown[][];
  rowsAffected?: number;
  diagnostic?: SQLResult["diagnostic"];
  truncated?: boolean;
}

interface ListDatabasesResult extends DatabaseResultBase {
  databases?: DatabaseInfo[];
}

interface ListTablesResult extends DatabaseResultBase {
  tables?: string[];
}

interface TableDataResponseResult extends DatabaseResultBase {
  columns?: string[];
  rows?: unknown[][];
  total?: number;
}

interface TableStructureResponseResult extends DatabaseResultBase {
  columns?: TableStructureResult["columns"];
}

export class CtrlProxyDatabase {
  constructor(private readonly context: DelegateContext) {}

  async executeSQL(appId: string, databasePath: string, query: string, timeoutMs: number = 5000): Promise<SQLResult> {
    const result = await this.request<ExecuteSqlResult>(
      "execute_sql",
      "execute_sql_result",
      { appId, databasePath, query },
      timeoutMs,
      "Execute SQL"
    );

    return result.queryType === "mutation"
      ? { type: "mutation", rowsAffected: result.rowsAffected ?? 0, diagnostic: result.diagnostic, truncated: result.truncated }
      : {
        type: "query",
        columns: result.columns ?? [],
        rows: result.rows ?? [],
        diagnostic: result.diagnostic,
        truncated: result.truncated,
      };
  }

  async listDatabases(appId: string, timeoutMs: number = 5000): Promise<DatabaseInfo[]> {
    const result = await this.request<ListDatabasesResult>(
      "list_databases",
      "list_databases_result",
      { appId },
      timeoutMs,
      "List databases"
    );
    return result.databases ?? [];
  }

  async listTables(appId: string, databasePath: string, timeoutMs: number = 5000): Promise<string[]> {
    const result = await this.request<ListTablesResult>(
      "list_tables",
      "list_tables_result",
      { appId, databasePath },
      timeoutMs,
      "List tables"
    );
    return result.tables ?? [];
  }

  async getTableData(
    appId: string,
    databasePath: string,
    table: string,
    limit: number = 50,
    offset: number = 0,
    timeoutMs: number = 5000
  ): Promise<TableDataResult> {
    const result = await this.request<TableDataResponseResult>(
      "get_table_data",
      "table_data_result",
      { appId, databasePath, table, limit, offset },
      timeoutMs,
      "Get table data"
    );
    return {
      columns: result.columns ?? [],
      rows: result.rows ?? [],
      total: result.total ?? 0,
    };
  }

  async getTableStructure(
    appId: string,
    databasePath: string,
    table: string,
    timeoutMs: number = 5000
  ): Promise<TableStructureResult> {
    const result = await this.request<TableStructureResponseResult>(
      "get_table_structure",
      "table_structure_result",
      { appId, databasePath, table },
      timeoutMs,
      "Get table structure"
    );
    return { columns: result.columns ?? [] };
  }

  private async request<T extends DatabaseResultBase>(
    type: string,
    responseType: string,
    payload: Record<string, unknown>,
    timeoutMs: number,
    operationName: string
  ): Promise<T> {
    const startTime = this.context.timer.now();

    if (!await this.context.ensureConnected()) {
      throw new Error("Failed to connect to CtrlProxy");
    }

    const requestId = this.context.requestManager.generateId(type);
    const promise = this.context.requestManager.register<T>(
      requestId,
      responseType,
      timeoutMs,
      (_id, _type, _timeout) => ({
        success: false,
        totalTimeMs: this.context.timer.now() - startTime,
        error: `${operationName} timeout after ${timeoutMs}ms`,
      } as T)
    );

    this.context.getWebSocket()?.send(JSON.stringify({
      type,
      requestId,
      ...payload,
    }));
    logger.debug(`[CTRL_PROXY_IOS] Sent ${type} request (requestId: ${requestId})`);

    const result = await promise;
    if (!result.success) {
      throw new Error(result.error || `${operationName} failed`);
    }
    return result;
  }
}
