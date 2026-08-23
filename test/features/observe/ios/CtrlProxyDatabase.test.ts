import { beforeEach, describe, expect, test } from "bun:test";
import { IOSCtrlProxyClient } from "../../../../src/features/observe/ios";
import type { BootedDevice } from "../../../../src/models";
import { FakeWebSocket, WebSocketState } from "../../../fakes/FakeWebSocket";
import { FakeTimer } from "../../../fakes/FakeTimer";

describe("CtrlProxyDatabase (iOS)", function () {
  let testDevice: BootedDevice;
  let fakeTimer: FakeTimer;
  const serverPort = 8765;

  beforeEach(function () {
    fakeTimer = new FakeTimer();
    fakeTimer.enableAutoAdvance();
    testDevice = {
      deviceId: "A1B2C3D4-E5F6-7890-ABCD-EF1234567890",
      platform: "ios",
      name: "iPhone 16 Simulator",
    };
    IOSCtrlProxyClient.resetInstances();
  });

  class CapturingWebSocket extends FakeWebSocket {
    sentMessages: string[] = [];

    send(data: unknown): void {
      this.sentMessages.push(String(data));
      super.send(data);
    }
  }

  const createCapturingFactory = (): {
    factory: (url: string) => CapturingWebSocket;
    getSocket: () => CapturingWebSocket | null;
  } => {
    let socket: CapturingWebSocket | null = null;
    return {
      factory: (url: string) => {
        socket = new CapturingWebSocket(url, "none", 0, fakeTimer);
        return socket;
      },
      getSocket: () => socket,
    };
  };

  const waitForSocketOpen = async (socket: FakeWebSocket | null): Promise<void> => {
    if (!socket || socket.readyState === WebSocketState.OPEN) {
      return;
    }
    await new Promise<void>((resolve) => socket.once("open", () => resolve()));
  };

  const waitForSocket = async (
    getSocket: () => CapturingWebSocket | null,
  ): Promise<CapturingWebSocket | null> => {
    for (let i = 0; i < 5; i += 1) {
      const socket = getSocket();
      if (socket) {
        return socket;
      }
      await new Promise((resolve) => setImmediate(resolve));
    }
    return getSocket();
  };

  const waitForSentMessages = async (
    socket: CapturingWebSocket | null,
    minCount = 1,
  ): Promise<void> => {
    if (!socket) {
      return;
    }
    for (let i = 0; i < 10; i += 1) {
      if (commandPayloads(socket).length >= minCount) {
        return;
      }
      await new Promise((resolve) => setImmediate(resolve));
    }
  };

  const syncMessageTypes = new Set([
    "set_hierarchy_poll_interval",
    "set_network_mock_rules",
    "set_network_error_simulation",
  ]);

  const commandPayloads = (socket: CapturingWebSocket): any[] =>
    socket.sentMessages
      .map((message) => JSON.parse(message))
      .filter((payload) => !syncMessageTypes.has(payload.type));

  test("executeSQLForIos sends execute_sql and returns query rows including blob strings", async function () {
    const { factory, getSocket } = createCapturingFactory();
    const client = IOSCtrlProxyClient.createForTesting(testDevice, serverPort, factory, fakeTimer);

    try {
      const resultPromise = client.executeSQLForIos(
        "com.example.app",
        "/app/Documents/app.db",
        "SELECT id, payload FROM notes",
      );
      const socket = await waitForSocket(getSocket);
      await waitForSocketOpen(socket);
      await waitForSentMessages(socket);

      const sentMessage = commandPayloads(socket!)[0];
      expect(sentMessage.type).toBe("execute_sql");
      expect(sentMessage.appId).toBe("com.example.app");
      expect(sentMessage.databasePath).toBe("/app/Documents/app.db");
      expect(sentMessage.query).toBe("SELECT id, payload FROM notes");

      socket!.simulateMessage(
        JSON.stringify({
          type: "execute_sql_result",
          requestId: sentMessage.requestId,
          success: true,
          queryType: "query",
          columns: ["id", "payload"],
          rows: [["1", "0xCAFE"]],
          rowsAffected: 0,
          totalTimeMs: 4,
        }),
      );

      await expect(resultPromise).resolves.toEqual({
        type: "query",
        columns: ["id", "payload"],
        rows: [["1", "0xCAFE"]],
      });
    } finally {
      await client.close();
    }
  });

  test("executeSQLForIos returns mutation rowsAffected", async function () {
    const { factory, getSocket } = createCapturingFactory();
    const client = IOSCtrlProxyClient.createForTesting(testDevice, serverPort, factory, fakeTimer);

    try {
      const resultPromise = client.executeSQLForIos(
        "com.example.app",
        "/app/Documents/app.db",
        "UPDATE notes SET title = 'x'",
      );
      const socket = await waitForSocket(getSocket);
      await waitForSocketOpen(socket);
      await waitForSentMessages(socket);
      const sentMessage = commandPayloads(socket!)[0];

      socket!.simulateMessage(
        JSON.stringify({
          type: "execute_sql_result",
          requestId: sentMessage.requestId,
          success: true,
          queryType: "mutation",
          rowsAffected: 2,
          totalTimeMs: 5,
        }),
      );

      await expect(resultPromise).resolves.toEqual({
        type: "mutation",
        rowsAffected: 2,
      });
    } finally {
      await client.close();
    }
  });

  test("executeSQLForIos surfaces disabled SDK errors without timing out", async function () {
    const { factory, getSocket } = createCapturingFactory();
    const client = IOSCtrlProxyClient.createForTesting(testDevice, serverPort, factory, fakeTimer);

    try {
      const resultPromise = client.executeSQLForIos(
        "com.example.app",
        "/app/Documents/app.db",
        "SELECT 1",
      );
      const socket = await waitForSocket(getSocket);
      await waitForSocketOpen(socket);
      await waitForSentMessages(socket);
      const sentMessage = commandPayloads(socket!)[0];

      socket!.simulateMessage(
        JSON.stringify({
          type: "execute_sql_result",
          requestId: sentMessage.requestId,
          success: false,
          error:
            "database inspection unavailable - embed the AutoMobile SDK and call DatabaseInspector.shared.setEnabled(true)",
          totalTimeMs: 3,
        }),
      );

      await expect(resultPromise).rejects.toThrow("setEnabled(true)");
    } finally {
      await client.close();
    }
  });
});

