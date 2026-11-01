import { raceWithDeadline } from "../../../utils/raceWithDeadline";
import type { SdkCapabilityQueryOptions } from "./CtrlProxySdkCapabilities";
/**
 * CtrlProxy iOS Database - Delegate for SQLite database inspection operations.
 *
 * Requests are relayed through CtrlProxy to the target app's in-app SDK server,
 * so SQLite access happens inside the app process.
 */

import { sendCommand } from "../DeviceServiceUtils";
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

/** One page of table rows; defaults to the first 50. */
export interface TablePage {
  limit?: number;
  offset?: number;
}

export interface StorageCapabilities {
  readOnly: boolean;
  mutationAuthorized: boolean;
  registeredAppGroupSuites: string[];
  coreDataStores: Array<{
    identifier: string;
    modelVersion?: string;
    entities: string[];
  }>;
  unavailableStores: string[];
  /** Keychain capability (#5161); absent from SDKs that predate it. See iosStorageDiscovery. */
  keychain?: unknown;
  /** App-group suite and Core Data store states (#5161); absent from older SDKs. */
  stores?: unknown;
}

interface StorageCapabilitiesResult extends DatabaseResultBase {
  capabilities?: StorageCapabilities;
}

interface ListTablesResult extends DatabaseResultBase {
  tables?: string[];
}

interface TableDataResponseResult extends DatabaseResultBase {
  columns?: string[];
  rows?: unknown[][];
  total?: number;
  diagnostic?: SQLResult["diagnostic"];
}

interface TableStructureResponseResult extends DatabaseResultBase {
  columns?: TableStructureResult["columns"];
  diagnostic?: SQLResult["diagnostic"];
}

/** Optional wire fields of `execute_sql`. `readOnly` is the host's read verdict, enforced by the SDK. */
interface ExecuteSqlOptions {
  sessionId?: string;
  mutationToken?: string;
  readOnly?: boolean;
}

export class CtrlProxyDatabase {
  constructor(private readonly context: DelegateContext) {}

  async queryCoreData(
    appId: string,
    store: string,
    entity: string,
    {
      limit,
      timeout = 5000,
    }: { limit?: number; timeout?: number | SdkCapabilityQueryOptions } = {},
  ): Promise<SQLResult> {
    const result = await this.request<ExecuteSqlResult>(
      "query_core_data",
      "execute_sql_result",
      { appId, store, entity, ...(limit === undefined ? {} : { limit }) },
      { timeout, operationName: "Query Core Data" },
    );
    return {
      type: "query",
      columns: result.columns ?? [],
      rows: result.rows ?? [],
      truncated: result.truncated,
    };
  }

  async executeSQL(
    appId: string,
    databasePath: string,
    query: string,
    {
      timeout = 5000,
      sessionId,
      mutationToken,
      readOnly,
    }: ExecuteSqlOptions & { timeout?: number | SdkCapabilityQueryOptions } = {},
  ): Promise<SQLResult> {
    const result = await this.request<ExecuteSqlResult>(
      "execute_sql",
      "execute_sql_result",
      {
        appId,
        databasePath,
        query,
        ...(sessionId ? { sessionId } : {}),
        ...(mutationToken ? { mutationToken } : {}),
        ...(readOnly ? { readOnly: true } : {}),
      },
      { timeout, operationName: "Execute SQL" },
    );

    return result.queryType === "mutation"
      ? {
          type: "mutation",
          rowsAffected: result.rowsAffected ?? 0,
          diagnostic: result.diagnostic,
          truncated: result.truncated,
        }
      : {
          type: "query",
          columns: result.columns ?? [],
          rows: result.rows ?? [],
          diagnostic: result.diagnostic,
          truncated: result.truncated,
        };
  }

  async listDatabases(
    appId: string,
    timeout: number | SdkCapabilityQueryOptions = 5000,
  ): Promise<DatabaseInfo[]> {
    const result = await this.request<ListDatabasesResult>(
      "list_databases",
      "list_databases_result",
      { appId },
      { timeout, operationName: "List databases" },
    );
    return result.databases ?? [];
  }

