import { ResourceRegistry, ResourceContent, getRequestedResourceUri } from "./resourceRegistry";
import { PlatformDeviceManagerFactory } from "../utils/factories/PlatformDeviceManagerFactory";
import {
  DatabaseInspector,
  DatabaseInfo,
  TableStructureResult,
} from "../features/database/DatabaseInspector";
import { defaultAdbClientFactory } from "../utils/android-cmdline-tools/AdbClientFactory";
import { BootedDevice } from "../models";
import { logger } from "../utils/logger";
import { IOSCtrlProxyClient } from "../features/observe/ios";
import type { TableDataResult } from "../features/database/DatabaseInspector";
import { optionalInteger } from "./queryParamValidation";

// Resource URI templates
const DATABASE_RESOURCE_TEMPLATES = {
  DATABASES: "automobile:devices/{deviceId}/databases?appId={appId}",
  TABLES: "automobile:devices/{deviceId}/databases/{databasePath}/tables?appId={appId}",
  // {?appId,limit,offset} is the RFC 6570 optional-query form: ResourceRegistry's
  // compileUriTemplate parses it via URLSearchParams, so appId/limit/offset each
  // match independently of presence or order (issue #6133). A literal
  // "?appId={appId}&limit={limit}&offset={offset}" query string compiles to
  // fixed-order, all-required captures instead and only matches when every
  // param appears, in that exact order.
  //
  // ResourceRegistry has no way to mark one of the template's query variables
  // required and the others optional, so `appId` matches the template even
  // when absent/empty (issue #6188) — getTableDataResource rejects a missing
  // or empty `appId` itself instead of forwarding it to the platform client.
  TABLE_DATA:
    "automobile:devices/{deviceId}/databases/{databasePath}/tables/{table}/data{?appId,limit,offset}",
  TABLE_STRUCTURE:
    "automobile:devices/{deviceId}/databases/{databasePath}/tables/{table}/structure?appId={appId}",
} as const;

// Path-captured and declared-query param names for the table-data template,
// used to reject any other (e.g. typo'd) query key instead of silently
// ignoring it (issue #6188) — matching the unknown-key validation in
// parsePerformanceParams/parseTrafficParams/parseAppsQueryParams.
const TABLE_DATA_PATH_PARAM_NAMES = new Set(["deviceId", "databasePath", "table"]);
const TABLE_DATA_QUERY_PARAM_NAMES = new Set(["appId", "limit", "offset"]);

// Android's DatabaseInspectorProvider.handleGetTableData parses limit/offset
// with Kotlin's `toIntOrNull()` (a 32-bit signed int), silently falling back
// to its own default when a value overflows Int32 — so a JS-safe-integer
// value like 2147483648 would report success with the wrong effective page
// instead of the value it claims. Bound both to the Int32 range up front.
const INT32_MAX = 2_147_483_647;

// Cache entries for change detection
interface DatabaseCacheEntry {
  databases: DatabaseInfo[];
  lastUpdated: string;
  hash: string;
}

interface TableSchemaCacheEntry {
  structure: TableStructureResult;
  lastUpdated: string;
  hash: string;
}

interface DatabaseCache {
  byApp: Map<string, DatabaseCacheEntry>; // key: `${deviceId}:${appId}`
  tableSchemas: Map<string, TableSchemaCacheEntry>; // key: `${deviceId}:${appId}:${dbPath}:${table}`
}

const cache: DatabaseCache = {
  byApp: new Map(),
  tableSchemas: new Map(),
};

/**
 * Generate a simple hash for change detection
 */
function generateHash(data: unknown): string {
  const str = JSON.stringify(data);
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash;
  }
  return hash.toString(16);
}

/**
 * Cross-platform interface for database inspection.
 */
interface AppDatabaseClient {
  listDatabases(appId: string): Promise<DatabaseInfo[]>;
  listTables(appId: string, databasePath: string): Promise<string[]>;
  getTableData(
    appId: string,
    databasePath: string,
    table: string,
    limit: number,
    offset: number,
  ): Promise<TableDataResult>;
  getTableStructure(
    appId: string,
    databasePath: string,
    table: string,
  ): Promise<TableStructureResult>;
}

/**
 * Find a booted Android or iOS device by ID.
 */
async function findBootedDevice(deviceId: string): Promise<BootedDevice | null> {
  const manager = PlatformDeviceManagerFactory.getInstance();
  const [androidDevices, iosDevices] = await Promise.all([
    getBootedDevicesSafely("android", () => manager.getBootedDevices("android")),
    getBootedDevicesSafely("ios", () => manager.getBootedDevices("ios")),
  ]);
  const devices = [...androidDevices, ...iosDevices];
  return devices.find((d) => d.deviceId === deviceId) ?? null;
}