// ---------------------------------------------------------------------------
// PARAM-2 (issue #4174, item 5): delegate-level 5 ops x outcomes.
//
// The client-level executeSQLForIos round-trips above drive a real FakeWebSocket
// + decode. This block drives the CtrlProxyDatabase DELEGATE directly through a
// real RequestManager + FakeTimer so the four previously-untested ops
// (listDatabases/listTables/getTableData/getTableStructure) and every op's
// timeout / not-connected / failure path get an asserted outcome, and the
// executeSQL `queryType` default is pinned. Timeouts fire by advancing the fake
// clock (asserted message), never by a real hang.
// ---------------------------------------------------------------------------
import {
  createIosDelegateHarness,
  type IosDelegateHarness,
} from "../../../helpers/iosDelegateHarness";
import { CtrlProxyDatabase } from "../../../../src/features/observe/ios/CtrlProxyDatabase";

describe("CtrlProxyDatabase delegate outcomes", () => {
  const flush = (): Promise<void> => new Promise<void>((resolve) => setImmediate(resolve));
  const TIMEOUT = 5000;

  let h: IosDelegateHarness;
  let db: CtrlProxyDatabase;

  beforeEach(() => {
    h = createIosDelegateHarness();
    db = new CtrlProxyDatabase(h.context);
  });

  interface Op {
    op: string;
    wireType: string;
    timeoutMsg: string;
    defaultErrorMsg: string;
    call: () => Promise<unknown>;
    successPayload: Record<string, unknown>;
    assertSuccess: (value: unknown) => void;
  }

  const ops: Op[] = [
    {
      op: "executeSQL",
      wireType: "execute_sql",
      timeoutMsg: `Execute SQL timeout after ${TIMEOUT}ms`,
      defaultErrorMsg: "Execute SQL failed",
      call: () => db.executeSQL("com.app", "/db/main.db", "SELECT 1", TIMEOUT),
      successPayload: {
        success: true,
        totalTimeMs: 1,
        queryType: "query",
        columns: ["id"],
        rows: [[1], [2]],
      },
      assertSuccess: (value) => {
        expect(value).toEqual({ type: "query", columns: ["id"], rows: [[1], [2]] });
      },
    },
    {
      op: "listDatabases",
      wireType: "list_databases",
      timeoutMsg: `List databases timeout after ${TIMEOUT}ms`,
      defaultErrorMsg: "List databases failed",
      call: () => db.listDatabases("com.app", TIMEOUT),
      successPayload: {
        success: true,
        totalTimeMs: 1,
        databases: [{ name: "main", path: "/db/main.db" }],
      },
      assertSuccess: (value) => {
        expect(value).toEqual([{ name: "main", path: "/db/main.db" }]);
      },
    },
    {
      op: "listTables",
      wireType: "list_tables",
      timeoutMsg: `List tables timeout after ${TIMEOUT}ms`,
      defaultErrorMsg: "List tables failed",
      call: () => db.listTables("com.app", "/db/main.db", TIMEOUT),
      successPayload: { success: true, totalTimeMs: 1, tables: ["users", "orders"] },
      assertSuccess: (value) => {
        expect(value).toEqual(["users", "orders"]);
      },
    },
    {
      op: "getTableData",
      wireType: "get_table_data",
      timeoutMsg: `Get table data timeout after ${TIMEOUT}ms`,
      defaultErrorMsg: "Get table data failed",
      call: () => db.getTableData("com.app", "/db/main.db", "users", 50, 0, TIMEOUT),
      successPayload: {
        success: true,
        totalTimeMs: 1,
        columns: ["id", "name"],
        rows: [[1, "a"]],
        total: 1,
      },
      assertSuccess: (value) => {
        expect(value).toEqual({ columns: ["id", "name"], rows: [[1, "a"]], total: 1 });
      },
    },
    {
      op: "getTableStructure",
      wireType: "get_table_structure",
      timeoutMsg: `Get table structure timeout after ${TIMEOUT}ms`,
      defaultErrorMsg: "Get table structure failed",
      call: () => db.getTableStructure("com.app", "/db/main.db", "users", TIMEOUT),
      successPayload: {
        success: true,
        totalTimeMs: 1,
        columns: [{ name: "id", type: "INTEGER", nullable: false, primaryKey: true }],
      },
      assertSuccess: (value) => {
        expect(value).toEqual({
          columns: [{ name: "id", type: "INTEGER", nullable: false, primaryKey: true }],
        });
      },
    },
  ];

  for (const o of ops) {
    describe(o.op, () => {
      test(`sends ${o.wireType} and resolves the mapped value on success`, async () => {
        const promise = o.call();
        await flush();
        expect(h.sentMessages[0]).toMatchObject({ type: o.wireType });
        expect(typeof h.sentMessages[0].requestId).toBe("string");
        expect(h.resolveLast(o.successPayload)).toBe(true);
        o.assertSuccess(await promise);
      });

      test("throws the runner-supplied error when success is false", async () => {
        const promise = o.call();
        await flush();
        h.resolveLast({ success: false, totalTimeMs: 2, error: "runner said no" });
        await expect(promise).rejects.toThrow("runner said no");
      });

      test("throws the default message when a failure carries no error string", async () => {
        const promise = o.call();
        await flush();
        h.resolveLast({ success: false, totalTimeMs: 2 });
        await expect(promise).rejects.toThrow(o.defaultErrorMsg);
      });

      test("throws an actionable timeout message after the deadline (no silent hang)", async () => {
        const promise = o.call();
        await flush();
        expect(h.requestManager.getPendingCount()).toBe(1);
        h.advanceTime(TIMEOUT);
        await expect(promise).rejects.toThrow(o.timeoutMsg);
      });

      test("throws when not connected without sending on the wire", async () => {
        h.setConnected(false);
        await expect(o.call()).rejects.toThrow("Failed to connect to CtrlProxy");
        expect(h.sentMessages).toHaveLength(0);
      });
    });
  }

  // executeSQL queryType defaulting (the "queryType default unpinned" gap).
  describe("executeSQL queryType defaulting", () => {
    test("maps queryType 'mutation' to a rowsAffected result", async () => {
      const promise = db.executeSQL("com.app", "/db/main.db", "DELETE FROM t", TIMEOUT);
      await flush();
      h.resolveLast({ success: true, totalTimeMs: 1, queryType: "mutation", rowsAffected: 4 });
      expect(await promise).toEqual({ type: "mutation", rowsAffected: 4 });
    });

    test("defaults rowsAffected to 0 for a mutation that omits it", async () => {
      const promise = db.executeSQL("com.app", "/db/main.db", "DELETE FROM t", TIMEOUT);
      await flush();
      h.resolveLast({ success: true, totalTimeMs: 1, queryType: "mutation" });
      expect(await promise).toEqual({ type: "mutation", rowsAffected: 0 });
    });

    test("treats an absent queryType as a query (not a mutation)", async () => {
      const promise = db.executeSQL("com.app", "/db/main.db", "SELECT 1", TIMEOUT);
      await flush();
      // No queryType field at all: the default half must be 'query'.
      h.resolveLast({ success: true, totalTimeMs: 1, columns: ["n"], rows: [[1]] });
      expect(await promise).toEqual({ type: "query", columns: ["n"], rows: [[1]] });
    });

    test("defaults columns and rows to empty arrays for a query that omits them", async () => {
      const promise = db.executeSQL("com.app", "/db/main.db", "SELECT 1", TIMEOUT);
      await flush();
      h.resolveLast({ success: true, totalTimeMs: 1, queryType: "query" });
      expect(await promise).toEqual({ type: "query", columns: [], rows: [] });
    });
  });
});