  async storageCapabilities(
    appId: string,
    timeout: number | SdkCapabilityQueryOptions = 5000,
  ): Promise<StorageCapabilities> {
    const result = await this.request<StorageCapabilitiesResult>(
      "storage_capabilities",
      "storage_capabilities_result",
      { appId },
      { timeout, operationName: "Get storage capabilities" },
    );
    return (
      result.capabilities ?? {
        readOnly: true,
        mutationAuthorized: false,
        registeredAppGroupSuites: [],
        coreDataStores: [],
        unavailableStores: [],
      }
    );
  }

  async listTables(
    appId: string,
    databasePath: string,
    timeout: number | SdkCapabilityQueryOptions = 5000,
  ): Promise<string[]> {
    const result = await this.request<ListTablesResult>(
      "list_tables",
      "list_tables_result",
      { appId, databasePath },
      { timeout, operationName: "List tables" },
    );
    return result.tables ?? [];
  }

  async getTableData(
    appId: string,
    databasePath: string,
    table: string,
    {
      limit = 50,
      offset = 0,
      timeout = 5000,
    }: TablePage & { timeout?: number | SdkCapabilityQueryOptions } = {},
  ): Promise<TableDataResult> {
    const result = await this.request<TableDataResponseResult>(
      "get_table_data",
      "table_data_result",
      { appId, databasePath, table, limit, offset },
      { timeout, operationName: "Get table data" },
    );
    return {
      columns: result.columns ?? [],
      rows: result.rows ?? [],
      total: result.total ?? 0,
      diagnostic: result.diagnostic,
    };
  }

  async getTableStructure(
    appId: string,
    databasePath: string,
    table: string,
    timeout: number | SdkCapabilityQueryOptions = 5000,
  ): Promise<TableStructureResult> {
    const result = await this.request<TableStructureResponseResult>(
      "get_table_structure",
      "table_structure_result",
      { appId, databasePath, table },
      { timeout, operationName: "Get table structure" },
    );
    return { columns: result.columns ?? [], diagnostic: result.diagnostic };
  }

  private async request<T extends DatabaseResultBase>(
    type: string,
    responseType: string,
    payload: Record<string, unknown>,
    {
      timeout,
      operationName,
    }: { timeout: number | SdkCapabilityQueryOptions; operationName: string },
  ): Promise<T> {
    const startTime = this.context.timer.now();
    // A bare timeout never attaches ambient cancellation: a dispatched database request
    // completes even if its caller is cancelled. Callers that gate on SDK capability pass
    // explicit options carrying the budget and signal they share with the gate.
    const options: SdkCapabilityQueryOptions =
      typeof timeout === "number" ? { deadlineMs: startTime + Math.max(0, timeout) } : timeout;
    const timeoutMs =
      options.deadlineMs === undefined ? 5000 : Math.max(0, options.deadlineMs - startTime);
    const requestId = this.context.requestManager.generateId(type);
    const promise = sendCommand<T>(this.context, {
      idPrefix: type,
      createRequestId: () => requestId,
      responseType,
      messageType: type,
      params: payload,
      timeoutMs,
      ...options,
      cancelScreenshotBackoff: false,
      notConnectedError: () => {
        options.abortSignal?.throwIfAborted();
        throw new Error("Failed to connect to CtrlProxy");
      },
      unsupportedCommandError: (_type, error) => {
        throw new Error(error);
      },
      timeoutError: () =>
        ({
          success: false,
          totalTimeMs: this.context.timer.now() - startTime,
          error: `${operationName} timeout after ${timeoutMs}ms`,
        }) as T,
    });
    logger.debug(`[CTRL_PROXY_IOS] Sent ${type} request (requestId: ${requestId})`);

    const result = await raceWithDeadline(promise, {
      timer: this.context.timer,
      timeoutMs,
      signal: options.abortSignal,
      label: operationName,
      timeoutError: () => new Error(`${operationName} timeout after ${timeoutMs}ms`),
      onTimeout: () =>
        this.context.requestManager.reject(
          requestId,
          new Error(`${operationName} timeout after ${timeoutMs}ms`),
        ),
    });
    if (!result.success) {
      throw new Error(result.error || `${operationName} failed`);
    }
    return result;
  }
}
