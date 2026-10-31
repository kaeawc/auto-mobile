import { describe, expect, test } from "bun:test";
import { CtrlProxyStorage } from "../../../src/features/observe/ios/CtrlProxyStorage";
import { CtrlProxyDatabase } from "../../../src/features/observe/ios/CtrlProxyDatabase";
import { iosWireDeadlineParams } from "../../../src/features/observe/ios/CtrlProxyDispatch";
import { serializeIosRequest } from "../../../src/features/observe/ios/serializeIosRequest";
import type { DelegateContext } from "../../../src/features/observe/ios/types";
import { ActionableError } from "../../../src/models/ActionableError";
import { CountingIdGenerator } from "../../../src/utils/IdGenerator";
import { RequestManager } from "../../../src/utils/RequestManager";
import { runWithAbortSignal } from "../../../src/utils/AbortContext";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeWebSocket, WebSocketState } from "../../fakes/FakeWebSocket";

class RecordingSocket extends FakeWebSocket {
  readonly frames: string[] = [];
  sendError?: Error;
  override send(data: string): void {
    if (this.sendError) {
      throw this.sendError;
    }
    super.send(data);
    this.frames.push(data);
  }
}

async function harness() {
  const timer = new FakeTimer();
  const socket = new RecordingSocket("ws://fake", "none", 0, timer);
  await Promise.resolve();
  const manager = new RequestManager(timer, new CountingIdGenerator("wire"));
  let connects = 0;
  let backoffs = 0;
  const context: DelegateContext = {
    timer,
    requestManager: manager,
    getWebSocket: () => socket,
    ensureConnected: async () => {
      connects++;
      return true;
    },
    cancelScreenshotBackoff: () => {
      backoffs++;
    },
    serializeRequest: serializeIosRequest,
    wireDeadlineParams: iosWireDeadlineParams,
  };
  const storage = new CtrlProxyStorage(
    context,
    () => "session",
    () => "mutation",
  );
  const database = new CtrlProxyDatabase(context);
  return {
    timer,
    socket,
    manager,
    context,
    storage,
    database,
    connects: () => connects,
    backoffs: () => backoffs,
  };
}

type Harness = Awaited<ReturnType<typeof harness>>;
async function flushDispatch() {
  for (let i = 0; i < 8; i++) {
    await Promise.resolve();
  }
}

interface Method {
  type: string;
  write?: boolean;
  database?: boolean;
  invoke: (h: Harness, onDispatch?: () => void) => Promise<unknown>;
  literal: string;
  timeout: string;
}

