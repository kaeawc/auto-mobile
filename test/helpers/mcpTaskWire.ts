import { InMemoryTransport, type JSONRPCMessage } from "@modelcontextprotocol/server";
import { createMcpServer } from "../../src/server/index";
import { TASKS_EXTENSION_ID } from "../../src/daemon/tasks/mcpTasksExtension";

/*
 * A raw JSON-RPC wire to one of our MCP servers for the Tasks extension (#4668) contract tests:
 * assertions read the exact frames the server sends, not an SDK client's interpretation.
 */

/** A request's per-request `_meta` declaring the Tasks extension. */
export const DECLARED_META = {
  "io.modelcontextprotocol/clientCapabilities": { extensions: { [TASKS_EXTENSION_ID]: {} } },
};

/** Longer than any loaded-host fs stall, shorter than the 5 s per-test timeout. */
const HANG_DEADLINE_MS = 4_000;

export type Frame = Record<string, any>;

/** Sends requests and matches each answer to its id. */
export class RawWire {
  private readonly waiters = new Map<string | number, (frame: Frame) => void>();
  private nextId = 1;

  constructor(private readonly transport: InMemoryTransport) {
    transport.onmessage = (frame) => {
      const id = "id" in frame ? frame.id : undefined;
      if (id !== undefined && ("result" in frame || "error" in frame)) {
        this.waiters.get(id)?.(frame as Frame);
      }
    };
  }

  async request(method: string, params?: Record<string, unknown>): Promise<Frame> {
    const id = this.nextId++;
    const answered = new Promise<Frame>((resolve) => this.waiters.set(id, resolve));
    await this.transport.send({
      jsonrpc: "2.0",
      id,
      method,
      ...(params && { params }),
    } as JSONRPCMessage);
    return answered;
  }

  call(name: string, args: Record<string, unknown>, declared: boolean): Promise<Frame> {
    return this.request("tools/call", {
      name,
      arguments: args,
      ...(declared && { _meta: DECLARED_META }),
    });
  }

  task(method: "tasks/get" | "tasks/cancel" | "tasks/update", taskId: string, extra = {}) {
    return this.request(method, { taskId, ...extra, _meta: DECLARED_META });
  }

  /**
   * Poll `tasks/get` until the task is terminal. `between` runs between polls; a test whose work
   * waits on fake time advances its clock there, and is bounded to 200 polls. Without `between`
   * the task is waiting on real I/O (fs, in-memory transport), whose speed depends on host load,
   * so the poll yields one event-loop turn at a time and is bounded by a hang deadline instead of
   * a turn count: 200 turns passed in well under a millisecond on an idle host and were exhausted
   * before a loaded host's fs work finished (#15059). It returns as soon as the task is terminal.
   */
  async settled(taskId: string, between?: () => Promise<void>): Promise<Frame> {
    const yieldTurn = between ?? (() => new Promise<void>((resolve) => setImmediate(resolve)));
    const startedAt = performance.now();
    for (
      let turn = 0;
      between ? turn < 200 : performance.now() - startedAt < HANG_DEADLINE_MS;
      turn++
    ) {
      const frame = await this.task("tasks/get", taskId);
      const status = frame.result?.status;
      if (status && status !== "working" && status !== "input_required") {
        return frame;
      }
      await yieldTurn();
    }
    throw new Error(`task ${taskId} never settled`);
  }
}

/** Connect a fresh server built from `options` over an in-memory transport. */
export async function connect(options: Parameters<typeof createMcpServer>[0]) {
  const server = createMcpServer(options);
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await clientTransport.start();
  return { wire: new RawWire(clientTransport), close: () => server.close() };
}
