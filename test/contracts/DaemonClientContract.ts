import { describe, expect, test } from "bun:test";
import { DaemonRequestNotDeliveredError } from "../../src/daemon/DaemonRequestNotDeliveredError";
import { DaemonUnavailableError, type DaemonClientLike } from "../../src/daemon/client/client";
import type { DaemonNotification } from "../../src/daemon/types";

/**
 * Behavioural contract for the daemon client surface the MCP proxy depends on, run against the
 * real `DaemonClient` (over a unix socket in a private temp directory, answered by a scripted
 * daemon) and `FakeDaemonClient`.
 *
 * It compares what a caller can observe of the client itself: how it hands out request ids, how it
 * honours an abort signal, which pushed frames reach which handlers, what a lost connection does,
 * and what an unreachable daemon does to a request. It deliberately does not compare what the
 * daemon answers: a fake has no daemon to answer, so a result is whatever the harness scripts.
 */
export interface DaemonClientHarnessOptions {
  /** The value every request is answered with. */
  result: unknown;
  /** The daemon accepts requests and never answers them. */
  hold?: boolean;
  /** No daemon is listening, so the client cannot connect. */
  unreachable?: boolean;
}

export interface DaemonClientHarness {
  client: DaemonClientLike;
  /** Requests that reached the daemon (real: request frames read; fake: its call histories). */
  requestCount(): number;
  /** The daemon pushes a frame to the connected client. */
  push(notification: DaemonNotification): Promise<void>;
  /** The daemon drops the connection. */
  hangUp(): Promise<void>;
  close(): Promise<void>;
}

export type DaemonClientHarnessFactory = (
  options: DaemonClientHarnessOptions,
) => Promise<DaemonClientHarness>;

const PROBE_METHOD = "daemon/contract-probe";

function frame(uri: string): DaemonNotification {
  return { type: "daemon_notification", method: "notifications/resources/updated", uri };
}

/** Resolves once `client` is handed the frame carrying `uri`. */
function arrival(client: DaemonClientLike, uri: string): Promise<void> {
  return new Promise((resolve) => {
    client.onNotification!((notification) => {
      if (notification.uri === uri) {
        resolve();
      }
    });
  });
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to reject");
}