// Literal frames come from the original JSON.stringify objects, including insertion order.
const methods: Method[] = [
  {
    type: "list_preference_files",
    invoke: (h) => h.storage.listPreferenceFiles("app", 50),
    literal:
      '{"type":"list_preference_files","requestId":"list_preference_files_wire-1","appId":"app"}',
    timeout: "List preference files timeout after 50ms",
  },
  {
    type: "get_preferences",
    invoke: (h) => h.storage.getPreferenceEntries("app", "prefs", 50),
    literal:
      '{"type":"get_preferences","requestId":"get_preferences_wire-1","appId":"app","fileName":"prefs"}',
    timeout: "Get preferences timeout after 50ms",
  },
  {
    type: "get_preference",
    invoke: (h) => h.storage.getPreference("app", "prefs", "key", 50),
    literal:
      '{"type":"get_preference","requestId":"get_preference_wire-1","appId":"app","fileName":"prefs","key":"key"}',
    timeout: "Get preference timeout after 50ms",
  },
  {
    type: "set_preference",
    write: true,
    invoke: (h, onDispatch) =>
      h.storage.setPreference(
        "app",
        "prefs",
        { key: "key", value: null, type: "STRING" },
        { timeoutMs: 50, onDispatch },
      ),
    literal:
      '{"type":"set_preference","requestId":"set_preference_wire-1","timeoutMs":50,"appId":"app","fileName":"prefs","key":"key","value":null,"valueType":"STRING","sessionId":"session","mutationToken":"mutation"}',
    timeout: "Set preference timeout after 50ms",
  },
  {
    type: "remove_preference",
    write: true,
    invoke: (h, onDispatch) =>
      h.storage.removePreference("app", "prefs", "key", { timeoutMs: 50, onDispatch }),
    literal:
      '{"type":"remove_preference","requestId":"remove_preference_wire-1","timeoutMs":50,"appId":"app","fileName":"prefs","key":"key","sessionId":"session","mutationToken":"mutation"}',
    timeout: "Remove preference timeout after 50ms",
  },
  {
    type: "clear_preferences",
    write: true,
    invoke: (h, onDispatch) =>
      h.storage.clearPreferenceStore("app", "prefs", { timeoutMs: 50, onDispatch }),
    literal:
      '{"type":"clear_preferences","requestId":"clear_preferences_wire-1","timeoutMs":50,"appId":"app","fileName":"prefs","sessionId":"session","mutationToken":"mutation"}',
    timeout: "Clear preferences timeout after 50ms",
  },
  {
    type: "execute_sql",
    database: true,
    invoke: (h) =>
      h.database.executeSQL("app", "db", "SELECT 1", {
        timeout: 50,
        sessionId: "session",
        mutationToken: "mutation",
        readOnly: true,
      }),
    literal:
      '{"type":"execute_sql","requestId":"execute_sql_wire-1","appId":"app","databasePath":"db","query":"SELECT 1","sessionId":"session","mutationToken":"mutation","readOnly":true}',
    timeout: "Execute SQL timeout after 50ms",
  },
  {
    type: "list_databases",
    database: true,
    invoke: (h) => h.database.listDatabases("app", 50),
    literal: '{"type":"list_databases","requestId":"list_databases_wire-1","appId":"app"}',
    timeout: "List databases timeout after 50ms",
  },
  {
    type: "storage_capabilities",
    database: true,
    invoke: (h) => h.database.storageCapabilities("app", 50),
    literal:
      '{"type":"storage_capabilities","requestId":"storage_capabilities_wire-1","appId":"app"}',
    timeout: "Get storage capabilities timeout after 50ms",
  },
  {
    type: "list_tables",
    database: true,
    invoke: (h) => h.database.listTables("app", "db", 50),
    literal:
      '{"type":"list_tables","requestId":"list_tables_wire-1","appId":"app","databasePath":"db"}',
    timeout: "List tables timeout after 50ms",
  },
  {
    type: "get_table_data",
    database: true,
    invoke: (h) =>
      h.database.getTableData("app", "db", "table", { limit: 7, offset: 2, timeout: 50 }),
    literal:
      '{"type":"get_table_data","requestId":"get_table_data_wire-1","appId":"app","databasePath":"db","table":"table","limit":7,"offset":2}',
    timeout: "Get table data timeout after 50ms",
  },
  {
    type: "get_table_structure",
    database: true,
    invoke: (h) => h.database.getTableStructure("app", "db", "table", 50),
    literal:
      '{"type":"get_table_structure","requestId":"get_table_structure_wire-1","appId":"app","databasePath":"db","table":"table"}',
    timeout: "Get table structure timeout after 50ms",
  },
];