async function getBootedDevicesSafely(
  platform: "android" | "ios",
  listDevices: () => Promise<BootedDevice[]>,
): Promise<BootedDevice[]> {
  try {
    return await listDevices();
  } catch (error) {
    logger.warn(`[DatabaseResources] Failed to list ${platform} devices: ${error}`);
    return [];
  }
}

function createDatabaseClient(device: BootedDevice): AppDatabaseClient {
  if (device.platform === "android") {
    const adb = defaultAdbClientFactory.create(device);
    return new DatabaseInspector(device, adb);
  }

  if (device.platform === "ios") {
    const client = IOSCtrlProxyClient.getInstance(device);
    return {
      listDatabases: async (appId) => client.listDatabasesForIos(appId),
      listTables: async (appId, databasePath) => client.listTablesForIos(appId, databasePath),
      getTableData: async (_appId, databasePath, table, limit, offset) =>
        client.getTableDataForIos(_appId, databasePath, table, limit, offset),
      getTableStructure: async (appId, databasePath, table) =>
        client.getTableStructureForIos(appId, databasePath, table),
    };
  }

  throw new Error(`Database inspection is not supported on ${device.platform} devices.`);
}

/**
 * Get cache key for database list
 */
function getDatabasesCacheKey(deviceId: string, appId: string): string {
  return `${deviceId}:${appId}`;
}

/**
 * Get cache key for table schema
 */
function getTableSchemaCacheKey(
  deviceId: string,
  appId: string,
  databasePath: string,
  table: string,
): string {
  return `${deviceId}:${appId}:${databasePath}:${table}`;
}

/**
 * Build resource URI for databases
 */
function buildDatabasesUri(deviceId: string, appId: string): string {
  return `automobile:devices/${deviceId}/databases?appId=${encodeURIComponent(appId)}`;
}

/**
 * Build resource URI for tables
 */
function buildTablesUri(deviceId: string, databasePath: string, appId: string): string {
  return `automobile:devices/${deviceId}/databases/${encodeURIComponent(databasePath)}/tables?appId=${encodeURIComponent(appId)}`;
}

/**
 * Build resource URI for table data
 */
function buildTableDataUri(
  deviceId: string,
  databasePath: string,
  table: string,
  appId: string,
): string {
  return `automobile:devices/${deviceId}/databases/${encodeURIComponent(databasePath)}/tables/${encodeURIComponent(table)}/data?appId=${encodeURIComponent(appId)}`;
}

/**
 * Build resource URI for table structure
 */
function buildTableStructureUri(
  deviceId: string,
  databasePath: string,
  table: string,
  appId: string,
): string {
  return `automobile:devices/${deviceId}/databases/${encodeURIComponent(databasePath)}/tables/${encodeURIComponent(table)}/structure?appId=${encodeURIComponent(appId)}`;
}

/**
 * Get databases resource content
 */
async function getDatabasesResource(params: Record<string, string>): Promise<ResourceContent> {
  const { deviceId, appId } = params;
  const uri = buildDatabasesUri(deviceId, appId);

  try {
    const device = await findBootedDevice(deviceId);
    if (!device) {
      return {
        uri,
        mimeType: "application/json",
        text: JSON.stringify({ error: `Device not found or not booted: ${deviceId}` }, null, 2),
      };
    }

    const inspector = createDatabaseClient(device);
    const databases = await inspector.listDatabases(appId);
    const lastUpdated = new Date().toISOString();
    const hash = generateHash(databases);

    // Check for changes and notify
    const cacheKey = getDatabasesCacheKey(deviceId, appId);
    const cached = cache.byApp.get(cacheKey);
    if (cached && cached.hash !== hash) {
      logger.info(`[DatabaseResources] Database list changed for ${appId} on ${deviceId}`);
      void ResourceRegistry.notifyResourceUpdated(uri);
    }

    // Update cache
    cache.byApp.set(cacheKey, { databases, lastUpdated, hash });

    return {
      uri,
      mimeType: "application/json",
      text: JSON.stringify(
        {
          deviceId,
          appId,
          databases,
          totalCount: databases.length,
          lastUpdated,
        },
        null,
        2,
      ),
    };
  } catch (error) {
    logger.error(`[DatabaseResources] Failed to list databases: ${error}`);
    return {
      uri,
      mimeType: "application/json",
      text: JSON.stringify({ error: `Failed to list databases: ${error}` }, null, 2),
    };
  }
}

/**
 * Get tables resource content
 */
