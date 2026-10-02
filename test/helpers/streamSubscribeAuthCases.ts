import { describe, expect, it } from "bun:test";
import {
  ObserverAdmittingStreamAuthenticator,
  type StreamSocketAuthenticator,
} from "../../src/daemon/streamSocketAuth";
import { ObserverSessionRegistry } from "../../src/daemon/observerSessionRegistry";
import { FakeSocket } from "../fakes/FakeNetServer";
import { FakeTimer } from "../fakes/FakeTimer";

export interface AuthTestServer {
  receive(socket: FakeSocket, line: string): Promise<void>;
  getSubscriberCount(): number;
  effects(): number;
}

/** The same wire contract must hold on all four sockets, without real sockets or clocks. */
export function streamSubscribeAuthCases(
  name: string,
  create: (timer: FakeTimer, authenticator: StreamSocketAuthenticator) => AuthTestServer,
): void {
  describe(`${name} subscribe authentication`, () => {
    for (const authOff of [false, true]) {
      for (const sessionUuid of [
        undefined,
        "unknown",
        "releasing",
        "observer",
        "owner",
        "expired",
      ]) {
        it(`${authOff ? "auth off" : "auth on"}: ${sessionUuid ?? "missing"}`, async () => {
          const timer = new FakeTimer();
          const registry = new ObserverSessionRegistry(timer, 10);
          registry.register("expired", "test");
          timer.advanceTime(10);
          registry.register("observer", "test");
          // Even stale observer registration must not admit a releasing device session.
          registry.register("releasing", "test");
          const releasing = {};
          const authenticator = new ObserverAdmittingStreamAuthenticator({
            operation: name,
            env: authOff ? { AUTOMOBILE_DAEMON_STREAM_AUTH: "0" } : {},
            resolveObserverRegistry: () => registry,
            resolveSessionManager: () => ({
              getSession: (uuid) =>
                uuid === "owner" ? {} : uuid === "releasing" ? releasing : null,
              getReleasingSession: (uuid) => (uuid === "releasing" ? releasing : null),
              getSessionForDevice: () => "other",
              getDeviceLabels: () => undefined,
            }),
          });
          const server = create(timer, authenticator);
          const socket = new FakeSocket();
          expect(socket.getWrittenMessages()).toEqual([]);
          expect(server.getSubscriberCount()).toBe(0);
          await server.receive(
            socket,
            JSON.stringify({ id: "auth-sub", command: "subscribe", sessionUuid }),
          );
          const replies = socket.getWrittenMessages<{
            id: string;
            type: string;
            success: boolean;
            error?: string;
          }>();
          const accepted = authOff || sessionUuid === "owner" || sessionUuid === "observer";
          expect(replies).toHaveLength(1);
          expect(replies[0].id).toBe("auth-sub");
          expect(replies[0].success).toBe(accepted);
          expect(replies[0].type).toBe(accepted ? "subscription_response" : "error");
          expect(server.getSubscriberCount()).toBe(accepted ? 1 : 0);
          expect(server.effects()).toBe(accepted ? 1 : 0);
          if (!accepted) {
            expect(replies[0].error).toContain("Register a session with daemon/registerSession");
            expect(replies[0].error).toContain("AUTOMOBILE_DAEMON_STREAM_AUTH=0");
          }
        });
      }
    }
  });
}