for (const method of methods) {
  describe(`${method.type} sendCommand`, () => {
    test("preserves the literal frame, wire deadline policy and reply correlation", async () => {
      const h = await harness();
      let dispatches = 0;
      const pending = method.invoke(h, () => {
        expect(h.socket.frames).toEqual([method.literal]);
        dispatches++;
      });
      await flushDispatch();
      expect(h.socket.frames).toEqual([method.literal]);
      expect(iosWireDeadlineParams(method.type, 50)).toEqual(method.write ? { timeoutMs: 50 } : {});
      expect(h.connects()).toBe(1);
      expect(h.backoffs()).toBe(0);
      expect(dispatches).toBe(method.write ? 1 : 0);
      h.manager.resolve(`${method.type}_wire-1`, { success: true, totalTimeMs: 0 });
      await pending;
      expect(h.manager.getPendingCount()).toBe(0);
      expect(h.timer.getPendingTimeoutCount()).toBe(0);
    });

    test("keeps its timeout string and clears pending state", async () => {
      const h = await harness();
      const pending = method.invoke(h);
      await flushDispatch();
      h.timer.advanceTime(50);
      await expect(pending).rejects.toThrow(method.timeout);
      expect(h.manager.getPendingCount()).toBe(0);
      expect(h.timer.getPendingTimeoutCount()).toBe(0);
    });

    for (const failure of ["missing", "closed", "send"] as const) {
      test(`fails fast on ${failure} socket without dispatch or leaked timer`, async () => {
        const h = await harness();
        if (failure === "missing") {
          h.context.getWebSocket = () => null;
        } else if (failure === "closed") {
          h.socket.readyState = WebSocketState.CLOSED;
        } else {
          h.socket.sendError = new Error("send failed");
        }
        let dispatches = 0;
        const pending = method.invoke(h, () => dispatches++);
        await expect(pending).rejects.toThrow(
          failure === "send" ? "send failed" : "WebSocket not connected",
        );
        expect(h.timer.now()).toBe(0);
        expect(h.manager.getPendingCount()).toBe(0);
        expect(h.timer.getPendingTimeoutCount()).toBe(0);
        expect(h.socket.frames).toEqual([]);
        expect(dispatches).toBe(0);
      });
    }

    test("refuses unsupported commands without dispatch or pending timers", async () => {
      const h = await harness();
      h.context.isCommandSupported = () => false;
      h.context.unsupportedCommandError = (command) => `Refused command: ${command}`;
      let dispatches = 0;
      const pending = method.invoke(h, () => dispatches++);
      await expect(pending).rejects.toThrow(`Refused command: ${method.type}`);
      await expect(pending).rejects.toBeInstanceOf(method.database ? Error : ActionableError);
      if (method.database) {
        await expect(pending).rejects.not.toBeInstanceOf(ActionableError);
      }
      expect(h.socket.frames).toEqual([]);
      expect(dispatches).toBe(0);
      expect(h.manager.getPendingCount()).toBe(0);
      expect(h.timer.getPendingTimeoutCount()).toBe(0);
    });

    test("retains failed-connect error before socket dispatch", async () => {
      const h = await harness();
      h.context.ensureConnected = async () => false;
      await expect(method.invoke(h)).rejects.toThrow("Failed to connect to CtrlProxy");
      expect(h.socket.frames).toEqual([]);
      expect(h.manager.getPendingCount()).toBe(0);
    });

    test("does not attach ambient cancellation after dispatch", async () => {
      const h = await harness();
      const controller = new AbortController();
      if (!method.write) {
        controller.abort(new Error("already cancelled"));
      }
      const pending = runWithAbortSignal(controller.signal, () => method.invoke(h));
      await flushDispatch();
      controller.abort(new Error("cancel after dispatch"));
      expect(h.socket.frames).toEqual([method.literal]);
      expect(h.manager.getPendingCount()).toBe(1);
      h.manager.resolve(`${method.type}_wire-1`, { success: true, totalTimeMs: 0 });
      await pending;
      expect(h.manager.getPendingCount()).toBe(0);
    });

    if (method.write) {
      for (const connected of [true, false]) {
        test(`keeps the post-connect ambient abort fence (connect=${connected})`, async () => {
          const h = await harness();
          const controller = new AbortController();
          h.context.ensureConnected = async () => {
            controller.abort(new Error("cancel during connect"));
            return connected;
          };
          await expect(
            runWithAbortSignal(controller.signal, () => method.invoke(h)),
          ).rejects.toThrow(connected ? "cancel during connect" : "Failed to connect to CtrlProxy");
          expect(h.socket.frames).toEqual([]);
          expect(h.manager.getPendingCount()).toBe(0);
        });
      }
    }
  });
}

test("storage preserves SDK error mapping for null set as remove", async () => {
  const h = await harness();
  const pending = h.storage.setPreference(
    "app",
    "prefs",
    { key: "key", value: null, type: "STRING" },
    50,
  );
  await flushDispatch();
  h.manager.resolve("set_preference_wire-1", {
    success: false,
    totalTimeMs: 0,
    error: "write_verification_failed",
  });
  await expect(pending).rejects.toBeInstanceOf(ActionableError);
  await expect(pending).rejects.toThrow("confirm the remove");
});

test("database retains operation failure fallback", async () => {
  const h = await harness();
  const pending = h.database.listDatabases("app", 50);
  await flushDispatch();
  h.manager.resolve("list_databases_wire-1", { success: false, totalTimeMs: 0, error: "" });
  await expect(pending).rejects.toThrow("List databases failed");
});
