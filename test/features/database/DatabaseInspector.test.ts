import { expect, describe, test, beforeEach } from "bun:test";
import { DatabaseInspector } from "../../../src/features/database/DatabaseInspector";
import type { BootedDevice } from "../../../src/models";
import { shellQuote } from "../../../src/utils/shellQuote";
import { FakeAdbClient } from "../../fakes/FakeAdbClient";
import { ActionableError } from "../../../src/models";

describe("DatabaseInspector", () => {
  const device: BootedDevice = {
    deviceId: "emulator-5554",
    name: "Test Device",
    platform: "android",
  };

  const appId = "com.example.app";
  const databasePath = "/data/data/com.example.app/databases/app.db";

  let fakeAdb: FakeAdbClient;
  let inspector: DatabaseInspector;

  beforeEach(() => {
    fakeAdb = new FakeAdbClient();
    inspector = new DatabaseInspector(device, fakeAdb);
  });

  describe("listDatabases", () => {
    test("parses database list from ContentProvider response", async () => {
      const response = `Bundle[{success=true, result={"databases":[{"name":"app.db","path":"/data/data/com.example.app/databases/app.db"},{"name":"cache.db","path":"/data/data/com.example.app/databases/cache.db"}]}}]`;

      fakeAdb.setCommandResult(
        `shell content call --uri content://${appId}.automobile.database --method listDatabases`,
        response,
      );

      const databases = await inspector.listDatabases(appId);

      expect(databases).toHaveLength(2);
      expect(databases[0].name).toBe("app.db");
      expect(databases[0].path).toBe("/data/data/com.example.app/databases/app.db");
      expect(databases[1].name).toBe("cache.db");
    });

    test("returns empty list when no databases exist", async () => {
      const response = `Bundle[{success=true, result={"databases":[]}}]`;

      fakeAdb.setCommandResult(
        `shell content call --uri content://${appId}.automobile.database --method listDatabases`,
        response,
      );

      const databases = await inspector.listDatabases(appId);

      expect(databases).toHaveLength(0);
    });

    test("throws ActionableError when inspection is disabled", async () => {
      const response = `Bundle[{success=false, errorType=DISABLED, error=Database inspection is disabled}]`;

      fakeAdb.setCommandResult(
        `shell content call --uri content://${appId}.automobile.database --method listDatabases`,
        response,
      );

      await expect(inspector.listDatabases(appId)).rejects.toThrow(ActionableError);
      await expect(inspector.listDatabases(appId)).rejects.toThrow("DISABLED");
    });
  });

  describe("listTables", () => {
    test("parses table list from ContentProvider response", async () => {
      const response = `Bundle[{success=true, result={"tables":["users","orders","products"]}}]`;

      fakeAdb.setCommandResult(
        `shell content call --uri content://${appId}.automobile.database --method listTables --extra databasePath:s:'${databasePath}'`,
        response,
      );

      const tables = await inspector.listTables(appId, databasePath);

      expect(tables).toEqual(["users", "orders", "products"]);
    });

    test("throws error when database not found", async () => {
      const response = `Bundle[{success=false, errorType=NotFound, error=Database not found: /invalid/path}]`;

      fakeAdb.setCommandResult(
        `shell content call --uri content://${appId}.automobile.database --method listTables --extra databasePath:s:'/invalid/path'`,
        response,
      );

      await expect(inspector.listTables(appId, "/invalid/path")).rejects.toThrow("NotFound");
    });
  });

  describe("getTableData", () => {
    test("parses table data with pagination", async () => {
      const response = `Bundle[{success=true, result={"columns":["id","name","email"],"rows":[[1,"Alice","alice@example.com"],[2,"Bob","bob@example.com"]],"total":100}}]`;

      fakeAdb.setCommandResult(
        `shell content call --uri content://${appId}.automobile.database --method getTableData --extra databasePath:s:'${databasePath}' --extra table:s:'users' --extra limit:s:'50' --extra offset:s:'0'`,
        response,
      );

      const data = await inspector.getTableData(appId, databasePath, "users");

      expect(data.columns).toEqual(["id", "name", "email"]);
      expect(data.rows).toHaveLength(2);
      expect(data.rows[0]).toEqual([1, "Alice", "alice@example.com"]);
      expect(data.total).toBe(100);
    });

    test("respects custom limit and offset", async () => {
      const response = `Bundle[{success=true, result={"columns":["id"],"rows":[[51],[52],[53]],"total":100}}]`;

      fakeAdb.setCommandResult(
        `shell content call --uri content://${appId}.automobile.database --method getTableData --extra databasePath:s:'${databasePath}' --extra table:s:'users' --extra limit:s:'10' --extra offset:s:'50'`,
        response,
      );

      const data = await inspector.getTableData(appId, databasePath, "users", 10, 50);

      expect(data.rows).toHaveLength(3);
      expect(fakeAdb.wasCommandExecuted("limit:s:'10'")).toBe(true);
      expect(fakeAdb.wasCommandExecuted("offset:s:'50'")).toBe(true);
    });

    test("handles null values in rows", async () => {
      const response = `Bundle[{success=true, result={"columns":["id","name"],"rows":[[1,null],[2,"Bob"]],"total":2}}]`;

      fakeAdb.setCommandResult(
        `shell content call --uri content://${appId}.automobile.database --method getTableData --extra databasePath:s:'${databasePath}' --extra table:s:'users' --extra limit:s:'50' --extra offset:s:'0'`,
        response,
      );

      const data = await inspector.getTableData(appId, databasePath, "users");

      expect(data.rows[0][1]).toBeNull();
      expect(data.rows[1][1]).toBe("Bob");
    });
  });

  describe("getTableStructure", () => {
    test("parses column definitions", async () => {
      const response = `Bundle[{success=true, result={"columns":[{"name":"id","type":"INTEGER","nullable":false,"primaryKey":true,"defaultValue":null},{"name":"name","type":"TEXT","nullable":true,"primaryKey":false,"defaultValue":"'Unknown'"}]}}]`;

      fakeAdb.setCommandResult(
        `shell content call --uri content://${appId}.automobile.database --method getTableStructure --extra databasePath:s:'${databasePath}' --extra table:s:'users'`,
        response,
      );

      const structure = await inspector.getTableStructure(appId, databasePath, "users");

      expect(structure.columns).toHaveLength(2);
      expect(structure.columns[0]).toEqual({
        name: "id",
        type: "INTEGER",
        nullable: false,
        primaryKey: true,
        defaultValue: null,
      });
      expect(structure.columns[1].name).toBe("name");
      expect(structure.columns[1].defaultValue).toBe("'Unknown'");
    });
  });

  describe("executeSQL", () => {
    test("executes SELECT query and returns results", async () => {
      const response = `Bundle[{success=true, result={"type":"query","columns":["id","name"],"rows":[[1,"Alice"],[2,"Bob"]]}}]`;

      fakeAdb.setCommandResult(
        `shell content call --uri content://${appId}.automobile.database --method executeSQL --extra databasePath:s:'${databasePath}' --extra query:s:'SELECT * FROM users'`,
        response,
      );

      const result = await inspector.executeSQL(appId, databasePath, "SELECT * FROM users");

      expect(result.type).toBe("query");
      expect(result.columns).toEqual(["id", "name"]);
      expect(result.rows).toHaveLength(2);
    });

    test("executes INSERT and returns rows affected", async () => {
      const response = `Bundle[{success=true, result={"type":"mutation","rowsAffected":1}}]`;

      fakeAdb.setCommandResult(
        `shell content call --uri content://${appId}.automobile.database --method executeSQL --extra databasePath:s:${shellQuote(databasePath)} --extra query:s:${shellQuote("INSERT INTO users (name) VALUES ('Alice')")}`,
        response,
      );

      const result = await inspector.executeSQL(
        appId,
        databasePath,
        "INSERT INTO users (name) VALUES ('Alice')",
      );

      expect(result.type).toBe("mutation");
      expect(result.rowsAffected).toBe(1);
    });

    test("throws error on SQL syntax error", async () => {
      const response = `Bundle[{success=false, errorType=SqlError, error=SQL error: near "SELEC": syntax error}]`;

      fakeAdb.setCommandResult(
        `shell content call --uri content://${appId}.automobile.database --method executeSQL --extra databasePath:s:'${databasePath}' --extra query:s:'SELEC * FROM users'`,
        response,
      );

      await expect(inspector.executeSQL(appId, databasePath, "SELEC * FROM users")).rejects.toThrow(
        "SqlError",
      );
    });
  });

  describe("error envelope parsing", () => {
    // Wire contract, established from the producer
    // (android/auto-mobile-sdk/src/debug/kotlin/.../DatabaseInspectorProvider.kt): the
    // provider fills a Bundle with the string keys `success`, `errorType`, `error` (and
    // `result` on success). `adb shell content call` prints it with Bundle.toString(),
    // i.e. `Bundle[{key=value, key=value}]` — entries joined by ", " and the whole map
    // closed by a single trailing "}]". Values are raw, unescaped strings, so an entry's
    // value may itself contain spaces, commas and closing braces. The only reliable
    // terminators for a value are the next `, <knownKey>=` boundary or the bundle's
    // trailing "}]".
    const errorFor = async (response: string): Promise<string> => {
      fakeAdb.setCommandResult(
        `shell content call --uri content://${appId}.automobile.database --method listDatabases`,
        response,
      );
      try {
        await inspector.listDatabases(appId);
      } catch (error) {
        return (error as Error).message;
      }
      throw new Error("expected listDatabases to reject");
    };

    test("preserves a multi-word errorType", async () => {
      const message = await errorFor(
        `Bundle[{success=false, errorType=SQL Error, error=Database inspection is disabled}]`,
      );

      expect(message).toBe("Database error (SQL Error): Database inspection is disabled");
    });

    test("preserves error text containing commas", async () => {
      const message = await errorFor(
        `Bundle[{success=false, errorType=SQLiteException, error=no such column: foo, bar}]`,
      );

      expect(message).toBe("Database error (SQLiteException): no such column: foo, bar");
    });

    test("preserves error text containing a closing brace", async () => {
      const message = await errorFor(
        `Bundle[{success=false, errorType=SQLiteException, error=near "}": syntax error (code 1)}]`,
      );

      expect(message).toBe(`Database error (SQLiteException): near "}": syntax error (code 1)`);
    });

    test("preserves error text when errorType follows error in the bundle", async () => {
      const message = await errorFor(
        `Bundle[{success=false, error=no such table: users, orders, errorType=SQLiteException}]`,
      );

      expect(message).toBe("Database error (SQLiteException): no such table: users, orders");
    });

    test("single-word errorType and comma-free error text are unchanged", async () => {
      const message = await errorFor(
        `Bundle[{success=false, errorType=DISABLED, error=Database inspection is disabled}]`,
      );

      expect(message).toBe("Database error (DISABLED): Database inspection is disabled");
    });

    test("includes raw output when the keys are absent", async () => {
      const message = await errorFor(`Bundle[{success=false}]`);

      expect(message).toBe("Database error (UNKNOWN): Bundle[{success=false}]");
    });

    test("keeps flat values when an old reply's error text embeds a parseable result={}", async () => {
      // Version skew: an old flat-form SDK whose SQLite message happens to echo a `result={...}`
      // span. The envelope reader latches onto that substring and parses it, but it carries no
      // errorType/error field, so the real flat values must still win.
      const message = await errorFor(
        `Bundle[{success=false, errorType=SQLiteException, error=near result={"a":1} bad}]`,
      );

      expect(message).toBe(`Database error (SQLiteException): near result={"a":1} bad`);
    });
  });

  describe("structured error envelope (SDK wire format)", () => {
    // Newer SDK builds put the failure payload in a single JSON envelope under `result=`,
    // exactly as the success path does, so `errorType`/`error` values are JSON-escaped and
    // can no longer collide with Bundle.toString() delimiters (", ", "=", "}]"). The TS side
    // reads this with the balanced-brace `extractJsonFromBundle`, and falls back to the flat
    // form for older SDK builds still in the field (see "error envelope parsing" above).
    const errorFor = async (response: string): Promise<string> => {
      fakeAdb.setCommandResult(
        `shell content call --uri content://${appId}.automobile.database --method listDatabases`,
        response,
      );
      try {
        await inspector.listDatabases(appId);
      } catch (error) {
        return (error as Error).message;
      }
      throw new Error("expected listDatabases to reject");
    };

    test("round-trips a caller-controlled fragment that mimics a delimiter", async () => {
      // The value contains a literal `, error=` sequence; the flat parser cuts it short, the
      // envelope carries it verbatim because it is inside a JSON string.
      const message = await errorFor(
        `Bundle[{success=false, result={"errorType":"SQLiteException","error":"near \\"x, error=y\\": syntax"}}]`,
      );

      expect(message).toBe(`Database error (SQLiteException): near "x, error=y": syntax`);
    });

    test("round-trips values containing every Bundle delimiter", async () => {
      const message = await errorFor(
        `Bundle[{success=false, result={"errorType":"SQL, errorType=Error}]","error":"no such column: foo, bar}] errorType=x"}}]`,
      );

      expect(message).toBe(
        `Database error (SQL, errorType=Error}]): no such column: foo, bar}] errorType=x`,
      );
    });

    test("reads the envelope regardless of Bundle entry order", async () => {
      // Bundle is backed by a hash-ordered ArrayMap, so `result` may print before `success`.
      const message = await errorFor(
        `Bundle[{result={"errorType":"SQLiteException","error":"disk I/O error"}, success=false}]`,
      );

      expect(message).toBe("Database error (SQLiteException): disk I/O error");
    });

    test("includes the raw bundle when the envelope omits the fields", async () => {
      const message = await errorFor(`Bundle[{success=false, result={}}]`);

      expect(message).toBe("Database error (UNKNOWN): Bundle[{success=false, result={}}]");
    });
  });

  describe("raw command output diagnostics", () => {
    const command = `shell content call --uri content://${appId}.automobile.database --method listDatabases`;

    const errorFor = async (stdout: string, stderr = ""): Promise<string> => {
      fakeAdb.setCommandResult(command, stdout, stderr);
      try {
        await inspector.listDatabases(appId);
      } catch (error) {
        return (error as Error).message;
      }
      throw new Error("expected listDatabases to reject");
    };

    test("includes raw stdout when content call returns an unstructured error", async () => {
      const message = await errorFor(
        "java.lang.SecurityException: Permission Denial: opening provider that is not exported",
      );

      expect(message).toBe(
        "Database error (UNKNOWN): java.lang.SecurityException: Permission Denial: opening provider that is not exported",
      );
    });

    test("includes raw stderr when content call writes an unstructured error there", async () => {
      const message = await errorFor(
        "",
        "java.lang.SecurityException: Do not have permission in call getContentProviderExternal()",
      );

      expect(message).toBe(
        "Database error (UNKNOWN): java.lang.SecurityException: Do not have permission in call getContentProviderExternal()",
      );
    });

    test("preserves both stdout and stderr when content call writes to both", async () => {
      const message = await errorFor("stdout failure", "stderr failure");

      expect(message).toBe("Database error (UNKNOWN): stdout failure\nstderr failure");
    });
  });

  describe("error handling", () => {
    test("throws ActionableError when ContentProvider not found", async () => {
      // Simulate when the app doesn't have the SDK or provider
      const response = `Error: Unable to find provider info for content://com.example.app.automobile.database`;

      fakeAdb.setCommandResult(
        `shell content call --uri content://${appId}.automobile.database --method listDatabases`,
        response,
      );

      await expect(inspector.listDatabases(appId)).rejects.toThrow(ActionableError);
    });

    test("throws ActionableError when result JSON is malformed", async () => {
      const response = `Bundle[{success=true, result={invalid json}}]`;

      fakeAdb.setCommandResult(
        `shell content call --uri content://${appId}.automobile.database --method listDatabases`,
        response,
      );

      await expect(inspector.listDatabases(appId)).rejects.toThrow("invalid JSON");
    });
  });

  describe("shell escaping", () => {
    test("escapes single quotes in database path", async () => {
      const pathWithQuote = "/data/data/com.example.app/databases/user's.db";
      const response = `Bundle[{success=true, result={"tables":["test"]}}]`;

      // The path should have escaped quotes
      fakeAdb.setCommandResult(
        `shell content call --uri content://${appId}.automobile.database --method listTables --extra databasePath:s:${shellQuote(pathWithQuote)}`,
        response,
      );

      const tables = await inspector.listTables(appId, pathWithQuote);

      expect(tables).toEqual(["test"]);
    });
  });
});
