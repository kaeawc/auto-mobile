import { describe, it, expect, beforeEach } from "bun:test";
import { Socket } from "node:net";
import {
  FailuresPushSocketServer,
  type FailureNotificationPush,
} from "../../src/daemon/failuresPushSocketServer";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeSocket } from "../fakes/FakeNetServer";
import { FakeDeviceSessionResolver } from "../fakes/FakeDeviceSessionResolver";

/**
 * Wraps FailuresPushSocketServer so tests can inject fake sockets and drive the
 * device-session attribution added in epic #5256, item 3 (#5259) without real IO.
 */
class TestableFailuresPushSocketServer extends FailuresPushSocketServer {
  constructor(timer: FakeTimer) {
    super("/fake/path/test.sock", timer);
  }

  async startFake(): Promise<void> {
    (this as any).server = { listening: true };
    (this as any).onServerStarted();
  }

  async closeFake(): Promise<void> {
    (this as any).onServerClosing();
    (this as any).server = null;
  }

  simulateSubscription(options: {
    type?: string;
    severity?: string;
    deviceSessionUuid?: string | null;
  }): { socket: FakeSocket; subscriptionId: string } {
    const socket = new FakeSocket();
    const subscriptionId = `failurespush-${++(this as any).subscriptionCounter}`;
    const timer = (this as any).timer as FakeTimer;
    this.subscribers.set(subscriptionId, {
      socket: socket as unknown as Socket,
      subscriptionId,
      lastActivity: timer.now(),
      filter: {
        type: options.type ?? null,
        severity: options.severity ?? null,
        deviceSessionUuid: options.deviceSessionUuid ?? null,
      },
      backfilling: false,
      drainPending: false,
    });
    return { socket, subscriptionId };
  }
}

function pushed(socket: FakeSocket): Array<{ type: string; data: FailureNotificationPush }> {
  return socket.getWrittenMessages<{ type: string; data: FailureNotificationPush }>();
}

function notification(overrides: Partial<FailureNotificationPush> = {}): FailureNotificationPush {
  return {
    occurrenceId: "occ-1",
    groupId: "grp-1",
    type: "crash",
    severity: "high",
    title: "Boom",
    message: "boom happened",
    timestamp: 0,
    deviceId: "emulator-5554",
    deviceSessionUuid: null,
    ...overrides,
  };
}

describe("FailuresPushSocketServer device-session attribution (#5259)", () => {
  let server: TestableFailuresPushSocketServer;
  let timer: FakeTimer;
  let resolver: FakeDeviceSessionResolver;

  beforeEach(async () => {
    timer = new FakeTimer();
    server = new TestableFailuresPushSocketServer(timer);
    resolver = new FakeDeviceSessionResolver()
      .bind("emulator-5554", "uuid-a")
      .bind("emulator-5556", "uuid-b");
    server.setDeviceSessionResolver(resolver);
    await server.startFake();
  });

  it("stamps deviceId and the resolved deviceSessionUuid on every pushed frame (AC1)", () => {
    const { socket } = server.simulateSubscription({});
    server.pushFailure(notification({ deviceId: "emulator-5554" }));

    const msgs = pushed(socket);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].data.deviceId).toBe("emulator-5554");
    expect(msgs[0].data.deviceSessionUuid).toBe("uuid-a");
  });

  it("isolates two devices by deviceSessionUuid filter (AC2)", () => {
    const a = server.simulateSubscription({ deviceSessionUuid: "uuid-a" });
    const b = server.simulateSubscription({ deviceSessionUuid: "uuid-b" });

    server.pushFailure(notification({ occurrenceId: "occ-a", deviceId: "emulator-5554" }));
    server.pushFailure(notification({ occurrenceId: "occ-b", deviceId: "emulator-5556" }));

    expect(pushed(a.socket).map(m => m.data.occurrenceId)).toEqual(["occ-a"]);
    expect(pushed(b.socket).map(m => m.data.occurrenceId)).toEqual(["occ-b"]);
  });

  it("delivers every device's failures to a null (all-devices) subscriber", () => {
    const { socket } = server.simulateSubscription({ deviceSessionUuid: null });
    server.pushFailure(notification({ occurrenceId: "occ-a", deviceId: "emulator-5554" }));
    server.pushFailure(notification({ occurrenceId: "occ-b", deviceId: "emulator-5556" }));

    expect(pushed(socket).map(m => m.data.occurrenceId)).toEqual(["occ-a", "occ-b"]);
  });

  it("yields zero events to a stale/retired deviceSessionUuid filter (AC4)", () => {
    const { socket } = server.simulateSubscription({ deviceSessionUuid: "uuid-a" });
    // Device reconnects under a new epoch: the old uuid no longer resolves and the
    // serial now maps to uuid-c.
    resolver.retire("emulator-5554").bind("emulator-5554", "uuid-c");

    server.pushFailure(notification({ deviceId: "emulator-5554" }));

    expect(pushed(socket)).toHaveLength(0);
  });

  it("still honors type/severity filters alongside the device key", () => {
    const { socket } = server.simulateSubscription({ type: "anr", deviceSessionUuid: "uuid-a" });
    server.pushFailure(notification({ type: "crash", deviceId: "emulator-5554" }));
    server.pushFailure(notification({ type: "anr", deviceId: "emulator-5554" }));

    expect(pushed(socket).map(m => m.data.type)).toEqual(["anr"]);
  });

  it("carries a null deviceSessionUuid for a device-less failure", () => {
    const { socket } = server.simulateSubscription({ deviceSessionUuid: null });
    server.pushFailure(notification({ deviceId: null }));

    const msgs = pushed(socket);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].data.deviceId).toBeNull();
    expect(msgs[0].data.deviceSessionUuid).toBeNull();
  });
});