async function getTablesResource(params: Record<string, string>): Promise<ResourceContent> {
  const { deviceId, databasePath, appId } = params;
  const decodedPath = decodeURIComponent(databasePath);
  const uri = buildTablesUri(deviceId, decodedPath, appId);

  try {
    const device = await findBootedDevice(deviceId);
    if (!device) {
      return {
        uri,
        mimeType: "application/json",
        text: JSON.stringify({ error: `Device not found or not booted: ${deviceId}` }, null, 2),
      };
    }

    const inspector = createDatabaseClient(device);
    const tables = await inspector.listTables(appId, decodedPath);
    const lastUpdated = new Date().toISOString();

    return {
      uri,
      mimeType: "application/json",
      text: JSON.stringify(
        {
          deviceId,
          appId,
          databasePath: decodedPath,
          tables,
          totalCount: tables.length,
          lastUpdated,
        },
        null,
        2,
      ),
    };
  } catch (error) {
    logger.error(`[DatabaseResources] Failed to list tables: ${error}`);
    return {
      uri,
      mimeType: "application/json",
      text: JSON.stringify({ error: `Failed to list tables: ${error}` }, null, 2),
    };
  }
}

/**
 * Get table data resource content
 */
async function getTableDataResource(params: Record<string, string>): Promise<ResourceContent> {
  const { deviceId, databasePath, table, appId } = params;
  const decodedPath = decodeURIComponent(databasePath);
  const decodedTable = decodeURIComponent(table);
  // Echo back the URI the client actually requested (limit/offset included)
  // rather than a canonical one without pagination — otherwise two different
  // pages come back labeled with the same URI, which a URI-keyed MCP client
  // would conflate (issue #6188). Falls back to the canonical form only if
  // this handler is ever invoked outside the registry's template-match path.
  const uri =
    getRequestedResourceUri(params) ??
    buildTableDataUri(deviceId, decodedPath, decodedTable, appId ?? "");

  try {
    // ResourceRegistry forwards any query key that isn't captured as a path
    // param, including a typo'd one (e.g. `limt=10`), rather than silently
    // dropping it — see extractTemplateParams (issue #6188). Reject one here
    // instead of silently falling back to defaults, matching the unknown-key
    // validation in parsePerformanceParams/parseTrafficParams/
    // parseAppsQueryParams.
    const unknownKeys = Object.keys(params).filter(
      (key) => !TABLE_DATA_PATH_PARAM_NAMES.has(key) && !TABLE_DATA_QUERY_PARAM_NAMES.has(key),
    );
    if (unknownKeys.length > 0) {
      throw new Error(`Unknown query parameters: ${unknownKeys.join(", ")}`);
    }

    // appId is a required identity for the target app/database, unlike
    // limit/offset — the `{?appId,limit,offset}` query-expansion form makes
    // every one of its variables optional at the template level, so the
    // handler must reject a missing or empty appId itself rather than
    // forwarding `undefined`/"" to the platform inspector (issue #6188).
    if (!appId) {
      throw new Error("Missing required appId query parameter for table data");
    }
    // Parse optional limit and offset from query params using the repo's
    // centralized query-validation helper (safe-integer + min-bound), rather
    // than a second hand-rolled parser (issue #6188). Absent/empty falls
    // back to the documented default (issue #6133). Bounded to Int32 max —
    // see the INT32_MAX comment above.
    const limit = optionalInteger(params.limit, "limit", { min: 0, max: INT32_MAX }) ?? 50;
    const offset = optionalInteger(params.offset, "offset", { min: 0, max: INT32_MAX }) ?? 0;

    const device = await findBootedDevice(deviceId);
    if (!device) {
      return {
        uri,
        mimeType: "application/json",
        text: JSON.stringify({ error: `Device not found or not booted: ${deviceId}` }, null, 2),
      };
    }

    const inspector = createDatabaseClient(device);
    const data = await inspector.getTableData(appId, decodedPath, decodedTable, limit, offset);
    const lastUpdated = new Date().toISOString();

    return {
      uri,
      mimeType: "application/json",
      text: JSON.stringify(
        {
          deviceId,
          appId,
          databasePath: decodedPath,
          table: decodedTable,
          columns: data.columns,
          rows: data.rows,
          total: data.total,
          limit,
          offset,
          lastUpdated,
        },
        null,
        2,
      ),
    };
  } catch (error) {
    logger.error(`[DatabaseResources] Failed to get table data: ${error}`);
    return {
      uri,
      mimeType: "application/json",
      text: JSON.stringify({ error: `Failed to get table data: ${error}` }, null, 2),
    };
  }
}

/**
 * Get table structure resource content
 */
