import { z } from "zod";
import { ToolRegistry } from "./toolRegistry";
import { ActionableError, BootedDevice } from "../models";
import { addDeviceTargetingToSchema } from "./toolSchemaHelpers";
import { createJSONToolResponse } from "../utils/toolUtils";
import { DatabaseInspector } from "../features/database/DatabaseInspector";
import { AdbClient } from "../utils/android-cmdline-tools/AdbClient";

// Schema definitions

export const listDatabasesSchema = addDeviceTargetingToSchema(
  z.object({
    appId: z.string().describe("App package ID (e.g., com.example.app)")
  })
);

export const listTablesSchema = addDeviceTargetingToSchema(
  z.object({
    appId: z.string().describe("App package ID"),
    databasePath: z.string().describe("Absolute path to the database file")
  })
);

export const getTableDataSchema = addDeviceTargetingToSchema(
  z.object({
    appId: z.string().describe("App package ID"),
    databasePath: z.string().describe("Absolute path to the database file"),
    table: z.string().describe("Table name"),
    limit: z.number().optional().describe("Maximum number of rows to return (default: 50)"),
    offset: z.number().optional().describe("Row offset for pagination (default: 0)")
  })
);

export const getTableStructureSchema = addDeviceTargetingToSchema(
  z.object({
    appId: z.string().describe("App package ID"),
    databasePath: z.string().describe("Absolute path to the database file"),
    table: z.string().describe("Table name")
  })
);

export const executeSQLSchema = addDeviceTargetingToSchema(
  z.object({
    appId: z.string().describe("App package ID"),
    databasePath: z.string().describe("Absolute path to the database file"),
    query: z.string().describe("SQL query to execute (SELECT, INSERT, UPDATE, DELETE)")
  })
);

// Type interfaces for tool arguments

export interface ListDatabasesArgs {
  appId: string;
}

export interface ListTablesArgs {
  appId: string;
  databasePath: string;
}

export interface GetTableDataArgs {
  appId: string;
  databasePath: string;
  table: string;
  limit?: number;
  offset?: number;
}

export interface GetTableStructureArgs {
  appId: string;
  databasePath: string;
  table: string;
}

export interface ExecuteSQLArgs {
  appId: string;
  databasePath: string;
  query: string;
}

/**
 * Register database inspection tools.
 *
 * These tools allow inspection and manipulation of SQLite databases in Android apps
 * that have integrated the AutoMobile SDK with database inspection enabled.
 */
export function registerDatabaseTools() {
  // List databases handler
  const listDatabasesHandler = async (device: BootedDevice, args: ListDatabasesArgs) => {
    validateAndroidDevice(device);

    try {
      const adb = new AdbClient(device);
      const inspector = new DatabaseInspector(device, adb);
      const databases = await inspector.listDatabases(args.appId);

      return createJSONToolResponse({
        message: `Found ${databases.length} database(s) in ${args.appId}`,
        databases
      });
    } catch (error) {
      if (error instanceof ActionableError) {
        throw error;
      }
      throw new ActionableError(`Failed to list databases: ${error}`);
    }
  };

  // List tables handler
  const listTablesHandler = async (device: BootedDevice, args: ListTablesArgs) => {
    validateAndroidDevice(device);

    try {
      const adb = new AdbClient(device);
      const inspector = new DatabaseInspector(device, adb);
      const tables = await inspector.listTables(args.appId, args.databasePath);

      return createJSONToolResponse({
        message: `Found ${tables.length} table(s) in database`,
        tables
      });
    } catch (error) {
      if (error instanceof ActionableError) {
        throw error;
      }
      throw new ActionableError(`Failed to list tables: ${error}`);
    }
  };

  // Get table data handler
  const getTableDataHandler = async (device: BootedDevice, args: GetTableDataArgs) => {
    validateAndroidDevice(device);

    try {
      const adb = new AdbClient(device);
      const inspector = new DatabaseInspector(device, adb);
      const data = await inspector.getTableData(
        args.appId,
        args.databasePath,
        args.table,
        args.limit ?? 50,
        args.offset ?? 0
      );

      return createJSONToolResponse({
        message: `Retrieved ${data.rows.length} row(s) from ${args.table} (${data.total} total)`,
        ...data
      });
    } catch (error) {
      if (error instanceof ActionableError) {
        throw error;
      }
      throw new ActionableError(`Failed to get table data: ${error}`);
    }
  };

  // Get table structure handler
  const getTableStructureHandler = async (device: BootedDevice, args: GetTableStructureArgs) => {
    validateAndroidDevice(device);

    try {
      const adb = new AdbClient(device);
      const inspector = new DatabaseInspector(device, adb);
      const structure = await inspector.getTableStructure(
        args.appId,
        args.databasePath,
        args.table
      );

      return createJSONToolResponse({
        message: `Table ${args.table} has ${structure.columns.length} column(s)`,
        ...structure
      });
    } catch (error) {
      if (error instanceof ActionableError) {
        throw error;
      }
      throw new ActionableError(`Failed to get table structure: ${error}`);
    }
  };

  // Execute SQL handler
  const executeSQLHandler = async (device: BootedDevice, args: ExecuteSQLArgs) => {
    validateAndroidDevice(device);

    try {
      const adb = new AdbClient(device);
      const inspector = new DatabaseInspector(device, adb);
      const result = await inspector.executeSQL(
        args.appId,
        args.databasePath,
        args.query
      );

      const message =
        result.type === "query"
          ? `Query returned ${result.rows?.length ?? 0} row(s)`
          : `Mutation affected ${result.rowsAffected ?? 0} row(s)`;

      return createJSONToolResponse({
        message,
        ...result
      });
    } catch (error) {
      if (error instanceof ActionableError) {
        throw error;
      }
      throw new ActionableError(`Failed to execute SQL: ${error}`);
    }
  };

  // Register tools with the registry
  ToolRegistry.registerDeviceAware(
    "listDatabases",
    "List all SQLite databases in an Android app. Requires the app to have AutoMobile SDK integrated with database inspection enabled.",
    listDatabasesSchema,
    listDatabasesHandler
  );

  ToolRegistry.registerDeviceAware(
    "listTables",
    "List all tables in a database. Use listDatabases first to get the database path.",
    listTablesSchema,
    listTablesHandler
  );

  ToolRegistry.registerDeviceAware(
    "getTableData",
    "Get rows from a database table with pagination support. Returns column names, row data, and total count.",
    getTableDataSchema,
    getTableDataHandler
  );

  ToolRegistry.registerDeviceAware(
    "getTableStructure",
    "Get column definitions for a database table including name, type, nullable, primary key, and default value.",
    getTableStructureSchema,
    getTableStructureHandler
  );

  ToolRegistry.registerDeviceAware(
    "executeSQL",
    "Execute a SQL query on a database. Supports SELECT, INSERT, UPDATE, and DELETE statements.",
    executeSQLSchema,
    executeSQLHandler
  );
}

/**
 * Validate that the device is an Android device
 */
function validateAndroidDevice(device: BootedDevice): void {
  if (device.platform !== "android") {
    throw new ActionableError(
      "Database inspection is only supported on Android devices. " +
      "The app must have AutoMobile SDK integrated with database inspection enabled."
    );
  }
}
