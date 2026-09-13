import { describe, it, expect } from "bun:test";
import { Socket } from "node:net";
import { TelemetryPushSocketServer } from "../../src/daemon/telemetryPushSocketServer";
import { FailuresPushSocketServer } from "../../src/daemon/failuresPushSocketServer";
import { PerformancePushSocketServer } from "../../src/daemon/performancePushSocketServer";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeSocket } from "../fakes/FakeNetServer";

interface SubscribeReply {
  id?: string;
  type: string;
  success?: boolean;
  error?: string;
  subscriptionId?: string;
}

/**
 * Exposes the base class's line handler so a subscribe command can be driven
 * exactly as it arrives over the wire, including the `success: false` envelope
 * the catch path produces (issue #6676).
 */
interface LineDrivable {
  processLineForTest(socket: FakeSocket, line: string): Promise<void>;
}

function drivable<T extends object>(server: T): T & LineDrivable {
  const target = server as T & {
    processLine(socket: Socket, line: string): Promise<void>;
  };
  return Object.assign(server, {
    processLineForTest: (socket: FakeSocket, line: string): Promise<void> =>
      target.processLine(socket as unknown as Socket, line),
  }) as T & LineDrivable;
}

async function subscribe(
  server: { processLineForTest(socket: FakeSocket, line: string): Promise<void> },
  request: Record<string, unknown>,
): Promise<SubscribeReply> {
  const socket = new FakeSocket();
  await server.processLineForTest(
    socket,
    JSON.stringify({ id: "sub-1", command: "subscribe", ...request }),
  );
  const messages = socket.getWrittenMessages<SubscribeReply>();
  return messages[messages.length - 1];
}

const servers: Array<{
  name: string;
  create: () => { processLineForTest(socket: FakeSocket, line: string): Promise<void> } & {
    getSubscriberCount(): number;
  };
}> = [
  {
    name: "TelemetryPushSocketServer",
    create: () => drivable(new TelemetryPushSocketServer("/fake/telemetry.sock", new FakeTimer())),
  },
  {
    name: "FailuresPushSocketServer",
    create: () => drivable(new FailuresPushSocketServer("/fake/failures.sock", new FakeTimer())),
  },
  {
    name: "PerformancePushSocketServer",
    create: () =>
      drivable(new PerformancePushSocketServer("/fake/performance.sock", new FakeTimer())),
  },
];

describe("push socket subscription deviceSessionUuid validation (#6676)", () => {
  for (const { name, create } of servers) {
    describe(name, () => {
      it("rejects a blank deviceSessionUuid instead of acking a dead subscription", async () => {
        const server = create();

        const reply = await subscribe(server, { deviceSessionUuid: "   " });

        expect(reply.success).toBe(false);
        expect(reply.type).toBe("error");
        expect(reply.error).toContain("deviceSessionUuid must not be blank");
        expect(server.getSubscriberCount()).toBe(0);
      });

      it("rejects a non-string deviceSessionUuid instead of acking a dead subscription", async () => {
        const server = create();

        const reply = await subscribe(server, { deviceSessionUuid: 123 });

        expect(reply.success).toBe(false);
        expect(reply.type).toBe("error");
        expect(reply.error).toContain("deviceSessionUuid must be a string or null");
        expect(server.getSubscriberCount()).toBe(0);
      });

      it("still accepts a valid deviceSessionUuid", async () => {
        const server = create();

        const reply = await subscribe(server, { deviceSessionUuid: "uuid-a" });

        expect(reply.success).toBe(true);
        expect(reply.type).toBe("subscription_response");
        expect(server.getSubscriberCount()).toBe(1);
      });

      it("still accepts an all-device subscription with no deviceSessionUuid", async () => {
        const server = create();

        const reply = await subscribe(server, {});

        expect(reply.success).toBe(true);
        expect(server.getSubscriberCount()).toBe(1);
      });
    });
  }
});
