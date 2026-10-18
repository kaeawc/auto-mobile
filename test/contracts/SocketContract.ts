import { describe, expect, test } from "bun:test";
import type { Socket } from "node:net";

/**
 * One server-side connection plus a scripted remote peer. FakeSocket plays the server end with
 * the peer simulated in memory; the real side is a `node:net` socket accepted on a loopback
 * ephemeral port with a real client as the peer. Scenarios only use this surface.
 */
export interface ScriptedSocket {
  /** The server-side socket the code under test would hold. */
  socket: Socket;
  /** The peer sends bytes that arrive at `socket`. */
  peerSend(text: string): Promise<void>;
  /** Bytes the peer has received from `socket` so far, once at least `minBytes` have arrived. */
  peerReceived(minBytes: number): Promise<string>;
  /** Resolves once the peer observes the connection as closed. */
  peerClosed(): Promise<void>;
  dispose?(): Promise<void>;
}

/** Resolves with the next `event` of `socket`; register before triggering the cause. */
function nextEvent<T>(socket: Socket, event: string): Promise<T> {
  return new Promise((resolve) => socket.once(event, (value: T) => resolve(value)));
}

/**
 * Shared behavioural contract for the socket surface the daemon's servers and clients rely on
 * (#11868): FakeSocket (test/fakes/FakeNetServer.ts) versus a real loopback `node:net` socket
 * agree on initial state, write delivery, incoming data, destroy/end lifecycle and
 * write-after-destroy. FakeSocket's `throwOnWriteAfterDestroy` default is an intentional
 * strictness over the real socket (which reports the error asynchronously), so the scenario
 * tolerates either reporting style and asserts only that no bytes reach the peer.
 */
export function runSocketContract(name: string, make: () => Promise<ScriptedSocket>): void {
  async function withSocket(run: (scripted: ScriptedSocket) => Promise<void>): Promise<void> {
    const scripted = await make();
    try {
      await run(scripted);
    } finally {
      await scripted.dispose?.();
    }
  }

  describe(`Socket contract: ${name}`, () => {
    test("a fresh connection is live and writable", () =>
      withSocket(async ({ socket }) => {
        expect(socket.destroyed).toBe(false);
        expect(socket.writable).toBe(true);
      }));

    test("written bytes reach the peer in order", () =>
      withSocket(async (scripted) => {
        expect(scripted.socket.write("one,")).toBe(true);
        expect(scripted.socket.write(Buffer.from("two"))).toBe(true);
        expect(await scripted.peerReceived(7)).toBe("one,two");
      }));

    test("peer bytes arrive as data events", () =>
      withSocket(async (scripted) => {
        const received = nextEvent<Buffer>(scripted.socket, "data");
        await scripted.peerSend("hello");
        expect((await received).toString()).toBe("hello");
      }));

    test("destroy flips the flags and emits close once with hadError false", () =>
      withSocket(async (scripted) => {
        const closes: boolean[] = [];
        scripted.socket.on("close", (hadError: boolean) => closes.push(hadError));
        const closed = nextEvent<boolean>(scripted.socket, "close");
        scripted.socket.destroy();
        expect(scripted.socket.destroyed).toBe(true);
        expect(scripted.socket.writable).toBe(false);
        await closed;
        scripted.socket.destroy();
        await scripted.peerClosed();
        expect(closes).toEqual([false]);
      }));

    test("destroy with an error emits error then close with hadError true", () =>
      withSocket(async (scripted) => {
        const events: string[] = [];
        scripted.socket.on("error", (error: Error) => events.push(`error:${error.message}`));
        const closed = nextEvent<boolean>(scripted.socket, "close");
        scripted.socket.destroy(new Error("boom"));
        const hadError = await closed;
        events.push(`close:${hadError}`);
        expect(events).toEqual(["error:boom", "close:true"]);
      }));

    test("end stops writes immediately and the socket closes", () =>
      withSocket(async (scripted) => {
        const closed = nextEvent<boolean>(scripted.socket, "close");
        scripted.socket.end();
        expect(scripted.socket.writable).toBe(false);
        await closed;
        expect(scripted.socket.destroyed).toBe(true);
        await scripted.peerClosed();
      }));

    test("a write after destroy never reaches the peer", () =>
      withSocket(async (scripted) => {
        scripted.socket.on("error", () => {});
        scripted.socket.write("before");
        expect(await scripted.peerReceived(6)).toBe("before");
        scripted.socket.destroy();
        try {
          scripted.socket.write("after");
        } catch {
          // FakeSocket's strict default throws EPIPE; a real socket reports asynchronously.
        }
        await scripted.peerClosed();
        expect(await scripted.peerReceived(6)).toBe("before");
      }));

    test("setTimeout returns the socket for chaining", () =>
      withSocket(async ({ socket }) => {
        expect(socket.setTimeout(1000)).toBe(socket);
      }));
  });
}