async function getTableStructureResource(params: Record<string, string>): Promise<ResourceContent> {
  const { deviceId, databasePath, table, appId } = params;
  const decodedPath = decodeURIComponent(databasePath);
  const decodedTable = decodeURIComponent(table);
  const uri = buildTableStructureUri(deviceId, decodedPath, decodedTable, appId);

  try {
    const device = await findBootedDevice(deviceId);
    if (!device) {
      return {
        uri,
        mimeType: "application/json",
        text: JSON.stringify({ error: `Device not found or not booted: ${deviceId}` }, null, 2),
      };
    }

    const inspector = createDatabaseClient(device);
    const structure = await inspector.getTableStructure(appId, decodedPath, decodedTable);
    const lastUpdated = new Date().toISOString();
    const hash = generateHash(structure);

    // Check for schema changes and notify
    const cacheKey = getTableSchemaCacheKey(deviceId, appId, decodedPath, decodedTable);
    const cached = cache.tableSchemas.get(cacheKey);
    if (cached && cached.hash !== hash) {
      logger.info(`[DatabaseResources] Table schema changed for ${decodedTable} in ${decodedPath}`);
      void ResourceRegistry.notifyResourceUpdated(uri);
      // Also notify table data resource since schema changed
      void ResourceRegistry.notifyResourceUpdated(
        buildTableDataUri(deviceId, decodedPath, decodedTable, appId),
      );
    }

    // Update cache
    cache.tableSchemas.set(cacheKey, { structure, lastUpdated, hash });

    return {
      uri,
      mimeType: "application/json",
      text: JSON.stringify(
        {
          deviceId,
          appId,
          databasePath: decodedPath,
          table: decodedTable,
          columns: structure.columns,
          lastUpdated,
        },
        null,
        2,
      ),
    };
  } catch (error) {
    logger.error(`[DatabaseResources] Failed to get table structure: ${error}`);
    return {
      uri,
      mimeType: "application/json",
      text: JSON.stringify({ error: `Failed to get table structure: ${error}` }, null, 2),
    };
  }
}

/**
 * Notify that database data has changed (called after SQL mutations)
 */
export async function notifyDatabaseChanged(
  deviceId: string,
  appId: string,
  databasePath: string,
  affectedTables?: string[],
): Promise<void> {
  // Notify database list resource
  await ResourceRegistry.notifyResourceUpdated(buildDatabasesUri(deviceId, appId));

  // Notify tables resource
  await ResourceRegistry.notifyResourceUpdated(buildTablesUri(deviceId, databasePath, appId));

  // If we know which tables were affected, notify those specifically
  if (affectedTables && affectedTables.length > 0) {
    for (const table of affectedTables) {
      await ResourceRegistry.notifyResourceUpdated(
        buildTableDataUri(deviceId, databasePath, table, appId),
      );
      await ResourceRegistry.notifyResourceUpdated(
        buildTableStructureUri(deviceId, databasePath, table, appId),
      );
    }
  }

  // Invalidate relevant cache entries
  const cacheKey = getDatabasesCacheKey(deviceId, appId);
  cache.byApp.delete(cacheKey);

  // Clear table schema cache for this database
  for (const key of cache.tableSchemas.keys()) {
    if (key.startsWith(`${deviceId}:${appId}:${databasePath}:`)) {
      cache.tableSchemas.delete(key);
    }
  }
}

/**
 * Register database resources
 */
export function registerDatabaseResources(): void {
  // Register template for listing databases
  ResourceRegistry.registerTemplate(
    DATABASE_RESOURCE_TEMPLATES.DATABASES,
    "App Databases",
    "List all SQLite databases in an Android or iOS app. Requires app to have AutoMobile SDK with database inspection enabled; iOS support requires a DEBUG SDK server.",
    "application/json",
    getDatabasesResource,
  );

  // Register template for listing tables
  ResourceRegistry.registerTemplate(
    DATABASE_RESOURCE_TEMPLATES.TABLES,
    "Database Tables",
    "List all tables in a database.",
    "application/json",
    getTablesResource,
  );

  // Register template for table data. appId, limit, and offset are all
  // optional and order-independent (issue #6133) — see the template comment.
  ResourceRegistry.registerTemplate(
    DATABASE_RESOURCE_TEMPLATES.TABLE_DATA,
    "Table Data",
    "Get rows from a database table with pagination (default: 50 rows). Add &limit=N&offset=M for pagination.",
    "application/json",
    getTableDataResource,
  );

  // Register template for table structure
  ResourceRegistry.registerTemplate(
    DATABASE_RESOURCE_TEMPLATES.TABLE_STRUCTURE,
    "Table Structure",
    "Get column definitions for a database table.",
    "application/json",
    getTableStructureResource,
  );

  logger.info("[DatabaseResources] Registered database resources");
}
