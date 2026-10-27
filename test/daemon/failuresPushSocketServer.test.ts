import { streamSubscribeAuthCases } from "../helpers/streamSubscribeAuthCases";
import type { StreamSocketAuthenticator } from "../../src/daemon/streamSocketAuth";
import { describe, it, expect, beforeEach } from "bun:test";
import {
  FailuresPushSocketServer,
  type FailureNotificationPush,
} from "../../src/daemon/failuresPushSocketServer";
import { FakeTimer } from "../fakes/FakeTimer";
import type { FailureSeverity, FailureType } from "../../src/models/failureAnalytics";
import type { Socket } from "node:net";
import { FakeListeningNetServer, FakeSocket } from "../fakes/FakeNetServer";
import { FakeDeviceSessionResolver } from "../fakes/FakeDeviceSessionResolver";
import { failurePushFrameSchema } from "../helpers/wireMessageSchemas";

/**
 * Wraps FailuresPushSocketServer so tests can inject fake sockets and drive the
 * device-session attribution added in epic #5256, item 3 (#5259) without real IO.
 */
class TestableFailuresPushSocketServer extends FailuresPushSocketServer {
  constructor(timer: FakeTimer) {
    super("/fake/path/test.sock", timer);
  }

  async startFake(): Promise<void> {
    this.server = new FakeListeningNetServer();
    this.onServerStarted();
  }

  async closeFake(): Promise<void> {
    this.onServerClosing();
    this.server = null;
  }

  simulateSubscription(options: {
    type?: FailureType;
    severity?: FailureSeverity;
    deviceSessionUuid?: string | null;
  }): { socket: FakeSocket; subscriptionId: string } {
    const socket = new FakeSocket();
    const subscriptionId = `failurespush-${++this.subscriptionCounter}`;
    this.subscribers.set(subscriptionId, {
      socket: socket,
      subscriptionId,
      lastActivity: this.timer.now(),
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

function pushed(socket: FakeSocket) {
  return socket.getWrittenMessages(failurePushFrameSchema);
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

    expect(pushed(a.socket).map((m) => m.data.occurrenceId)).toEqual(["occ-a"]);
    expect(pushed(b.socket).map((m) => m.data.occurrenceId)).toEqual(["occ-b"]);
  });

  it("delivers every device's failures to a null (all-devices) subscriber", () => {
    const { socket } = server.simulateSubscription({ deviceSessionUuid: null });
    server.pushFailure(notification({ occurrenceId: "occ-a", deviceId: "emulator-5554" }));
    server.pushFailure(notification({ occurrenceId: "occ-b", deviceId: "emulator-5556" }));

    expect(pushed(socket).map((m) => m.data.occurrenceId)).toEqual(["occ-a", "occ-b"]);
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

    expect(pushed(socket).map((m) => m.data.type)).toEqual(["anr"]);
  });

  it("carries a null deviceSessionUuid for a device-less failure", () => {
    const { socket } = server.simulateSubscription({ deviceSessionUuid: null });
    server.pushFailure(notification({ deviceId: null }));

    const msgs = pushed(socket);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].data.deviceId).toBeNull();
    expect(msgs[0].data.deviceSessionUuid).toBeNull();
  });
  // The pooled entry keeps its epoch while its AVD identity is unresolved, but a
  // possible replacement's failures must not be attributed to the previous AVD —
  // nor broadcast under a serial the pool can no longer tie to a runtime
  // (#6863 review).
  it("drops a failure for a device whose pooled identity is quarantined", () => {
    const scoped = server.simulateSubscription({ deviceSessionUuid: "uuid-a" });
    const all = server.simulateSubscription({ deviceSessionUuid: null });
    resolver.quarantine("emulator-5554");

    server.pushFailure(notification({ deviceId: "emulator-5554" }));

    expect(pushed(scoped.socket)).toHaveLength(0);
    expect(pushed(all.socket)).toHaveLength(0);
  });

  it("resumes failure delivery under the same uuid once the quarantine lifts", () => {
    const { socket } = server.simulateSubscription({ deviceSessionUuid: "uuid-a" });
    resolver.quarantine("emulator-5554");
    server.pushFailure(notification({ occurrenceId: "occ-dropped", deviceId: "emulator-5554" }));

    resolver.resolveIdentity("emulator-5554");
    server.pushFailure(notification({ occurrenceId: "occ-kept", deviceId: "emulator-5554" }));

    expect(pushed(socket).map((m) => m.data.occurrenceId)).toEqual(["occ-kept"]);
  });
});

class AuthFailuresServer extends FailuresPushSocketServer {
  private subscribed = 0;
  constructor(timer: FakeTimer, authenticator: StreamSocketAuthenticator) {
    super("/fake/failures.sock", timer, { authenticator });
  }
  receive(socket: Socket, line: string): Promise<void> {
    return this.processLine(socket, line);
  }
  protected override onSubscribed(): void {
    this.subscribed++;
  }
  effects(): number {
    return this.subscribed;
  }
}
streamSubscribeAuthCases(
  "failures-push",
  (timer, authenticator) => new AuthFailuresServer(timer, authenticator),
);