/** Lets in-flight socket I/O and the tick the client needs to register a request go by. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

export function runDaemonClientContract(
  name: string,
  makeHarness: DaemonClientHarnessFactory,
): void {
  describe(`DaemonClient contract: ${name}`, () => {
    async function withHarness(
      options: DaemonClientHarnessOptions,
      body: (harness: DaemonClientHarness) => Promise<void>,
    ): Promise<void> {
      const harness = await makeHarness(options);
      try {
        await body(harness);
      } finally {
        await harness.close();
      }
    }

    test("a tool call, a resource read and a daemon method each resolve with the daemon's result", async () => {
      await withHarness({ result: { ok: 1 } }, async ({ client }) => {
        expect(await client.callTool("observe", {})).toEqual({ ok: 1 });
        expect(await client.readResource("automobile:test", {})).toEqual({ ok: 1 });
        expect(await client.callDaemonMethod(PROBE_METHOD, {})).toEqual({ ok: 1 });
      });
    });

    test("a tool call reports a distinct request id before it settles", async () => {
      await withHarness({ result: {} }, async ({ client }) => {
        const ids: string[] = [];
        await client.callTool("observe", {}, undefined, { onRequestId: (id) => ids.push(id) });
        await client.callTool("observe", {}, undefined, { onRequestId: (id) => ids.push(id) });
        expect(ids).toHaveLength(2);
        expect(ids.every((id) => typeof id === "string" && id.length > 0)).toBe(true);
        expect(ids[0]).not.toBe(ids[1]);
      });
    });

    test("an already-aborted signal rejects before anything is sent", async () => {
      await withHarness({ result: {} }, async ({ client, requestCount }) => {
        const reason = new Error("caller gave up");
        const signal = AbortSignal.abort(reason);
        expect(await rejection(client.callTool("observe", {}, undefined, { signal }))).toBe(reason);
        expect(await rejection(client.readResource("automobile:test", {}, { signal }))).toBe(
          reason,
        );
        const refused = await rejection(client.callDaemonMethod(PROBE_METHOD, {}, { signal }));
        expect(refused).toBeInstanceOf(DaemonUnavailableError);
        expect((refused as Error).cause).toBe(reason);
        expect(requestCount()).toBe(0);
      });
    });

    test("aborting an unanswered tool call rejects it with the abort reason", async () => {
      await withHarness({ result: {}, hold: true }, async ({ client }) => {
        const controller = new AbortController();
        const reason = new Error("caller gave up");
        const call = rejection(
          client.callTool("observe", {}, undefined, { signal: controller.signal }),
        );
        await settle();
        controller.abort(reason);
        expect(await call).toBe(reason);
      });
    });

    test("aborting an unanswered daemon method rejects it as unavailable, caused by the reason", async () => {
      await withHarness({ result: {}, hold: true }, async ({ client }) => {
        const controller = new AbortController();
        const reason = new Error("caller gave up");
        const call = rejection(
          client.callDaemonMethod(PROBE_METHOD, {}, { signal: controller.signal }),
        );
        await settle();
        controller.abort(reason);
        const refused = await call;
        expect(refused).toBeInstanceOf(DaemonUnavailableError);
        expect((refused as Error).cause).toBe(reason);
      });
    });

    test("a pushed frame reaches every handler until it unsubscribes", async () => {
      await withHarness({ result: {} }, async ({ client, push }) => {
        await client.connect();
        const first: string[] = [];
        const second: string[] = [];
        const unsubscribeFirst = client.onNotification!((n) => first.push(n.uri ?? ""));
        client.onNotification!((n) => second.push(n.uri ?? ""));
        const secondSeenA = arrival(client, "a");
        await push(frame("a"));
        await secondSeenA;
        unsubscribeFirst();
        const secondSeenB = arrival(client, "b");
        await push(frame("b"));
        await secondSeenB;
        expect(first).toEqual(["a"]);
        expect(second).toEqual(["a", "b"]);
      });
    });

    test("a throwing handler does not stop later handlers from seeing the frame", async () => {
      await withHarness({ result: {} }, async ({ client, push }) => {
        await client.connect();
        client.onNotification!(() => {
          throw new Error("handler failed");
        });
        const seen: string[] = [];
        client.onNotification!((n) => seen.push(n.uri ?? ""));
        const arrived = arrival(client, "a");
        await push(frame("a"));
        await arrived;
        expect(seen).toEqual(["a"]);
      });
    });

    test("closing the client drops its handlers, so a reconnect starts with none", async () => {
      await withHarness({ result: {} }, async ({ client, push }) => {
        await client.connect();
        const stale: string[] = [];
        client.onNotification!((n) => stale.push(n.uri ?? ""));
        await client.close();
        await client.connect();
        const arrived = arrival(client, "a");
        await push(frame("a"));
        await arrived;
        expect(stale).toEqual([]);
      });
    });

    test("a dropped connection notifies the connection-closed handlers once", async () => {
      await withHarness({ result: {} }, async ({ client, hangUp }) => {
        await client.connect();
        let closed = 0;
        const notified = new Promise<void>((resolve) => {
          client.onConnectionClosed!(() => {
            closed += 1;
            resolve();
          });
        });
        await hangUp();
        await notified;
        await settle();
        expect(closed).toBe(1);
      });
    });

    test("a request to an unreachable daemon is rejected as not delivered", async () => {
      await withHarness({ result: {}, unreachable: true }, async ({ client, requestCount }) => {
        expect(await rejection(client.callTool("observe", {}))).toBeInstanceOf(
          DaemonRequestNotDeliveredError,
        );
        expect(await rejection(client.readResource("automobile:test", {}))).toBeInstanceOf(
          DaemonRequestNotDeliveredError,
        );
        expect(await rejection(client.callDaemonMethod(PROBE_METHOD, {}))).toBeInstanceOf(
          DaemonUnavailableError,
        );
        expect(requestCount()).toBe(0);
      });
    });
  });
}
